// The popup runs in its own document, so these checks are structural: they verify
// the three panels, their controls, and the issue URL the feedback form builds.
const fs = require('fs');
const path = require('path');
const { section, t, report } = require('./harness');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const html = read('src/popup/popup.html');
const js = read('src/popup/popup.js');
const css = read('src/popup/popup.css');

section('three panels, one switcher');
for (const id of ['content', 'settings', 'feedback']) {
	t('panel exists: ' + id, html.includes(`id="${id}"`));
}
t('switcher handles all three', ['usage', 'settings', 'feedback'].every((p) => js.includes(`${p}:`) || js.includes(`'${p}'`)));
t('clicking an open panel returns to usage', js.includes('togglePanel'));

section('action icons');
for (const [id, tip] of [['refresh', 'Refresh'], ['settingsBtn', 'Settings'], ['feedbackBtn', 'Send feedback']]) {
	t(`${id} has hover label "${tip}"`, html.includes(`id="${id}"`) && html.includes(`data-tip="${tip}"`));
}
t('no sluggish native title attributes left', !/<button class="icon"[^>]*title=/.test(html));
t('hover label is styled, not native', css.includes('[data-tip]::after') && css.includes('content: attr(data-tip)'));
t('last icon label hangs left so it cannot clip', css.includes('.icon:last-child[data-tip]::after'));

section('feedback opens a prefilled issue, never posts one');
t('points at the repo', js.includes('github.com/kr1shnasomani/claude-token-counter/issues/new'));
t('no GitHub token anywhere', !/gh[pousr]_[A-Za-z0-9]/.test(js) && !js.includes('Authorization'));
t('does not call the GitHub API', !js.includes('api.github.com'));
t('opens in a new tab with noopener', js.includes("window.open(url, '_blank', 'noopener')"));
t('title and body are encoded', js.includes('encodeURIComponent'));
t('send is disabled until something is typed', js.includes('send.disabled = !text.value.trim()'));

section('the report says what it includes');
t('note is shown to the user', html.includes('id="feedbackNote"') && js.includes('prefilled issue on GitHub'));
for (const fact of ['Extension:', 'Browser:', 'Plan:', 'Claude UI:']) {
	t('reports ' + fact, js.includes(fact));
}
// Reported in every bug report, so the three anchoring tiers must stay
// distinguishable - anchoring is the least-tested, most breakage-prone code here
// and "which tier matched" is the first thing worth knowing.
const uiSrc = read('src/content/ui.js');
t('UI variant names the tier that matched', ["'shape'", "'cds'", "'class'"].every((v) => uiSrc.includes(v)));
t('and carried in the snapshot', read('src/content/main.js').includes('uiVariant: CC.uiVariant'));

section('refresh does not fake freshness');
// On plans whose /usage returns empty windows, refresh cannot learn anything.
// Moving the timestamp forward anyway would present an old reading as current.
t('timestamp only moves when a window came back', js.includes('if (five || seven) {') && js.includes('current.updatedAt = Date.now();'));
t('and says so instead', js.includes('does not report usage on demand'));
t('existing values are kept, not blanked', js.includes("five || current?.five_hour || null"));

section('plan labels are defined once, in two places that must agree');
// The popup cannot import from the content script, so PLAN_LABELS exists twice.
// A mismatch would have the page and the popup disagree about the plan.
const labelsIn = (src) => {
	const body = /PLAN_LABELS = \[(.*?)\];/s.exec(src);
	return body ? [...body[1].matchAll(/\['(\w+)', '(\w+)'\]/g)].map((m) => m[1] + '=' + m[2]) : null;
};
const fromMain = labelsIn(read('src/content/main.js'));
const fromPopup = labelsIn(js);
t('both copies exist', Array.isArray(fromMain) && Array.isArray(fromPopup));
t('and are identical', JSON.stringify(fromMain) === JSON.stringify(fromPopup), String(fromMain) + ' vs ' + String(fromPopup));
t('unrecognised capabilities fall back to FREE', js.includes("match ? match[1] : 'FREE'"));

