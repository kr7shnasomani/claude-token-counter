// Every popup toggle must actually remove its element from the page.
const { load, loadWith, fakeStorage, section, t, report } = require('./harness');

const future = new Date(Date.now() + 3e6).toISOString();
const past = new Date(Date.now() - 3e6).toISOString();

/**
 * Boot a whole content script against a storage holding `snapshot`, and report
 * what the seed made of it. `seedFromSnapshot()` runs as main.js evaluates, so
 * the storage has to exist before the file does.
 */
async function seedWith(snapshot) {
	const chrome = fakeStorage(snapshot ? { 'cc:usageSnapshot': snapshot } : {});
	const c = loadWith({ chrome },
		'src/content/constants.js', 'src/content/tokens.js', 'src/content/ui.js',
		'src/content/bridge-client.js', 'src/content/main.js');
	// The seed fires during evaluation; await the same call to join it.
	await c.ClaudeCounter.usage.seedFromSnapshot();
	return c.ClaudeCounter.usage.readState();
}

const ctx = load('src/content/constants.js', 'src/content/ui.js');
const ui = new ctx.ClaudeCounter.ui.CounterUI();
ui.initialize();
ui.setConversationMetrics({ totalTokens: 42, cachedUntil: Date.now() + 180000 });
ui.setUsage({
	five_hour: { utilization: 20, resets_at: new Date(Date.now() + 3e6).toISOString() },
	seven_day: { utilization: 40, resets_at: new Date(Date.now() + 6e8).toISOString() }
});

const header = () => ui.headerContainer.textContent;
const inHeader = (el) => ui.headerContainer.children.includes(el) ||
	ui.headerDisplay.children.includes(el);
const hidden = (el) => !!el && el.classList.contains('cc-hidden');

section('defaults show everything');
t('token counter', header().includes('Token Counter'));
t('cache timer', header().includes('Cached Context Timer'));
t('export button', inHeader(ui.exportBtn));
t('session bar', !hidden(ui.sessionGroup));
t('weekly bar', !hidden(ui.weeklyGroup));
t('usage refresh button', !hidden(ui.refreshBtn));

section('each toggle removes exactly its own element');
ui.applySettings({ tokenCounter: false });
t('token counter off', !header().includes('Token Counter'));
t('  cache timer survives', header().includes('Cached Context Timer'));
t('  no stray separator', !header().includes('|'));

ui.applySettings({ cacheTimer: false });
t('cache timer off', !header().includes('Cached Context Timer'));
t('  token counter survives', header().includes('Token Counter'));

ui.applySettings({ exportButton: false });
t('export button off', !inHeader(ui.exportBtn));

ui.applySettings({ sessionBar: false });
t('session bar off', hidden(ui.sessionGroup));
t('  weekly bar survives', !hidden(ui.weeklyGroup));
t('  row still visible', !hidden(ui.usageLine));

ui.applySettings({ weeklyBar: false });
t('weekly bar off', hidden(ui.weeklyGroup));
t('  session bar survives', !hidden(ui.sessionGroup));

ui.applySettings({ usageRefresh: false });
t('usage refresh button off', hidden(ui.refreshBtn));
t('  bars survive', !hidden(ui.sessionGroup) && !hidden(ui.weeklyGroup));
t('  row still visible', !hidden(ui.usageLine));

section('combinations');
ui.applySettings({ sessionBar: false, weeklyBar: false });
t('both bars off hides the whole row', hidden(ui.usageLine));

ui.applySettings({ tokenCounter: false, cacheTimer: false, exportButton: false });
t('everything off leaves an empty header', ui.headerContainer.children.length === 0);

ui.applySettings({});
t('restoring defaults brings it all back',
	header().includes('Token Counter') && header().includes('Cached Context Timer') &&
	inHeader(ui.exportBtn) && !hidden(ui.usageLine) && !hidden(ui.sessionGroup));

section('settings never reveal an empty row');
// applySettings runs at page load, before any usage has arrived.
const fresh = new ctx.ClaudeCounter.ui.CounterUI();
fresh.initialize();
t('hidden before any data', hidden(fresh.usageLine));
fresh.applySettings({});
t('still hidden after settings load', hidden(fresh.usageLine));
fresh.applySettings({ sessionBar: true, weeklyBar: true });
t('still hidden with every bar switched on', hidden(fresh.usageLine));

