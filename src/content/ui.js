(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	function formatSeconds(totalSeconds) {
		const minutes = Math.floor(totalSeconds / 60);
		const seconds = totalSeconds % 60;
		return `${minutes}:${String(seconds).padStart(2, '0')}`;
	}

	function formatResetCountdown(timestampMs) {
		// <= 0: reset time reached
		const diffMs = timestampMs - Date.now();
		if (diffMs <= 0) return '0s';

		// < 1 min: show seconds
		const totalSeconds = Math.floor(diffMs / 1000);
		if (totalSeconds < 60) return `${totalSeconds}s`;

		// < 1 hour: show minutes
		const totalMinutes = Math.round(totalSeconds / 60);
		if (totalMinutes < 60) return `${totalMinutes}m`;

		// < 1 day: show hours
		const hours = Math.floor(totalMinutes / 60);
		const minutes = totalMinutes % 60;
		if (hours < 24) return `${hours}h ${minutes}m`;

		// >= 1 day: show days
		const days = Math.floor(hours / 24);
		const remHours = hours % 24;
		return `${days}d ${remHours}h`;
	}

	// Shown in the token counter's popover. Product facts, so they sit in one place.
	const CONTEXT_SIZES = [['Sonnet 5', '1M'], ['Opus 4.8', '500K'], ['Other models', '200K']];

	// One tooltip for the whole UI, drawn to Claude's own tooltip spec (see
	// styles.css), so hovering anything we add looks like hovering anything of theirs.
	const TOOLTIP_DELAY_MS = 300;
	// Long enough to carry the pointer from the element onto its tooltip.
	const TOOLTIP_GRACE_MS = 200;
	let sharedTip = null;
	let tipOwner = null;
	let tipAction = null;
	let tipGraceTimer = null;

	function tipElement() {
		if (!sharedTip) {
			sharedTip = document.createElement('div');
			sharedTip.className = 'cc-tooltip';
			sharedTip.setAttribute('role', 'tooltip');
			// A tooltip that offers an action has to be reachable: it stays while the
			// pointer is on it, and clicking it does what it says.
			sharedTip.addEventListener('pointerenter', () => clearTimeout(tipGraceTimer));
			sharedTip.addEventListener('pointerleave', () => hideTip(tipOwner));
			sharedTip.addEventListener('click', (e) => {
				const action = tipAction;
				if (action) action(e);
			});
		}
		if (!sharedTip.parentElement) document.body.appendChild(sharedTip);
		return sharedTip;
	}

	function hideTip(owner) {
		clearTimeout(tipGraceTimer);
		if (!sharedTip || (owner && tipOwner !== owner)) return;
		sharedTip.classList.remove('cc-tooltip--on', 'cc-tooltip--action');
		tipOwner = null;
		tipAction = null;
	}

	/**
	 * Place a floating box beside `anchor`, kept inside the window: above it by
	 * default (tooltips), or under it (menus and popovers), flipping when there is
	 * no room.
	 */
	function placeNear(box, anchor, gap, below = false) {
		// Measured from the corner, so a box near an edge is not squeezed before it is placed.
		box.style.left = '0px';
		box.style.top = '0px';
		const a = anchor.getBoundingClientRect();
		const b = box.getBoundingClientRect();
		const left = Math.max(8, Math.min(a.left + a.width / 2 - b.width / 2, window.innerWidth - b.width - 8));
		const under = a.bottom + gap;
		const over = a.top - b.height - gap;
		let top;
		if (below) top = under + b.height > window.innerHeight - 8 && over >= 8 ? over : under;
		else top = over < 8 ? under : over;
		box.style.left = `${left}px`;
		box.style.top = `${top}px`;
	}

	function showTip(owner, text, hint, action) {
		const tip = tipElement();
		clearTimeout(tipGraceTimer);
		tip.replaceChildren(document.createTextNode(text));
		if (hint) tip.appendChild(Object.assign(document.createElement('span'), { className: 'cc-tooltip__hint', textContent: hint }));
		tipOwner = owner;
		tipAction = action;
		placeNear(tip, owner, 6);
		tip.classList.toggle('cc-tooltip--action', !!action);
		tip.classList.add('cc-tooltip--on');
	}

	/**
	 * Explain `element` on hover. With `hint` and `action`, the tooltip carries a
	 * cue ("Click for details") and is itself clickable: the cue is not decoration.
	 */
	function setupTooltip(element, text, hint = '', action = null) {
		if (!element) return;
		element.classList.add('cc-tooltipTrigger');

		let showTimer;
		let pressTimer;
		let hideTimer;
		const hide = () => {
			clearTimeout(showTimer);
			clearTimeout(pressTimer);
			clearTimeout(hideTimer);
			hideTip(element);
		};
		const show = () => showTip(element, text, hint, action);

		// A short delay, as Claude's own tooltips have, so passing over does not flash one.
		element.addEventListener('pointerenter', (e) => {
			if (e.pointerType !== 'mouse') return;
			clearTimeout(showTimer);
			clearTimeout(tipGraceTimer);
			showTimer = setTimeout(show, TOOLTIP_DELAY_MS);
		});
		element.addEventListener('pointerleave', (e) => {
			if (e.pointerType !== 'mouse') return;
			if (!action) return hide();
			// Give the pointer time to reach the tooltip before taking it away.
			clearTimeout(showTimer);
			clearTimeout(tipGraceTimer);
			tipGraceTimer = setTimeout(() => hideTip(element), TOOLTIP_GRACE_MS);
		});
		element.addEventListener('pointerdown', (e) => {
			if (e.pointerType === 'touch' || e.pointerType === 'pen') {
				pressTimer = setTimeout(() => {
					show();
					hideTimer = setTimeout(hide, 3000);
				}, 500);
			} else {
				hide(); // a click is its own answer
			}
		});
		element.addEventListener('pointerup', () => clearTimeout(pressTimer));
		element.addEventListener('pointercancel', hide);
		// Keyboard users get it too, but a mouse click that happens to focus must not.
		element.addEventListener('focus', () => {
			if (element.matches?.(':focus-visible')) show();
		});
		element.addEventListener('blur', hide);
	}

	/** A usage bar: track, fill and elapsed-time marker. */
	function makeBar() {
		const bar = document.createElement('div');
		bar.className = 'cc-bar';
		const fill = document.createElement('div');
		fill.className = 'cc-bar__fill';
		const marker = document.createElement('div');
		marker.className = 'cc-bar__marker cc-hidden';
		bar.appendChild(fill);
		bar.appendChild(marker);
		return { bar, fill, marker };
	}

	/** Paint one usage window into its label and bar. Returns its reset time in ms, or null. */
	function paintWindow(win, label, span, fill) {
		if (typeof win?.utilization !== 'number') {
			span.textContent = '';
			fill.style.width = '0%';
			fill.classList.remove('cc-caution', 'cc-warn', 'cc-full');
			return null;
		}
		const resetMs = win.resets_at ? Date.parse(win.resets_at) : null;
		const pct = Math.round(win.utilization * 10) / 10;
		span.textContent = `${label}: ${pct}%${resetMs ? ` (resets in ${formatResetCountdown(resetMs)})` : ''}`;

		const width = Math.max(0, Math.min(100, win.utilization));
		fill.style.width = `${width}%`;
		fill.classList.toggle('cc-caution', width >= 75 && width < 90);
		fill.classList.toggle('cc-warn', width >= 90);
		fill.classList.toggle('cc-full', width >= 99.5);
		return resetMs;
	}

	/** Rewrite the "(resets in ...)" tail of a usage label as the clock moves. */
	function retimeReset(span, resetMs) {
		const text = span?.textContent;
		const idx = resetMs && text ? text.indexOf('(resets in') : -1;
		if (idx !== -1) span.textContent = `${text.slice(0, idx + '(resets in '.length)}${formatResetCountdown(resetMs)})`;
	}

	const SVG_NS = 'http://www.w3.org/2000/svg';

	/** Build an icon through the DOM, so no markup is ever parsed from a string. */
	function svgIcon(className, size, shapes) {
		const svg = document.createElementNS(SVG_NS, 'svg');
		const base = {
			class: className,
			viewBox: '0 0 24 24',
			fill: 'none',
			stroke: 'currentColor',
			'stroke-width': '2.2',
			'stroke-linecap': 'round',
			'stroke-linejoin': 'round',
			width: String(size),
			height: String(size),
			'aria-hidden': 'true'
		};
		for (const [name, value] of Object.entries(base)) svg.setAttribute(name, value);
		for (const [tag, attrs] of shapes) {
			const shape = document.createElementNS(SVG_NS, tag);
			for (const [name, value] of Object.entries(attrs)) shape.setAttribute(name, value);
			svg.appendChild(shape);
		}
		return svg;
	}

	/** Text for screen readers only: the labels the chip no longer shows. */
	function srText(text) {
		return Object.assign(document.createElement('span'), { className: 'cc-sr', textContent: text });
	}

	/**
	 * Identify the composer card by what it looks like rather than what it is called.
	 * Enterprise ships different markup from consumer plans - no `rounded-composer`
	 * class - but on both variants the card is the nearest ancestor of the text input
	 * that is a flex column with a real corner radius and a painted background.
	 */
	function findComposerCard(input) {
		let el = input?.parentElement;
		for (let hops = 0; el && el !== document.body && hops < 8; hops++, el = el.parentElement) {
			const style = window.getComputedStyle(el);
			if (style.display !== 'flex' || style.flexDirection !== 'column') continue;
			if (parseFloat(style.borderRadius) < 4) continue;
			const bg = style.backgroundColor;
			if (!bg || bg === 'transparent' || bg.replace(/\s/g, '') === 'rgba(0,0,0,0)') continue;
			return el;
		}
		return null;
	}

	/**
	 * The group inside the chat header that holds the conversation title: the first
	 * child with visible text. Used when a variant does not ship the title testid.
	 */
	function findHeaderTitleGroup(header) {
		for (const child of header.children) {
			if (child.tagName === 'BUTTON') continue;
			if (!child.textContent || !child.textContent.trim()) continue;
			const rect = child.getBoundingClientRect();
			if (rect.width < 1 || rect.height < 1) continue;
			return child;
		}
		return null;
	}

	// How long a floating part waits before trying its real place again.
	const FLOAT_RETRY_MS = 30000;

	class CounterUI {
		constructor({ onUsageRefresh, onExport } = {}) {
			this.onUsageRefresh = onUsageRefresh || null;
			this.onExport = onExport || null;

			this.exportBtn = null;
			this.exportIcon = null;
			this.exportMenu = null;
			// True while the button sits in Claude's top-right action group, wearing
			// the classes it borrowed from a neighbouring icon button.
			this.exportDocked = false;
			this.nativeExportClasses = [];
			// The action group is drawn after the header, so for the first moments of a
			// page there is nowhere to dock yet. Showing the button beside the counter in
			// the meantime made it flash there before jumping to its real place; it is
			// held back, and only shown in the header once no group has turned up.
			this.createdAt = Date.now();
			this.exportFallbackOk = false;
			this.exportingChat = false;

			this.headerContainer = null;
			this.headerDisplay = null;
			this.lengthGroup = null;
			this.lengthDisplay = null;
			this.lengthValueSpan = null;
			this.cachedDisplay = null;
			this.contextPopover = null;
			this._toggleContext = null;
			this.lastCachedUntilMs = null;
			this.pendingCache = false;
			this.pendingCacheTimeoutId = null;

			this.usageLine = null;
			this.sessionUsageSpan = null;
			this.weeklyUsageSpan = null;
			this.sessionBar = null;
			this.sessionBarFill = null;
			this.weeklyBar = null;
			this.weeklyBarFill = null;
			this.sessionResetMs = null;
			this.weeklyResetMs = null;
			this.sessionMarker = null;
			this.weeklyMarker = null;
			// Latched the moment a reading proves the nominal window length wrong.
			// Never cleared: one contradiction is enough to know the figure does
			// not describe this account, and the marker stays hidden after it.
			this.sessionWindowLengthUnknown = false;
			this.weeklyWindowLengthUnknown = false;
			this.refreshingUsage = false;
			this.refreshBtn = null;

			this.domObserver = null;
			this.settings = { ...CC.SETTINGS_DEFAULTS };
			this.hasUsageData = false;
			this.usageUnavailable = false;
			this.hasSessionData = false;
			this.hasWeeklyData = false;
			this.headerTier = null;
			// Last resort, see _ensureShown: how long each part has gone unseen, and when
			// a floating one may next try its real place again.
			this.unseen = { header: 0, usage: 0 };
			this.floatRetryAt = { header: 0, usage: 0 };
		}

		/** Apply a settings change without needing fresh usage data. */
		applySettings(settings) {
			this.settings = { ...CC.SETTINGS_DEFAULTS, ...(settings || {}) };
			this._syncUsageVisibility();
			this._renderHeader();
		}

		/**
		 * The account reports no usage windows at all. Free plans only publish them
		 * once a message has been sent, so say that rather than leaving a blank space
		 * that looks like a failure.
		 */
		markUsageUnavailable() {
			if (this.hasUsageData) return;
			this.usageUnavailable = true;
			this._syncUsageVisibility();
		}

		_syncUsageVisibility() {
			// Settings decide what may be shown; data decides whether anything is. A
			// settings change arriving before the first reading must not reveal an
			// empty row.
			this.usageHint?.classList.toggle('cc-hidden', this.hasUsageData || !this.usageUnavailable);
			if (!this.hasUsageData) {
				this.sessionGroup?.classList.add('cc-hidden');
				this.weeklyGroup?.classList.add('cc-hidden');
				this.refreshBtn?.classList.toggle('cc-hidden', !this.settings.usageRefresh);
				this.usageLine?.classList.toggle('cc-hidden', !this.usageUnavailable);
				return;
			}

			// Each bar needs a setting AND data behind it. Neither window can be
			// assumed present: some plans report one, the other, or neither.
			const { sessionBar, weeklyBar, usageRefresh } = this.settings;
			const showSession = sessionBar && this.hasSessionData;
			const showWeekly = weeklyBar && this.hasWeeklyData;

			// A window with no current figure keeps its place, marked unknown, rather
			// than vanishing: one bar on its own reads as a fault, where a pair with
			// one blank reads as what it is.
			this.sessionGroup?.classList.toggle('cc-hidden', !sessionBar);
			this.weeklyGroup?.classList.toggle('cc-hidden', !weeklyBar);
			this.sessionGroup?.classList.toggle('cc-usageGroup--single', !weeklyBar);
			this.weeklyGroup?.classList.toggle('cc-usageGroup--single', !sessionBar);
			this.sessionUsageSpan?.classList.toggle('cc-usageUnknown', !this.hasSessionData);
			this.weeklyUsageSpan?.classList.toggle('cc-usageUnknown', !this.hasWeeklyData);
			this.refreshBtn?.classList.toggle('cc-hidden', !usageRefresh);
			this.usageLine?.classList.toggle('cc-hidden', !showSession && !showWeekly);
			if (!this.hasSessionData) {
				this.sessionUsageSpan.textContent = 'Hourly: \u2014';
				this.sessionBarFill.style.width = '0%';
			}
			if (!this.hasWeeklyData) {
				this.weeklyUsageSpan.textContent = 'Weekly: \u2014';
				this.weeklyBarFill.style.width = '0%';
			}
		}

		initialize() {
			// Header container (tokens + cache timer)
			this.headerContainer = document.createElement('div');
			this.headerContainer.className = 'text-text-500 text-xs !px-1 cc-header';

			this.headerDisplay = document.createElement('span');
			this.headerDisplay.className = 'cc-headerItem';

			this.lengthGroup = document.createElement('span');
			this.lengthGroup.className = 'cc-headerPart';
			this.lengthDisplay = document.createElement('span');
			this.cachedDisplay = document.createElement('span');
			this.cachedDisplay.className = 'cc-headerPart';
			this.cacheTimeSpan = null; // reference to inner time span

			this.lengthGroup.appendChild(this.lengthDisplay);
			this.headerDisplay.appendChild(this.lengthGroup);

			// Usage line (session + weekly)
			this._initUsageLine();
			this._initExportButton();
			this._initContextPopover();

			this._setupTooltips();
			this._observeDom();
		}

		_observeDom() {
			// At most one search per second: this runs on every mutation batch, which
			// during token streaming is hundreds of times a second, and a layout we
			// cannot attach to would otherwise repeat the search on all of them.
			const RETRY_MS = 1000;
			let lastUsageAttempt = 0;
			let lastHeaderAttempt = 0;
			let lastHeaderCheck = 0;
			let retryTimer = null;

			const check = () => {
				retryTimer = null;
				const now = Date.now();
				const usageMissing = this.usageLine && !document.contains(this.usageLine);
				const headerMissing = !document.contains(this.headerContainer);
				// The header can exist before the title inside it does. Attached to a
				// lower tier in the meantime, the counter would never move to its
				// proper place once the title rendered, so look again - but only
				// after the throttle, as this runs on every mutation batch.
				// Advanced on every check, not only on a reattach: left to the latter it
				// stayed "due" on a healthy page and the queries below ran on every batch.
				const checkDue = now - lastHeaderCheck >= RETRY_MS;
				if (checkDue) lastHeaderCheck = now;
				const headerFloating = this.headerContainer.classList.contains('cc-floating');
				const headerOffTitle =
					!headerMissing && !headerFloating && checkDue && this.headerTier !== 'title' &&
					!!document.querySelector(CC.DOM.CHAT_MENU_TRIGGER);
				const exportStale = checkDue && this._exportStale();
				// Floating is a last resort, not a home: look for the real place again
				// now and then, but not so often that it flickers between the two.
				const headerFloatRetry = headerFloating && now >= this.floatRetryAt.header;
				const usageFloatRetry = !!this.usageLine?.classList.contains('cc-floating') && now >= this.floatRetryAt.usage;

				const usageWants = usageMissing || usageFloatRetry;
				const headerWants = headerMissing || headerOffTitle || exportStale || headerFloatRetry;
				const usageDue = now - lastUsageAttempt >= RETRY_MS;
				const headerDue = now - lastHeaderAttempt >= RETRY_MS;

				// The attach methods do nothing while their anchor is absent, so there
				// is nothing to wait for: the next batch that brings it tries again.
				if (usageWants && usageDue) {
					lastUsageAttempt = now;
					this.floatRetryAt.usage = now + FLOAT_RETRY_MS;
					this.attachUsageLine();
				}
				if (headerWants && headerDue) {
					lastHeaderAttempt = now;
					this.floatRetryAt.header = now + FLOAT_RETRY_MS;
					this.attachHeader();
				}

				// A batch that wanted a place but fell inside the throttle may be the one
				// that brought the anchor, and an idle page sends no second batch. (The
				// comparisons above are >=: a timer can fire a millisecond early.)
				if (((usageWants && !usageDue) || (headerWants && !headerDue)) && !retryTimer) {
					retryTimer = setTimeout(check, RETRY_MS);
				}
			};

			this.domObserver = new MutationObserver(check);
			this.domObserver.observe(document.body, { childList: true, subtree: true });
		}

		_initUsageLine() {
			this.usageLine = document.createElement('div');
			this.usageLine.className =
				'text-text-400 text-[11px] cc-usageRow cc-hidden flex flex-row items-center gap-3 w-full';

			// Shown when the account reports no usage at all, so an empty row does not
			// read as a broken extension.
			this.usageHint = document.createElement('span');
			this.usageHint.className = 'cc-usageText cc-usageHint cc-hidden';
			this.usageHint.textContent = 'Send a message to see usage';

			this.sessionUsageSpan = document.createElement('span');
			this.sessionUsageSpan.className = 'cc-usageText';

			({ bar: this.sessionBar, fill: this.sessionBarFill, marker: this.sessionMarker } = makeBar());

			this.weeklyUsageSpan = document.createElement('span');
			this.weeklyUsageSpan.className = 'cc-usageText';

			({ bar: this.weeklyBar, fill: this.weeklyBarFill, marker: this.weeklyMarker } = makeBar());

			this.sessionGroup = document.createElement('div');
			this.sessionGroup.className = 'cc-usageGroup';
			this.sessionGroup.appendChild(this.sessionUsageSpan);
			this.sessionGroup.appendChild(this.sessionBar);

			this.weeklyGroup = document.createElement('div');
			this.weeklyGroup.className = 'cc-usageGroup cc-usageGroup--weekly';
			this.weeklyGroup.appendChild(this.weeklyBar);
			this.weeklyGroup.appendChild(this.weeklyUsageSpan);

			this.refreshBtn = document.createElement('button');
			this.refreshBtn.className = 'cc-refreshBtn';
			this.refreshBtn.setAttribute('aria-label', 'Refresh usage');
			this.refreshBtn.appendChild(
				svgIcon('cc-refreshIcon', 11, [
					['polyline', { points: '23 4 23 10 17 10' }],
					['path', { d: 'M20.49 15a9 9 0 1 1-2.12-9.36L23 10' }]
				])
			);

			this.usageLine.appendChild(this.usageHint);
			this.usageLine.appendChild(this.sessionGroup);
			this.usageLine.appendChild(this.weeklyGroup);
			this.usageLine.appendChild(this.refreshBtn);


			this.refreshBtn.addEventListener('click', async (e) => {
				e.stopPropagation();
				if (!this.onUsageRefresh || this.refreshingUsage) return;
				this.refreshingUsage = true;
				this.refreshBtn.classList.add('cc-refreshBtn--spinning');
				this.usageLine.classList.add('cc-usageRow--dim');
				try {
					await this.onUsageRefresh();
				} finally {
					this.refreshBtn.classList.remove('cc-refreshBtn--spinning');
					this.usageLine.classList.remove('cc-usageRow--dim');
					this.refreshingUsage = false;
				}
			});
		}

		_initExportButton() {
			this.exportBtn = document.createElement('button');
			this.exportBtn.className = 'cc-exportBtn';
			this.exportBtn.setAttribute('aria-label', 'Export conversation');
			this.exportBtn.setAttribute('aria-haspopup', 'menu');
			this.exportIcon = svgIcon('cc-exportIcon', 11, [
				['path', { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' }],
				['polyline', { points: '7 10 12 15 17 10' }],
				['line', { x1: '12', y1: '15', x2: '12', y2: '3' }]
			]);
			this.exportBtn.appendChild(this.exportIcon);

			this.exportMenu = document.createElement('div');
			this.exportMenu.className = 'cc-exportMenu cc-hidden';
			this.exportMenu.setAttribute('role', 'menu');

			for (const [format, label] of [['md', 'Markdown (.md)'], ['txt', 'Plain text (.txt)']]) {
				const item = document.createElement('button');
				item.className = 'cc-exportMenuItem';
				item.setAttribute('role', 'menuitem');
				item.textContent = label;
				item.addEventListener('click', (e) => {
					e.stopPropagation();
					this._closeExportMenu();
					this._runExport(format);
				});
				this.exportMenu.appendChild(item);
			}
			document.body.appendChild(this.exportMenu);

			this.exportBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				if (this.exportMenu.classList.contains('cc-hidden')) this._openExportMenu();
				else this._closeExportMenu();
			});

			document.addEventListener('click', () => this._closeFloaters());
			document.addEventListener('keydown', (e) => {
				if (e.key === 'Escape') this._closeFloaters();
			});
		}

		/** The token counter's click popover: the context sizes the old tooltip crammed in. */
		_initContextPopover() {
			const pop = document.createElement('div');
			pop.className = 'cc-popover cc-hidden';
			pop.setAttribute('role', 'dialog');
			pop.setAttribute('aria-label', 'Context window');
			const line = (className, text) => Object.assign(document.createElement('div'), { className, textContent: text });
			pop.appendChild(line('cc-popover__title', 'Max context \u00B7 paid plans'));
			for (const [model, size] of CONTEXT_SIZES) {
				const row = line('cc-popover__row', '');
				row.appendChild(Object.assign(document.createElement('span'), { textContent: model }));
				row.appendChild(Object.assign(document.createElement('span'), { textContent: size }));
				pop.appendChild(row);
			}
			pop.appendChild(line('cc-popover__note', 'Free plan: 200K, Haiku and Sonnet only. The count no longer applies after context compaction.'));
			document.body.appendChild(pop);
			this.contextPopover = pop;

			const trigger = this.lengthGroup;
			trigger.setAttribute('role', 'button');
			trigger.setAttribute('tabindex', '0');
			trigger.setAttribute('aria-haspopup', 'dialog');
			trigger.setAttribute('aria-expanded', 'false');
			const toggle = (e) => {
				e.stopPropagation();
				const opening = pop.classList.contains('cc-hidden');
				this._closeFloaters();
				if (!opening) return;
				hideTip(trigger);
				pop.classList.remove('cc-hidden');
				trigger.setAttribute('aria-expanded', 'true');
				placeNear(pop, trigger, 6, true);
			};
			this._toggleContext = toggle;
			trigger.addEventListener('click', toggle);
			trigger.addEventListener('keydown', (e) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					toggle(e);
				}
			});
		}

		_openExportMenu() {
			this._closeFloaters();
			this.exportMenu.classList.remove('cc-hidden');
			placeNear(this.exportMenu, this.exportBtn, 6, true);
		}

		_closeExportMenu() {
			this.exportMenu?.classList.add('cc-hidden');
		}

		/** Close whichever of our menus and popovers is open. */
		_closeFloaters() {
			this._closeExportMenu();
			this.contextPopover?.classList.add('cc-hidden');
			this.lengthGroup?.setAttribute('aria-expanded', 'false');
		}

		async _runExport(format) {
			if (!this.onExport || this.exportingChat) return;
			this.exportingChat = true;
			this.exportBtn.classList.add('cc-exportBtn--busy');
			try {
				await this.onExport(format);
			} catch {
				// An explicit click that silently does nothing is worse than a wrong
				// answer, so flash the button rather than failing invisibly.
				this.exportBtn.classList.add('cc-exportBtn--error');
				setTimeout(() => this.exportBtn?.classList.remove('cc-exportBtn--error'), 2000);
			} finally {
				this.exportBtn.classList.remove('cc-exportBtn--busy');
				this.exportingChat = false;
			}
		}

		_setupTooltips() {
			setupTooltip(this.lengthGroup, "Approximate tokens, excluding the system prompt. May differ from Claude's own count.", 'Click for details', (e) => this._toggleContext(e));
			setupTooltip(this.cachedDisplay, 'Cached context timer. Messages sent while cached are significantly cheaper.');
			setupTooltip(this.exportBtn, 'Export as Markdown or plain text. Active branch only.');
			setupTooltip(this.refreshBtn, 'Refresh usage');
			setupTooltip(this.sessionGroup, "5-hour session window. The thin line shows how far through it you are.");
			setupTooltip(this.weeklyGroup, "7-day usage window. The thin line shows how far through it you are.");
		}

		attachHeader() {
			this._placeExport();
			const anchor = document.querySelector(CC.DOM.CHAT_MENU_TRIGGER);
			if (anchor) {
				this.headerTier = 'title';
				if (anchor.nextElementSibling !== this.headerContainer) anchor.after(this.headerContainer);
			} else {
				// Not every Claude variant ships the title testid. Fall back to the
				// header's own title group so the counter and the export button stay
				// reachable instead of vanishing.
				// The previous Claude design ships neither testid - only a semantic
				// <header> - so fall through to that before giving up.
				// Home, settings and the rest have a <header> too, and nothing to count.
				if (!/\/chat\//.test(window.location.pathname)) {
					this.headerTier = 'none';
					return;
				}
				const testidHeader = document.querySelector(CC.DOM.CHAT_HEADER);
				const header = testidHeader || document.querySelector(CC.DOM.HEADER_FALLBACK);
				if (!header) {
					this.headerTier = 'none';
					return;
				}
				this.headerTier = testidHeader ? 'header-testid' : 'semantic-header';
				const host = findHeaderTitleGroup(header) || header;
				if (this.headerContainer.parentElement !== host) host.appendChild(this.headerContainer);
			}
			this.headerContainer.classList.remove('cc-floating');
			this._renderHeader();
		}

		/**
		 * Claude's top-right action group and an icon button in it to copy, or null
		 * when there is nothing to dock beside (home page, or a layout without the
		 * group). Our own button is skipped: once docked it carries the same
		 * attributes, and would otherwise be found as its own model.
		 */
		_actionsTarget() {
			if (!/\/chat\//.test(window.location.pathname)) return null;
			const host = document.querySelector(CC.DOM.ACTIONS_HOST);
			if (!host) return null;
			const ref = [...host.querySelectorAll(CC.DOM.ACTIONS_ICON_BUTTON)].find((b) => b !== this.exportBtn);
			return ref ? { host, ref } : null;
		}

		/** Is the export button where it should be? Cheap enough for the throttled observer. */
		_exportStale() {
			if (!this.exportBtn) return false;
			const target = this._actionsTarget();
			if (!target) return this.exportDocked;
			return !this.exportDocked || this.exportBtn.parentElement !== target.host;
		}

		/**
		 * Put the export button beside Claude's own page icon, looking like it, or
		 * back beside the token counter when there is no such icon. Claude moves and
		 * re-renders that group as panels open and close, so this is re-run from the
		 * DOM observer rather than trusted to stick.
		 */
		_placeExport() {
			const btn = this.exportBtn;
			if (!btn) return;
			const target = this._actionsTarget();
			if (!target) {
				if (this.exportDocked) this._undockExport();
				return;
			}
			if (!this.exportDocked) this._dockExport(target.ref);
			// Left of the page icon: first in the group. Only touch the DOM when it is
			// not already so, or the observer would chase its own tail.
			if (btn.parentElement !== target.host || target.host.firstElementChild !== btn) target.host.prepend(btn);
			this._syncExportVisibility();
		}

		_dockExport(ref) {
			const btn = this.exportBtn;
			for (const name of ['data-cds', 'data-cds-icon-only', 'data-cds-ghost', 'data-size']) {
				if (ref.hasAttribute(name)) btn.setAttribute(name, ref.getAttribute(name));
			}
			this.nativeExportClasses = String(ref.className).split(/\s+/).filter(Boolean);
			btn.classList.remove('cc-exportBtn');
			btn.classList.add('cc-exportBtn--docked', ...this.nativeExportClasses);

			// Claude's buttons paint their background in a child span; borrow that
			// too, or hover and focus would have nothing to draw on.
			const inner = document.createElement('span');
			inner.className = 'inline-flex min-w-0 items-center gap-1';
			inner.appendChild(this.exportIcon);
			const paint = ref.firstElementChild?.cloneNode(true);
			btn.replaceChildren(...(paint ? [paint, inner] : [inner]));
			this.exportIcon.setAttribute('width', '18');
			this.exportIcon.setAttribute('height', '18');
			this.exportIcon.setAttribute('stroke-width', '1.75');
			this.exportDocked = true;
		}

		_undockExport() {
			const btn = this.exportBtn;
			for (const name of ['data-cds', 'data-cds-icon-only', 'data-cds-ghost', 'data-size']) btn.removeAttribute(name);
			btn.classList.remove('cc-exportBtn--docked', ...this.nativeExportClasses);
			btn.classList.add('cc-exportBtn');
			this.nativeExportClasses = [];
			btn.replaceChildren(this.exportIcon);
			this.exportIcon.setAttribute('width', '11');
			this.exportIcon.setAttribute('height', '11');
			this.exportIcon.setAttribute('stroke-width', '2.2');
			this.exportDocked = false;
			// A group that was there and has gone: no reason to hold the button back.
			this.exportFallbackOk = true;
			// Docked, visibility was set on the button itself. Back in the header the
			// container decides, and a leftover hide would never be lifted.
			btn.classList.remove('cc-hidden');
			btn.remove();
			this._renderHeader();
		}

		/**
		 * Docked, the button is not part of the header container, so the rules that
		 * decide whether it shows - the setting, and a conversation to export - are
		 * applied to it directly.
		 */
		_syncExportVisibility() {
			if (!this.exportDocked) return;
			const show = this.settings.exportButton && !!this.lengthDisplay.textContent;
			this.exportBtn.classList.toggle('cc-hidden', !show);
		}

		/**
		 * Last resort, for whenever claude.ai changes its layout again: a part with
		 * something to say that has not been painted for a few seconds is lifted out
		 * of the page's own markup and floated over it as a small pill. It is not
		 * where it belongs, but it is shown, and the real place is tried again every
		 * so often. Whatever else changes, the numbers stay visible.
		 *
		 * A few ticks, not one: a re-render takes the part out for a moment, and
		 * that is not a failure.
		 */
		_ensureShown() {
			if (!this.exportFallbackOk && !this.exportDocked && Date.now() - this.createdAt > CC.CONST.EXPORT_DOCK_GRACE_MS) {
				this.exportFallbackOk = true;
				this._renderHeader();
			}
			this._keepSeen('header', this.headerContainer, this.headerContainer.children.length > 0);
			this._keepSeen('usage', this.usageLine, !!this.usageLine && !this.usageLine.classList.contains('cc-hidden'));
		}

		_keepSeen(key, el, wanted) {
			if (!el || el.classList.contains('cc-floating')) return;
			// No layout to ask (a non-rendering context) is taken as painted: floating
			// on a guess would be worse than not floating.
			const rects = document.contains(el) ? el.getClientRects?.() : [];
			const painted = !wanted || (rects ? rects.length > 0 && rects[0].width > 0 : true);
			if (painted) {
				this.unseen[key] = 0;
				return;
			}
			if (++this.unseen[key] < 3) return;
			this.unseen[key] = 0;
			if (key === 'usage') {
				// Inline insets copied from the composer mean nothing out here.
				el.style.paddingInline = '';
				el.style.marginBottom = '';
			}
			document.body.appendChild(el);
			el.classList.add('cc-floating');
			this.floatRetryAt[key] = Date.now() + FLOAT_RETRY_MS;
			if (key === 'header') this.headerTier = 'floating';
		}

		/**
		 * What a bug report needs to say which layout this is and which parts of the
		 * extension actually made it onto the page. Plain facts only: no ids, no
		 * conversation text.
		 */
		getDiagnostics() {
			const root = document.documentElement;
			const d = root.dataset || {};
			const shown = (el) => !!(el && document.contains(el) && el.getBoundingClientRect().width > 0);
			const ts = Number(d.buildTimestamp);
			return {
				build: d.buildId || null,
				buildDate: Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000).toISOString().slice(0, 10) : null,
				colors: d.colorVersion || null,
				cdsRoot: /\bcds-root\b/.test(root.className || ''),
				composer: CC.uiVariant || 'none',
				header: this.headerTier || 'none',
				tokens: shown(this.lengthDisplay) && !!this.lengthDisplay.textContent,
				timer: shown(this.cacheTimeSpan),
				usageRow: shown(this.usageLine),
				exportBtn: shown(this.exportBtn),
				exportAt: this.exportDocked ? 'actions' : 'header',
				floating: [['header', this.headerContainer], ['usage', this.usageLine]]
					.filter(([, el]) => el?.classList.contains('cc-floating')).map(([k]) => k),
				// A hidden element is not a broken one; say which the user turned off.
				disabled: Object.keys(this.settings).filter((k) => this.settings[k] === false),
				errors: CC.recentErrors()
			};
		}

		attachUsageLine() {
			if (!this.usageLine) return;

			// The rounded card around the text input is the one stable landmark in the
			// composer, and the only container that keeps the row visually inside the
			// composer on both layouts. Anchor on it instead of guessing at a "toolbar
			// row": the toolbar controls are absolutely positioned (home page) or sit
			// outside the card entirely (chat page), so anchoring on them either
			// overlaps them or drops the row below the composer, against the viewport
			// edge.
			const input = document.querySelector(CC.DOM.CHAT_INPUT);
			if (!input) return;
			const matched = input.closest(CC.DOM.COMPOSER_CARD);
			const card = matched || findComposerCard(input);
			if (!card) return;
			// Which of the three tiers actually matched. This rides along in bug
			// reports, and anchoring is the code most likely to break when claude.ai
			// redesigns, so "it fell through to the shape heuristic" has to be
			// distinguishable from "the design-system attribute was there". These
			// were one value, `new`, until `[data-cds]` joined the same selector and
			// silently merged two different layouts under it.
			CC.uiVariant = !matched ? 'shape'
				: matched.hasAttribute('data-cds') ? 'cds'
					: 'class';

			// The card is a flex column, so appending puts the row on its own full-width
			// line below the input, inside the card's padding box.
			if (card.lastElementChild !== this.usageLine) {
				card.appendChild(this.usageLine);
			}
			this.usageLine.classList.remove('cc-floating');
			this._alignToComposer(card);
		}

		/**
		 * Match whatever inset the card already gives its own content, so the row lines
		 * up with the input on layouts that use padding and on ones that use margins.
		 * The card's first child is not reliably the content - some variants put an
		 * overlay against the left edge - so measure the largest child instead, and
		 * keep the stylesheet default if the answer looks degenerate.
		 */
		_alignToComposer(card) {
			let content = null;
			let largest = 0;
			for (const child of card.children) {
				if (child === this.usageLine) continue;
				const rect = child.getBoundingClientRect();
				if (rect.width < 1 || rect.height < 1) continue;
				const area = rect.width * rect.height;
				if (area > largest) {
					largest = area;
					content = rect;
				}
			}
			if (!content) return;
			const cardRect = card.getBoundingClientRect();
			const pad = Math.round(content.left - cardRect.left);
			if (!Number.isFinite(pad) || pad < 4 || pad >= 64) return;
			this.usageLine.style.paddingInline = `${pad}px`;

			// Layouts that inset their content with margins rather than padding leave
			// the card with no bottom padding, which puts the row flush against the
			// rounded border. Make up the difference ourselves.
			const cardPadBottom = parseFloat(window.getComputedStyle(card).paddingBottom) || 0;
			const shortfall = Math.max(0, pad - cardPadBottom);
			this.usageLine.style.marginBottom = shortfall ? `${shortfall}px` : '';
		}

		setPendingCache(pending) {
			this.pendingCache = pending;
			clearTimeout(this.pendingCacheTimeoutId);
			this.pendingCacheTimeoutId = null;
			if (!pending) return;

			// A live countdown keeps running - it jumps to the new window when the
			// refreshed conversation lands. Only show the placeholder when the timer is
			// hidden, so it doesn't pop in from nothing a few seconds later.
			if (!this.lastCachedUntilMs) {
				this._renderCache('-:--', true);
				this._renderHeader();
			}

			// A stopped or failed generation never produces a refreshed conversation,
			// so without this the placeholder would sit there indefinitely. The pending
			// state is dropped even while a countdown runs: left set, it would turn
			// that countdown into a permanent "-:--" when it reaches zero.
			this.pendingCacheTimeoutId = setTimeout(() => {
				this.pendingCacheTimeoutId = null;
				if (!this.pendingCache) return;
				this.pendingCache = false;
				if (this.lastCachedUntilMs) return;
				this._clearCache();
				this._renderHeader();
			}, CC.CONST.PENDING_CACHE_TIMEOUT_MS);
		}

		_renderCache(text, pending = false) {
			this.cacheTimeSpan = Object.assign(document.createElement('span'), {
				className: 'cc-cacheTime',
				textContent: text
			});
			// The dot is the "cached" signal: green while a countdown runs, muted while
			// the next window is still being waited for.
			const dot = Object.assign(document.createElement('span'), {
				className: pending ? 'cc-cacheDot cc-cacheDot--pending' : 'cc-cacheDot'
			});
			this.cachedDisplay.replaceChildren(srText('Cached Context Timer:\u00A0'), dot, this.cacheTimeSpan);
		}

		_clearCache() {
			this.cacheTimeSpan = null;
			this.cachedDisplay.textContent = '';
		}

		setConversationMetrics({ totalTokens, cachedUntil } = {}) {
			this.pendingCache = false;
			clearTimeout(this.pendingCacheTimeoutId);
			this.pendingCacheTimeoutId = null;

			if (typeof totalTokens !== 'number') {
				this.lengthDisplay.textContent = '';
				this.lengthValueSpan = null;
				this._clearCache();
				this.lastCachedUntilMs = null;
				this._renderHeader();
				return;
			}

			this.lengthValueSpan = Object.assign(document.createElement('span'), {
				textContent: `${totalTokens.toLocaleString()} tokens`
			});
			this.lengthDisplay.replaceChildren(srText('Token Counter: '), this.lengthValueSpan);

			// Cache timer: only present while the context is actually cached.
			const now = Date.now();
			if (typeof cachedUntil === 'number' && cachedUntil > now) {
				this.lastCachedUntilMs = cachedUntil;
				const secondsLeft = Math.max(0, Math.ceil((cachedUntil - now) / 1000));
				this._renderCache(formatSeconds(secondsLeft));
			} else {
				this.lastCachedUntilMs = null;
				this._clearCache();
			}

			this._renderHeader();
		}

		_renderHeader() {
			this.headerContainer.replaceChildren();
			this._syncExportVisibility();
			if (!this.lengthDisplay.textContent) return;

			const { tokenCounter, cacheTimer, exportButton } = this.settings;
			const parts = [];
			if (tokenCounter) parts.push(this.lengthGroup);
			if (cacheTimer && this.cachedDisplay.textContent) parts.push(this.cachedDisplay);

			if (parts.length) {
				const children = [];
				for (const part of parts) {
					if (children.length) {
						children.push(Object.assign(document.createElement('span'), { className: 'cc-headerSep' }));
					}
					children.push(part);
				}
				this.headerDisplay.replaceChildren(...children);
				this.headerContainer.appendChild(this.headerDisplay);
			}

			if (exportButton && this.exportBtn && !this.exportDocked && this.exportFallbackOk) this.headerContainer.appendChild(this.exportBtn);
		}

		setUsage(usage) {
			const session = usage?.five_hour;
			const weekly = usage?.seven_day;
			this.hasSessionData = typeof session?.utilization === 'number';
			this.hasWeeklyData = typeof weekly?.utilization === 'number';
			this.hasUsageData = this.hasSessionData || this.hasWeeklyData;
			if (this.hasUsageData) this.usageUnavailable = false;

			this.sessionResetMs = paintWindow(session, 'Hourly', this.sessionUsageSpan, this.sessionBarFill);
			this.weeklyResetMs = paintWindow(weekly, 'Weekly', this.weeklyUsageSpan, this.weeklyBarFill);
			// A window with no reading is marked unknown here rather than hidden, so the
			// row keeps its pair.
			this._syncUsageVisibility();
			this._updateMarkers();
		}

		/**
		 * Place both elapsed-time markers, or withdraw them.
		 *
		 * Neither payload states how long a window is, so the window start has to
		 * be inferred as `resets_at - nominal`. That inference holds only while the
		 * readings agree with it: a window can never have meaningfully more time
		 * left than it is long, so a remaining time above the nominal proves the
		 * nominal figure does not describe this account. The verdict is latched,
		 * because the contradiction shows up only early in an over-long window -
		 * later readings look perfectly ordinary while the marker they imply is
		 * badly misplaced.
		 *
		 * The tolerance is what keeps that latch off a hair trigger. `resets_at` is
		 * the server's clock and `now` is the browser's, so a window that just
		 * opened reads as a little over nominal on any browser running behind -
		 * and without a margin, seconds of ordinary clock skew would withdraw the
		 * marker permanently for the session.
		 */
		_updateMarkers() {
			const now = Date.now();

			const place = (marker, resetMs, windowMs, latchKey) => {
				if (!marker) return;

				const known = resetMs && Number.isFinite(resetMs) && windowMs > 0;
				if (known && resetMs - now > windowMs + CC.CONST.WINDOW_NOMINAL_TOLERANCE_MS) {
					this[latchKey] = true;
				}

				const remaining = known ? resetMs - now : 0;
				// A window past its reset is not stale so much as unplaceable: the
				// next reading carries the new window, and until it lands there is
				// no start to measure from.
				if (!known || this[latchKey] || remaining <= 0) {
					marker.classList.add('cc-hidden');
					return;
				}

				const pct = Math.max(0, Math.min(100, ((windowMs - remaining) / windowMs) * 100));
				marker.style.left = `${pct}%`;
				marker.classList.remove('cc-hidden');
			};

			place(this.sessionMarker, this.sessionResetMs, CC.CONST.SESSION_WINDOW_MS, 'sessionWindowLengthUnknown');
			place(this.weeklyMarker, this.weeklyResetMs, CC.CONST.WEEKLY_WINDOW_MS, 'weeklyWindowLengthUnknown');
		}

		tick() {
			this._ensureShown();
			// Cache countdown
			const now = Date.now();
			if (this.lastCachedUntilMs && this.lastCachedUntilMs > now) {
				const secondsLeft = Math.max(0, Math.ceil((this.lastCachedUntilMs - now) / 1000));
				if (this.cacheTimeSpan) {
					this.cacheTimeSpan.textContent = formatSeconds(secondsLeft);
				}
			} else if (this.lastCachedUntilMs && this.lastCachedUntilMs <= now) {
				// Window closed: drop the timer and its separator entirely, unless a
				// generation is in flight and is about to open a new window.
				this.lastCachedUntilMs = null;
				if (this.pendingCache) {
					this._renderCache('-:--', true);
				} else {
					this._clearCache();
				}
				this._renderHeader();
			}

			retimeReset(this.sessionUsageSpan, this.sessionResetMs);
			retimeReset(this.weeklyUsageSpan, this.weeklyResetMs);

			// The markers advance with the clock, not with usage, so they move on
			// every tick rather than only when a fresh reading arrives.
			this._updateMarkers();
		}
	}

	CC.ui = {
		CounterUI
	};
})();
