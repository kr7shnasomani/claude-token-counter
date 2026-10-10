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
async function boot({ org = 'org-b', items = {}, conversation = async () => null } = {}) {
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
	ctx.document.cookie = `lastActiveOrg=${org}`;
	let ui = null;
	const RealUI = CC.ui.CounterUI;
	CC.ui.CounterUI = class extends RealUI { constructor(...a) { super(...a); ui = this; } };
	CC.bridge.requestUsage = async () => ({ five_hour: null, seven_day: null }); // a plan that reports nothing
	CC.bridge.requestOrgs = async () => [{ uuid: org, capabilities: ['chat'] }];
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

	process.exit(report('wrong-data') ? 1 : 0);
})();
