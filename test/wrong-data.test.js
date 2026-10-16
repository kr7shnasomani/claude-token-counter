// Numbers that are shown must belong to what is on screen: this account, this
// window, this chat. Each case here once showed someone else's or an expired one.
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const { loadWith, fakeStorage, section, t, report } = require('./harness');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHAT_A = '11111111-1111-4111-8111-111111111111';
const CHAT_B = '22222222-2222-4222-8222-222222222222';
const iso = (ms) => new Date(Date.now() + ms).toISOString();

/** Boot the whole content script on `org`, with `items` already in storage. */
async function boot({ org = 'org-b', cookie = true, items = {}, conversation = async () => null, usage = async () => ({ five_hour: null, seven_day: null }), orgs } = {}) {
	const store = fakeStorage(items);
	const intervals = [];
	const urlListeners = [];
	const ctx = loadWith({
		chrome: { storage: store.storage },
		setInterval: (fn) => { intervals.push(fn); return 0; },
		setup: (x) => {
			x.window.location.pathname = '/chat/' + CHAT_A;
			x.window.addEventListener = (type, fn) => { if (type === 'cc:urlchange') urlListeners.push(fn); };
		}
	}, 'src/content/constants.js', 'src/content/tokens.js', 'src/content/ui.js', 'src/content/bridge-client.js');
	const CC = ctx.ClaudeCounter;
	ctx.GPTTokenizer_o200k_base = { countTokens: (text) => text.split(/\s+/).length };
	ctx.document.cookie = cookie ? `lastActiveOrg=${org}` : '';
	let ui = null;
	const RealUI = CC.ui.CounterUI;
	CC.ui.CounterUI = class extends RealUI { constructor(...a) { super(...a); ui = this; } };
	CC.bridge.requestUsage = (...a) => usage(...a); // by default a plan that reports nothing
	CC.bridge.requestOrgs = orgs || (async () => [{ uuid: org, capabilities: ['chat'] }]);
	CC.bridge.requestConversation = (...a) => conversation(...a);
	vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src/content/main.js'), 'utf8'), ctx);
	await sleep(20);
	return {
		ctx, CC, ui,
		tick: async () => { intervals.forEach((fn) => fn()); await sleep(10); },
		navigate: async (id) => { ctx.window.location.pathname = '/chat/' + id; urlListeners.forEach((fn) => fn()); await sleep(20); }
	};
}

