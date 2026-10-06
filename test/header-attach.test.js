// The counter and the cache timer live in the chat header. main.js used to wait
// only for the title testid before calling attachHeader, so on a layout without
// that testid the fallbacks inside attachHeader were unreachable and both
// elements simply never appeared. These suites pin the whole route, not just
// attachHeader on its own.
const { load, loadWith, fakeStorage, section, t, report } = require('./harness');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CONV = '00000000-0000-4000-8000-000000000000';

section('the observer reaches every tier attachHeader can use');
// It used to wait on the title testid alone, so a layout without it never got as
// far as attachHeader's fallbacks. The observer now calls attachHeader itself, and
// attachHeader looks at all three, so each layout must be reachable from a batch.
for (const [label, anchor, tier] of [
	['title testid', '[data-testid="chat-title-split"]', 'title'],
	['chat-header testid', '[data-testid="chat-header"]', 'header-testid'],
	['semantic <header> only', 'header', 'semantic-header']
]) {
	const observers = [];
	const c = loadWith({
		setup: (x) => { x.MutationObserver = class { constructor(cb) { observers.push(cb); } observe() {} disconnect() {} }; }
	}, 'src/content/constants.js', 'src/content/ui.js');
	const el = c.document.createElement('div');
	el.after = (n) => { el.sibling = n; };
	c.document.querySelector = (sel) => (sel === anchor ? el : null);
	const ui = new c.ClaudeCounter.ui.CounterUI();
	ui.initialize();
	// Nothing of ours is in the page yet (the shim's contains() says yes to anything).
	c.document.contains = () => false;
	observers.forEach((cb) => cb());
	t(label + ': attached from the observer', ui.headerTier === tier);
}

section('attachHeader reports which tier it used');
{
	const mk = () => {
		const ctx = load('src/content/constants.js', 'src/content/ui.js');
		const ui = new ctx.ClaudeCounter.ui.CounterUI();
		ui.initialize();
		return { ctx, ui, doc: ctx.document };
	};
	const el = (doc) => doc.createElement('div');

	let { ui, doc } = mk();
	const title = el(doc);
	title.after = (n) => { title.sibling = n; };
	doc.querySelector = (s) => (s === '[data-testid="chat-title-split"]' ? title : null);
	ui.attachHeader();
	t('title testid', ui.headerTier === 'title' && title.sibling === ui.headerContainer);

	({ ui, doc } = mk());
	const hdr = el(doc);
	doc.querySelector = (s) => (s === '[data-testid="chat-header"]' ? hdr : null);
	ui.attachHeader();
	t('chat-header testid', ui.headerTier === 'header-testid' && hdr.children.includes(ui.headerContainer));

	({ ui, doc } = mk());
	const bare = el(doc);
	doc.querySelector = (s) => (s === 'header' ? bare : null);
	ui.attachHeader();
	t('semantic <header> only', ui.headerTier === 'semantic-header' && bare.children.includes(ui.headerContainer));

	({ ui, doc } = mk());
	doc.querySelector = () => null;
	ui.attachHeader();
	t('nothing at all', ui.headerTier === 'none');
}

