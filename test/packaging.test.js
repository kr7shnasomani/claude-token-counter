// A release ships exactly the two extension builds, and the manifest declares only
// files that exist.
const fs = require('fs');
const path = require('path');
const { section, t, report } = require('./harness');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const manifest = JSON.parse(read('manifest.json'));

section('releases carry only the two extension builds');
const release = read('.github/workflows/release.yml');
t('release attaches only the two zips and checksums',
	release.includes('claude-token-counter-chrome-*.zip') &&
	release.includes('claude-token-counter-firefox-*.zip'));

section('manifest still ships every file it declares');
for (const f of [...manifest.content_scripts.flatMap((c) => [...(c.js || []), ...(c.css || [])]), manifest.action.default_popup]) {
	t('exists: ' + f, fs.existsSync(path.join(ROOT, f)));
}
const lock = JSON.parse(read('package-lock.json'));
t('versions agree', manifest.version === JSON.parse(read('package.json')).version);
t('  and the lockfile says the same', lock.version === manifest.version && lock.packages[''].version === manifest.version);

process.exit(report('packaging'));