section('a window with no reading keeps its slot, marked unknown');
// Discarding a still-valid weekly figure because the five-hour one had rolled
// over left free users with nothing for hours at a time. The valid figure is a
// floor, not stale data: usage only advances when a message is sent. Keep it,
// and mark the missing one rather than dropping a bar and leaving one alone.
const later = (ms) => new Date(Date.now() + ms).toISOString();
const only = (usage) => {
	const u = new ctx.ClaudeCounter.ui.CounterUI();
	u.initialize();
	u.applySettings({});
	u.setUsage(usage);
	return u;
};

let one = only({ five_hour: null, seven_day: { utilization: 29, resets_at: later(3 * 86400e3) } });
t('weekly figure is kept', !hidden(one.weeklyGroup) && one.weeklyUsageSpan.textContent.includes('29%'));
t('hourly slot stays, marked unknown', !hidden(one.sessionGroup) && one.sessionUsageSpan.textContent === 'Hourly: \u2014');
t('  no lone bar', !hidden(one.usageLine));

one = only({ five_hour: { utilization: 2, resets_at: later(5 * 3600e3) }, seven_day: null });
t('the mirror case works too', one.weeklyUsageSpan.textContent === 'Weekly: \u2014' && one.sessionUsageSpan.textContent.includes('2%'));

one = only({ five_hour: { utilization: 2, resets_at: later(5 * 3600e3) },
	seven_day: { utilization: 29, resets_at: later(3 * 86400e3) } });
t('both present: no dashes', !one.usageLine.textContent.includes('\u2014'));

section('an account with no usage says so instead of looking broken');
// Free plans publish no usage windows until a message has been sent. A blank
// composer reads as a broken extension, so the row explains itself instead.
const blank = new ctx.ClaudeCounter.ui.CounterUI();
blank.initialize();
blank.applySettings({});
t('nothing known yet: row stays hidden', hidden(blank.usageLine));

blank.markUsageUnavailable();
t('API reports none: row appears', !hidden(blank.usageLine));
t('  with the hint', !hidden(blank.usageHint));
t('  and no empty bars', hidden(blank.sessionGroup) && hidden(blank.weeklyGroup));

blank.setUsage({
	five_hour: { utilization: 2, resets_at: new Date(Date.now() + 5 * 3600e3).toISOString() },
	seven_day: { utilization: 0, resets_at: new Date(Date.now() + 6 * 86400e3).toISOString() }
});
t('real data replaces the hint', hidden(blank.usageHint));
t('  and shows both bars', !hidden(blank.sessionGroup) && !hidden(blank.weeklyGroup));

blank.markUsageUnavailable();
t('a later empty response cannot undo it', hidden(blank.usageHint) && !hidden(blank.sessionGroup));

section('settings never invent a figure');
ui.setUsage({ five_hour: { utilization: 10, resets_at: new Date(Date.now() + 3e6).toISOString() }, seven_day: null });
ui.applySettings({ weeklyBar: true });
t('weekly shows a dash rather than a stale figure', ui.weeklyUsageSpan.textContent === 'Weekly: \u2014');

// Async because seedFromSnapshot() is. Everything above is synchronous and has
// already reported by the time this runs.
(async () => {
	section('a stored reading keeps what is still true');
	// These ran against main.js *source text* until the harness could load the
	// file; they are the real behaviour now. A window whose reset has passed is
	// not stale data waiting to be refreshed - there is no active window at all
	// until the next message - so it is dropped. One that has not reset is still
	// correct, because usage only rises when a message is sent: a floor, not a
	// stale figure.
	const live = await seedWith({
		five_hour: { utilization: 12, resets_at: future },
		seven_day: { utilization: 34, resets_at: future }
	});
	t('a live window is seeded onto the row', live.usage?.five_hour?.utilization === 12);
	t('  and marked as a seed, not a reading', live.seeded === true);
	t('  without stamping the freshness clock', live.updatedAt === 0);

	const half = await seedWith({
		five_hour: { utilization: 12, resets_at: past },
		seven_day: { utilization: 34, resets_at: future }
	});
	t('a window whose reset has passed is dropped', half.usage?.five_hour === null);
	t('  while its live partner survives', half.usage?.seven_day?.utilization === 34);

	const dead = await seedWith({
		five_hour: { utilization: 12, resets_at: past },
		seven_day: { utilization: 34, resets_at: past }
	});
	t('nothing is seeded when no window is still live', dead.usage === null);
	t('nothing is seeded from an empty store', (await seedWith(null)).usage === null);
	t('a window with no reset time is not trusted',
		(await seedWith({ five_hour: { utilization: 12 }, seven_day: null })).usage === null);

	process.exit(report('settings'));
})();
