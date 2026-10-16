/* global ReadableStream */
// Live refresh after a reply.
//
// claude.ai renders a reply from its completion stream and does not refetch the
// conversation tree afterwards. The token count and the cache timer are both
// computed from that tree, so for three releases they froze after the first
// message and only moved on a page reload. Nothing caught it: no suite ran the
// bridge at all. This one runs the real bridge against a fake fetch, and the
// real main.js against a stubbed bridge client.
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const { load, section, t, report } = require('./harness');

const CONV = '00000000-0000-4000-8000-000000000000';
const ORG = 'org-1';
const COMPLETION_URL = `https://claude.ai/api/organizations/${ORG}/chat_conversations/${CONV}/completion`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sse(events) {
	const enc = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const e of events) controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
			controller.close();
		}
	});
}

/** Load the real bridge into a page-world sandbox whose fetch is `fakeFetch`. */
function loadBridge(fakeFetch) {
	const posted = [];
	const window = {
		fetch: fakeFetch,
		location: { origin: 'https://claude.ai', href: 'https://claude.ai/chat/x' },
		postMessage: (msg) => posted.push(msg),
		addEventListener() {},
		dispatchEvent() {}
	};
	const ctx = vm.createContext({
		window, posted,
		history: { pushState() {}, replaceState() {} },
		CustomEvent: class { constructor(type) { this.type = type; } },
		Request, Response, ReadableStream, TextDecoder, TextEncoder, URL, crypto, console, Blob, DecompressionStream, CompressionStream
	});
	vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src/injected/bridge.js'), 'utf8'), ctx);
	const types = () => posted.map((m) => m.type);
	return { fetch: window.fetch, posted, types };
}

async function waitFor(cond, ms = 500) {
	const until = Date.now() + ms;
	while (!cond() && Date.now() < until) await sleep(5);
	return cond();
}

