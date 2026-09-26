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
		location: { origin: 'https://claude.ai' },
		postMessage: (msg) => posted.push(msg),
		addEventListener() {},
		dispatchEvent() {}
	};
	const ctx = vm.createContext({
		window, posted,
		history: { pushState() {}, replaceState() {} },
		CustomEvent: class { constructor(type) { this.type = type; } },
		Request, Response, ReadableStream, TextDecoder, TextEncoder, URL, crypto, console
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
		// Hashing lives in the page world; with no bridge each call would time out.
		CC.bridge.requestHash = async (text) => ({ hash: String(text.length) });
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
		CC.bridge.requestConversation = async (orgId, conversationId) => {
			CC.bridge._emit('cc:conversation', { orgId, conversationId, data: tree });
			return tree;
		};

		vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src/content/main.js'), 'utf8'), ctx);
		await sleep(20);
		const header = () => ui.headerContainer.textContent;
		const tokensShown = () => Number((header().match(/~([\d,]+) tokens/) || [])[1]?.replace(/,/g, ''));

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
