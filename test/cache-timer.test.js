// The cache timer is only present while the context is actually cached.
const { load, loadWith, section, t, report } = require('./harness');

const ctx = load('src/content/constants.js', 'src/content/ui.js');
const ui = new ctx.ClaudeCounter.ui.CounterUI();
ui.initialize();

const header = () => ui.headerContainer.textContent || '(empty)';
const TOKENS = (n) => `Token Counter: ~${n} tokens`;
const CACHE = (v) => `\u00A0|\u00A0Cached Context Timer:\u00A0${v}`;
const is = (label, expected) => t(label, header() === expected, `expected ${JSON.stringify(expected)}\n          got      ${JSON.stringify(header())}`);

section('visible only while cached');
ui.setConversationMetrics({ totalTokens: 42, cachedUntil: Date.now() + 180000 });
is('active cache shows a countdown', TOKENS(42) + CACHE('3:00'));

ui.lastCachedUntilMs = Date.now() - 1;
ui.tick();
is('countdown hits zero -> timer and separator both go', TOKENS(42));

ui.setConversationMetrics({ totalTokens: 99, cachedUntil: Date.now() - 600000 });
is('opening a stale conversation shows no timer', TOKENS(99));

ui.setConversationMetrics({ totalTokens: 7 });
is('no cachedUntil at all shows no timer', TOKENS(7));

section('pending, while a new window is being opened');
ui.setPendingCache(true);
is('sending from hidden shows the placeholder', TOKENS(7) + CACHE('-:--'));

ui.setConversationMetrics({ totalTokens: 21, cachedUntil: Date.now() + 299000 });
is('refreshed conversation replaces it with a live countdown', TOKENS(21) + CACHE('4:59'));

ui.setPendingCache(true);
is('sending while already cached leaves the countdown alone', TOKENS(21) + CACHE('4:59'));
ui.setPendingCache(false);

ui.setConversationMetrics({ totalTokens: 21, cachedUntil: Date.now() + 500 });
ui.setPendingCache(true);
ui.lastCachedUntilMs = Date.now() - 1;
ui.tick();
is('window expiring mid-generation falls back to the placeholder', TOKENS(21) + CACHE('-:--'));

section('safety net');
ui.setPendingCache(true);
t('a pending export arms the timeout', ui.pendingCacheTimeoutId !== null);
t('timeout is configured', ctx.ClaudeCounter.CONST.PENDING_CACHE_TIMEOUT_MS === 60000);
ui.pendingCache = false;
ui._clearCache();
ui._renderHeader();
is('timing out falls back to hidden', TOKENS(21));

section('safety net, with a countdown already running when the message is sent');
// The common case: send while cached. The countdown keeps running on purpose,
// and if no refreshed conversation ever arrives the safety net must still let
// go of the pending state - otherwise the timer turns into a permanent "-:--"
// when the countdown reaches zero instead of disappearing.
{
	const timers = [];
	const c2 = loadWith({ setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout: () => {} },
		'src/content/constants.js', 'src/content/ui.js');
	const u = new c2.ClaudeCounter.ui.CounterUI();
	u.initialize();
	const h = () => u.headerContainer.textContent;

	u.setConversationMetrics({ totalTokens: 5, cachedUntil: Date.now() + 180000 });
	u.setPendingCache(true);
	t('the running countdown is left alone', h() === TOKENS(5) + CACHE('3:00'), JSON.stringify(h()));

	timers.at(-1)();
	t('the safety net still drops the pending state', u.pendingCache === false);
	t('  without disturbing the countdown', h() === TOKENS(5) + CACHE('3:00'), JSON.stringify(h()));

	u.lastCachedUntilMs = Date.now() - 1;
	u.tick();
	t('so at zero the timer disappears rather than sticking at -:--', h() === TOKENS(5), JSON.stringify(h()));
}

process.exit(report('cache timer'));