// A real Team org reports exactly ["raven", "chat"], so the capability list cannot
// separate Team from Enterprise - `raven_type` on the org object does. `claude_team`
// sat in PLAN_LABELS for three releases and never matched anything.
const ravenIn = (src) => {
	const body = /RAVEN_TYPES = \[(.*?)\];/s.exec(src);
	return body ? [...body[1].matchAll(/\['(\w+)', '(\w+)'\]/g)].map((m) => m[1] + '=' + m[2]) : null;
};
const ravenMain = ravenIn(read('src/content/main.js'));
const ravenPopup = ravenIn(js);
t('the org tier is read from raven_type', Array.isArray(ravenPopup) && ravenPopup.includes('team=TEAM'));
t('and both copies agree', JSON.stringify(ravenMain) === JSON.stringify(ravenPopup), String(ravenMain) + ' vs ' + String(ravenPopup));
t('no copy still claims a claude_team capability', !read('src/content/main.js').includes("['claude_team'") && !js.includes("['claude_team'"));
t('an org tier with no name is not reported as FREE', js.includes("raven ? raven[1] : 'TEAM'"));

section('the heading survives every plan name');
// ENTERPRISE wrapped onto a second line and pushed the bars down. The heading was
// shortened and pinned to one line rather than mislabelling the plan.
t('heading is the short form', html.includes('Usage limits<span id="plan">') && !html.includes('Plan usage limits'));
t('panel title matches the markup', js.includes("title: 'Usage limits'"));
t('heading cannot wrap', /\.eyebrow \{[^}]*white-space: nowrap/s.test(css));
t('long names ellipsize rather than overflow', /\.eyebrow \{[^}]*text-overflow: ellipsis/s.test(css));
t('and can actually shrink', /\.eyebrow \{[^}]*min-width: 0/s.test(css));

section('a window with no data is hidden, not shown blank');
// Free tier reports no windows until the first message of a session. The session
// row used to render regardless, giving a bare "Hourly limit" over an empty bar.
t('session row can be hidden', html.includes('id="sessionRow"'));
t('session visibility follows its data', js.includes("getElementById('sessionRow').hidden = !hasSession"));
t('weekly visibility follows its data', js.includes("getElementById('weeklyRow').hidden = !hasWeekly"));
t('neither window means the empty state', js.includes('if (!hasSession && !hasWeekly)'));
t('renderWindow reports whether it drew anything', js.includes('const hasSession = renderWindow('));

section('bars change colour at the same thresholds as the page');
// A limit should look equally urgent on either surface. The page uses 75% and
// 90%; the popup was left plain blue, which is worst exactly when it matters.
t('caution below 90', js.includes("toggle('caution', pct >= 75 && pct < 90)"));
t('warn at 90 and above', js.includes("toggle('warn', pct >= 90)"));
t('thresholds match ui.js', read('src/content/ui.js').includes("'cc-caution', width >= 75 && width < 90") &&
	read('src/content/ui.js').includes("'cc-warn', width >= 90"));
t('colours match CC.COLORS', css.toLowerCase().includes('#f0b544') && css.toLowerCase().includes('#ce2029'));
const constants = read('src/content/constants.js').toLowerCase();
t('amber is the same value the page uses', constants.includes('#f0b544'));
t('red is the same value the page uses', constants.includes('#ce2029'));
t('defined in both light and dark', (css.match(/--fill-caution:/g) || []).length === 2);
t('a stale window drops its colour', js.includes("classList.remove('caution', 'warn')"));

section('browser is identified, not guessed from the user agent');
// Brave reports itself as Chrome on purpose; only navigator.brave gives it away.
t('checks navigator.brave first', js.includes('navigator.brave') && js.includes('isBrave()'));
for (const b of ['Brave', 'Edge', 'Opera', 'Vivaldi', 'Firefox', 'Chrome', 'Safari']) {
	t('detects ' + b, js.includes(`'${b}'`));
}
t('reports a readable name, not the raw agent', !js.includes('${navigator.userAgent}'));

section('the draft survives the popup closing');
t('draft has its own key', js.includes("DRAFT_KEY = 'cc:feedbackDraft'"));
t('restored on open', js.includes('storageGet(storage, DRAFT_KEY)'));
t('saved as you type, debounced', js.includes('saveTimer') && js.includes('storage.set({ [DRAFT_KEY]: text.value })'));
t('cleared only once the report is sent', js.includes('storage.remove'));
t('does not clobber text already in the box', js.includes('&& !text.value'));

section('no extra permissions were needed');
const manifest = JSON.parse(read('manifest.json'));
t('permissions unchanged', JSON.stringify(manifest.permissions) === '["storage"]');
t('github not in host permissions', JSON.stringify(manifest.optional_host_permissions) === '["https://claude.ai/*"]');

process.exit(report('popup'));