(async () => {
section('the counter moves up to the title once it renders');
{
	const observers = [];
	const c = require('./harness').loadWith({
		setup: (x) => { x.MutationObserver = class { constructor(cb) { observers.push(cb); } observe() {} disconnect() {} }; }
	}, 'src/content/constants.js', 'src/content/ui.js');
	const CC = c.ClaudeCounter;
	const header = c.document.createElement('div');
	const title = c.document.createElement('div');
	title.after = (n) => { title.sibling = n; };
	let titleThere = false;
	c.document.querySelector = (sel) => {
		if (sel === '[data-testid="chat-title-split"]') return titleThere ? title : null;
		if (sel === 'header') return header;
		return null;
	};
	const ui = new CC.ui.CounterUI();
	ui.initialize();
	ui.attachHeader();
	t('attached to the semantic header first', ui.headerTier === 'semantic-header');
	titleThere = true;
	observers.forEach((cb) => cb());
	await sleep(10);
	t('then re-attached beside the title', ui.headerTier === 'title' && title.sibling === ui.headerContainer);
}

section('an anchor that lands inside the throttle is still found on an idle page');
{
	// The observer searches at most once a second. A batch that brings the header
	// can arrive inside that window, and an idle page sends no second batch: the
	// retry has to come from the observer itself.
	const observers = [];
	const c = require('./harness').loadWith({
		setup: (x) => { x.MutationObserver = class { constructor(cb) { observers.push(cb); } observe() {} disconnect() {} }; }
	}, 'src/content/constants.js', 'src/content/ui.js');
	const header = c.document.createElement('div');
	let headerThere = false;
	c.document.querySelector = (sel) => (sel === 'header' && headerThere ? header : null);
	c.document.contains = () => false;
	const ui = new c.ClaudeCounter.ui.CounterUI();
	ui.initialize();
	observers.forEach((cb) => cb());
	t('first look: nothing to attach to yet', ui.headerTier === 'none');
	headerThere = true;
	observers.forEach((cb) => cb());
	t('the second batch is inside the throttle', ui.headerTier === 'none');
	await sleep(1150);
	t('and the observer looks again by itself', ui.headerTier === 'semantic-header' && header.children.includes(ui.headerContainer));
}

section('no header fallback away from a conversation');
{
	const c = load('src/content/constants.js', 'src/content/ui.js');
	c.window.location.pathname = '/new';
	const ui = new c.ClaudeCounter.ui.CounterUI();
	ui.initialize();
	const hdr = c.document.createElement('div');
	c.document.querySelector = (s) => (s === 'header' ? hdr : null);
	ui.attachHeader();
	t('home page: nothing attached', ui.headerTier === 'none' && hdr.children.length === 0);
}

section('content script: a layout with only a semantic <header> still gets the counter');
{
	const header = { tag: 'header', children: [], appendChild(c) { this.children.push(c); return c; }, getBoundingClientRect: () => ({ width: 0, height: 0 }) };
	// Behave like a real DOM: a selector list matches if any of its parts does.
	const query = (sel) => (sel.split(',').map((x) => x.trim()).includes('header') ? header : null);
	loadWith({
		chrome: fakeStorage(),
		setup: (c) => { c.document.querySelector = query; }
	}, 'src/content/constants.js', 'src/content/tokens.js', 'src/content/ui.js',
	'src/content/bridge-client.js', 'src/content/main.js');
	await sleep(20);
	t('the header container was attached to it', header.children.some((c) => String(c.className).includes('cc-header')));
}

section('content script: an org id that arrives late still fetches the conversation');
{
	// No chrome.runtime here, as in live-refresh: with one, the shim never fires
	// the bridge script's onload and every fetch waits on it forever.
	const c = load('src/content/constants.js', 'src/content/tokens.js', 'src/content/ui.js',
		'src/content/bridge-client.js', 'src/content/main.js');
	const CC = c.ClaudeCounter;
	await sleep(10);
	const calls = [];
	CC.bridge.requestConversation = async (orgId, conversationId) => { calls.push({ orgId, conversationId }); return null; };
	// No cookie: nothing could be fetched at load.
	CC.bridge._emit('cc:org', { orgId: 'org-late' });
	await sleep(20);
	t('fetches once the org id is known', calls.length === 1 && calls[0].orgId === 'org-late' && calls[0].conversationId === CONV);
}

})().then(() => {
section('diagnostics: facts for a bug report, nothing about the conversation');
{
	const ctx = load('src/content/constants.js', 'src/content/ui.js');
	const CC = ctx.ClaudeCounter;
	const root = ctx.document.documentElement;
	root.dataset.buildId = 'aa6da7d0d3';
	root.dataset.buildTimestamp = '1790987744';
	root.dataset.colorVersion = 'v2';
	root.className = 'cds-root h-screen';
	CC.uiVariant = 'cds';
	CC.noteError('conversation fetch', new Error('boom'));

	const ui = new CC.ui.CounterUI();
	ui.initialize();
	ui.headerTier = 'title';
	const d = ui.getDiagnostics();
	t('build id', d.build === 'aa6da7d0d3');
	t('build date from the timestamp', d.buildDate === '2026-10-03');
	t('colors and cds-root', d.colors === 'v2' && d.cdsRoot === true);
	t('layout tiers', d.composer === 'cds' && d.header === 'title');
	t('nothing is claimed shown without layout', d.tokens === false && d.timer === false && d.usageRow === false);
	t('recent errors are carried', d.errors.length === 1 && d.errors[0] === 'conversation fetch: boom');
	t('only plain values', Object.values(d).every((v) => v === null || ['string', 'boolean'].includes(typeof v) || Array.isArray(v)));

	ui.lengthDisplay.textContent = '42';
	ui.lengthDisplay.getBoundingClientRect = () => ({ width: 30 });
	t('tokens count as shown once painted', ui.getDiagnostics().tokens === true);

	for (let i = 0; i < 9; i++) CC.noteError('x' + i, new Error('e'));
	t('error list is capped', CC.recentErrors().length === 5);

	CC.noteError('parse', new Error('Unexpected token \'x\', "private words here" is not valid JSON'));
	t('quoted text is scrubbed from errors', !CC.recentErrors().some((e) => e.includes('private')));

	ui.settings.cacheTimer = false;
	t('settings turned off are listed', ui.getDiagnostics().disabled.join() === 'cacheTimer');
}

process.exit(report('header-attach') ? 1 : 0);
});
