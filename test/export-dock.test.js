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
	ui.createdAt -= ctx.ClaudeCounter.CONST.EXPORT_DOCK_GRACE_MS + 1;
	ui.tick();
	t('after the grace period it settles beside the counter', ui.headerContainer.children.includes(ui.exportBtn));

	const u = setup();
	u.ctx.document.querySelector = () => null;
	u.ui.setConversationMetrics({ totalTokens: 42, cachedUntil: Date.now() + 180000 });
	u.ui.attachHeader();
	t('a group that never existed is not a reason to wait forever', u.ui.exportDocked === false);
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
