// The export button docks into Claude's top-right action group, left of the page
// icon, wearing that icon's own classes so it matches in size, colour and hover.
// Claude moves and re-renders the group as panels open, so the button must also
// follow it, hide with its setting, and fall back to the header when the group
// has nothing to copy.
const { load, section, t, report } = require('./harness');

function setup(pathname = '/chat/00000000-0000-4000-8000-000000000000') {
	const ctx = load('src/content/constants.js', 'src/content/ui.js');
	const CC = ctx.ClaudeCounter;
	ctx.window.location.pathname = pathname;
	const doc = ctx.document;

	const host = doc.createElement('div');
	const ref = doc.createElement('button');
	for (const [k, v] of [['data-cds', 'Button'], ['data-cds-icon-only', ''], ['data-cds-ghost', ''], ['data-size', 'sm']]) ref.setAttribute(k, v);
	ref.className = 'cds-reset group/btn h-control aspect-square w-control';
	const paint = doc.createElement('span');
	paint.className = 'absolute inset-0 paint';
	ref.appendChild(paint);
	host.appendChild(ref);
	const isIcon = (b) => b.attrs && b.attrs['data-cds'] === 'Button' && 'data-cds-icon-only' in b.attrs;
	host.querySelectorAll = () => host.children.filter(isIcon);

	doc.querySelector = (sel) => (sel === CC.DOM.ACTIONS_HOST ? host : null);
	const ui = new CC.ui.CounterUI();
	ui.initialize();
	return { ctx, CC, doc, host, ref, paint, ui };
}

section('docks left of the page icon');
{
	const { host, ref, ui } = setup();
	ui.attachHeader();
	t('docked', ui.exportDocked === true);
	t('first in the group, before the page icon', host.children[0] === ui.exportBtn && host.children[1] === ref);
	t('wears the neighbour\'s classes', ['cds-reset', 'h-control', 'w-control'].every((c) => ui.exportBtn.classList.contains(c)));
	t('and its design-system attributes', ui.exportBtn.getAttribute('data-cds') === 'Button' && ui.exportBtn.hasAttribute('data-cds-ghost'));
	t('not the small undocked style', !ui.exportBtn.classList.contains('cc-exportBtn'));
	t('icon is Claude\'s 18px', ui.exportIcon.attrs.width === '18' && ui.exportIcon.attrs.height === '18');
	t('borrows the paint layer for hover', ui.exportBtn.children[0].className === 'absolute inset-0 paint');
	t('no colour of its own: the borrowed classes supply it', !ui.exportBtn.style.color && !ui.exportBtn.classList.contains('cc-exportBtn'));
	t('docked button never reads as its own model', ui._actionsTarget().ref === ref);
}

section('shows only with a conversation and its setting');
{
	const { ui } = setup();
	ui.attachHeader();
	t('hidden until there is something to export', ui.exportBtn.classList.contains('cc-hidden'));
	ui.setConversationMetrics({ totalTokens: 42, cachedUntil: Date.now() + 180000 });
	t('shown once a conversation is counted', !ui.exportBtn.classList.contains('cc-hidden'));
	t('and not also in the header', !ui.headerContainer.children.includes(ui.exportBtn));
	ui.applySettings({ exportButton: false });
	t('hidden by its setting', ui.exportBtn.classList.contains('cc-hidden'));
	ui.applySettings({ exportButton: true });
	t('back with it', !ui.exportBtn.classList.contains('cc-hidden'));
}

section('follows the group as Claude moves things');
{
	const { host, ref, ui } = setup();
	ui.attachHeader();
	t('in place: nothing to do', ui._exportStale() === false);
	host.children = [ref, ui.exportBtn];
	ui.attachHeader();
	t('knocked behind the icon: put back in front', host.children[0] === ui.exportBtn);
	const before = host.children.slice();
	ui.attachHeader();
	t('already in place: DOM left alone', host.children.every((c, i) => c === before[i]));

	ui.exportBtn.remove();
	t('removed by a re-render: noticed', ui._exportStale() === true);
	ui.attachHeader();
	t('and restored', host.children[0] === ui.exportBtn);
}

section('falls back to the header when there is no icon to copy');
{
	const { host, ref, ui } = setup();
	ui.setConversationMetrics({ totalTokens: 42, cachedUntil: Date.now() + 180000 });
	ui.attachHeader();
	t('docked first', ui.exportDocked);
	ref.remove();
	t('the icon going away is noticed', ui._exportStale() === true);
	ui.attachHeader();
	t('undocked', ui.exportDocked === false && !host.children.includes(ui.exportBtn));
	ui.exportHoldUntil = Date.now() - 1; // no group came back within the grace
	ui.tick();
	t('back in the header', ui.headerContainer.children.includes(ui.exportBtn));
	t('with its original look', ui.exportBtn.classList.contains('cc-exportBtn') && !ui.exportBtn.classList.contains('h-control'));
	t('design-system attributes removed', !ui.exportBtn.hasAttribute('data-cds'));
	t('icon back to 11px', ui.exportIcon.attrs.width === '11');
	t('exactly once, in a group of one', ui.exportBtn.parentElement === ui.headerContainer);
}