(async () => {
	section('a reading stored by another organisation is not shown for this one');
	{
		const snapshot = { updatedAt: Date.now(), orgId: 'org-a', five_hour: { utilization: 83, resets_at: iso(3600e3) }, seven_day: { utilization: 61, resets_at: iso(3 * 864e5) } };
		const other = await boot({ org: 'org-b', items: { 'cc:usageSnapshot': snapshot } });
		t('another org: nothing seeded', other.CC.usage.readState().usage === null && !/83%/.test(other.ui.sessionUsageSpan.textContent));
		const same = await boot({ org: 'org-a', items: { 'cc:usageSnapshot': snapshot } });
		t('the same org: seeded as before', /83%/.test(same.ui.sessionUsageSpan.textContent));
	}

	section('a window past its reset stops showing its old figure');
	{
		const { CC, ui, tick } = await boot();
		CC.bridge._emit('cc:message_limit', { windows: {
			'5h': { utilization: 0.92, resets_at: Math.floor(Date.now() / 1000) + 1 },
			'7d': { utilization: 0.4, resets_at: Math.floor(Date.now() / 1000) + 86400 }
		} });
		t('shown while it runs', /92%/.test(ui.sessionUsageSpan.textContent));
		await sleep(2100);
		await tick();
		t('unknown once it has reset, on a plan that reports nothing on demand', !/92%/.test(ui.sessionUsageSpan.textContent) && ui.sessionBarFill.style.width === '0%', ui.sessionUsageSpan.textContent);
		t('the other window is untouched', /40%/.test(ui.weeklyUsageSpan.textContent));
	}

	section('the last chat\'s count does not follow to the next chat');
	{
		const tree = { current_leaf_message_uuid: 'b', chat_messages: [
			{ uuid: 'a', parent_message_uuid: null, sender: 'human', created_at: iso(0), content: [{ type: 'text', text: 'one two three' }] },
			{ uuid: 'b', parent_message_uuid: 'a', sender: 'assistant', created_at: iso(0), content: [{ type: 'text', text: 'four five six' }] }] };
		let failing = false;
		const { ui, navigate } = await boot({ conversation: async () => { if (failing) throw new Error('timed out'); return tree; } });
		t('counted on the first chat', /6 tokens/.test(ui.headerContainer.textContent), ui.headerContainer.textContent);
		failing = true;
		await navigate(CHAT_B);
		t('gone on the next one when its own fetch fails', ui.headerContainer.textContent === '', JSON.stringify(ui.headerContainer.textContent));
	}

	section('a usage answer that left before a newer reading arrived is not applied');
	{
		let release;
		const { CC, ui } = await boot({ usage: () => new Promise((r) => { release = r; }) });
		CC.bridge._emit('cc:message_limit', { windows: { '5h': { utilization: 0.5, resets_at: Math.floor(Date.now() / 1000) + 3600 } } });
		release({ five_hour: { utilization: 20, resets_at: iso(3600e3) }, seven_day: null });
		await sleep(20);
		t('the reply\'s 50% stands, not the older 20%', /50%/.test(ui.sessionUsageSpan.textContent), ui.sessionUsageSpan.textContent);
	}

	section('a usage answer still carrying a window that already ended');
	{
		const { CC, ui } = await boot({ usage: async () => ({ five_hour: { utilization: 97, resets_at: iso(-5000) }, seven_day: { utilization: 30, resets_at: iso(864e5) } }) });
		t('the ended window is not shown', !/97%/.test(ui.sessionUsageSpan.textContent) && CC.usage.readState().usage?.five_hour === null);
		t('  its live partner is', /30%/.test(ui.weeklyUsageSpan.textContent));
	}

	section('reports say where usage came from');
	{
		const { ctx, CC, tick } = await boot();
		const from = async () => (await ctx.chrome.storage.local.get('cc:diag'))['cc:diag']?.usageFrom;
		const w = { '5h': { utilization: 0.1, resets_at: Math.floor(Date.now() / 1000) + 3600 } };
		CC.bridge._emit('cc:message_limit', { windows: w, via: 'timeline' });
		await tick();
		t('the newer layout\'s stream: timeline', (await from()) === 'timeline');
		CC.bridge._emit('cc:message_limit', { windows: w, via: 'refusal' });
		for (let i = 0; i < 5; i++) await tick();
		t('a refused send: refusal', (await from()) === 'refusal');
		CC.bridge._emit('cc:message_limit', { windows: w, via: '<b>anything else</b>' });
		for (let i = 0; i < 5; i++) await tick();
		t('anything a page script makes up: sse', (await from()) === 'sse');
	}

	section('another chat\'s reply starting leaves this chat\'s timer alone');
	{
		const { CC, ui } = await boot();
		let pending = 0;
		const real = ui.setPendingCache.bind(ui);
		ui.setPendingCache = (v) => { if (v) pending++; real(v); };
		CC.bridge._emit('cc:generation_start', { conversationId: CHAT_B });
		t('not marked waiting for another chat', pending === 0);
		CC.bridge._emit('cc:generation_start', { conversationId: CHAT_A });
		t('marked waiting for this one', pending === 1);
	}

	section('an empty organisations answer is not a free plan');
	{
		const { ctx, tick } = await boot({ orgs: async () => [] });
		await tick();
		const diag = (await ctx.chrome.storage.local.get('cc:diag'))['cc:diag'];
		t('plan unknown, not guessed', diag && diag.plan === null, JSON.stringify(diag?.plan));
	}

	section('a stored reading waits for the org id, then shows');
	{
		const snapshot = { updatedAt: Date.now(), orgId: 'org-a', five_hour: { utilization: 44, resets_at: iso(3600e3) }, seven_day: null };
		const { CC, ui } = await boot({ org: 'org-a', cookie: false, items: { 'cc:usageSnapshot': snapshot } });
		t('no org id yet: nothing seeded', !/44%/.test(ui.sessionUsageSpan.textContent));
		CC.bridge._emit('cc:org', { orgId: 'org-a' });
		await sleep(20);
		t('the bridge names this org: seeded', /44%/.test(ui.sessionUsageSpan.textContent), ui.sessionUsageSpan.textContent);
	}

	section('a stream reading whose window already ended is not shown');
	{
		const { CC, ui } = await boot();
		CC.bridge._emit('cc:message_limit', { windows: {
			'5h': { utilization: 0.88, resets_at: Math.floor(Date.now() / 1000) - 5 },
			'7d': { utilization: 0.2, resets_at: Math.floor(Date.now() / 1000) + 86400 }
		} });
		t('the ended window is a dash, not 88%', !/88%/.test(ui.sessionUsageSpan.textContent));
		t('  its live partner shows', /20%/.test(ui.weeklyUsageSpan.textContent));
	}

	process.exit(report('wrong-data') ? 1 : 0);
})();
