// A bug report used to say "Plan: unknown" for every free account: the plan was
// stored only alongside a usage reading, and free accounts report no usage until
// a message is sent. The plan now travels with the diagnostics, which are
// published whatever the account reports.
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const { loadWith, fakeStorage, section, t, report } = require('./harness');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ORG = 'org-123';
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

/** Boot the whole content script against a stubbed bridge; `orgs` answers requestOrgs. */
async function boot(orgs, { cookie = true } = {}) {
	const store = fakeStorage();
	// No chrome.runtime: with one, the shim never fires the bridge script's onload
	// and every request waits on it forever.
	const chrome = { storage: store.storage };
	const intervals = [];
	const ctx = loadWith({ chrome, setInterval: (fn) => { intervals.push(fn); return 0; } },
		'src/content/constants.js', 'src/content/tokens.js', 'src/content/ui.js', 'src/content/bridge-client.js');
	const CC = ctx.ClaudeCounter;
	if (cookie) ctx.document.cookie = `lastActiveOrg=${ORG}`;
	const requests = { orgs: 0 };
	CC.bridge.requestOrgs = async () => { requests.orgs += 1; return orgs(requests.orgs); };
	CC.bridge.requestUsage = async () => ({ five_hour: null, seven_day: null });
	CC.bridge.requestConversation = async () => null;
	vm.runInContext(read('src/content/main.js'), ctx);
	await sleep(10);
	const tick = async () => { intervals.forEach((fn) => fn()); await sleep(10); };
	return { store: store._store, tick, requests };
}

(async () => {
	section('the plan reaches the diagnostics without any usage reading');
	for (const [label, capabilities, extra, want] of [
		['free', ['chat'], {}, 'FREE'],
		['pro', ['chat', 'claude_pro'], {}, 'PRO'],
		['max', ['chat', 'claude_max'], {}, 'MAX'],
		['team', ['chat', 'raven'], { raven_type: 'team' }, 'TEAM']
	]) {
		const { store, tick } = await boot(() => [{ uuid: ORG, capabilities, ...extra }]);
		await tick();
		t(label + ': plan is ' + want, store['cc:diag']?.plan === want, JSON.stringify(store['cc:diag']));
		t('  and no usage snapshot was needed', store['cc:usageSnapshot'] === undefined);
	}

	section('another org in the list is not mistaken for this one');
	{
		const { store, tick } = await boot(() => [
			{ uuid: 'someone-else', capabilities: ['claude_max'] },
			{ uuid: ORG, capabilities: ['chat'] }
		]);
		await tick();
		t('matches by uuid', store['cc:diag']?.plan === 'FREE');
	}

	section('a failed lookup is retried, and not forever');
	{
		let fail = true;
		const { store, tick, requests } = await boot(() => {
			if (fail) throw new Error('network');
			return [{ uuid: ORG, capabilities: ['claude_pro'] }];
		});
		await tick();
		t('first lookup failed: published without a plan, not as a guess', store['cc:diag'] && store['cc:diag'].plan === null);
		fail = false;
		for (let i = 0; i < 5; i++) await tick();
		t('a later tick finds it', store['cc:diag']?.plan === 'PRO');
		t('and stops asking once it has it', requests.orgs === 2, 'requests: ' + requests.orgs);
	}
	{
		const { tick, requests } = await boot(() => { throw new Error('down'); });
		for (let i = 0; i < 12; i++) await tick();
		t('a dead endpoint is tried three times, not on every tick', requests.orgs === 3, 'requests: ' + requests.orgs);
	}

	section('no org id yet: nothing is requested, nothing is guessed');
	{
		const { store, tick, requests } = await boot(() => [{ uuid: ORG, capabilities: ['claude_pro'] }], { cookie: false });
		await tick();
		t('no request without an id', requests.orgs === 0);
		t('plan stays null rather than FREE', store['cc:diag']?.plan === null);
	}

	section('the popup reads it, and says when nothing has reported');
	{
		const js = read('src/popup/popup.js');
		t('plan falls back to the diagnostics', js.includes('current?.plan || diag?.plan'));
		t('says when no claude.ai tab has ever reported', js.includes('Seen on claude.ai: no'));
		t('org id is validated before it enters a URL path', js.includes('ID_PATTERN.test(current?.orgId)') && js.includes('ID_PATTERN.test(org?.uuid)'));
		t('reports go to the repo that owns them', js.includes(JSON.parse(read('package.json')).bugs.url + '/new'));
	}

	process.exit(report('plan'));
})();
