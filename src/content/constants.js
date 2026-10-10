(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	CC.DOM = Object.freeze({
		CHAT_MENU_TRIGGER: '[data-testid="chat-title-split"]',
		CHAT_HEADER: '[data-testid="chat-header"]',
		HEADER_FALLBACK: 'header',
		// Claude's top-right action group (page icon, Share). The export button sits
		// right before it, as a sibling in our own look, never inside it.
		ACTIONS_HOST: '[data-testid="wiggle-controls-actions"]',
		ACTIONS_ICON_BUTTON: 'button[data-cds="Button"][data-cds-icon-only]',
		// With an artifact panel open Claude hides the action group (no icon button is
		// left in it), but the chat header still has this icon button on its right.
		// The export button sits right before it instead.
		POP_OUT_BUTTON: '[data-testid="chat-pop-out"]',
		// Set by the page itself on a reply that is still being written. Present on
		// layouts that send over their own RPC rather than a /completion stream.
		STREAMING: '[data-is-streaming="true"]',
		CHAT_INPUT: '[data-testid="chat-input"]',
		// Claude names the composer in its own design-system attribute, which is a
		// far better anchor than either a utility class or a shape heuristic. The
		// other two remain as fallbacks for layouts that predate it.
		COMPOSER_CARD: '[data-cds="ChatComposer"], [class*="rounded-composer"]',
		BRIDGE_SCRIPT_ID: 'cc-bridge-script'
	});

	CC.SETTINGS_KEY = 'cc:settings';
	CC.DIAG_KEY = 'cc:diag';
	CC.SNAPSHOT_KEY = 'cc:usageSnapshot';

	// This file is also loaded by the popup, so what both sides need lives here once.

	CC.getStorage = () => {
		try {
			return globalThis.browser?.storage?.local || globalThis.chrome?.storage?.local || null;
		} catch {
			return null;
		}
	};

	// MV3 storage returns promises on every browser this ships to (Firefox >= 128).
	CC.storageGet = async (key) => {
		try {
			return (await CC.getStorage()?.get(key)) || null;
		} catch {
			return null;
		}
	};

	const PLAN_LABELS = [
		['claude_max', 'MAX'],
		['claude_pro', 'PRO']
	];

	// `raven` is the organisation tier and covers Team and Enterprise alike: a real
	// Team org reports exactly ["raven", "chat"], so the capability list cannot tell
	// the two apart. `raven_type` on the org object names which one it is.
	// `claude_team` used to sit in the list above and never matched anything: it is
	// the value of a reporting field on the org object, not a capability.
	const RAVEN_TYPES = [
		['team', 'TEAM'],
		['enterprise', 'ENTERPRISE']
	];

	/** Plan label for an org object, or FREE when nothing identifies it. */
	CC.planFromOrg = (org) => {
		const caps = Array.isArray(org?.capabilities) ? org.capabilities : [];
		if (caps.includes('raven')) {
			const type = typeof org?.raven_type === 'string' ? org.raven_type.toLowerCase() : null;
			const raven = RAVEN_TYPES.find(([t]) => t === type);
			// An unrecognised org tier falls back to TEAM rather than dropping to
			// FREE: Team is much the commoner of the two, so it is the better guess
			// if Anthropic ever adds a third `raven_type`.
			return raven ? raven[1] : 'TEAM';
		}
		const match = PLAN_LABELS.find(([cap]) => caps.includes(cap));
		return match ? match[1] : 'FREE';
	};

	/**
	 * One usage window as `{ utilization: 0-100, resets_at: ISO | null }`, or null.
	 * The REST endpoint sends a percentage and an ISO string; the message_limit
	 * event (`fromEvent`) sends a 0-1 fraction and epoch seconds.
	 */
	CC.usageWindow = (w, fromEvent = false) => {
		if (!w || typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) return null;
		const utilization = Math.max(0, Math.min(100, fromEvent ? w.utilization * 100 : w.utilization));
		const r = w.resets_at;
		// A finite number can still be out of range for a date, and toISOString throws on one.
		const eventMs = typeof r === 'number' ? r * 1000 : NaN;
		const resets_at = fromEvent
			? (Math.abs(eventMs) <= 8.64e15 ? new Date(eventMs).toISOString() : null)
			: (typeof r === 'string' ? r : null);
		return { utilization, resets_at };
	};

	/**
	 * Weekly limits that apply to one model rather than the account, from the
	 * `limits` list of the usage response: Max, Team and Enterprise accounts get a
	 * separate Fable allowance, shown as its own bar. Observed on a real response
	 * (2026-10-08): `{ kind: 'weekly_scoped', percent, resets_at,
	 * scope: { model: { display_name: 'Fable' } } }`. Accounts without one send no
	 * such entry, so this is simply empty for them.
	 */
	CC.scopedWindows = (raw) => (Array.isArray(raw?.limits) ? raw.limits : []).flatMap((entry) => {
		const label = entry?.scope?.model?.display_name;
		if (entry?.kind !== 'weekly_scoped' || typeof label !== 'string' || !label.trim()) return [];
		const win = CC.usageWindow({ utilization: entry.percent, resets_at: entry.resets_at });
		return win ? [{ label: label.trim().slice(0, 24), ...win }] : [];
	});

	// The last few errors the extension swallowed, for bug reports. Plain strings,
	// never page content.
	const recentErrors = [];
	CC.noteError = (where, err) => {
		// Some engines quote a slice of the offending text in a parse error; drop it.
		const message = String(err?.message || err).replace(/(["'`]).*?\1/g, '$1…$1').slice(0, 80);
		const text = `${where}: ${message}`;
		if (recentErrors[recentErrors.length - 1] === text) return;
		recentErrors.push(text);
		if (recentErrors.length > 5) recentErrors.shift();
	};
	CC.recentErrors = () => recentErrors.slice();

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
		// How long the export button waits for Claude's action group before settling
		// for a place beside the token counter.
		EXPORT_DOCK_GRACE_MS: 4000,
		// How long to wait before re-reading a conversation whose tree did not yet
		// include the reply when its stream closed.
		REPLY_SETTLE_RETRY_MS: 1500,
		// A chat that has produced no count yet is looked at again this often, this many
		// times, rather than left blank (see main.js tick).
		EMPTY_REFRESH_MS: 5000,
		EMPTY_REFRESH_MAX: 6,
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
})();
