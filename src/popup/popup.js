(() => {
	'use strict';

	const SNAPSHOT_KEY = 'cc:usageSnapshot';
	const SETTINGS_KEY = 'cc:settings';
	const ISSUES_URL = 'https://github.com/kr1shnasomani/claude-token-counter/issues/new';
	const DRAFT_KEY = 'cc:feedbackDraft';

	// Mirrors CC.SETTINGS_DEFAULTS in the content script.
	const SETTINGS_DEFAULTS = {
		tokenCounter: true,
		cacheTimer: true,
		exportButton: true,
		sessionBar: true,
		weeklyBar: true,
		usageRefresh: true
	};

	function getStorage() {
		try {
			return globalThis.browser?.storage?.local || globalThis.chrome?.storage?.local || null;
		} catch {
			return null;
		}
	}

	/** "resets 4h" / "resets 6d" / "resets 12m" - coarse, like Claude's own panel. */
	function formatReset(iso) {
		const ms = Date.parse(iso);
		if (!Number.isFinite(ms)) return '';
		const diff = ms - Date.now();
		if (diff <= 0) return ' · resetting';
		const minutes = Math.round(diff / 60000);
		if (minutes < 60) return ` · resets ${minutes}m`;
		const hours = Math.round(minutes / 60);
		if (hours < 24) return ` · resets ${hours}h`;
		return ` · resets ${Math.round(hours / 24)}d`;
	}

	function ordinal(n) {
		if (n % 100 >= 11 && n % 100 <= 13) return 'th';
		return ['th', 'st', 'nd', 'rd'][n % 10] || 'th';
	}

	function formatStamp(ms) {
		const d = new Date(ms);
		const day = d.getDate();
		const month = d.toLocaleDateString(undefined, { month: 'short' });
		const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
		return `Last updated on ${day}${ordinal(day)} ${month} ${d.getFullYear()} at ${time}`;
	}

	function renderWindow(win, valueEl, fillEl) {
		if (!win || typeof win.utilization !== 'number') return false;

		// Past its reset, the stored figure is not just old - it is wrong, because the
		// window has rolled over since. Report it as out of date rather than guessing.
		const resetMs = Date.parse(win.resets_at);
		if (Number.isFinite(resetMs) && resetMs <= Date.now()) {
			valueEl.textContent = 'out of date';
			fillEl.style.width = '0%';
			fillEl.classList.remove('caution', 'warn');
			return true;
		}

		const pct = Math.max(0, Math.min(100, win.utilization));
		valueEl.textContent = `${Math.round(pct)}%${formatReset(win.resets_at)}`;
		fillEl.style.width = `${pct}%`;
		fillEl.classList.toggle('caution', pct >= 75 && pct < 90);
		fillEl.classList.toggle('warn', pct >= 90);
		return true;
	}

	function render(snapshot) {
		const empty = document.getElementById('empty');
		const content = document.getElementById('content');

		if (!snapshot) {
			empty.hidden = false;
			content.hidden = true;
			document.getElementById('stamp').textContent = '';
			return;
		}

		const hasSession = renderWindow(
			snapshot.five_hour,
			document.getElementById('sessionValue'),
			document.getElementById('sessionFill')
		);
		const hasWeekly = renderWindow(
			snapshot.seven_day,
			document.getElementById('weeklyValue'),
			document.getElementById('weeklyFill')
		);
		document.getElementById('sessionRow').hidden = !hasSession;
		document.getElementById('weeklyRow').hidden = !hasWeekly;

		// Some plans report no windows at all until the first message of a session.
		// A bare "Hourly limit" label above an empty bar looks broken; say there is
		// nothing yet instead.
		if (!hasSession && !hasWeekly) {
			empty.hidden = false;
			content.hidden = true;
			document.getElementById('stamp').textContent = '';
			return;
		}

		document.getElementById('plan').textContent = snapshot.plan ? ` · ${snapshot.plan}` : '';
		document.getElementById('stamp').textContent = formatStamp(snapshot.updatedAt);
		empty.hidden = true;
		content.hidden = false;
	}

	// chrome.* takes a callback, browser.* returns a promise and ignores it. Support
	// both, or the popup silently renders empty on one of the two browsers.
	// --- refresh ----------------------------------------------------------------
	// Reading usage means talking to claude.ai, which the popup cannot do on install
	// permissions alone. That host access is optional and requested on the first
	// click, so nobody sees a permission warning unless they ask for live numbers.

	const CLAUDE_ORIGIN = 'https://claude.ai/*';

	/** chrome.* uses callbacks, browser.* returns promises; accept either. */
	function storageGet(storage, key) {
		return new Promise((resolve) => {
			let done = false;
			const finish = (value) => {
				if (done) return;
				done = true;
				resolve(value || null);
			};
			try {
				const maybePromise = storage.get(key, finish);
				if (maybePromise && typeof maybePromise.then === 'function') maybePromise.then(finish, () => finish(null));
			} catch {
				finish(null);
			}
		});
	}

	function getPermissions() {
		try {
			return globalThis.browser?.permissions || globalThis.chrome?.permissions || null;
		} catch {
			return null;
		}
	}

	function requestHostAccess() {
		const permissions = getPermissions();
		if (!permissions) return Promise.resolve(false);
		return new Promise((resolve) => {
			let done = false;
			const finish = (granted) => {
				if (done) return;
				done = true;
				resolve(!!granted);
			};
			try {
				const maybePromise = permissions.request({ origins: [CLAUDE_ORIGIN] }, finish);
				if (maybePromise && typeof maybePromise.then === 'function') maybePromise.then(finish, () => finish(false));
			} catch {
				finish(false);
			}
		});
	}

	function normalizeWindow(raw, key) {
		const win = raw?.[key];
		if (!win || typeof win.utilization !== 'number' || !Number.isFinite(win.utilization)) return null;
		return {
			utilization: Math.max(0, Math.min(100, win.utilization)),
			resets_at: typeof win.resets_at === 'string' ? win.resets_at : null
		};
	}

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

	async function refresh() {
		const button = document.getElementById('refresh');
		const stamp = document.getElementById('stamp');

		button.classList.add('icon--busy');
		button.disabled = true;
		try {
			if (!(await requestHostAccess())) {
				stamp.textContent = 'Permission needed to refresh';
				return;
			}

			// With host access the popup can discover the account on its own, so a
			// first run works without ever having opened claude.ai in a tab.
			let orgId = current?.orgId || null;
			let plan = current?.plan || null;
			if (!orgId || !plan) {
				const orgRes = await fetch('https://claude.ai/api/organizations', { credentials: 'include' });
				if (orgRes.status === 401 || orgRes.status === 403) {
					stamp.textContent = 'Sign in to claude.ai first';
					return;
				}
				if (!orgRes.ok) throw new Error(String(orgRes.status));
				const payload = await orgRes.json();
				const list = Array.isArray(payload) ? payload : [payload];
				const org = list.find((o) => o?.uuid === orgId) || list[0];
				orgId = org?.uuid || orgId;
				plan = planFromOrg(org);
			}
			if (!orgId) {
				stamp.textContent = 'No account found';
				return;
			}

			const res = await fetch('https://claude.ai/api/organizations/' + orgId + '/usage', {
				credentials: 'include'
			});
			if (res.status === 401 || res.status === 403) {
				stamp.textContent = 'Sign in to claude.ai first';
				return;
			}
			if (!res.ok) throw new Error(String(res.status));
			const raw = await res.json();

			// Plans whose usage endpoint reports nothing would otherwise wipe a good
			// reading that came from the message stream. Keep what we already had.
			const five = normalizeWindow(raw, 'five_hour');
			const seven = normalizeWindow(raw, 'seven_day');

			current = {
				...(current || {}),
				orgId,
				plan,
				five_hour: five || current?.five_hour || null,
				seven_day: seven || current?.seven_day || null
			};

			// Only restamp the reading when the response actually carried one. Free
			// plans answer with empty windows, and moving the timestamp forward there
			// would present month-old numbers as if they had just been confirmed.
			if (five || seven) {
				current.updatedAt = Date.now();
				storage.set({ [SNAPSHOT_KEY]: current });
				render(current);
			} else {
				storage.set({ [SNAPSHOT_KEY]: current });
				render(current);
				stamp.textContent = 'Your plan does not report usage on demand';
			}
		} catch {
			stamp.textContent = 'Could not refresh';
		} finally {
			button.classList.remove('icon--busy');
			button.disabled = false;
		}
	}

	// --- settings panel ---------------------------------------------------------

	const PANELS = {
		usage: { title: 'Usage limits' },
		settings: { title: 'Settings', panel: 'settings', button: 'settingsBtn' },
		feedback: { title: 'Send feedback', panel: 'feedback', button: 'feedbackBtn' }
	};

	let panel = 'usage';

	function showPanel(name) {
		panel = PANELS[name] ? name : 'usage';
		const active = PANELS[panel];

		for (const [key, spec] of Object.entries(PANELS)) {
			if (!spec.panel) continue;
			document.getElementById(spec.panel).hidden = key !== panel;
			document.getElementById(spec.button).setAttribute('aria-pressed', String(key === panel));
		}

		document.getElementById('eyebrow').firstChild.textContent = active.title;
		document.getElementById('plan').hidden = panel !== 'usage';
		document.querySelector('.foot').hidden = panel !== 'usage';

		if (panel === 'usage') {
			render(current);
		} else {
			document.getElementById('content').hidden = true;
			document.getElementById('empty').hidden = true;
		}
	}

	function togglePanel(name) {
		showPanel(panel === name ? 'usage' : name);
	}

	/**
	 * A readable browser name. The user agent alone is not enough: Brave reports
	 * itself as plain Chrome on purpose, so a report from Brave would otherwise be
	 * filed as Chrome and sent chasing the wrong bug.
	 */
	async function describeBrowser() {
		const ua = navigator.userAgent;
		let name = 'Unknown browser';
		try {
			if (navigator.brave && (await navigator.brave.isBrave())) name = 'Brave';
		} catch {
			// not Brave, fall through to the user agent
		}
		if (name === 'Unknown browser') {
			if (/\bEdgA?\//.test(ua)) name = 'Edge';
			else if (/\bOPR\//.test(ua)) name = 'Opera';
			else if (/\bVivaldi\//.test(ua)) name = 'Vivaldi';
			else if (/\bFirefox\//.test(ua)) name = 'Firefox';
			else if (/\bChrome\//.test(ua)) name = 'Chrome';
			else if (/\bSafari\//.test(ua)) name = 'Safari';
		}

		const version = (ua.match(/(?:Edg|OPR|Vivaldi|Firefox|Chrome|Version)\/(\d+)/) || [])[1];
		const platforms = { Mac: 'macOS', Win: 'Windows', Linux: 'Linux', Android: 'Android', iPhone: 'iOS', iPad: 'iPadOS', CrOS: 'ChromeOS' };
		const key = (/(Mac|Win|Linux|Android|iPhone|iPad|CrOS)/.exec(ua) || [])[1];

		return [name, version, platforms[key] && `on ${platforms[key]}`].filter(Boolean).join(' ');
	}

	function runtimeVersion() {
		try {
			const runtime = globalThis.browser?.runtime || globalThis.chrome?.runtime;
			return runtime?.getManifest().version || 'unknown';
		} catch {
			return 'unknown';
		}
	}

	/**
	 * Opens a prefilled issue rather than posting one. Creating issues from here
	 * would mean shipping a GitHub token inside the extension, where anyone could
	 * pull it out; this way the report is submitted by the person filing it, and
	 * they see exactly what is being sent before it goes.
	 */
	async function openIssue() {
		const description = document.getElementById('feedbackText').value.trim();
		if (!description) return;

		const facts = [
			`Extension: ${runtimeVersion()}`,
			`Browser: ${await describeBrowser()}`,
			`Plan: ${current?.plan || 'unknown'}`,
			`Claude UI: ${current?.uiVariant || 'unknown'}`
		];
		const body = `${description}\n\n---\n${facts.join('\n')}\n`;
		const url = `${ISSUES_URL}?title=${encodeURIComponent(description.split('\n')[0].slice(0, 70))}&body=${encodeURIComponent(body)}`;

		window.open(url, '_blank', 'noopener');
		// The report is on its way out, so the draft has served its purpose.
		document.getElementById('feedbackText').value = '';
		storage.remove ? storage.remove(DRAFT_KEY) : storage.set({ [DRAFT_KEY]: '' });
		showPanel('usage');
	}

	function wireFeedback(storage) {
		const text = document.getElementById('feedbackText');
		const send = document.getElementById('feedbackSend');

		document.getElementById('feedbackNote').textContent =
			'Opens a prefilled issue on GitHub for you to review and submit. Your extension version, browser, plan, and which Claude layout you are on are included so the problem can be reproduced.';

		const sync = () => {
			send.disabled = !text.value.trim();
		};

		// A popup closes the moment it loses focus, which is easy to do by accident
		// halfway through writing a report. Keep the draft until it is actually sent.
		storageGet(storage, DRAFT_KEY).then((items) => {
			const draft = items?.[DRAFT_KEY];
			if (typeof draft === 'string' && draft && !text.value) text.value = draft;
			sync();
		});

		let saveTimer = null;
		text.addEventListener('input', () => {
			sync();
			clearTimeout(saveTimer);
			saveTimer = setTimeout(() => storage.set({ [DRAFT_KEY]: text.value }), 250);
		});
		sync();

		send.addEventListener('click', openIssue);
		document.getElementById('feedbackCancel').addEventListener('click', () => showPanel('usage'));
		document.getElementById('feedbackBtn').addEventListener('click', () => togglePanel('feedback'));
	}

	function wireSettings(storage) {
		const boxes = [...document.querySelectorAll('.opt input[data-key]')];

		storageGet(storage, SETTINGS_KEY).then((items) => {
			const merged = { ...SETTINGS_DEFAULTS, ...(items?.[SETTINGS_KEY] || {}) };
			for (const box of boxes) box.checked = merged[box.dataset.key] !== false;
		});

		for (const box of boxes) {
			box.addEventListener('change', () => {
				const next = {};
				for (const other of boxes) next[other.dataset.key] = other.checked;
				storage.set({ [SETTINGS_KEY]: next });
			});
		}

		document.getElementById('settingsBtn').addEventListener('click', () => togglePanel('settings'));
	}

	const storage = getStorage();
	if (!storage) {
		render(null);
		return;
	}

	let current = null;
	let settled = false;
	const done = (items) => {
		if (settled) return;
		settled = true;
		current = items?.[SNAPSHOT_KEY] || null;
		render(current);
	};
	try {
		const maybePromise = storage.get(SNAPSHOT_KEY, done);
		if (maybePromise && typeof maybePromise.then === 'function') maybePromise.then(done, () => done(null));
	} catch {
		done(null);
	}

	document.getElementById('refresh').addEventListener('click', () => {
		// Refreshing from another panel should show the numbers it just fetched.
		if (panel !== 'usage') showPanel('usage');
		refresh();
	});
	wireSettings(storage);
	wireFeedback(storage);
})();
