// The export button sits beside Claude's top-right controls as a sibling in our
// own look: never inside Claude's groups, never wearing its classes. Claude
// moves and re-renders those controls as panels open, so the button must follow
// them, hide with its setting, and fall back to the header when there are none.
const { load, section, t, report } = require('./harness');

function setup(pathname = '/chat/00000000-0000-4000-8000-000000000000', { icons = true } = {}) {
	const ctx = load('src/content/constants.js', 'src/content/ui.js');
	const CC = ctx.ClaudeCounter;
	ctx.window.location.pathname = pathname;
	const doc = ctx.document;

	const row = doc.createElement('div'); // the header's right-hand side
	const host = doc.createElement('div'); // wiggle-controls-actions
	const ref = doc.createElement('button');
	for (const [k, v] of [['data-cds', 'Button'], ['data-cds-icon-only', '']]) ref.setAttribute(k, v);
	host.appendChild(ref);
	host.querySelector = () => (icons ? ref : null);
	row.appendChild(host);

	doc.querySelector = (sel) => (sel === CC.DOM.ACTIONS_HOST ? host : null);
	const ui = new CC.ui.CounterUI();
	ui.initialize();
	return { ctx, CC, doc, row, host, ref, ui };
}
const COUNTED = { totalTokens: 42, cachedUntil: Date.now() + 180000 };

section('sits beside Claude\'s controls, not in them');
{
	const { row, host, ref, ui } = setup();
	ui.attachHeader();
	t('docked', ui.exportDocked === true);
	t('a sibling right before the controls', ui.exportBtn.parentElement === row && ui.exportBtn.nextElementSibling === host);
	t('nothing added to Claude\'s group', host.children.length === 1 && host.children[0] === ref);
	t('our own look, no borrowed classes or attributes', ui.exportBtn.classList.contains('cc-exportBtn--docked') && !ui.exportBtn.hasAttribute('data-cds') && ui.exportBtn.children.length === 1);
	t('reported as such', ui.getDiagnostics().exportAt === 'actions');
}

section('a task-style chat (a group with only a Share button) is the same');
{
	const { row, host, ui } = setup(undefined, { icons: false });
	ui.attachHeader();
	t('docked before the group', ui.exportDocked && ui.exportBtn.parentElement === row && ui.exportBtn.nextElementSibling === host);
	t('not in the header', !ui.headerContainer.children.includes(ui.exportBtn));
}

section('shows only with a conversation and its setting');
{
	const { ui } = setup();
	ui.attachHeader();
	t('hidden until there is something to export', ui.exportBtn.classList.contains('cc-hidden'));
	ui.setConversationMetrics(COUNTED);
	t('shown once a conversation is counted', !ui.exportBtn.classList.contains('cc-hidden'));
	t('and not also in the header', !ui.headerContainer.children.includes(ui.exportBtn));
	ui.applySettings({ exportButton: false });
	t('hidden by its setting', ui.exportBtn.classList.contains('cc-hidden'));
	ui.applySettings({ exportButton: true });
	t('back with it', !ui.exportBtn.classList.contains('cc-hidden'));
}

section('follows the controls as Claude moves things');
{
	const { row, host, ui } = setup();
	ui.attachHeader();
	t('in place: nothing to do', ui._exportStale() === false);
	row.children = [host, ui.exportBtn];
	t('knocked behind them: noticed', ui._exportStale() === true);
	ui.attachHeader();
	t('and put back in front', ui.exportBtn.nextElementSibling === host);
	const before = row.children.slice();
	ui.attachHeader();
	t('already in place: DOM left alone', row.children.every((c, i) => c === before[i]));
	ui.exportBtn.remove();
	t('removed by a re-render: noticed', ui._exportStale() === true);
	ui.attachHeader();
	t('and restored', ui.exportBtn.nextElementSibling === host);
}

section('with an artifact panel open: beside the pop-out icon');
{
	// Seen 2026-10-08: Claude keeps the group but hides it, with only Share in it.
	const { CC, doc, host, ui } = setup(undefined, { icons: false });
	const header = doc.createElement('div');
	const popOut = doc.createElement('button');
	header.appendChild(popOut);
	doc.querySelector = (sel) => (sel === CC.DOM.ACTIONS_HOST ? host : sel === CC.DOM.POP_OUT_BUTTON ? popOut : null);
	ui.attachHeader();
	t('a sibling right before the pop-out icon', ui.exportBtn.parentElement === header && ui.exportBtn.nextElementSibling === popOut);
	t('reported as such', ui.getDiagnostics().exportAt === 'popout');
	const placed = header.children.slice();
	ui.attachHeader();
	t('already in place: left alone', header.children.every((c, i) => c === placed[i]) && !ui._exportStale());
	popOut.remove();
	doc.querySelector = (sel) => (sel === CC.DOM.ACTIONS_HOST ? host : null);
	t('the pop-out icon going away is noticed', ui._exportStale() === true);
}

