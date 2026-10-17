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
	}

	function parseUsage(five, seven, fromEvent) {
		const five_hour = CC.usageWindow(five, fromEvent);
		const seven_day = CC.usageWindow(seven, fromEvent);
		return five_hour || seven_day ? { five_hour, seven_day } : null;
	}

	function parseUsageFromUsageEndpoint(raw) {
		const parsed = raw && typeof raw === 'object' ? parseUsage(raw.five_hour, raw.seven_day, false) : null;
		// Per-model weekly limits ride along for the popup; the page row ignores them.
		if (parsed && Array.isArray(raw.limits)) parsed.scoped = CC.scopedWindows(raw);
		return parsed;
	}

	function parseUsageFromMessageLimit(raw) {
		return raw?.windows && typeof raw.windows === 'object' ? parseUsage(raw.windows['5h'], raw.windows['7d'], true) : null;
	}

	let currentConversationId = null;
	let currentOrgId = null;

	let usageState = null; // last snapshot
	const usageResetMs = { five_hour: null, seven_day: null }; // cached parsed timestamps
	let usageFetchInFlight = false;
	let lastUsageUpdateMs = 0;
	let lastUsageAttemptMs = 0;
	// A seeded reading is a placeholder, not a reading. Tracked separately so it
	// never counts as "we already have usage".
	let usageIsSeeded = false;
	// The usage endpoint answered, with no windows (free tier). Asked again hourly,
	// not on the five-minute retry meant for a failed request.
	let usageEmpty = false;
	// Where the last reading came from, for bug reports: which of the three paths
	// this account's layout actually feeds is the first thing a report needs.
	let usageSource = 'none';
	// A usage answer still carrying an ended window is asked again, this many times.
	let expiredRetries = 0;
	const rolloverHandledForResetMs = { five_hour: null, seven_day: null };

	const ui = new CC.ui.CounterUI({
		onUsageRefresh: refreshUsage,
		onExport: exportConversation
	});
	ui.initialize();

	// The bridge has been running since document_start; greet it so it repeats what
	// it saw before this script was listening.
	CC.connectBridge();

	function applyUsageUpdate(normalized, source) {
		if (!normalized) return;
		// A window whose reset has passed is wrong, whichever source sent it.
		for (const key of ['five_hour', 'seven_day']) {
			if (CC.windowEnded(normalized[key])) normalized = { ...normalized, [key]: null };
		}
		const now = Date.now();
		const seeded = source === 'snapshot';
		usageState = normalized;
		usageIsSeeded = seeded;
		if (!seeded) usageSource = source;
		// Deliberately not stamped for a seed: the freshness clocks drive the
		// safety refresh, and stale numbers must not hold it off for an hour.
		if (!seeded) lastUsageUpdateMs = now;
		// Cache parsed timestamps to avoid Date.parse() every tick
		usageResetMs.five_hour = normalized.five_hour?.resets_at ? Date.parse(normalized.five_hour.resets_at) : null;
		usageResetMs.seven_day = normalized.seven_day?.resets_at ? Date.parse(normalized.seven_day.resets_at) : null;
		ui.setUsage(normalized);
		if (source !== 'snapshot') persistSnapshot(normalized);
	}

	function updateOrgIdIfNeeded(newOrgId) {
		if (newOrgId && typeof newOrgId === 'string' && newOrgId !== currentOrgId) {
			currentOrgId = newOrgId;
			// What the last org answered says nothing about this one.
			usageEmpty = false;
		}
	}

	/** The org id we hold, else the cookie's, remembered. Null when neither exists. */
	function resolveOrgId() {
		const id = currentOrgId || getOrgIdFromCookie();
		updateOrgIdIfNeeded(id);
		return id;
	}

	async function refreshUsage() {
		// Recorded even when the fetch fails or the payload is unusable, so the
		// safety refresh below backs off instead of retrying every second.
		lastUsageAttemptMs = Date.now();
		const orgId = resolveOrgId();
		if (!orgId) return;

		if (usageFetchInFlight) return;
		usageFetchInFlight = true;
		const askedAt = Date.now();
		let raw;
		try {
			raw = await CC.bridge.requestUsage(orgId);
		} catch {
			return;
		} finally {
			usageFetchInFlight = false;
		}

		// A reading from a reply's stream that landed while this was in flight is newer.
		if (lastUsageUpdateMs > askedAt) return;
		const parsed = parseUsageFromUsageEndpoint(raw);
		// A successful response carrying no windows is an answer, not a failure: this
		// plan does not publish usage until a message has been sent.
		usageEmpty = !parsed;
		if (!parsed) ui.markUsageUnavailable();
		// Just after a rollover the server can still answer with the window that
		// ended. Shown, it read "resets in 0s" and latched; ask again shortly instead.
		const expired = parsed && ['five_hour', 'seven_day'].filter((k) => CC.windowEnded(parsed[k]));
		if (expired?.length) {
			for (const k of expired) parsed[k] = null;
			if (expiredRetries++ < 3) setTimeout(refreshUsage, CC.CONST.USAGE_ROLLOVER_RETRY_MS);
		} else if (parsed) {
			expiredRetries = 0;
		}
		applyUsageUpdate(parsed, 'usage');
	}

	// --- popup snapshot -----------------------------------------------------
	// The popup is a separate document and cannot read this script's memory, so the
	// last good reading is mirrored into extension storage. Deliberately a snapshot:
	// it carries its own timestamp rather than pretending to be live.

	let planLabel = null;
	let planAttempts = 0;
	const MAX_PLAN_ATTEMPTS = 3;

	// Bounded and shared: every usage reading asks for the plan, and an
	// /organizations that keeps failing must not be asked again for each of them.
	let planPromise = null;
	function resolvePlanLabel() {
		if (planLabel) return Promise.resolve(planLabel);
		if (planPromise) return planPromise;
		const orgId = resolveOrgId();
		if (!orgId || planAttempts >= MAX_PLAN_ATTEMPTS) return Promise.resolve(null);
		planAttempts += 1;
		planPromise = (async () => {
			try {
				const orgs = await CC.bridge.requestOrgs();
				const list = (Array.isArray(orgs) ? orgs : [orgs]).filter((o) => o && typeof o === 'object');
				const org = list.find((o) => o.uuid === orgId) || list[0];
				// No org in the answer is not evidence of a free plan.
				planLabel = org ? CC.planFromOrg(org) : null;
			} catch {
				planLabel = null;
			}
			return planLabel;
		})();
		// Cleared once settled, never from inside: that could run before this assignment.
		planPromise.finally(() => { planPromise = null; });
		return planPromise;
	}

	// The message stream carries no per-model limits, so a reading that came from it
	// keeps the last ones the usage endpoint gave rather than wiping them.
	let lastScoped = [];

	async function persistSnapshot(windows) {
		const storage = CC.getStorage();
		if (!storage || !windows) return;
		if (windows.scoped) lastScoped = windows.scoped;
		const plan = await resolvePlanLabel();
		try {
			await storage.set({
				[CC.SNAPSHOT_KEY]: {
					updatedAt: Date.now(),
					orgId: resolveOrgId(),
					plan,
					uiVariant: CC.uiVariant || null,
					five_hour: windows.five_hour,
					seven_day: windows.seven_day,
					scoped: lastScoped
				}
			});
		} catch (e) {
			// Storage is a convenience for the popup; never let it break the page UI.
			CC.noteError('snapshot write', e);
		}
	}

	// Diagnostics live under their own key. The usage snapshot is only written when
	// a plan reports usage, which is exactly what free accounts with a broken
	// layout never do - they are the reports that most need these facts. That
	// includes the plan itself: the snapshot used to be its only home, so a free
	// account's bug report always said "Plan: unknown".
	let lastDiag = '';
	function publishDiagnostics() {
		const storage = CC.getStorage();
		if (!storage) return;
		if (!planLabel && !planPromise) {
			resolvePlanLabel().then((plan) => {
				if (plan) publishDiagnostics();
			});
		}
		try {
			const diag = { ...ui.getDiagnostics(), plan: planLabel, usageFrom: usageSource };
			const text = JSON.stringify(diag);
			if (text === lastDiag) return;
			lastDiag = text;
			Promise.resolve(storage.set({ [CC.DIAG_KEY]: diag })).catch(() => {});
		} catch (e) {
			CC.noteError('diagnostics', e);
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
	async function seedFromSnapshot() {
		if (usageState) return;

		const items = await CC.storageGet(CC.SNAPSHOT_KEY);
		const snapshot = items?.[CC.SNAPSHOT_KEY];
		if (!snapshot || usageState) return;
		// Usage belongs to an organisation. After switching account or org the stored
		// reading is someone else's, and on a plan that reports nothing it would stay.
		// With no org id to compare yet, it may be someone else's too.
		const orgId = resolveOrgId();
		if (!orgId || snapshot.orgId !== orgId) return;
		// Per-model limits are only ever read from the usage endpoint; keep the last
		// ones so a reading from the message stream does not overwrite them with none.
		if (Array.isArray(snapshot.scoped)) lastScoped = snapshot.scoped;

		// A window whose reset has passed is not stale data waiting to be refreshed:
		// there is no active window at all until the next message, and its true figure
		// is unknowable until then. One that has not reset is still correct, because
		// usage only advances when a message is sent - so it is a floor, never an
		// overstatement. Keep those, drop the rest.
		const current = (w) => typeof w?.utilization === 'number' && Number.isFinite(Date.parse(w.resets_at)) && !CC.windowEnded(w);

		const five_hour = current(snapshot.five_hour) ? snapshot.five_hour : null;
		const seven_day = current(snapshot.seven_day) ? snapshot.seven_day : null;
		if (!five_hour && !seven_day) return;

		applyUsageUpdate({ five_hour, seven_day }, 'snapshot');
	}

	/** Fetch the conversation tree through the bridge and fold it into the counter. */
	async function fetchConversation(orgId, conversationId) {
		const data = await CC.bridge.requestConversation(orgId, conversationId);
		await handleConversationPayload({ orgId, conversationId, data });
		return data;
	}

	async function refreshConversation() {
		if (!currentConversationId) {
			ui.setConversationMetrics();
			return;
		}

		const orgId = resolveOrgId();
		if (!orgId) return null;

		try {
			return await fetchConversation(orgId, currentConversationId);
		} catch (e) {
			CC.noteError('conversation fetch', e);
			return null;
		}
	}

	async function exportConversation(format) {
		if (!currentConversationId) return;

		const orgId = resolveOrgId();
		if (!orgId) return;

		// Fetch fresh rather than reusing the last payload, so an export always
		// includes the turn that just finished.
		const data = await fetchConversation(orgId, currentConversationId);
		if (data) CC.exportChat.download(data, format);
	}

	function handleGenerationStart({ conversationId } = {}) {
		if (!currentConversationId) return;
		// A timeline stream can belong to another chat than the one on screen.
		if (conversationId && conversationId !== currentConversationId) return;
		ui.setPendingCache(true);
	}

	/**
	 * A reply has finished, been stopped, or failed. claude.ai does not refetch the
	 * conversation tree after a reply, so this is the only thing that moves the
	 * token count and restarts the cache timer between page loads.
	 */
	let lastGenerationEndMs = 0;

	let lastPageEndMs = 0;

	async function handleGenerationEnd({ conversationId, fromPage = false } = {}) {
		if (!currentConversationId) return;
		if (conversationId && conversationId !== currentConversationId) return;
		// The page's flag and the stream both report one reply. The page standing down
		// after the stream is in watchStreaming; this is the other order.
		if (fromPage) lastPageEndMs = Date.now();
		else if (Date.now() - lastPageEndMs < CC.CONST.SIGNAL_OVERLAP_MS) return;
		lastGenerationEndMs = Date.now();
		emptyRefreshes = 0;

		const data = await refreshConversation();
		// The stream can close a moment before the reply is readable from the tree.
		// One late retry covers that; anything slower is not worth polling for.
		const trunk = data ? CC.tokens.buildTrunk(data) : [];
		if (trunk[trunk.length - 1]?.sender !== 'assistant') {
			setTimeout(refreshConversation, CC.CONST.REPLY_SETTLE_RETRY_MS);
		}
	}

	/**
	 * The page's own mark of a reply in progress, as a second signal beside the
	 * bridge's (a completion stream closing, or the newer layout's timeline going
	 * idle). It is an attribute rather than words, so it holds in every language, and
	 * it still works if claude.ai changes how replies travel.
	 *
	 * Both signals fire for one reply; this one stands down for the couple of
	 * seconds after the bridge's, and handleGenerationEnd drops the bridge's when it
	 * comes second.
	 */
	function watchStreaming() {
		let streaming = false;
		let scheduled = false;
		// A short reply can switch the attribute on and off between two looks, and
		// the reply was then never seen to end (seen on a one-word answer).
		let sawStreaming = false;
		const check = () => {
			scheduled = false;
			const now = !!document.querySelector(CC.DOM.STREAMING);
			const missed = sawStreaming && !now && !streaming;
			sawStreaming = false;
			if (now === streaming && !missed) return;
			streaming = now;
			if (now) {
				handleGenerationStart();
				return;
			}
			if (Date.now() - lastGenerationEndMs < CC.CONST.SIGNAL_OVERLAP_MS) return;
			handleGenerationEnd({ fromPage: true });
			// For a layout whose stream carries no usage the bridge could read.
			refreshUsage();
		};
		// Streaming churns the DOM hundreds of times a second; look at most a few.
		const schedule = (records = []) => {
			// Only attribute records can show the flag flipping; the rest are page churn.
			if (records.some((r) => r.type === 'attributes' && (r.oldValue === 'true' || r.target.getAttribute('data-is-streaming') === 'true'))) sawStreaming = true;
			if (scheduled) return;
			scheduled = true;
			setTimeout(check, 150);
		};
		new MutationObserver(schedule).observe(document.documentElement, {
			subtree: true,
			childList: true,
			attributes: true,
			attributeOldValue: true,
			attributeFilter: ['data-is-streaming']
		});
	}

	// Has the open conversation produced a count yet? A new chat is read the moment
	// its first message is sent, before the server has it; if that read is empty and
	// the end of the reply is then missed, nothing would ask again. tick() re-reads a
	// chat that still has no count, a few times, so it can never stay blank.
	let countSeen = false;
	let emptyRefreshes = 0;
	let lastEmptyRefreshMs = Date.now();

	async function handleConversationPayload({ orgId, conversationId, data }) {
		if (!conversationId || conversationId !== currentConversationId) return;
		updateOrgIdIfNeeded(orgId);
		if (!data) return;

		const metrics = await CC.tokens.computeConversationMetrics(data);
		if (metrics.totalTokens > 0) countSeen = true;
		ui.setConversationMetrics({ totalTokens: metrics.totalTokens, cachedUntil: metrics.cachedUntil });
	}

	function handleMessageLimit(messageLimit) {
		const parsed = parseUsageFromMessageLimit(messageLimit);
		const via = messageLimit?.via;
		applyUsageUpdate(parsed, via === 'timeline' || via === 'refusal' ? via : 'sse');
	}

	CC.bridge.on('cc:org', ({ orgId } = {}) => {
		// Strictly a fallback for a missing cookie. Never override an id we already
		// have: someone in several orgs would otherwise latch onto whichever org a
		// stray request happened to touch.
		if (currentOrgId) return;
		updateOrgIdIfNeeded(orgId);
		// The stored reading could not be matched to an org at load; now it can.
		if (currentOrgId && !usageState) seedFromSnapshot();
		if (currentOrgId && !usageState) refreshUsage();
		// With no readable cookie the first conversation fetch bailed for want of an
		// org id, so the counter and timer waited for a message that might never
		// come. Now that the id is known, fetch it.
		if (currentOrgId && currentConversationId) refreshConversation();
	});
	CC.bridge.on('cc:generation_start', handleGenerationStart);
	CC.bridge.on('cc:generation_end', handleGenerationEnd);
	CC.bridge.on('cc:conversation', handleConversationPayload);
	CC.bridge.on('cc:message_limit', handleMessageLimit);

	async function handleUrlChange() {
		const previous = currentConversationId;
		currentConversationId = getConversationId();
		if (currentConversationId !== previous) {
			countSeen = false;
			emptyRefreshes = 0;
			lastEmptyRefreshMs = Date.now(); // the read this navigation makes counts as the first
			// The last chat's count is not this one's, and would stay if this fetch failed.
			ui.setConversationMetrics();
		}
		// A new page redraws Claude's header; keep the export button from flashing in
		// ours while its own group is drawn.
		ui.holdExport();

		// Attach the usage line and the header independently - they have different
		// anchors, and the header does not exist on home/new pages. Each does nothing
		// until its anchor is there; the UI's own observer retries as pages render.
		ui.attachUsageLine();
		ui.attachHeader();

		// Best-effort orgId from cookie.
		updateOrgIdIfNeeded(getOrgIdFromCookie());

		// Usage is org-level, not conversation-level, so fetch it even on /new. This
		// used to sit after the early return below, which left the popup with nothing
		// to show until the user opened an actual conversation.
		// A plan that answered with nothing is asked hourly (tick), not per navigation.
		if ((!usageState && !usageEmpty) || usageIsSeeded) refreshUsage();

		if (!currentConversationId) {
			ui.setConversationMetrics();
			return;
		}

		await refreshConversation();
	}

	observeUrlChanges(handleUrlChange);

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
		const observer = new MutationObserver(() => {
			if (indicator.textContent !== originalText) {
				observer.disconnect();
				if (branchObserver === observer) branchObserver = null;
				refreshConversation();
			}
		});
		branchObserver = observer;
		observer.observe(indicator, { childList: true, characterData: true, subtree: true });

		// Clean up if nothing changes after 60 seconds. Only this observer: a later
		// click may already have replaced it, and must keep its own.
		setTimeout(() => {
			observer.disconnect();
			if (branchObserver === observer) branchObserver = null;
		}, 60000);
	});

	// --- settings -----------------------------------------------------------
	// Owned by the popup, applied here. Changes take effect without a reload.

	async function loadSettings() {
		const items = await CC.storageGet(CC.SETTINGS_KEY);
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
	watchStreaming();
	seedFromSnapshot();
	handleUrlChange();

	const ONE_HOUR_MS = 60 * 60 * 1000;
	const USAGE_RETRY_MS = 5 * 60 * 1000;

	let ticks = 0;
	function tick() {
		// Nobody sees a hidden tab: skip the paint and layout reads. The first tick
		// after it is shown catches the countdowns up.
		if (!document.hidden) {
			ui.tick();
			// Reads layout, so not every second; the first tick still publishes at once.
			if (ticks++ % 5 === 0) publishDiagnostics();
		}

		const now = Date.now();

		// A chat with no count yet is read again (see countSeen).
		if (!document.hidden && currentConversationId && !countSeen && emptyRefreshes < CC.CONST.EMPTY_REFRESH_MAX &&
			now - lastEmptyRefreshMs >= CC.CONST.EMPTY_REFRESH_MS) {
			lastEmptyRefreshMs = now;
			emptyRefreshes++;
			refreshConversation();
		}

		// Refresh usage when a window ends (5h / 7d). SSE won't fire at rollover unless a message is sent.
		for (const key of ['five_hour', 'seven_day']) {
			const resetMs = usageResetMs[key];
			if (resetMs && now >= resetMs && rolloverHandledForResetMs[key] !== resetMs) {
				rolloverHandledForResetMs[key] = resetMs;
				// The old figure is wrong from here on. Plans that report nothing on
				// demand would otherwise keep showing it, "resets in 0s", until a message.
				usageResetMs[key] = null;
				usageState = { ...usageState, [key]: null };
				ui.setUsage(usageState);
				refreshUsage();
			}
		}

		// Optional hourly safety refresh. Accounts without usage windows (some plans
		// return no five_hour/seven_day at all) never set lastUsageUpdateMs, so the
		// attempt clock is what keeps this from firing on every tick.
		const anyAge = now - lastUsageUpdateMs;
		const attemptAge = now - lastUsageAttemptMs;
		if (!document.hidden && anyAge > ONE_HOUR_MS && attemptAge > (usageEmpty ? ONE_HOUR_MS : USAGE_RETRY_MS)) {
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
