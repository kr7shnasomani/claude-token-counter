// The elapsed-time marker on each usage bar: where it sits, and when it refuses
// to sit anywhere. It was lost once in a UI rewrite without anything failing,
// which is what this suite exists to prevent.
const { load, section, t, report } = require('./harness');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const fresh = () => {
	const ctx = load('src/content/constants.js', 'src/content/ui.js');
	const ui = new ctx.ClaudeCounter.ui.CounterUI();
	ui.initialize();
	return ui;
};

const hidden = (el) => !!el && el.classList.contains('cc-hidden');
const left = (el) => parseFloat(el.style.left);
const inAbout = (actual, expected, tolerance = 1) => Math.abs(actual - expected) <= tolerance;
const at = (ms) => new Date(Date.now() + ms).toISOString();

section('the marker exists at all');
const ui = fresh();
t('session bar has a marker', !!ui.sessionMarker);
t('weekly bar has a marker', !!ui.weeklyMarker);
t('  it lives inside its bar', ui.sessionBar.children.includes(ui.sessionMarker));
t('  and carries the marker class', ui.sessionMarker.className.includes('cc-bar__marker'));
t('hidden until there is a reading', hidden(ui.sessionMarker) && hidden(ui.weeklyMarker));

section('it tracks time elapsed, not usage');
// Two thirds through a five-hour window, but only 4% of the quota spent: the
// whole point of the marker is that these two numbers disagree.
ui.setUsage({
	five_hour: { utilization: 4, resets_at: at(5 * HOUR / 3) },
	seven_day: { utilization: 90, resets_at: at(6 * DAY) }
});
t('session marker placed', !hidden(ui.sessionMarker));
t('  at two thirds, not at 4%', inAbout(left(ui.sessionMarker), 66.7));
t('weekly marker placed', !hidden(ui.weeklyMarker));
t('  one day in, not at 90%', inAbout(left(ui.weeklyMarker), 14.3));

section('the ends of a window');
const ends = fresh();
ends.setUsage({
	five_hour: { utilization: 0, resets_at: at(5 * HOUR - 1000) },
	seven_day: { utilization: 0, resets_at: at(1000) }
});
t('just opened: marker at the left', inAbout(left(ends.sessionMarker), 0));
t('about to reset: marker at the right', inAbout(left(ends.weeklyMarker), 100));

section('no reading, no marker');
const gone = fresh();
gone.setUsage({ five_hour: { utilization: 30, resets_at: null }, seven_day: null });
t('a window with no reset time gets no marker', hidden(gone.sessionMarker));
t('a window with no reading at all gets no marker', hidden(gone.weeklyMarker));

gone.setUsage({ five_hour: { utilization: 30, resets_at: 'not a date' }, seven_day: null });
t('an unparseable reset time gets no marker', hidden(gone.sessionMarker));

const past = fresh();
past.setUsage({ five_hour: { utilization: 30, resets_at: at(-HOUR) }, seven_day: null });
t('a window already past its reset gets no marker', hidden(past.sessionMarker));

section('a window longer than we assume withdraws the marker');
// Nothing in either payload states a window length, so the start is inferred as
// `resets_at - nominal`. More time left than the window is long proves that
// inference wrong for this account, and a wrong marker is worse than none.
const long = fresh();
long.setUsage({
	five_hour: { utilization: 10, resets_at: at(8 * HOUR) },
	seven_day: { utilization: 10, resets_at: at(30 * DAY) }
});
t('session marker withdrawn', hidden(long.sessionMarker));
t('weekly marker withdrawn', hidden(long.weeklyMarker));
t('  the bar itself is unaffected', !hidden(long.sessionBar) && long.sessionBarFill.style.width === '10%');
t('  and the countdown text still reads', long.sessionUsageSpan.textContent.includes('resets in'));

// The contradiction is only visible early on. Once seen, it has to stick: a
// later reading from the same over-long window looks perfectly ordinary.
long.setUsage({
	five_hour: { utilization: 20, resets_at: at(4 * HOUR) },
	seven_day: { utilization: 20, resets_at: at(6 * DAY) }
});
t('the verdict is latched for the session', hidden(long.sessionMarker));
t('  for both windows', hidden(long.weeklyMarker));

// ...and is judged per window, not for the row as a whole.
const oneOff = fresh();
oneOff.setUsage({
	five_hour: { utilization: 10, resets_at: at(8 * HOUR) },
	seven_day: { utilization: 10, resets_at: at(6 * DAY) }
});
t('one bad window does not silence the other', hidden(oneOff.sessionMarker) && !hidden(oneOff.weeklyMarker));

section('ordinary clock skew must not withdraw the marker');
// `resets_at` is the server's clock, `Date.now()` the browser's. A window that
// has just opened therefore reads as a little OVER nominal on any browser
// running behind - and the latch is permanent, so without a tolerance a few
// seconds of skew would cost the marker for the whole session.
const skewed = fresh();
skewed.setUsage({ five_hour: { utilization: 1, resets_at: at(5 * HOUR + 30 * 1000) }, seven_day: null });
t('30 seconds of skew is tolerated', !hidden(skewed.sessionMarker));
t('  and is not latched', skewed.sessionWindowLengthUnknown === false);
t('  the marker pins to the start of the window', inAbout(left(skewed.sessionMarker), 0));

const skewed2 = fresh();
skewed2.setUsage({ five_hour: { utilization: 1, resets_at: at(5 * HOUR + 4 * 60 * 1000) }, seven_day: null });
t('four minutes of skew is still tolerated', !hidden(skewed2.sessionMarker));

// ...but the tolerance must not swallow a genuinely wrong nominal, which is
// wrong by hours rather than minutes.
const wrong = fresh();
wrong.setUsage({ five_hour: { utilization: 1, resets_at: at(5 * HOUR + 30 * 60 * 1000) }, seven_day: null });
t('half an hour over nominal is not skew, and withdraws', hidden(wrong.sessionMarker));

section('the marker advances on its own');
const moving = fresh();
moving.setUsage({ five_hour: { utilization: 5, resets_at: at(2.5 * HOUR) }, seven_day: null });
const before = left(moving.sessionMarker);
const realNow = Date.now;
Date.now = () => realNow() + HOUR;
moving.tick();
const after = left(moving.sessionMarker);
Date.now = realNow;
t('a tick moves it without a new reading', after > before);
t('  by an hour of a five-hour window', inAbout(after - before, 20));

process.exit(report('usage-marker'));
