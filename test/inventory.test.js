// A guard against features quietly disappearing.
//
// Every other suite tests a behaviour someone thought to write down, which means
// a part with no suite of its own can be deleted and nothing goes red. That is
// exactly how the elapsed-time marker was lost in a release commit and shipped
// missing. This suite asserts the *inventory* instead of the behaviour: what the
// row is made of, and what the rendered tree looks like. Removing a feature is
// still allowed - it just has to be done on purpose, by editing a list or a
// snapshot, where a reviewer can see it.
const fs = require('fs');
const path = require('path');
const { load, section, t, report } = require('./harness');

const ROOT = path.join(__dirname, '..');
const ctx = load('src/content/constants.js', 'src/content/ui.js');
const ui = new ctx.ClaudeCounter.ui.CounterUI();
ui.initialize();
ui.setConversationMetrics({ totalTokens: 1234, cachedUntil: Date.now() + 180000 });
ui.setUsage({
	five_hour: { utilization: 20, resets_at: new Date(Date.now() + 3e6).toISOString() },
	seven_day: { utilization: 40, resets_at: new Date(Date.now() + 6e8).toISOString() }
});

section('every part the row is made of');
// Deleting a line here is the only way to drop a feature. That is the point:
// it turns a silent omission into a visible edit.
const PARTS = [
	'cachedDisplay', 'exportBtn', 'exportMenu', 'headerContainer', 'headerDisplay',
	'lengthDisplay', 'lengthGroup', 'refreshBtn', 'sessionBar', 'sessionBarFill',
	'sessionGroup', 'sessionMarker', 'sessionUsageSpan', 'usageHint', 'usageLine',
	'weeklyBar', 'weeklyBarFill', 'weeklyGroup', 'weeklyMarker', 'weeklyUsageSpan'
];
for (const part of PARTS) t(part, !!ui[part]);

// The list above must stay in step with what the source actually builds, or it
// decays into a list of things that used to matter.
const uiSrc = fs.readFileSync(path.join(ROOT, 'src/content/ui.js'), 'utf8');
const built = [...uiSrc.matchAll(/this\.([a-zA-Z]+) = document\.createElement/g)].map((m) => m[1]);
const unlisted = [...new Set(built)].filter((n) => !PARTS.includes(n)).sort();
t(`no part is built but unlisted${unlisted.length ? ` (${unlisted.join(', ')})` : ''}`, unlisted.length === 0);

section('nothing is built and then dropped on the floor');
// An element can exist as a field and still never reach the page. Both roots are
// walked, because the header and the usage row mount separately.
const reachable = new Set();
const walk = (el) => {
	if (!el || reachable.has(el)) return;
	reachable.add(el);
	(el.children || []).forEach(walk);
};
walk(ui.headerContainer);
walk(ui.usageLine);
// The export menu is mounted on demand, next to the button rather than inside it.
const DETACHED_BY_DESIGN = new Set(['exportMenu']);
for (const part of PARTS) {
	if (DETACHED_BY_DESIGN.has(part)) continue;
	t(`${part} is attached`, reachable.has(ui[part]));
}

section('the rendered structure matches the committed snapshot');
// Catches what no list can: nesting changes, a lost class, an element that stops
// being rendered. Regenerate deliberately with UPDATE_SNAPSHOT=1, and read the
// diff before committing it.
const serialize = (el, depth = 0) => {
	if (!el) return '';
	const cls = el.className ? '.' + el.className.split(/\s+/).filter(Boolean).join('.') : '';
	const line = `${'  '.repeat(depth)}${el.tag}${cls}`;
	return [line, ...(el.children || []).map((c) => serialize(c, depth + 1))].filter(Boolean).join('\n');
};
const snapshot = `# header\n${serialize(ui.headerContainer)}\n\n# usage row\n${serialize(ui.usageLine)}\n`;
const snapPath = path.join(__dirname, 'snapshots', 'ui-structure.txt');

