// Max, Team and Enterprise accounts have a separate weekly Fable allowance. It
// reaches the popup through the stored snapshot: read from the usage endpoint's
// `limits` list, kept when a reading arrives from the message stream (which has
// no per-model data), and drawn as one bar each.
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const { loadWith, fakeStorage, section, t, report } = require('./harness');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const future = (ms) => new Date(Date.now() + ms).toISOString();
const win = (utilization, ms) => ({ utilization, resets_at: future(ms) });
const fable = (percent) => ({ kind: 'weekly_scoped', percent, resets_at: future(5 * 86400e3), scope: { model: { id: null, display_name: 'Fable' }, surface: null } });

/** The content script, booted against a stored snapshot and a chosen usage endpoint. */
async function boot({ stored, usage }) {
	const store = fakeStorage(stored ? { 'cc:usageSnapshot': stored } : {});
	const ctx = loadWith({
		chrome: { storage: store.storage },
		setup: (x) => { x.document.cookie = 'lastActiveOrg=org-1'; }
	}, 'src/content/constants.js', 'src/content/tokens.js', 'src/content/ui.js', 'src/content/bridge-client.js');
	const CC = ctx.ClaudeCounter;
	CC.bridge.requestOrgs = async () => [];
	CC.bridge.requestConversation = async () => null;
	CC.bridge.requestUsage = usage;
	vm.runInContext(read('src/content/main.js'), ctx);
	await sleep(30);
	return { CC, snapshot: () => store._store['cc:usageSnapshot'] };
}

const sseReading = () => ({ windows: { '5h': { utilization: 0.4, resets_at: Math.floor(Date.now() / 1000) + 3600 }, '7d': { utilization: 0.6, resets_at: Math.floor(Date.now() / 1000) + 86400 } } });

