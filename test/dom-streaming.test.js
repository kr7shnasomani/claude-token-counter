// Newer claude.ai sends over its own RPC and streams the reply on a connection
// that was already open: no /completion request, so the bridge never announces a
// reply, and the token count and cache timer froze after the first one. The page
// flags a reply in progress in an attribute; main.js watches for that.
const { loadWith, section, t, report } = require('./harness');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CONV = '00000000-0000-4000-8000-000000000000';

(async () => {
	const observers = [];
	let streamingEl = null;
	// A reply takes seconds; the test does not. Let it say how much time passed.
	const clock = { t: Date.now() };
	const c = loadWith({
		setup: (x) => {
			x.Date = class extends Date { static now() { return clock.t; } };
			x.MutationObserver = class { constructor(cb) { observers.push(cb); } observe() {} disconnect() {} };
			x.document.cookie = 'lastActiveOrg=org-1';
			x.document.querySelector = (sel) => (sel === '[data-is-streaming="true"]' ? streamingEl : null);
		}
	}, 'src/content/constants.js', 'src/content/tokens.js', 'src/content/ui.js',
	'src/content/bridge-client.js', 'src/content/main.js');
	const CC = c.ClaudeCounter;
	await sleep(10);

	const msg = (uuid, parent, sender) => ({ uuid, parent_message_uuid: parent, sender, created_at: new Date().toISOString(), content: [{ type: 'text', text: 'hi' }] });
	const reply = { current_leaf_message_uuid: 'b', chat_messages: [msg('a', null, 'human'), msg('b', 'a', 'assistant')] };
	let calls = 0;
	CC.bridge.requestConversation = async () => { calls++; return reply; };
	const fire = async () => { observers.forEach((cb) => cb()); await sleep(200); };

	section('the page flagging a reply in progress is a signal');
	t('the selector is the page\'s own attribute', CC.DOM.STREAMING === '[data-is-streaming="true"]');

	streamingEl = {};
	await fire();
	t('a reply starting fetches nothing yet', calls === 0);

	streamingEl = null;
	await fire();
	t('a reply finishing refetches the conversation', calls === 1);

	section('no flag change, no work');
	await fire();
	t('nothing changed: nothing fetched', calls === 1);

	section('the next reply works too (it froze after the first)');
	clock.t += 30000;
	streamingEl = {};
	await fire();
	streamingEl = null;
	await fire();
	t('second reply refetched', calls === 2);

	section('the bridge and the page do not both fetch for one reply');
	clock.t += 30000;
	CC.bridge._emit('cc:generation_end', { conversationId: CONV });
	await sleep(20);
	const afterBridge = calls;
	streamingEl = {};
	await fire();
	streamingEl = null;
	await fire();
	t('the bridge\'s end is kept; the page signal stands down just after it', calls === afterBridge);

	process.exit(report('dom-streaming') ? 1 : 0);
})();