if (process.env.UPDATE_SNAPSHOT) {
	fs.mkdirSync(path.dirname(snapPath), { recursive: true });
	fs.writeFileSync(snapPath, snapshot);
	t('snapshot rewritten (UPDATE_SNAPSHOT set)', true);
} else if (!fs.existsSync(snapPath)) {
	t('snapshot exists - run with UPDATE_SNAPSHOT=1 to create it', false);
} else {
	const expected = fs.readFileSync(snapPath, 'utf8');
	const ok = expected === snapshot;
	t('structure is unchanged', ok);
	if (!ok) {
		const a = expected.split('\n');
		const b = snapshot.split('\n');
		for (let i = 0; i < Math.max(a.length, b.length); i++) {
			if (a[i] !== b[i]) console.log(`      line ${i + 1}:\n        was: ${a[i] ?? '(nothing)'}\n        now: ${b[i] ?? '(nothing)'}`);
		}
	}
}

section('the popup keeps every control it declares');
// The popup is a separate document the harness cannot execute, so its markup is
// snapshotted instead. Every id here is one popup.js queries by name: losing one
// leaves a dead `getElementById` and a control that silently does nothing.
const popupHtml = fs.readFileSync(path.join(ROOT, 'src/popup/popup.html'), 'utf8');
const popupJs = fs.readFileSync(path.join(ROOT, 'src/popup/popup.js'), 'utf8');

const declaredIds = [...popupHtml.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]).sort();
const queriedIds = [...popupJs.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]);
const missing = [...new Set(queriedIds)].filter((id) => !declaredIds.includes(id)).sort();
t(`every id the popup script queries exists in its markup${missing.length ? ` (${missing.join(', ')})` : ''}`, missing.length === 0);
t('the popup declares controls at all', declaredIds.length > 10);

const popupSnapPath = path.join(__dirname, 'snapshots', 'popup-structure.txt');
const popupSnapshot = declaredIds.join('\n') + '\n';
if (process.env.UPDATE_SNAPSHOT) {
	fs.mkdirSync(path.dirname(popupSnapPath), { recursive: true });
	fs.writeFileSync(popupSnapPath, popupSnapshot);
	t('popup snapshot rewritten (UPDATE_SNAPSHOT set)', true);
} else if (!fs.existsSync(popupSnapPath)) {
	t('popup snapshot exists - run with UPDATE_SNAPSHOT=1 to create it', false);
} else {
	const expected = fs.readFileSync(popupSnapPath, 'utf8');
	const ok = expected === popupSnapshot;
	t('popup controls are unchanged', ok);
	if (!ok) {
		const was = new Set(expected.trim().split('\n'));
		const now = new Set(popupSnapshot.trim().split('\n'));
		[...was].filter((x) => !now.has(x)).forEach((x) => console.log(`      removed: #${x}`));
		[...now].filter((x) => !was.has(x)).forEach((x) => console.log(`      added:   #${x}`));
	}
}

section('styles and scripts agree on class names');
// A half-removal - the rule deleted but the class still applied, or the reverse -
// leaves the feature present but silently unstyled.
const css = fs.readFileSync(path.join(ROOT, 'src/styles.css'), 'utf8');
const styled = new Set([...css.matchAll(/\.(cc-[a-zA-Z_-]+)/g)].map((m) => m[1]));
const scripts = ['ui.js', 'main.js', 'export.js', 'bridge-client.js', 'constants.js']
	.map((f) => fs.readFileSync(path.join(ROOT, 'src/content', f), 'utf8')).join('\n');
const applied = new Set([...scripts.matchAll(/'(cc-[a-zA-Z_-]+)'/g)].map((m) => m[1]));
// Ids are not classes and have no rule to find.
const ids = new Set(Object.values(ctx.ClaudeCounter.DOM).filter((v) => typeof v === 'string'));
// Hooks that exist to be found by script, not to be painted.
const UNSTYLED_BY_DESIGN = new Set(['cc-exportIcon', 'cc-cacheTime']);

const unstyled = [...applied].filter((c) => !styled.has(c) && !ids.has(c) && !UNSTYLED_BY_DESIGN.has(c)).sort();
t(`every class the scripts apply has a rule${unstyled.length ? ` (${unstyled.join(', ')})` : ''}`, unstyled.length === 0);

const orphaned = [...styled].filter((c) => !applied.has(c) && !scripts.includes(c)).sort();
t(`no rule is left behind by a deleted feature${orphaned.length ? ` (${orphaned.join(', ')})` : ''}`, orphaned.length === 0);

process.exit(report('inventory'));