(async () => {
	section('the usage endpoint\'s Fable limit is stored for the popup');
	{
		const { snapshot } = await boot({
			usage: async () => ({ five_hour: win(26, 3600e3), seven_day: win(48, 86400e3), limits: [{ kind: 'session', percent: 26 }, fable(12)] })
		});
		const s = snapshot();
		t('stored as scoped', s?.scoped?.length === 1 && s.scoped[0].label === 'Fable' && s.scoped[0].utilization === 12, JSON.stringify(s?.scoped));
	}

	section('a reading from the message stream does not wipe it');
	{
		const { CC, snapshot } = await boot({
			usage: async () => ({ five_hour: win(26, 3600e3), seven_day: win(48, 86400e3), limits: [fable(12)] })
		});
		CC.bridge._emit('cc:message_limit', sseReading());
		await sleep(30);
		t('the stream reading was stored', Math.round(snapshot().five_hour.utilization) === 40);
		t('and Fable is still there', snapshot().scoped?.[0]?.label === 'Fable');
	}

	section('nor does one that arrives before the endpoint answers');
	{
		const stored = { updatedAt: Date.now(), orgId: 'org-1', plan: 'MAX', five_hour: win(10, 3600e3), seven_day: win(20, 86400e3), scoped: [{ label: 'Fable', ...win(33, 5 * 86400e3) }] };
		const { CC, snapshot } = await boot({ stored, usage: () => new Promise(() => {}) });
		CC.bridge._emit('cc:message_limit', sseReading());
		await sleep(30);
		t('stored Fable survives the first stream reading', snapshot().scoped?.[0]?.label === 'Fable' && snapshot().scoped[0].utilization === 33, JSON.stringify(snapshot().scoped));
	}

	section('an account that lost the limit loses the bar');
	{
		const stored = { updatedAt: Date.now(), orgId: 'org-1', plan: 'MAX', five_hour: win(10, 3600e3), seven_day: win(20, 86400e3), scoped: [{ label: 'Fable', ...win(33, 5 * 86400e3) }] };
		const { snapshot } = await boot({ stored, usage: async () => ({ five_hour: win(26, 3600e3), seven_day: win(48, 86400e3), limits: [{ kind: 'session', percent: 26 }] }) });
		t('a limits list without one empties it', snapshot().scoped.length === 0);
	}

	section('the popup draws one bar per limit');
	{
		const store = fakeStorage({
			'cc:usageSnapshot': {
				updatedAt: Date.now(), plan: 'MAX', five_hour: win(26, 3600e3), seven_day: win(48, 86400e3),
				scoped: [{ label: 'Fable', ...win(92, 5 * 86400e3) }, { label: 'Other', ...win(10, 86400e3) }]
			}
		});
		const els = {};
		const ctx = loadWith({
			chrome: { storage: store.storage },
			setup: (x) => {
				x.document.getElementById = (id) => (els[id] = els[id] || Object.assign(x.document.createElement('div'), { value: '' }));
				x.document.querySelectorAll = () => [];
			}
		}, 'src/content/constants.js');
		vm.runInContext(read('src/popup/popup.js'), ctx);
		await sleep(30);
		const rows = els.scopedRows.children;
		const label = (r) => r.children[0].children[0].textContent;
		const value = (r) => r.children[0].children[1].textContent;
		const fill = (r) => r.children[1].children[0];
		t('two rows', rows.length === 2);
		t('named for the model', label(rows[0]) === 'Fable weekly limit' && label(rows[1]) === 'Other weekly limit');
		t('with its percentage', /^92%/.test(value(rows[0])));
		t('filled to it, and red past 90%', fill(rows[0]).style.width === '92%' && fill(rows[0]).classList.contains('warn'));
		t('the ordinary bars are unaffected', /^26%/.test(els.sessionValue.textContent) && /^48%/.test(els.weeklyValue.textContent));
	}

	{
		const store = fakeStorage({ 'cc:usageSnapshot': { updatedAt: Date.now(), plan: 'PRO', five_hour: win(26, 3600e3), seven_day: win(48, 86400e3) } });
		const els = {};
		const ctx = loadWith({
			chrome: { storage: store.storage },
			setup: (x) => { x.document.getElementById = (id) => (els[id] = els[id] || Object.assign(x.document.createElement('div'), { value: '' })); x.document.querySelectorAll = () => []; }
		}, 'src/content/constants.js');
		vm.runInContext(read('src/popup/popup.js'), ctx);
		await sleep(30);
		t('an account with none gets none', els.scopedRows.children.length === 0);
	}

	section('the popup\'s own refresh keeps or drops the bar the same way');
	for (const [label, response, want] of [
		['a response that lists limits without one drops it', { five_hour: win(30, 3600e3), seven_day: win(50, 86400e3), limits: [{ kind: 'session', percent: 30 }] }, 0],
		['a response with no limits list leaves what is stored', { five_hour: win(30, 3600e3), seven_day: win(50, 86400e3) }, 1],
		['a response that lists one updates it', { five_hour: win(30, 3600e3), seven_day: win(50, 86400e3), limits: [fable(77)] }, 1]
	]) {
		const store = fakeStorage({
			'cc:usageSnapshot': { updatedAt: Date.now(), orgId: 'org-1', plan: 'MAX', five_hour: win(10, 3600e3), seven_day: win(20, 86400e3), scoped: [{ label: 'Fable', ...win(33, 5 * 86400e3) }] }
		});
		store.permissions = { request: async () => true };
		const els = {};
		const ctx = loadWith({
			chrome: { storage: store.storage, permissions: store.permissions },
			setup: (x) => {
				x.document.getElementById = (id) => (els[id] = els[id] || Object.assign(x.document.createElement('div'), { value: '' }));
				x.document.querySelectorAll = () => [];
				x.fetch = async () => ({ ok: true, status: 200, json: async () => response });
			}
		}, 'src/content/constants.js');
		vm.runInContext(read('src/popup/popup.js'), ctx);
		await sleep(30);
		els.refresh.fire('click');
		await sleep(60);
		const kept = store._store['cc:usageSnapshot'].scoped;
		t(label, kept.length === want && (want === 0 || kept[0].utilization === (response.limits ? 77 : 33)), JSON.stringify(kept));
	}

	process.exit(report('scoped-limits'));
})();
