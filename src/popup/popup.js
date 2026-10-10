(() => {
	'use strict';

	// Shared with the content script: constants.js is loaded first by popup.html.
	const CC = globalThis.ClaudeCounter;
	const ISSUES_URL = 'https://github.com/kr7shnasomani/claude-token-counter/issues/new';
	// The same shape bridge.js insists on before an id goes into a URL path.
	const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
	const DRAFT_KEY = 'cc:feedbackDraft';
	// GitHub does not publish its limit; long links fail at around 8 KB.
	const MAX_ISSUE_URL = 7000;

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

	/** One bar per model-specific weekly limit (Fable, on the plans that have one). */
	function renderScoped(list) {
		const host = document.getElementById('scopedRows');
		const rows = (Array.isArray(list) ? list : []).map((win) => {
			const el = (tag, className) => Object.assign(document.createElement(tag), { className });
			const row = el('section', 'row');
			const head = el('div', 'row__head');
			const label = el('span', 'row__label');
			label.textContent = `${win.label} weekly limit`;
			const value = el('span', 'row__value');
			const fill = el('div', 'fill');
			const track = el('div', 'track');
			track.appendChild(fill);
			head.append(label, value);
			row.append(head, track);
			return renderWindow(win, value, fill) ? row : null;
		});
		host.replaceChildren(...rows.filter(Boolean));
	}

	function render(snapshot) {
		const empty = document.getElementById('empty');
		const content = document.getElementById('content');

		const showEmpty = () => {
			empty.hidden = false;
			content.hidden = true;
			document.getElementById('stamp').textContent = '';
		};

		if (!snapshot) return showEmpty();

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
		renderScoped(snapshot.scoped);

		// Some plans report no windows at all until the first message of a session.
		// A bare "Hourly limit" label above an empty bar looks broken; say there is
		// nothing yet instead.
		if (!hasSession && !hasWeekly) return showEmpty();

		document.getElementById('plan').textContent = snapshot.plan ? ` · ${snapshot.plan}` : '';
		document.getElementById('stamp').textContent = formatStamp(snapshot.updatedAt);
		empty.hidden = true;
		content.hidden = false;
	}

	// --- refresh ----------------------------------------------------------------
	// Reading usage means talking to claude.ai, which the popup cannot do on install
	// permissions alone. That host access is optional and requested on the first
	// click, so nobody sees a permission warning unless they ask for live numbers.

	const CLAUDE_ORIGIN = 'https://claude.ai/*';

	async function requestHostAccess() {
		try {
			const permissions = globalThis.browser?.permissions || globalThis.chrome?.permissions;
			return !!(await permissions?.request({ origins: [CLAUDE_ORIGIN] }));
		} catch {
			return false;
		}
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
			let orgId = ID_PATTERN.test(current?.orgId) ? current.orgId : null;
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
				orgId = ID_PATTERN.test(org?.uuid) ? org.uuid : orgId;
				plan = CC.planFromOrg(org);
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
			const five = CC.usageWindow(raw?.five_hour);
			const seven = CC.usageWindow(raw?.seven_day);

			current = {
				...(current || {}),
				orgId,
				plan,
				five_hour: five || current?.five_hour || null,
				seven_day: seven || current?.seven_day || null
			};
			// A response that lists limits is the whole story, so an account that no
			// longer has a per-model one loses its bar; one that does not list any
			// (free) leaves what was stored.
			if (Array.isArray(raw?.limits)) current.scoped = CC.scopedWindows(raw);

			// Only restamp the reading when the response actually carried one. Free
			// plans answer with empty windows, and moving the timestamp forward there
			// would present month-old numbers as if they had just been confirmed.
			if (five || seven) current.updatedAt = Date.now();
			storage.set({ [CC.SNAPSHOT_KEY]: current });
			render(current);
			if (!five && !seven) stamp.textContent = 'Your plan does not report usage on demand';
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

	const yn = (v) => (v ? 'yes' : 'no');

	/** The page-side facts a layout bug needs, as report lines. Empty if none yet. */
	function diagLines(d) {
		if (!d || typeof d !== 'object') return [];
		const lines = [
			`Claude build: ${d.build || 'unknown'}${d.buildDate ? ` (${d.buildDate})` : ''}, colors ${d.colors || 'unknown'}`,
			`Layout: composer=${d.composer || 'none'}, header=${d.header || 'none'}, export=${d.exportAt || 'header'}, cds-root=${yn(d.cdsRoot)}`,
			`Shown: tokens=${yn(d.tokens)} timer=${yn(d.timer)} usageRow=${yn(d.usageRow)} export=${yn(d.exportBtn)}`
		];
		if (Array.isArray(d.floating) && d.floating.length) lines.push(`Floating, no place found: ${d.floating.join(', ')}`);
		if (Array.isArray(d.disabled) && d.disabled.length) lines.push(`Turned off in settings: ${d.disabled.join(', ')}`);
		if (Array.isArray(d.errors) && d.errors.length) lines.push(`Errors: ${d.errors.join('; ')}`);
		return lines;
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

		const diag = (await CC.storageGet(CC.DIAG_KEY))?.[CC.DIAG_KEY];
		const facts = [
			`Extension: ${runtimeVersion()}`,
			`Browser: ${await describeBrowser()}`,
			`Plan: ${current?.plan || diag?.plan || 'unknown'}`,
			`Claude UI: ${diag?.composer || current?.uiVariant || 'unknown'}`,
			// Both unknown can mean the extension never ran on claude.ai - a tab open
			// before install is not injected until it is reloaded - rather than a bug.
			...(diag || current ? [] : ['Seen on claude.ai: no (no claude.ai tab has reported since install or reload)']),
			...diagLines(diag)
		];
		// GitHub answers an over-long URL with 414 and no form, and encoding makes
		// non-Latin text nine times longer. Trim the description to fit, and keep the
		// draft when it was trimmed, so the full text is never lost.
		const build = (text) => `${ISSUES_URL}?title=${encodeURIComponent(description.split('\n')[0].slice(0, 70))}&body=${encodeURIComponent(`${text}\n\n---\n${facts.join('\n')}\n`)}`;
		let sent = description;
		let url = build(sent);
		while (url.length > MAX_ISSUE_URL && sent.length > 1) {
			sent = sent.slice(0, Math.floor(sent.length * 0.9));
			url = build(`${sent}\n\n[cut to fit the link; paste the rest from the extension's feedback box]`);
		}

		window.open(url, '_blank', 'noopener');
		if (sent === description) {
			// The whole report is on its way out, so the draft has served its purpose.
			document.getElementById('feedbackText').value = '';
			storage.remove(DRAFT_KEY);
		}
		showPanel('usage');
	}

	function wireFeedback(storage) {
		const text = document.getElementById('feedbackText');
		const send = document.getElementById('feedbackSend');

		const sync = () => {
			send.disabled = !text.value.trim();
		};

		// A popup closes the moment it loses focus, which is easy to do by accident
		// halfway through writing a report. Keep the draft until it is actually sent.
		CC.storageGet(DRAFT_KEY).then((items) => {
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

		CC.storageGet(CC.SETTINGS_KEY).then((items) => {
			const merged = { ...CC.SETTINGS_DEFAULTS, ...(items?.[CC.SETTINGS_KEY] || {}) };
			for (const box of boxes) box.checked = merged[box.dataset.key] !== false;
		});

		for (const box of boxes) {
			box.addEventListener('change', () => {
				const next = {};
				for (const other of boxes) next[other.dataset.key] = other.checked;
				storage.set({ [CC.SETTINGS_KEY]: next });
			});
		}

		document.getElementById('settingsBtn').addEventListener('click', () => togglePanel('settings'));
	}

	const storage = CC.getStorage();
	if (!storage) {
		render(null);
		return;
	}

	let current = null;
	CC.storageGet(CC.SNAPSHOT_KEY).then((items) => {
		current = items?.[CC.SNAPSHOT_KEY] || null;
		render(current);
	});

	document.getElementById('refresh').addEventListener('click', () => {
		// Refreshing from another panel should show the numbers it just fetched.
		if (panel !== 'usage') showPanel('usage');
		refresh();
	});
	wireSettings(storage);
	wireFeedback(storage);
})();