section('moves between the two spots as an artifact panel opens and closes');
{
	const { CC, doc, row, host, ref, ui } = setup();
	ui.attachHeader();
	t('beside the controls first', ui.exportBtn.nextElementSibling === host && ui.getDiagnostics().exportAt === 'actions');
	const header = doc.createElement('div');
	const popOut = doc.createElement('button');
	header.appendChild(popOut);
	host.querySelector = () => null; // the panel hides the group and empties it of icons
	doc.querySelector = (sel) => (sel === CC.DOM.ACTIONS_HOST ? host : sel === CC.DOM.POP_OUT_BUTTON ? popOut : null);
	t('panel opened: noticed', ui._exportStale() === true);
	ui.attachHeader();
	t('now before the pop-out icon', ui.exportBtn.parentElement === header && ui.exportBtn.nextElementSibling === popOut);
	t('gone from the controls\' row, still docked', !row.children.includes(ui.exportBtn) && ui.exportDocked && ui.getDiagnostics().exportAt === 'popout');
	host.querySelector = () => ref;
	popOut.remove();
	doc.querySelector = (sel) => (sel === CC.DOM.ACTIONS_HOST ? host : null);
	ui.attachHeader();
	t('panel closed: back beside the controls', ui.exportBtn.parentElement === row && ui.exportBtn.nextElementSibling === host && ui.getDiagnostics().exportAt === 'actions');
}

section('falls back to the header when there are no controls');
{
	const { ctx, ui } = setup();
	ui.setConversationMetrics(COUNTED);
	ui.attachHeader();
	t('docked first', ui.exportDocked);
	ctx.document.querySelector = () => null;
	t('the controls going away is noticed', ui._exportStale() === true);
	ui.attachHeader();
	t('undocked and out of the page', ui.exportDocked === false && !ui.exportBtn.parentElement);
	t('not shown in the header at once: a re-render may bring them back', !ui.headerContainer.children.includes(ui.exportBtn));
	ui.exportHoldUntil = Date.now() - 1;
	ui.tick();
	t('beside the counter once the grace has passed', ui.headerContainer.children.includes(ui.exportBtn) && ui.exportBtn.parentElement === ui.headerContainer);
	t('with the small look', !ui.exportBtn.classList.contains('cc-exportBtn--docked'));
	t('reported as the header', ui.getDiagnostics().exportAt === 'header');
}

section('undocking does not leave the button hidden');
{
	const { ctx, ui } = setup();
	ui.attachHeader();
	t('docked and hidden: no conversation yet', ui.exportDocked && ui.exportBtn.classList.contains('cc-hidden'));
	ctx.document.querySelector = () => null;
	ui.attachHeader();
	ui.setConversationMetrics(COUNTED);
	ui.exportHoldUntil = Date.now() - 1;
	ui.tick();
	t('in the header once there is a conversation, and visible', ui.headerContainer.children.includes(ui.exportBtn) && !ui.exportBtn.classList.contains('cc-hidden'));
}

section('no flash in the old place while the page is still drawing');
{
	const { ctx, host, row, ui } = setup();
	ctx.document.querySelector = () => null; // not drawn yet
	ui.setConversationMetrics(COUNTED);
	t('not in the header at first, nor anywhere in the page', !ui.headerContainer.children.includes(ui.exportBtn) && !ui.exportBtn.parentElement);
	ui.tick();
	t('still held back inside the grace period', !ui.headerContainer.children.includes(ui.exportBtn));
	ctx.document.querySelector = (sel) => (sel === ctx.ClaudeCounter.DOM.ACTIONS_HOST ? host : null);
	ui.attachHeader();
	t('the controls arrive: straight to its place, never in the header', ui.exportDocked && ui.exportBtn.parentElement === row && !ui.headerContainer.children.includes(ui.exportBtn));
}

section('the header is the fallback once nothing has come, and a settled button stays');
{
	const { ctx, ui } = setup();
	ctx.document.querySelector = () => null;
	ui.setConversationMetrics(COUNTED);
	ui.exportHoldUntil = Date.now() - 1;
	ui.tick();
	t('settled beside the counter after the grace period', ui.headerContainer.children.includes(ui.exportBtn));
	ui.holdExport(); // a navigation
	ui.setConversationMetrics({ totalTokens: 43, cachedUntil: Date.now() + 180000 });
	t('the next redraw does not take it away', ui.headerContainer.children.includes(ui.exportBtn));

	ui.exportBtn.remove(); // Claude redrew the header and took it with it
	ui.holdExport();
	ui.setConversationMetrics({ totalTokens: 44, cachedUntil: Date.now() + 180000 });
	t('removed and a navigation: held again, never flashes there', !ui.headerContainer.children.includes(ui.exportBtn));
	ui.exportHoldUntil = Date.now() - 1;
	ui.tick();
	t('and settles if nothing arrives', ui.headerContainer.children.includes(ui.exportBtn));
}

section('an empty conversation shows no count');
{
	const { ui } = setup();
	ui.setConversationMetrics({ totalTokens: 0, cachedUntil: null });
	t('no "0 tokens"', ui.lengthDisplay.textContent === '' && ui.headerContainer.children.length === 0);
	ui.setConversationMetrics({ totalTokens: 5, cachedUntil: null });
	t('and the count appears once there is one', /5 tokens/.test(ui.lengthDisplay.textContent));
}

section('only on a conversation');
{
	const { ui } = setup('/new');
	ui.attachHeader();
	t('home page: not docked', ui.exportDocked === false);
}

process.exit(report('export-dock') ? 1 : 0);