section('undocking does not leave the button hidden');
{
	// Docked with nothing to export yet, the button is hidden on its own. Back in
	// the header the container decides, so the hide must not survive the move.
	const { ref, ui } = setup();
	ui.attachHeader();
	t('docked and hidden: no conversation yet', ui.exportDocked && ui.exportBtn.classList.contains('cc-hidden'));
	ref.remove();
	ui.attachHeader();
	t('undocked', ui.exportDocked === false);
	ui.setConversationMetrics({ totalTokens: 42, cachedUntil: Date.now() + 180000 });
	ui.exportHoldUntil = Date.now() - 1; // the grace after a group goes has passed
	ui.tick();
	t('in the header once there is a conversation', ui.headerContainer.children.includes(ui.exportBtn));
	t('and actually visible', !ui.exportBtn.classList.contains('cc-hidden'));
}

section('no flash in the old place while the page is still drawing');
{
	// The action group is drawn after the header. Until it is, the button used to
	// show beside the counter and then jump to the top right.
	const { ctx, host, ref, ui } = setup();
	ctx.document.querySelector = () => null; // no group yet
	ui.setConversationMetrics({ totalTokens: 42, cachedUntil: Date.now() + 180000 });
	t('not in the header at first', !ui.headerContainer.children.includes(ui.exportBtn));
	t('and not in the page at all', ui.exportBtn.parentElement === undefined || ui.exportBtn.parentElement === null);

	ui.tick();
	t('still held back inside the grace period', !ui.headerContainer.children.includes(ui.exportBtn));

	ctx.document.querySelector = (sel) => (sel === ctx.ClaudeCounter.DOM.ACTIONS_HOST ? host : null);
	ui.attachHeader();
	t('the group arrives: it goes straight to its place', ui.exportDocked && host.children[0] === ui.exportBtn);
	t('never having been in the header', !ui.headerContainer.children.includes(ui.exportBtn));
	void ref;
}

section('and the header is the fallback once no group has come');
{
	const { ctx, ui } = setup();
	ctx.document.querySelector = () => null;
	ui.setConversationMetrics({ totalTokens: 42, cachedUntil: Date.now() + 180000 });
	ui.exportHoldUntil = Date.now() - 1;
	ui.tick();
	t('after the grace period it settles beside the counter', ui.headerContainer.children.includes(ui.exportBtn));

	const u = setup();
	u.ctx.document.querySelector = () => null;
	u.ui.setConversationMetrics({ totalTokens: 42, cachedUntil: Date.now() + 180000 });
	u.ui.attachHeader();
	t('a group that never existed is not a reason to wait forever', u.ui.exportDocked === false);
}

section('a chat opened long after load is held back too');
{
	const { ctx, ui } = setup();
	ctx.document.querySelector = () => null;
	ui.setConversationMetrics({ totalTokens: 42, cachedUntil: Date.now() + 180000 });
	ui.exportHoldUntil = Date.now() - 1;
	ui.tick();
	t('settled in the header once no group came', ui.headerContainer.children.includes(ui.exportBtn));
	ui.exportBtn.remove(); // Claude redrew the header and took it with it
	ui.holdExport();
	ui.setConversationMetrics({ totalTokens: 43, cachedUntil: Date.now() + 180000 });
	t('after a navigation it is held again, so it never flashes there', !ui.headerContainer.children.includes(ui.exportBtn));
	ui.exportHoldUntil = Date.now() - 1;
	ui.tick();
	t('and it settles if no group arrives', ui.headerContainer.children.includes(ui.exportBtn));
}

section('a group that goes away for a moment does not flash the button');
{
	const { ref, ui } = setup();
	ui.setConversationMetrics({ totalTokens: 42, cachedUntil: Date.now() + 180000 });
	ui.attachHeader();
	t('docked first', ui.exportDocked);
	ref.remove();
	ui.attachHeader();
	t('group gone: undocked', !ui.exportDocked);
	t('but not shown in the header at once', !ui.headerContainer.children.includes(ui.exportBtn));
}

section('an empty conversation shows no count');
{
	const { ui } = setup();
	ui.setConversationMetrics({ totalTokens: 0, cachedUntil: null });
	t('no "0 tokens"', ui.lengthDisplay.textContent === '' && ui.headerContainer.children.length === 0);
	ui.setConversationMetrics({ totalTokens: 5, cachedUntil: null });
	t('and the count appears once there is one', /5 tokens/.test(ui.lengthDisplay.textContent));
}

