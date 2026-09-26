(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	CC.DOM = Object.freeze({
		CHAT_MENU_TRIGGER: '[data-testid="chat-title-split"]',
		CHAT_HEADER: '[data-testid="chat-header"]',
		HEADER_FALLBACK: 'header',
		CHAT_INPUT: '[data-testid="chat-input"]',
		// Claude names the composer in its own design-system attribute, which is a
		// far better anchor than either a utility class or a shape heuristic. The
		// other two remain as fallbacks for layouts that predate it.
		COMPOSER_CARD: '[data-cds="ChatComposer"], [class*="rounded-composer"]',
		BRIDGE_SCRIPT_ID: 'cc-bridge-script'
	});

	CC.SETTINGS_KEY = 'cc:settings';

	// Every on-page element the popup can switch off. All on by default.
	CC.SETTINGS_DEFAULTS = Object.freeze({
		tokenCounter: true,
		cacheTimer: true,
		exportButton: true,
		sessionBar: true,
		weeklyBar: true,
		usageRefresh: true
	});

	CC.CONST = Object.freeze({
		CACHE_WINDOW_MS: 5 * 60 * 1000,
		PENDING_CACHE_TIMEOUT_MS: 60 * 1000,
		// How long to wait before re-reading a conversation whose tree did not yet
		// include the reply when its stream closed.
		REPLY_SETTLE_RETRY_MS: 1500,
		// Nominal window lengths, taken from the names the server itself gives the
		// windows (`five_hour`/`seven_day` over REST, `5h`/`7d` over SSE). Nothing
		// in either payload states a duration, so these are the only figures
		// available - and they are only ever used to place the elapsed-time
		// marker, which hides itself as soon as a reading contradicts them.
		SESSION_WINDOW_MS: 5 * 60 * 60 * 1000,
		WEEKLY_WINDOW_MS: 7 * 24 * 60 * 60 * 1000,
		// `resets_at` is the server's clock; `Date.now()` is the browser's. A
		// window that has just opened therefore reads as slightly longer than
		// nominal on any browser running behind, which would otherwise look like
		// proof that the nominal is wrong. A genuinely wrong nominal is wrong by
		// hours; skew is seconds to minutes, so this separates them.
		WINDOW_NOMINAL_TOLERANCE_MS: 5 * 60 * 1000
	});

	CC.COLORS = Object.freeze({
		PROGRESS_FILL_DARK: '#2c84db',
		PROGRESS_FILL_LIGHT: '#5aa6ff',
		PROGRESS_OUTLINE_DARK: '#787877',
		PROGRESS_OUTLINE_LIGHT: '#bfbfbf',
		AMBER_WARNING: '#F0B544',
		RED_WARNING: '#ce2029',
		BOLD_LIGHT: '#141413',
		BOLD_DARK: '#faf9f5',
		CACHE_ACTIVE_DARK: '#3fb950',
		CACHE_ACTIVE_LIGHT: '#1a7f37',
		PROGRESS_MARKER_DARK: '#ffffff',
		PROGRESS_MARKER_LIGHT: '#111111'
	});
})();
