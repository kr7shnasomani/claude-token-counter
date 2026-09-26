(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});
	if (CC.__started) return;
	CC.__started = true;

	function getConversationId() {
		const match = window.location.pathname.match(/\/chat\/([^/?]+)/);
		return match ? match[1] : null;
	}

	function getOrgIdFromCookie() {
		try {
			return document.cookie
				.split('; ')
				.find((row) => row.startsWith('lastActiveOrg='))
				?.split('=')[1] || null;
		} catch {
			return null;
		}
	}

	/**
	 * Wait for an element to appear in the DOM using MutationObserver.
	 * More efficient than polling - reacts immediately when element appears.
	 * @param {string} selector - CSS selector
	 * @param {number} [timeoutMs] - Optional timeout in ms. Returns null if timeout expires.
	 */
	function waitForElement(selector, timeoutMs) {
		return new Promise((resolve) => {
			const existing = document.querySelector(selector);
			if (existing) {
				resolve(existing);
				return;
			}

			let timeoutId;
			const observer = new MutationObserver(() => {
				const el = document.querySelector(selector);
				if (el) {
					if (timeoutId) clearTimeout(timeoutId);
					observer.disconnect();
					resolve(el);
				}
			});

			observer.observe(document.body, { childList: true, subtree: true });

			if (timeoutMs) {
				timeoutId = setTimeout(() => {
					observer.disconnect();
					resolve(null);
				}, timeoutMs);
			}
		});
	}

	CC.waitForElement = waitForElement;

	function observeUrlChanges(callback) {
		let lastPath = window.location.pathname;

		const fireIfChanged = () => {
			const current = window.location.pathname;
			if (current !== lastPath) {
				lastPath = current;
				callback();
			}
		};

		// Listen for custom event from bridge (history methods wrapped early)
		window.addEventListener('cc:urlchange', fireIfChanged);
		// Also popstate for back/forward buttons
		window.addEventListener('popstate', fireIfChanged);

		return () => {
			window.removeEventListener('cc:urlchange', fireIfChanged);
			window.removeEventListener('popstate', fireIfChanged);
		};
	}

	function parseUsageFromUsageEndpoint(raw) {
		if (!raw || typeof raw !== 'object') return null;

		const normalizeWindow = (w) => {
			if (!w || typeof w !== 'object') return null;
			if (typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) return null;
			const utilization = Math.max(0, Math.min(100, w.utilization));
			const resets_at = typeof w.resets_at === 'string' ? w.resets_at : null;
			return { utilization, resets_at };
		};

		const fiveHour = normalizeWindow(raw.five_hour);
		const sevenDay = normalizeWindow(raw.seven_day);

		if (!fiveHour && !sevenDay) return null;
		return { five_hour: fiveHour, seven_day: sevenDay };
	}

	function parseUsageFromMessageLimit(raw) {
		if (!raw?.windows || typeof raw.windows !== 'object') return null;

		const normalizeWindow = (w) => {
			if (!w || typeof w !== 'object') return null;
			if (typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) return null;
			const utilization = Math.max(0, Math.min(100, w.utilization * 100));
			const resets_at = typeof w.resets_at === 'number' && Number.isFinite(w.resets_at)
				? new Date(w.resets_at * 1000).toISOString()
				: null;
			return { utilization, resets_at };
		};

		const fiveHour = normalizeWindow(raw.windows['5h']);
		const sevenDay = normalizeWindow(raw.windows['7d']);

		if (!fiveHour && !sevenDay) return null;
		return { five_hour: fiveHour, seven_day: sevenDay };
	}

	let currentConversationId = null;
	let currentOrgId = null;

	let usageState = null; // last snapshot
	const usageResetMs = { five_hour: null, seven_day: null }; // cached parsed timestamps
	let lastUsageSseMs = 0;
	let usageFetchInFlight = false;
	let lastUsageUpdateMs = 0;
	let lastUsageAttemptMs = 0;
	// A seeded reading is a placeholder, not a reading. Tracked separately so it
	// never counts as "we already have usage".
	let usageIsSeeded = false;
	const rolloverHandledForResetMs = { five_hour: null, seven_day: null };

	const ui = new CC.ui.CounterUI({
		onUsageRefresh: async () => {
			await refreshUsage();
		},
		onExport: async (format) => {
			await exportConversation(format);
		}
	});
	ui.initialize();

	// Bridge must be ready before we can make requests
	const bridgeReady = CC.injectBridgeOnce();

	function applyUsageUpdate(normalized, source) {
		if (!normalized) return;
		const now = Date.now();
		const seeded = source === 'snapshot';
		usageState = normalized;
		usageIsSeeded = seeded;
		// Deliberately not stamped for a seed: the freshness clocks drive the
		// safety refresh, and stale numbers must not hold it off for an hour.
		if (!seeded) lastUsageUpdateMs = now;
		if (source === 'sse') lastUsageSseMs = now;
		// Cache parsed timestamps to avoid Date.parse() every tick
		usageResetMs.five_hour = normalized.five_hour?.resets_at ? Date.parse(normalized.five_hour.resets_at) : null;
		usageResetMs.seven_day = normalized.seven_day?.resets_at ? Date.parse(normalized.seven_day.resets_at) : null;
		ui.setUsage(normalized);
		if (source !== 'snapshot') persistSnapshot(normalized);
	}

	function updateOrgIdIfNeeded(newOrgId) {
		if (newOrgId && typeof newOrgId === 'string' && newOrgId !== currentOrgId) {
			currentOrgId = newOrgId;
		}
	}

	async function refreshUsage() {
		await bridgeReady;
		// Recorded even when the fetch fails or the payload is unusable, so the
		// safety refresh below backs off instead of retrying every second.
		lastUsageAttemptMs = Date.now();
		const orgId = currentOrgId || getOrgIdFromCookie();
		if (!orgId) return;
		updateOrgIdIfNeeded(orgId);

		if (usageFetchInFlight) return;
		usageFetchInFlight = true;
		let raw;
		try {
			raw = await CC.bridge.requestUsage(orgId);
		} catch {
			return;
		} finally {
			usageFetchInFlight = false;
		}

		const parsed = parseUsageFromUsageEndpoint(raw);
		// A successful response carrying no windows is an answer, not a failure: this
		// plan does not publish usage until a message has been sent.
		if (!parsed) ui.markUsageUnavailable();
		applyUsageUpdate(parsed, 'usage');
	}

	// --- popup snapshot -----------------------------------------------------
	// The popup is a separate document and cannot read this script's memory, so the
	// last good reading is mirrored into extension storage. Deliberately a snapshot:
	// it carries its own timestamp rather than pretending to be live.

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
	function planFromOrg(org) {
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
	}

	let planLabel = null;

	function getStorage() {
		try {
			return globalThis.browser?.storage?.local || globalThis.chrome?.storage?.local || null;
		} catch {
			return null;
		}
	}

	async function resolvePlanLabel() {
		if (planLabel) return planLabel;
		const orgId = currentOrgId || getOrgIdFromCookie();
		if (!orgId) return null;
		try {
			const orgs = await CC.bridge.requestOrgs();
			const list = Array.isArray(orgs) ? orgs : [orgs];
			const org = list.find((o) => o?.uuid === orgId) || list[0];
			planLabel = planFromOrg(org);
		} catch {
			planLabel = null;
		}
		return planLabel;
	}

	async function persistSnapshot(windows) {
		const storage = getStorage();
		if (!storage || !windows) return;
		const plan = await resolvePlanLabel();
		try {
			await storage.set({
				'cc:usageSnapshot': {
					updatedAt: Date.now(),
					orgId: currentOrgId || getOrgIdFromCookie(),
					plan,
					uiVariant: CC.uiVariant || null,
					five_hour: windows.five_hour,
					seven_day: windows.seven_day
				}
			});
		} catch {
			// Storage is a convenience for the popup; never let it break the page UI.
		}
	}

	/**
	 * Show the last stored reading immediately on load.
	 *
	 * Some plans - free tier among them - get `null` for every window from the usage
	 * endpoint, so their only source is the SSE event that arrives with a reply. That
	 * left the bars blank until the first message of the session. A window whose
	 * reset time has already passed is dropped rather than shown stale.
	 */
	/**
	 * chrome.* takes a callback, browser.* returns a promise and ignores the callback.
	 * Preferring one over the other silently breaks the other browser, so accept both.
	 */
	function storageGet(storage, key) {
		return new Promise((resolve) => {
			let settled = false;
			const done = (value) => {
				if (settled) return;
				settled = true;
				resolve(value || null);
			};
			try {
				const maybePromise = storage.get(key, done);
				if (maybePromise && typeof maybePromise.then === 'function') maybePromise.then(done, () => done(null));
			} catch {
				done(null);
			}
		});
	}

	async function seedFromSnapshot() {
		const storage = getStorage();
		if (!storage || usageState) return;

		const items = await storageGet(storage, 'cc:usageSnapshot');
		const snapshot = items?.['cc:usageSnapshot'];
		if (!snapshot || usageState) return;

		// A window whose reset has passed is not stale data waiting to be refreshed:
		// there is no active window at all until the next message, and its true figure
		// is unknowable until then. One that has not reset is still correct, because
		// usage only advances when a message is sent - so it is a floor, never an
		// overstatement. Keep those, drop the rest.
		const current = (w) =>
			!!w && typeof w.utilization === 'number' && !!w.resets_at && Date.parse(w.resets_at) > Date.now();

		const five_hour = current(snapshot.five_hour) ? snapshot.five_hour : null;
		const seven_day = current(snapshot.seven_day) ? snapshot.seven_day : null;
		if (!five_hour && !seven_day) return;

		applyUsageUpdate({ five_hour, seven_day }, 'snapshot');
	}

	async function refreshConversation() {
		await bridgeReady;
		if (!currentConversationId) {
			ui.setConversationMetrics();
			return;
		}

		const orgId = currentOrgId || getOrgIdFromCookie();
		if (!orgId) return null;
		updateOrgIdIfNeeded(orgId);

		try {
			return await CC.bridge.requestConversation(orgId, currentConversationId);
		} catch {
			return null;
		}
	}

	async function exportConversation(format) {
		await bridgeReady;
		if (!currentConversationId) return;

		const orgId = currentOrgId || getOrgIdFromCookie();
		if (!orgId) return;
		updateOrgIdIfNeeded(orgId);

		// Fetch fresh rather than reusing the last payload, so an export always
		// includes the turn that just finished.
		const data = await CC.bridge.requestConversation(orgId, currentConversationId);
		if (data) CC.exportChat.download(data, format);
	}

	function handleGenerationStart() {
		if (!currentConversationId) return;
		ui.setPendingCache(true);
	}

	/**
	 * A reply has finished, been stopped, or failed. claude.ai does not refetch the
	 * conversation tree after a reply, so this is the only thing that moves the
	 * token count and restarts the cache timer between page loads.
	 */
	async function handleGenerationEnd({ conversationId } = {}) {
		if (!currentConversationId) return;
		if (conversationId && conversationId !== currentConversationId) return;

		const data = await refreshConversation();
		// The stream can close a moment before the reply is readable from the tree.
		// One late retry covers that; anything slower is not worth polling for.
		const trunk = data ? CC.tokens.buildTrunk(data) : [];
		if (trunk[trunk.length - 1]?.sender !== 'assistant') {
			setTimeout(refreshConversation, CC.CONST.REPLY_SETTLE_RETRY_MS);
		}
	}

	async function handleConversationPayload({ orgId, conversationId, data }) {
		if (!conversationId || conversationId !== currentConversationId) return;
		updateOrgIdIfNeeded(orgId);
		if (!data) return;

		const metrics = await CC.tokens.computeConversationMetrics(data);
		ui.setConversationMetrics({ totalTokens: metrics.totalTokens, cachedUntil: metrics.cachedUntil });
	}

	function handleMessageLimit(messageLimit) {
		const parsed = parseUsageFromMessageLimit(messageLimit);
		applyUsageUpdate(parsed, 'sse');
	}

	CC.bridge.on('cc:org', ({ orgId } = {}) => {
		// Strictly a fallback for a missing cookie. Never override an id we already
		// have: someone in several orgs would otherwise latch onto whichever org a
		// stray request happened to touch.
		if (currentOrgId) return;
		updateOrgIdIfNeeded(orgId);
		if (currentOrgId && !usageState) refreshUsage();
	});
	CC.bridge.on('cc:generation_start', handleGenerationStart);
	CC.bridge.on('cc:generation_end', handleGenerationEnd);
	CC.bridge.on('cc:conversation', handleConversationPayload);
	CC.bridge.on('cc:message_limit', handleMessageLimit);

	async function handleUrlChange() {
		currentConversationId = getConversationId();

		// Attach usage line and header independently - they have different anchor elements
		// and CHAT_MENU_TRIGGER doesn't exist on home/new pages
		waitForElement(CC.DOM.CHAT_INPUT, 60000).then((el) => {
			if (el) ui.attachUsageLine();
		});
		waitForElement(CC.DOM.CHAT_MENU_TRIGGER, 60000).then((el) => {
			if (el) ui.attachHeader();
		});

		// Best-effort orgId from cookie.
		updateOrgIdIfNeeded(getOrgIdFromCookie());

		// Usage is org-level, not conversation-level, so fetch it even on /new. This
		// used to sit after the early return below, which left the popup with nothing
		// to show until the user opened an actual conversation.
		if (!usageState || usageIsSeeded) await refreshUsage();

		if (!currentConversationId) {
			ui.setConversationMetrics();
			return;
		}

		await refreshConversation();
	}

	const unobserveUrl = observeUrlChanges(handleUrlChange);
	window.addEventListener('beforeunload', unobserveUrl);

	// Refresh on branch navigation - watch for the branch indicator to change
	let branchObserver = null;
	document.addEventListener('click', (e) => {
		if (!currentConversationId) return;
		const btn = e.target.closest('button');
		if (!btn) return;

		// Branch switchers sit beside an "N / M" counter. Match on that shape rather
		// than on aria-label text or a utility class: the labels are English-only, so
		// anyone using Claude in another language got no refresh on branch switches.
		let indicator = null;
		let scope = btn.parentElement;
		for (let hops = 0; scope && hops < 4 && !indicator; hops++, scope = scope.parentElement) {
			indicator = Array.from(scope.querySelectorAll('span')).find((s) =>
				/^\d+\s*\/\s*\d+$/.test((s.textContent || '').trim())
			);
		}
		if (!indicator) return;

		const originalText = indicator.textContent;

		// Clean up any existing observer
		if (branchObserver) branchObserver.disconnect();

		// Watch for the indicator text to change (with cleanup timeout)
		branchObserver = new MutationObserver(() => {
			if (indicator.textContent !== originalText) {
				branchObserver.disconnect();
				branchObserver = null;
				refreshConversation();
			}
		});

		branchObserver.observe(indicator, { childList: true, characterData: true, subtree: true });

		// Clean up if nothing changes after 60 seconds
		setTimeout(() => {
			if (branchObserver) {
				branchObserver.disconnect();
				branchObserver = null;
			}
		}, 60000);
	});

	// --- settings -----------------------------------------------------------
	// Owned by the popup, applied here. Changes take effect without a reload.

	async function loadSettings() {
		const storage = getStorage();
		if (!storage) return;
		const items = await storageGet(storage, CC.SETTINGS_KEY);
		ui.applySettings(items?.[CC.SETTINGS_KEY]);
	}

	function watchSettings() {
		const area = globalThis.browser?.storage || globalThis.chrome?.storage;
		if (!area?.onChanged?.addListener) return;
		area.onChanged.addListener((changes, areaName) => {
			if (areaName !== 'local' || !changes[CC.SETTINGS_KEY]) return;
			ui.applySettings(changes[CC.SETTINGS_KEY].newValue);
		});
	}

	// Initial attach + fetches
	loadSettings();
	watchSettings();
	seedFromSnapshot();
	handleUrlChange();

	function tick() {
		ui.tick();

		// Refresh usage when a window ends (5h / 7d). SSE won't fire at rollover unless a message is sent.
		const now = Date.now();

		if (usageResetMs.five_hour && now >= usageResetMs.five_hour && rolloverHandledForResetMs.five_hour !== usageResetMs.five_hour) {
			rolloverHandledForResetMs.five_hour = usageResetMs.five_hour;
			refreshUsage();
		}
		if (usageResetMs.seven_day && now >= usageResetMs.seven_day && rolloverHandledForResetMs.seven_day !== usageResetMs.seven_day) {
			rolloverHandledForResetMs.seven_day = usageResetMs.seven_day;
			refreshUsage();
		}

		// Optional hourly safety refresh. Accounts without usage windows (some plans
		// return no five_hour/seven_day at all) never set lastUsageUpdateMs, so the
		// attempt clock is what keeps this from firing on every tick.
		const ONE_HOUR_MS = 60 * 60 * 1000;
		const USAGE_RETRY_MS = 5 * 60 * 1000;
		const sseAge = now - lastUsageSseMs;
		const anyAge = now - lastUsageUpdateMs;
		const attemptAge = now - lastUsageAttemptMs;
		if (!document.hidden && sseAge > ONE_HOUR_MS && anyAge > ONE_HOUR_MS && attemptAge > USAGE_RETRY_MS) {
			refreshUsage();
		}
	}

	// Exposed for tests. This file is one IIFE with no other seam, and the suites
	// previously asserted against its *source text* - which broke on reformatting
	// and proved nothing about behaviour. `parseUsage*` are the only routes usage
	// takes into the extension (on free tier the SSE one is the only route there
	// is), and `seedFromSnapshot` decides what a stored reading is still worth on
	// load; both are worth exercising directly.
	CC.usage = {
		parseUsageFromUsageEndpoint,
		parseUsageFromMessageLimit,
		seedFromSnapshot,
		readState: () => ({ usage: usageState, seeded: usageIsSeeded, updatedAt: lastUsageUpdateMs })
	};

	// Keep the countdowns ticking.
	setInterval(tick, 1000);
})();
