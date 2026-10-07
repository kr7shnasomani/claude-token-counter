// A new chat is read the moment its first message is sent, before the server has
// it, and showed no count. If the end of the reply was then missed, nothing asked
// again and the chip stayed blank (reported on 1.0.11). tick() now re-reads a chat
// that has produced no count, a few times.
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const { loadWith, section, t, report } = require('./harness');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Boot the content script; `server()` is what the conversation endpoint answers. */
async function boot(server) {
	const intervals = [];
	const clock = { t: Date.now() };
	const ctx = loadWith({
		setInterval: (fn) => { intervals.push(fn); return 0; },
		setup: (x) => {
			x.Date = class extends Date { static now() { return clock.t; } };
			x.GPTTokenizer_o200k_base = { countTokens: (text) => text.split(/\s+/).length };
			x.document.cookie = 'lastActiveOrg=org-1';
		}
	}, 'src/content/constants.js', 'src/content/tokens.js', 'src/content/ui.js', 'src/content/bridge-client.js');
	const CC = ctx.ClaudeCounter;
	let ui = null;
	const RealUI = CC.ui.CounterUI;
	CC.ui.CounterUI = class extends RealUI { constructor(...a) { super(...a); ui = this; } };
	const state = { calls: 0 };
	CC.bridge.requestUsage = async () => ({ five_hour: null, seven_day: null });
	CC.bridge.requestOrgs = async () => [];
	CC.bridge.requestConversation = async () => { state.calls++; return server(); };
	vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src/content/main.js'), 'utf8'), ctx);
	await sleep(20);
	const tick = async (advance) => { clock.t += advance; intervals.forEach((fn) => fn()); await sleep(20); };
	return { CC, ui: () => ui, state, tick };
}

const msg = (uuid, parent, sender, text) => ({ uuid, parent_message_uuid: parent, sender, created_at: new Date().toISOString(), content: [{ type: 'text', text }] });
const full = { current_leaf_message_uuid: 'b', chat_messages: [msg('a', null, 'human', 'hello there'), msg('b', 'a', 'assistant', 'hi, how can I help')] };

(async () => {
	{
		let answer = null; // the server does not have the chat yet
		const { CC, ui, state, tick } = await boot(() => answer);
		const { EMPTY_REFRESH_MS } = CC.CONST;

		section('a chat with no count is read again');
		const first = state.calls;
		t('read once on load', first >= 1);
		await tick(1000);
		t('not on every tick', state.calls === first);
		await tick(EMPTY_REFRESH_MS);
		t('but after the interval', state.calls === first + 1);
		t('nothing shown while there is nothing', ui().lengthDisplay.textContent === '');

		section('and it stops once there is a count');
		answer = full;
		await tick(EMPTY_REFRESH_MS);
		t('the count appears with no reply signal at all', /tokens/.test(ui().lengthDisplay.textContent), ui().lengthDisplay.textContent);
		const found = state.calls;
		for (let i = 0; i < 4; i++) await tick(EMPTY_REFRESH_MS);
		t('no more reads once it has one', state.calls === found, `${state.calls} vs ${found}`);
	}

	{
		section('and not forever');
		const { CC, state, tick } = await boot(() => null);
		for (let i = 0; i < CC.CONST.EMPTY_REFRESH_MAX + 6; i++) await tick(CC.CONST.EMPTY_REFRESH_MS);
		t('gives up after the cap', state.calls <= CC.CONST.EMPTY_REFRESH_MAX + 1, `calls ${state.calls}`);
	}

	process.exit(report('empty-refresh'));
})();