section('with an artifact panel open: beside the pop-out icon');
{
	// Seen on a real page (2026-10-08): Claude keeps the action group but hides it
	// and leaves only a Share button in it, which is not an icon button, so there
	// is nothing to copy. The header's own pop-out icon is still there.
	const { ctx, CC, doc } = setup();
	const share = doc.createElement('button');
	share.setAttribute('data-cds', 'Button');
	share.setAttribute('data-testid', 'wiggle-controls-actions-share');
	const group = doc.createElement('div');
	group.appendChild(share);
	group.querySelectorAll = () => []; // no icon-only button in it
	const row = doc.createElement('div');
	const popOut = doc.createElement('button');
	for (const [k, v] of [['data-cds', 'Button'], ['data-cds-icon-only', ''], ['data-cds-ghost', ''], ['data-size', 'sm']]) popOut.setAttribute(k, v);
	popOut.className = 'cds-reset group/btn h-control aspect-square w-control';
	const paint = doc.createElement('span');
	paint.className = 'paint';
	popOut.appendChild(paint);
	row.appendChild(group);
	row.appendChild(popOut);
	doc.querySelector = (sel) => (sel === CC.DOM.ACTIONS_HOST ? group : sel === CC.DOM.POP_OUT_BUTTON ? popOut : null);
	const ui = new CC.ui.CounterUI();
	ui.initialize();
	ui.setConversationMetrics({ totalTokens: 42, cachedUntil: Date.now() + 180000 });

	ui.attachHeader();
	t('docked', ui.exportDocked === true);
	t('right before the pop-out icon, in its row', ui.exportBtn.parentElement === row && ui.exportBtn.nextElementSibling === popOut);
	t('not inside the hidden group', !group.children.includes(ui.exportBtn));
	t('wears the pop-out icon\'s look', ['cds-reset', 'h-control', 'w-control'].every((c) => ui.exportBtn.classList.contains(c)) && ui.exportBtn.getAttribute('data-cds') === 'Button');
	t('never in the header beside the counter', !ui.headerContainer.children.includes(ui.exportBtn));
	t('and reported as such', ui.getDiagnostics().exportAt === 'popout');

	const before = row.children.slice();
	ui.attachHeader();
	t('already in place: left alone', row.children.every((c, i) => c === before[i]) && !ui._exportStale());

	ui.exportBtn.remove();
	t('removed by a re-render: noticed', ui._exportStale() === true);
	ui.attachHeader();
	t('and put back', ui.exportBtn.nextElementSibling === popOut && ui.exportBtn.parentElement === row);

	popOut.remove();
	doc.querySelector = (sel) => (sel === CC.DOM.ACTIONS_HOST ? group : null);
	t('the pop-out icon going away is noticed', ui._exportStale() === true);
	void ctx;
}

section('a settled header button stays through redraws');
{
	const { ctx, ui } = setup();
	ctx.document.querySelector = () => null;
	ui.setConversationMetrics({ totalTokens: 42, cachedUntil: Date.now() + 180000 });
	ui.exportHoldUntil = Date.now() - 1;
	ui.tick();
	t('settled in the header', ui.headerContainer.children.includes(ui.exportBtn));
	ui.holdExport(); // a navigation
	ui.setConversationMetrics({ totalTokens: 43, cachedUntil: Date.now() + 180000 });
	t('the next redraw does not take it away', ui.headerContainer.children.includes(ui.exportBtn));
}

section('moving between the two docking spots re-borrows the look');
{
	const { ctx, CC, doc, host, ref, ui } = setup();
	ui.setConversationMetrics({ totalTokens: 42, cachedUntil: Date.now() + 180000 });
	ui.attachHeader();
	t('docked in the group with its classes', ui.exportBtn.classList.contains('w-control'));

	const row = doc.createElement('div');
	const popOut = doc.createElement('button');
	for (const [k, v] of [['data-cds', 'Button'], ['data-cds-icon-only', '']]) popOut.setAttribute(k, v);
	popOut.className = 'cds-reset pop-out-look';
	row.appendChild(popOut);
	ref.remove();
	host.querySelectorAll = () => [];
	doc.querySelector = (sel) => (sel === CC.DOM.ACTIONS_HOST ? host : sel === CC.DOM.POP_OUT_BUTTON ? popOut : null);
	ui.attachHeader();
	t('now beside the pop-out icon', ui.exportBtn.nextElementSibling === popOut);
	t('wearing its classes, not the group icon\'s', ui.exportBtn.classList.contains('pop-out-look') && !ui.exportBtn.classList.contains('w-control'));
	void ctx;
}

section('only on a conversation');
{
	const { ui } = setup('/new');
	ui.attachHeader();
	t('home page: not docked', ui.exportDocked === false);
}

section('reports where it is');
{
	const { ui } = setup();
	t('header before docking', ui.getDiagnostics().exportAt === 'header');
	ui.attachHeader();
	t('actions once docked', ui.getDiagnostics().exportAt === 'actions');
}

process.exit(report('export-dock') ? 1 : 0);
