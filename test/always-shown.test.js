// claude.ai keeps changing its layout, and every change used to mean the counter
// or the usage row silently vanishing until someone noticed and shipped a fix.
// The safety net: a part with something to say that goes unpainted for a few
// ticks is floated over the page as a pill, and tries its real place again later.
const { loadWith, section, t, report } = require('./harness');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function make() {
	const observers = [];
	const ctx = loadWith({
		setup: (x) => { x.MutationObserver = class { constructor(cb) { observers.push(cb); } observe() {} disconnect() {} }; }
	}, 'src/content/constants.js', 'src/content/ui.js');
	const CC = ctx.ClaudeCounter;
	const ui = new CC.ui.CounterUI();
	ui.initialize();
	ui.setConversationMetrics({ totalTokens: 42, cachedUntil: Date.now() + 180000 });
	return { ctx, CC, ui, observers };
}
const unpaint = (el) => { el.getClientRects = () => []; };
const paint = (el) => { el.getClientRects = () => [{ width: 100 }]; };
const ticks = (ui, n) => { for (let i = 0; i < n; i++) ui.tick(); };

(async () => {
section('a part nobody can see is floated, after a few ticks');
{
	const { ctx, ui } = make();
	unpaint(ui.headerContainer);
	ticks(ui, 2);
	t('two ticks is a re-render, not a failure', !ui.headerContainer.classList.contains('cc-floating'));
	ticks(ui, 1);
	t('the third floats it', ui.headerContainer.classList.contains('cc-floating'));
	t('lifted out to the page itself', ctx.document.body.children.includes(ui.headerContainer));
	t('and reported', ui.headerTier === 'floating' && ui.getDiagnostics().floating.join() === 'header');
}

section('a part that comes back resets the count');
{
	const { ui } = make();
	unpaint(ui.headerContainer);
	ticks(ui, 2);
	paint(ui.headerContainer);
	ticks(ui, 1);
	unpaint(ui.headerContainer);
	ticks(ui, 2);
	t('seen once in between: not floated', !ui.headerContainer.classList.contains('cc-floating'));
}

section('never floats on a guess, or with nothing to show');
{
	const { ui } = make();
	ticks(ui, 10);
	t('no layout to ask: left alone', !ui.headerContainer.classList.contains('cc-floating'));

	const e = make();
	e.ui.headerContainer.replaceChildren();
	unpaint(e.ui.headerContainer);
	ticks(e.ui, 10);
	t('an empty header is not floated', !e.ui.headerContainer.classList.contains('cc-floating'));

	const u = make();
	unpaint(u.ui.usageLine);
	ticks(u.ui, 10);
	t('a usage row with no data (hidden) is not floated', !u.ui.usageLine.classList.contains('cc-floating'));
}

section('the usage row floats too, without the composer\'s insets');
{
	const { ui } = make();
	ui.setUsage({ five_hour: { utilization: 20, resets_at: new Date(Date.now() + 3e6).toISOString() }, seven_day: null });
	ui.usageLine.style.paddingInline = '24px';
	ui.usageLine.style.marginBottom = '6px';
	unpaint(ui.usageLine);
	ticks(ui, 3);
	t('floats', ui.usageLine.classList.contains('cc-floating'));
	t('inline insets cleared', ui.usageLine.style.paddingInline === '' && ui.usageLine.style.marginBottom === '');
	t('reported', ui.getDiagnostics().floating.includes('usage'));
}

section('it goes home when its real place is back');
{
	const { ctx, ui, observers } = make();
	unpaint(ui.headerContainer);
	ticks(ui, 3);
	t('floating', ui.headerContainer.classList.contains('cc-floating'));

	const title = ctx.document.createElement('div');
	title.after = (n) => { title.sibling = n; };
	ctx.document.querySelector = (sel) => (sel === '[data-testid="chat-title-split"]' ? title : null);

	ui.floatRetryAt.header = Date.now() + 60000;
	observers.forEach((cb) => cb());
	await sleep(10);
	t('not before its retry time (no flicker)', ui.headerContainer.classList.contains('cc-floating'));

	ui.floatRetryAt.header = 0;
	observers.forEach((cb) => cb());
	await sleep(10);
	t('after it: re-attached to the page\'s own markup', title.sibling === ui.headerContainer);
	t('and no longer floating', !ui.headerContainer.classList.contains('cc-floating'));
}


process.exit(report('always-shown') ? 1 : 0);
})();