(async () => {
	section('bridge: a completion stream announces its end');
	{
		const events = [
			{ type: 'message_start' },
			{ type: 'message_limit', message_limit: { windows: {} } },
			{ type: 'content_block_delta', delta: { text: 'hello' } },
			{ type: 'message_stop' }
		];
		const b = loadBridge(async () => new Response(sse(events), { headers: { 'content-type': 'text/event-stream' } }));
		const res = await b.fetch(COMPLETION_URL, { method: 'POST' });
		const body = await res.text();
		t('the page still reads the whole stream itself', body.includes('message_stop') && body.includes('hello'));
		t('generation_end is posted', await waitFor(() => b.types().includes('cc:generation_end')));
		const end = b.posted.find((m) => m.type === 'cc:generation_end');
		t('  naming the conversation', end?.payload?.conversationId === CONV);
		t('message_limit is still posted', b.types().includes('cc:message_limit'));
		t('  before the end, not instead of it',
			b.types().indexOf('cc:message_limit') < b.types().indexOf('cc:generation_end'));
		t('start and end are paired', b.types().filter((x) => x === 'cc:generation_start').length === 1 &&
			b.types().filter((x) => x === 'cc:generation_end').length === 1);
	}

	section('bridge: a completion that never streams still ends');
	{
		const b = loadBridge(async () => new Response('{"error":"rate_limited"}', { status: 429, headers: { 'content-type': 'application/json' } }));
		await b.fetch(COMPLETION_URL, { method: 'POST' });
		t('a JSON refusal posts generation_end', b.types().includes('cc:generation_end'));

		const f = loadBridge(async () => { throw new TypeError('network down'); });
		let threw = false;
		try { await f.fetch(COMPLETION_URL, { method: 'POST' }); } catch { threw = true; }
		t('a failed fetch posts generation_end', f.types().includes('cc:generation_end'));
		t('  and the error still reaches claude.ai', threw);
	}

	section('bridge: a send refused at the limit still reports usage');
	{
		const limit = { windows: { '5h': { status: 'exceeded_limit', resets_at: 1787417400, utilization: 0.98 } } };
		const b = loadBridge(async () => new Response(JSON.stringify({ error: { message: JSON.stringify(limit) } }), { status: 429, headers: { 'content-type': 'application/json' } }));
		await b.fetch(COMPLETION_URL, { method: 'POST' });
		t('message_limit posted from the refusal', await waitFor(() => b.types().includes('cc:message_limit')));
		t('  with its windows', b.posted.find((m) => m.type === 'cc:message_limit')?.payload?.windows?.['5h']?.utilization === 0.98);
	}

	section('bridge: the newer layout\'s timeline stream carries usage too');
	{
		// A protobuf writer just big enough for the message_limit path, so the test
		// builds real wire bytes rather than trusting the decoder's own idea of them.
		const varint = (n) => { const o = []; while (n >= 0x80) { o.push((n % 128) | 0x80); n = Math.floor(n / 128); } o.push(n); return o; };
		const bytes = (field, b) => [...varint(field * 8 + 2), ...varint(b.length), ...b];
		const num = (field, n) => [...varint(field * 8), ...varint(n)];
		const dbl = (field, x) => { const d = new DataView(new ArrayBuffer(8)); d.setFloat64(0, x, true); return [...varint(field * 8 + 1), ...new Uint8Array(d.buffer)]; };
		const win = (key, status, secs, util) => bytes(13, [...bytes(1, [...new TextEncoder().encode(key)]), ...bytes(2, [...num(1, status), ...bytes(2, num(1, secs)), ...dbl(3, util)])]);
		const limitMsg = bytes(1, bytes(4, [...num(1, 1), ...win('5h', 3, 1787417400, 0.98), ...win('7d', 1, 1787860800, 0.04)]));
		const otherMsg = bytes(1, bytes(6, [])); // a heartbeat
		const frame = (flags, payload) => [flags, ...[24, 16, 8, 0].map((s) => (payload.length >>> s) & 255), ...payload];
		const all = new Uint8Array([...frame(0, otherMsg), ...frame(0, limitMsg), ...frame(2, [...new TextEncoder().encode('{}')])]);
		// Split mid-frame, as a network read would.
		const body = new ReadableStream({ start(c) { c.enqueue(all.slice(0, 9)); c.enqueue(all.slice(9)); c.close(); } });
		const url = 'https://claude.ai/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/StreamTimeline';
		// A bridge whose fetch answers with a timeline stream carrying these bytes.
		const timelineOf = (data) => loadBridge(async () => new Response(
			data instanceof ReadableStream ? data : new ReadableStream({ start(c) { c.enqueue(data); c.close(); } }),
			{ headers: { 'content-type': 'application/connect+proto' } }));
		const b = timelineOf(body);
		const res = await b.fetch(url, { method: 'POST' });
		t('the page still gets its whole stream', (await res.arrayBuffer()).byteLength === all.length);
		t('message_limit posted from the timeline', await waitFor(() => b.types().includes('cc:message_limit')));
		const w = b.posted.find((m) => m.type === 'cc:message_limit')?.payload?.windows;
		t('  5h decoded, marked spent', w?.['5h']?.utilization === 0.98 && w['5h'].resets_at === 1787417400 && w['5h'].status === 'exceeded_limit', JSON.stringify(w));
		t('  7d decoded', w?.['7d']?.utilization === 0.04 && w['7d'].status === 'within_limit');
		t('  once, for the one limit event', b.types().filter((x) => x === 'cc:message_limit').length === 1);
		t('not mistaken for a completion', !b.types().includes('cc:generation_start'));

		// The same stream says when a reply starts and ends: the conversation's status.
		const enc = (x) => [...new TextEncoder().encode(x)];
		const statusOf = (id, n) => bytes(1, bytes(1, bytes(2, [...bytes(1, enc(id)), ...num(3, n)])));
		const status = (n) => statusOf(CONV, n);
		const turn = new Uint8Array([
			...frame(0, status(1)), // idle on connect: no reply
			...frame(0, status(2)), // running
			...frame(0, status(2)), // still running: no second start
			...frame(0, limitMsg),
			...frame(0, status(1)) // idle: the reply is done
		]);
		const t2 = timelineOf(turn);
		await (await t2.fetch(url, { method: 'POST' })).arrayBuffer();
		await waitFor(() => t2.types().includes('cc:generation_end'));
		t('a reply on the timeline starts once and ends once',
			t2.types().filter((x) => x === 'cc:generation_start').length === 1 && t2.types().filter((x) => x === 'cc:generation_end').length === 1, t2.types().join());
		t('  in order, with the usage between', t2.types().join() === 'cc:generation_start,cc:message_limit,cc:generation_end', t2.types().join());
		t('  naming the conversation', t2.posted.find((m) => m.type === 'cc:generation_end')?.payload?.conversationId === CONV);

		const cut = timelineOf(new Uint8Array(frame(0, status(2))));
		await (await cut.fetch(url, { method: 'POST' })).arrayBuffer();
		t('a stream cut mid-reply still ends the wait', await waitFor(() => cut.types().includes('cc:generation_end')));

		// Hostile input: junk messages, a gzipped one, a huge one, all in tiny chunks.
		// A message that does not decode is skipped; the ones after it still count.
		let seed = 7;
		const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
		const junk = () => Array.from({ length: 1 + Math.floor(rnd() * 200) }, () => Math.floor(rnd() * 256));
		const gz = async (raw) => [...new Uint8Array(await new Response(new Blob([new Uint8Array(raw)]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer())];
		// A long chat's first snapshot: one 3 MB message (an update whose messages
		// field is filler). Built as bytes, too big to spread into an array.
		const MB3 = 3 * 1024 * 1024;
		const inner = [0x1a, ...varint(MB3)]; // update.messages (field 3), length-delimited
		const mid = [0x0a, ...varint(inner.length + MB3)]; // event.update (field 1)
		const outer = [0x0a, ...varint(mid.length + inner.length + MB3)]; // response.event (field 1)
		const bigLen = outer.length + mid.length + inner.length + MB3;
		const bigFrame = new Uint8Array(5 + bigLen);
		bigFrame.set([0, (bigLen >>> 24) & 255, (bigLen >>> 16) & 255, (bigLen >>> 8) & 255, bigLen & 255, ...outer, ...mid, ...inner]);
		const chunks = [];
		for (let i = 0; i < 40; i++) chunks.push(new Uint8Array(frame(0, junk())));
		chunks.push(bigFrame, new Uint8Array(frame(0, status(2))), new Uint8Array(frame(1, await gz(limitMsg))));
		for (let i = 0; i < 40; i++) chunks.push(new Uint8Array(frame(0, junk())));
		chunks.push(new Uint8Array(frame(0, status(4))));
		const hostile = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
		chunks.reduce((at, c) => (hostile.set(c, at), at + c.length), 0);
		const started = Date.now();
		const h = timelineOf(new ReadableStream({
			start(c) { for (let i = 0; i < hostile.length; i += 4096) c.enqueue(hostile.slice(i, i + 4096)); c.close(); }
		}));
		const got = await (await h.fetch(url, { method: 'POST' })).arrayBuffer();
		await waitFor(() => h.types().includes('cc:generation_end'), 3000);
		t('junk is skipped, not fatal: usage and the reply\'s end still arrive',
			h.types().join() === 'cc:generation_start,cc:message_limit,cc:generation_end', h.types().join());
		t('  the gzipped message decoded', h.posted.find((m) => m.type === 'cc:message_limit')?.payload?.windows?.['7d']?.utilization === 0.04);
		t('  the page still got every byte', got.byteLength === hostile.length);
		t('  a 3 MB message in 4 KB chunks reads in well under a second', Date.now() - started < 1000, (Date.now() - started) + ' ms');

		const desync = timelineOf(new Uint8Array([0, 255, 255, 255, 255, 1, 2, 3]));
		await (await desync.fetch(url, { method: 'POST' })).arrayBuffer();
		await sleep(50);
		t('a length no real message has stops reading instead of buffering forever', desync.types().length === 0);

		const OTHER = '11111111-1111-4111-8111-111111111111';
		const two = new Uint8Array([...frame(0, statusOf(CONV, 2)), ...frame(0, statusOf(OTHER, 1)), ...frame(0, statusOf(CONV, 1))]);
		const tw = timelineOf(two);
		await (await tw.fetch(url, { method: 'POST' })).arrayBuffer();
		await waitFor(() => tw.types().includes('cc:generation_end'));
		const ends = tw.posted.filter((m) => m.type === 'cc:generation_end').map((m) => m.payload.conversationId);
		t('another chat going idle does not end this one\'s reply', ends.length === 1 && ends[0] === CONV, ends.join());

		const noId = (n) => bytes(1, bytes(1, bytes(2, num(3, n))));
		const anon = new Uint8Array([...frame(0, statusOf(CONV, 2)), ...frame(0, noId(1))]);
		const an = timelineOf(anon);
		await (await an.fetch(url, { method: 'POST' })).arrayBuffer();
		await waitFor(() => an.types().includes('cc:generation_end'));
		t('an idle update that names no chat still ends the running reply, once',
			an.posted.filter((m) => m.type === 'cc:generation_end').length === 1 && an.posted.find((m) => m.type === 'cc:generation_end').payload.conversationId === CONV);

		const midDesync = new Uint8Array([...frame(0, statusOf(CONV, 2)), 0, 255, 255, 255, 255]);
		const md = timelineOf(midDesync);
		await (await md.fetch(url, { method: 'POST' })).arrayBuffer();
		t('framing lost mid-reply still ends that reply', await waitFor(() => md.posted.some((m) => m.type === 'cc:generation_end' && m.payload.conversationId === CONV)));

		const err = loadBridge(async () => new Response('<!DOCTYPE html>', { status: 401, headers: { 'content-type': 'application/connect+proto' } }));
		await (await err.fetch(url, { method: 'POST' })).text();
		await sleep(30);
		t('an error response is not read as a stream', err.types().length === 0);
	}

	section('bridge: requests are recognised however they are written');
	{
		const b = loadBridge(async () => new Response('{}', { headers: { 'content-type': 'application/json' } }));
		await b.fetch('//claude.ai/api/organizations/' + ORG + '/usage');
		t('a protocol-relative URL still teaches the org id', b.posted.some((m) => m.type === 'cc:org' && m.payload.orgId === ORG));
		const c = loadBridge(async () => new Response('{}', { headers: { 'content-type': 'application/json' } }));
		await c.fetch('https://tracker.example/api/organizations/' + ORG + '/x');
		t('another site\'s URL does not', !c.types().includes('cc:org'));
		const d = loadBridge(async () => new Response('{}', { headers: { 'content-type': 'application/json' } }));
		await d.fetch(new URL('https://claude.ai/api/organizations/' + ORG + '/chat_conversations/' + CONV + '/completion'), { method: 'POST' });
		t('a URL object is recognised as a completion', d.types().includes('cc:generation_start'));
		const e = loadBridge(async () => new Response('{}', { headers: { 'content-type': 'application/json' } }));
		let res;
		try { res = await e.fetch({ toString() { throw new Error('odd input'); } }); } catch { res = 'threw'; }
		t('input that trips our checks still reaches the real fetch', res && res !== 'threw');
	}

	section('bridge: an HTTP error is a failure, not data');
	{
		// A 429 or 401 answers with JSON. Passed on as data it became an empty export,
		// a "no usage" account and a FREE plan.
		const listeners = [];
		const posted = [];
		const window = {
			fetch: async () => new Response('{"type":"error"}', { status: 429, headers: { 'content-type': 'application/json' } }),
			location: { origin: 'https://claude.ai' }, postMessage: (m) => posted.push(m),
			addEventListener: (_type, fn) => listeners.push(fn), dispatchEvent() {}
		};
		vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src/injected/bridge.js'), 'utf8'), vm.createContext({
			window, history: { pushState() {}, replaceState() {} }, CustomEvent: class {}, Request, Response, TextDecoder, URL, console
		}));
		for (const [kind, payload] of [['usage', { orgId: ORG }], ['orgs', {}], ['conversation', { orgId: ORG, conversationId: CONV }]]) {
			posted.length = 0;
			for (const fn of listeners) await fn({ source: window, data: { cc: 'ClaudeCounter', type: 'cc:request', requestId: 'r', kind, payload } });
			const res = posted.find((m) => m.type === 'cc:response');
			t(kind + ': refused, with the status', res?.ok === false && res.payload === null && /429/.test(res.error), JSON.stringify(res));
		}
	}

	section('bridge: what it saw before the content script listened is said again');
	{
		// The bridge runs at document_start, the content script at idle: the page's
		// first org-scoped call is long over by then, and was posted to nobody.
		const listeners = [];
		const posted = [];
		const window = {
			fetch: async () => new Response('{}', { headers: { 'content-type': 'application/json' } }),
			location: { origin: 'https://claude.ai' }, postMessage: (m) => posted.push(m),
			addEventListener: (_type, fn) => listeners.push(fn), dispatchEvent() {}
		};
		vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src/injected/bridge.js'), 'utf8'), vm.createContext({
			window, history: { pushState() {}, replaceState() {} }, CustomEvent: class {}, Request, Response, TextDecoder, URL, console
		}));
		await window.fetch('https://claude.ai/api/organizations/' + ORG + '/usage');
		posted.length = 0;
		for (const fn of listeners) await fn({ source: window, data: { cc: 'ClaudeCounter', type: 'cc:hello' } });
		t('the org id is posted again on hello', posted.some((m) => m.type === 'cc:org' && m.payload?.orgId === ORG));
	}

	section('bridge: completion detection');
	{
		const b = loadBridge(async () => new Response(sse([{ type: 'message_stop' }]), { headers: { 'content-type': 'text/event-stream' } }));
		await (await b.fetch(new Request(COMPLETION_URL, { method: 'POST', body: '{}' }))).text();
		t('a POST carried on a Request object counts', await waitFor(() => b.types().includes('cc:generation_end')));

		const g = loadBridge(async () => new Response(sse([{ type: 'x' }]), { headers: { 'content-type': 'text/event-stream' } }));
		await (await g.fetch(`https://claude.ai/api/organizations/${ORG}/some_other_stream`)).text();
		await sleep(20);
		t('an unrelated stream does not', !g.types().includes('cc:generation_end'));
	}

	section('content script: the end of a reply refetches the conversation');
	{
		const ctx = load(
			'src/content/constants.js', 'src/content/tokens.js', 'src/content/ui.js',
			'src/content/bridge-client.js', 'src/content/main.js'
		);
		ctx.document.cookie = `lastActiveOrg=${ORG}`;
		const CC = ctx.ClaudeCounter;
		await sleep(10);

		const msg = (uuid, parent, sender) => ({ uuid, parent_message_uuid: parent, sender, created_at: new Date().toISOString(), content: [{ type: 'text', text: 'hi' }] });
		const replied = { current_leaf_message_uuid: 'b', chat_messages: [msg('a', null, 'human'), msg('b', 'a', 'assistant')] };
		const notYet = { current_leaf_message_uuid: 'a', chat_messages: [msg('a', null, 'human')] };

		let calls = [];
		let nextReply = replied;
		CC.bridge.requestConversation = async (orgId, conversationId) => { calls.push({ orgId, conversationId }); return nextReply; };

		CC.bridge._emit('cc:generation_end', { conversationId: CONV });
		await sleep(10);
		t('generation_end triggers a conversation fetch', calls.length === 1);
		t('  for this conversation', calls[0]?.conversationId === CONV && calls[0]?.orgId === ORG);

		calls = [];
		CC.bridge._emit('cc:generation_end', { conversationId: 'some-other-conversation' });
		await sleep(10);
		t('another conversation\'s reply is ignored', calls.length === 0);

		calls = [];
		nextReply = notYet;
		CC.bridge._emit('cc:generation_end', { conversationId: CONV });
		await sleep(10);
		t('a tree without the reply yet is fetched once now', calls.length === 1);
		nextReply = replied;
		await sleep(CC.CONST.REPLY_SETTLE_RETRY_MS + 100);
		t('  and once more after it settles', calls.length === 2);
	}

	section('end to end: an expired cache timer comes back on the next reply');
	{
		// Load everything but main.js, capture the UI it builds, then run it. The
		// vendored tokenizer needs browser globals the shim lacks; a word count
		// stands in, since only "did the number move" matters here.
		const ctx = load(
			'src/content/constants.js', 'src/content/tokens.js', 'src/content/ui.js',
			'src/content/bridge-client.js'
		);
		ctx.GPTTokenizer_o200k_base = { countTokens: (text) => text.split(/\s+/).length };
		ctx.document.cookie = `lastActiveOrg=${ORG}`;
		const CC = ctx.ClaudeCounter;
		// Load fetches usage before the conversation; unanswered, that waits 15s.
		CC.bridge.requestUsage = async () => ({ five_hour: null, seven_day: null });
		CC.bridge.requestOrgs = async () => [];
		const RealUI = CC.ui.CounterUI;
		let ui = null;
		CC.ui.CounterUI = class extends RealUI { constructor(...a) { super(...a); ui = this; } };

		const at = (msAgo) => new Date(Date.now() - msAgo).toISOString();
		const msg = (uuid, parent, sender, created_at, text) => ({ uuid, parent_message_uuid: parent, sender, created_at, content: [{ type: 'text', text }] });
		const firstTurn = [msg('a', null, 'human', at(400000), 'hello'), msg('b', 'a', 'assistant', at(390000), 'hi there')];
		let tree = { current_leaf_message_uuid: 'b', chat_messages: firstTurn };
		CC.bridge.requestConversation = async () => tree;

		vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src/content/main.js'), 'utf8'), ctx);
		await sleep(20);
		const header = () => ui.headerContainer.textContent;
		const tokensShown = () => Number((header().match(/([\d,]+) tokens/) || [])[1]?.replace(/,/g, ''));

		t('page loads a conversation whose cache already expired', /Token Counter/.test(header()) && !/Cached Context Timer/.test(header()),
			JSON.stringify(header()));
		const before = tokensShown();

		CC.bridge._emit('cc:generation_start', {});
		t('sending shows the placeholder', header().includes('Cached Context Timer:\u00A0-:--'), JSON.stringify(header()));

		tree = {
			current_leaf_message_uuid: 'd',
			chat_messages: [...firstTurn,
				msg('c', 'b', 'human', at(3000), 'tell me more about that please'),
				msg('d', 'c', 'assistant', at(1000), 'certainly, here is a much longer answer than before')]
		};
		CC.bridge._emit('cc:generation_end', { conversationId: CONV });
		await sleep(20);
		t('the reply brings the timer back as a live countdown', /Cached Context Timer:\u00A0[45]:\d\d/.test(header()), JSON.stringify(header()));
		t('  and the token count goes up with it', tokensShown() > before, `${before} -> ${tokensShown()}`);
	}

	process.exit(report('live-refresh') ? 1 : 0);
})();
