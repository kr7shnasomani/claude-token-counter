// The two routes usage takes into the extension.
//
// Everything on the row - both bars, both countdowns, both markers - is
// downstream of these two functions, and nothing else validates the payloads.
// The SSE route matters most: on free tier the REST endpoint returns null for
// every window, so `message_limit` is the only source there is. A silent change
// to either shape blanks the row for a whole tier of users, which is precisely
// the kind of break that reaches a release unnoticed.
const { load, section, t, report } = require('./harness');

const ctx = load(
	'src/content/constants.js', 'src/content/tokens.js', 'src/content/ui.js',
	'src/content/bridge-client.js', 'src/content/main.js'
);
const { parseUsageFromUsageEndpoint: rest, parseUsageFromMessageLimit: sse } = ctx.ClaudeCounter.usage;

const iso = (s) => new Date(s * 1000).toISOString();

section('REST: /usage reports percentages already');
const r = rest({
	five_hour: { utilization: 16, resets_at: '2026-09-01T12:00:00.000Z' },
	seven_day: { utilization: 57, resets_at: '2026-09-04T18:00:00.000Z' }
});
t('both windows come back', !!r && !!r.five_hour && !!r.seven_day);
t('the percentage is passed through, not rescaled', r.five_hour.utilization === 16);
t('  weekly too', r.seven_day.utilization === 57);
t('the reset timestamp is kept verbatim', r.five_hour.resets_at === '2026-09-01T12:00:00.000Z');

section('SSE: message_limit reports fractions and epoch seconds');
// The two shapes differ in both respects. Conflating them was always going to
// be the failure mode, so it is pinned from both directions.
const s = sse({ windows: { '5h': { utilization: 0.16, resets_at: 1789000000 }, '7d': { utilization: 0.57, resets_at: 1789300000 } } });
t('both windows come back', !!s && !!s.five_hour && !!s.seven_day);
t('a fraction is scaled to a percentage', s.five_hour.utilization === 16);
t('  and not left as 0.16', s.five_hour.utilization !== 0.16);
t('  weekly too', Math.round(s.seven_day.utilization) === 57);
t('epoch seconds become an ISO string', s.five_hour.resets_at === iso(1789000000));
t('  a string the UI can parse', Number.isFinite(Date.parse(s.five_hour.resets_at)));
t('the 5h/7d keys map onto five_hour/seven_day', !!s.five_hour && !!s.seven_day);

section('the two routes agree on the same underlying reading');
const viaRest = rest({ five_hour: { utilization: 42, resets_at: iso(1789000000) }, seven_day: null });
const viaSse = sse({ windows: { '5h': { utilization: 0.42, resets_at: 1789000000 } } });
t('same percentage from either route', viaRest.five_hour.utilization === viaSse.five_hour.utilization);
t('same reset instant from either route', viaRest.five_hour.resets_at === viaSse.five_hour.resets_at);

section('free tier: null windows are absent, not zero');
// Free plans report null for every window over REST. Reading that as 0% would
// paint an empty bar and a confident "0%" - a wrong figure, not a missing one.
const free = rest({ five_hour: null, seven_day: null });
t('an all-null payload yields nothing at all', free === null);
t('a null window is dropped, not zeroed', rest({ five_hour: { utilization: 5, resets_at: null }, seven_day: null }).seven_day === null);
t('SSE with no windows yields nothing', sse({ windows: {} }) === null);

section('one usable window is still worth reporting');
const half = rest({ five_hour: { utilization: 8, resets_at: '2026-09-01T12:00:00.000Z' }, seven_day: null });
t('the good window survives', half.five_hour.utilization === 8);
t('  its partner is null, not invented', half.seven_day === null);
t('the mirror case works too', sse({ windows: { '7d': { utilization: 0.9, resets_at: 1789000000 } } }).five_hour === null);

section('a window with no reset time still reports its figure');
// The bar and the percentage do not depend on the countdown; only the marker
// and the "resets in" text do, and both handle a null of their own accord.
const noReset = rest({ five_hour: { utilization: 30 }, seven_day: null });
t('the utilization is kept', noReset.five_hour.utilization === 30);
t('the missing timestamp is null', noReset.five_hour.resets_at === null);
t('a non-string timestamp is rejected', rest({ five_hour: { utilization: 30, resets_at: 12345 }, seven_day: null }).five_hour.resets_at === null);
t('a non-numeric SSE timestamp is rejected', sse({ windows: { '5h': { utilization: 0.3, resets_at: 'soon' } } }).five_hour.resets_at === null);

section('percentages are clamped to a bar that can draw them');
t('over 100 clamps down', rest({ five_hour: { utilization: 420, resets_at: null }, seven_day: null }).five_hour.utilization === 100);
t('below zero clamps up', rest({ five_hour: { utilization: -5, resets_at: null }, seven_day: null }).five_hour.utilization === 0);
t('an SSE fraction over 1 clamps too', sse({ windows: { '5h': { utilization: 4.2, resets_at: 1789000000 } } }).five_hour.utilization === 100);

section('junk in never becomes a figure out');
for (const [label, bad] of [
	['null', null], ['undefined', undefined], ['a string', 'nope'],
	['a number', 42], ['an array', []], ['an empty object', {}]
]) {
	t(`REST rejects ${label}`, rest(bad) === null);
	t(`SSE rejects ${label}`, sse(bad) === null);
}
t('SSE rejects a payload with no windows key', sse({ other: 1 }) === null);
t('a non-numeric utilization is rejected', rest({ five_hour: { utilization: 'lots', resets_at: null }, seven_day: null }) === null);
t('NaN is rejected', rest({ five_hour: { utilization: NaN, resets_at: null }, seven_day: null }) === null);
t('Infinity is rejected', rest({ five_hour: { utilization: Infinity, resets_at: null }, seven_day: null }) === null);

process.exit(report('usage-parsing'));
