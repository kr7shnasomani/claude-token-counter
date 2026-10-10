// Guards for the properties that keep this extension safe to install. Each of
// these has a specific failure mode; none is decorative.
const fs = require('fs');
const path = require('path');
const { section, t, report } = require('./harness');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SHIPPED = ['src/content/constants.js', 'src/content/bridge-client.js', 'src/content/tokens.js',
	'src/content/export.js', 'src/content/ui.js', 'src/content/main.js',
	'src/injected/bridge.js', 'src/popup/popup.js'];
const code = SHIPPED.map(read).join('\n');
const manifest = JSON.parse(read('manifest.json'));

section('no code execution primitives');
t('no eval', !/\beval\s*\(/.test(code));
t('no new Function', !/new\s+Function\s*\(/.test(code));
t('no innerHTML / outerHTML / insertAdjacentHTML', !/(inner|outer)HTML|insertAdjacentHTML/.test(code));
t('no document.write', !/document\.write/.test(code));
t('no string-bodied timers', !/set(Timeout|Interval)\s*\(\s*['"`]/.test(code));

section('least privilege');
t('storage is the only permission', JSON.stringify(manifest.permissions) === '["storage"]');
t('no install-time host permissions', !manifest.host_permissions);
t('optional host access is claude.ai only', JSON.stringify(manifest.optional_host_permissions) === '["https://claude.ai/*"]');
t('content scripts run on claude.ai only', JSON.stringify(manifest.content_scripts[0].matches) === '["https://claude.ai/*"]');
t('injected bridge exposed to claude.ai only',
	JSON.stringify(manifest.web_accessible_resources[0].matches) === '["https://claude.ai/*"]');
t('nothing is externally connectable', !manifest.externally_connectable);

section('the manifest does not promise more than Firefox can deliver');
// optional_host_permissions landed in Firefox 128. Declaring an older minimum
// ships a refresh button that can never obtain its permission.
const gecko = manifest.browser_specific_settings.gecko;
t('strict_min_version is at least 128',
	parseFloat(gecko.strict_min_version) >= 128, 'declared ' + gecko.strict_min_version);
t('README states the same floor',
	read('README.md').includes('requires Firefox ' + parseInt(gecko.strict_min_version, 10) + ' or later'));

section('message channel is not a broadcast');
const bridge = read('src/injected/bridge.js');
const client = read('src/content/bridge-client.js');
t('bridge never posts to "*"', !/postMessage\([^)]*,\s*['"]\*['"]/.test(bridge));
t('bridge targets its own origin', bridge.includes('TARGET_ORIGIN = window.location.origin'));
t('bridge only accepts same-window messages', bridge.includes('event.source !== window'));
t('client checks the sender origin', client.includes("event.origin !== 'https://claude.ai'"));
t('client targets claude.ai explicitly', client.includes("'https://claude.ai'"));

section('ids cannot walk out of their URL path');
t('ids are pattern-checked', bridge.includes('ID_PATTERN') && bridge.includes('safeId'));
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
for (const bad of ['../../admin', 'x/../account', 'https://evil.com/', 'a?b=c', 'a#b', '', 'a'.repeat(65)]) {
	t('rejects ' + JSON.stringify(bad), !ID_PATTERN.test(bad));
}
t('accepts a real org uuid', ID_PATTERN.test('d3bfd181-30bc-4405-849f-391fe2023072'));

section('no credentials, no third-party endpoints');
t('no hardcoded tokens', !/(gh[pousr]_[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._-]{20,}|api[_-]?key\s*[:=]\s*['"])/i.test(code));
t('no Authorization headers', !/Authorization/i.test(code));
const hosts = [...code.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1]);
const allowed = new Set(['claude.ai', 'github.com', 'www.w3.org']);
t('only expected hosts appear: ' + [...new Set(hosts)].join(', '), hosts.every((h) => allowed.has(h)));
t('no analytics or telemetry', !/analytics|telemetry|sentry|mixpanel|segment\.io|google-analytics/i.test(code));

section('supply chain');
t('runtime ships no dependencies', !JSON.parse(read('package.json')).dependencies);
// Recorded is not enough: a changed file with an unchanged notice must fail here.
const vendorHash = require('crypto').createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'src/vendor/o200k_base.js'))).digest('hex');
t('vendored tokenizer matches its recorded hash', read('THIRD_PARTY_NOTICES.md').includes('SHA-256 of the vendored file: `' + vendorHash + '`'));

section('dependencies cannot execute code on install');
// npm runs preinstall/install/postinstall automatically. Nothing here needs to
// compile or generate anything, so they are switched off everywhere rather than
// trusted not to be abused.
t('.npmrc disables lifecycle scripts', read('.npmrc').includes('ignore-scripts=true'));
for (const wf of ['ci.yml', 'eslint.yml', 'release.yml']) {
	const s = read('.github/workflows/' + wf);
	t(wf + ' installs with --ignore-scripts',
		!/npm ci(?! --ignore-scripts)/.test(s) && s.includes('npm ci --ignore-scripts'));
}
const lock = JSON.parse(read('package-lock.json'));
const pkgs = Object.entries(lock.packages || {}).filter(([k]) => k);
t('every locked package has an integrity hash',
	pkgs.filter(([, v]) => v.resolved).every(([, v]) => Boolean(v.integrity)));
t('every package comes from the public registry',
	pkgs.filter(([, v]) => v.resolved).every(([, v]) => v.resolved.startsWith('https://registry.npmjs.org/')));

section('every action is pinned to a commit');
// A tag can be repointed by whoever owns the action; a commit sha cannot.
for (const wf of fs.readdirSync(path.join(ROOT, '.github/workflows'))) {
	const s = read('.github/workflows/' + wf);
	const uses = [...s.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
	const loose = uses.filter((u) => !/@[0-9a-f]{40}$/.test(u));
	t(wf + ' pins all ' + uses.length + ' actions', loose.length === 0, loose.join(', '));
}

section('what leaves the machine');
const popup = read('src/popup/popup.js');
t('feedback opens a URL, never posts', !popup.includes('api.github.com') && popup.includes('window.open'));
t('feedback carries no conversation content',
	!/conversation|chat_messages|transcript/i.test(popup));
t('export stays local (blob, no upload)',
	read('src/content/export.js').includes('URL.createObjectURL') && !/fetch\(|XMLHttpRequest/.test(read('src/content/export.js')));

process.exit(report('security'));
