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

	function setupTooltip(element, tooltip, { topOffset = 10 } = {}) {
		if (!element || !tooltip) return;
		if (element.hasAttribute('data-tooltip-setup')) return;
		element.setAttribute('data-tooltip-setup', 'true');
		element.classList.add('cc-tooltipTrigger');

		let pressTimer;
		let hideTimer;

		const show = () => {
			const rect = element.getBoundingClientRect();
			tooltip.style.opacity = '1';
			const tipRect = tooltip.getBoundingClientRect();

			let left = rect.left + rect.width / 2;
			if (left + tipRect.width / 2 > window.innerWidth) left = window.innerWidth - tipRect.width / 2 - 10;
			if (left - tipRect.width / 2 < 0) left = tipRect.width / 2 + 10;

			let top = rect.top - tipRect.height - topOffset;
			if (top < 10) top = rect.bottom + 10;

			tooltip.style.left = `${left}px`;
			tooltip.style.top = `${top}px`;
			tooltip.style.transform = 'translateX(-50%)';
		};

		const hide = () => {
			tooltip.style.opacity = '0';
			clearTimeout(hideTimer);
		};

		element.addEventListener('pointerdown', (e) => {
			if (e.pointerType === 'touch' || e.pointerType === 'pen') {
				pressTimer = setTimeout(() => {
					show();
					hideTimer = setTimeout(hide, 3000);
				}, 500);
			}
		});

		element.addEventListener('pointerup', () => clearTimeout(pressTimer));
		element.addEventListener('pointercancel', () => {
			clearTimeout(pressTimer);
			hide();
		});

		element.addEventListener('pointerenter', (e) => {
			if (e.pointerType === 'mouse') show();
		});

		element.addEventListener('pointerleave', (e) => {
			if (e.pointerType === 'mouse') hide();
		});
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

	function makeTooltip(text) {
		const tip = document.createElement('div');
		tip.className = 'bg-bg-500 text-text-000 cc-tooltip';
		tip.textContent = text;
		document.body.appendChild(tip);
		return tip;
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

	class CounterUI {
		constructor({ onUsageRefresh, onExport } = {}) {
			this.onUsageRefresh = onUsageRefresh || null;
			this.onExport = onExport || null;

			this.exportBtn = null;
			this.exportMenu = null;
			this.exportingChat = false;

			this.headerContainer = null;
			this.headerDisplay = null;
			this.lengthGroup = null;
			this.lengthDisplay = null;
			this.lengthValueSpan = null;
			this.cachedDisplay = null;
			this.lengthTooltip = null;
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

		getProgressChrome() {
			const root = document.documentElement;
			const modeDark = root.dataset?.mode === 'dark';
			const modeLight = root.dataset?.mode === 'light';
			const isDark = modeDark && !modeLight;

			return {
				strokeColor: isDark ? CC.COLORS.PROGRESS_OUTLINE_DARK : CC.COLORS.PROGRESS_OUTLINE_LIGHT,
				fillColor: isDark ? CC.COLORS.PROGRESS_FILL_DARK : CC.COLORS.PROGRESS_FILL_LIGHT,
				boldColor: isDark ? CC.COLORS.BOLD_DARK : CC.COLORS.BOLD_LIGHT,
				markerColor: isDark ? CC.COLORS.PROGRESS_MARKER_DARK : CC.COLORS.PROGRESS_MARKER_LIGHT,
				cacheActiveColor: isDark ? CC.COLORS.CACHE_ACTIVE_DARK : CC.COLORS.CACHE_ACTIVE_LIGHT
			};
		}

		refreshProgressChrome() {
			const { strokeColor, fillColor, boldColor, markerColor } = this.getProgressChrome();

			const applyBarChrome = (bar, { fillCaution, fillWarn } = {}) => {
				if (!bar) return;
				bar.style.setProperty('--cc-stroke', strokeColor);
				bar.style.setProperty('--cc-fill', fillColor);
				bar.style.setProperty('--cc-fill-caution', fillCaution ?? fillColor);
				bar.style.setProperty('--cc-fill-warn', fillWarn ?? fillColor);
				bar.style.setProperty('--cc-marker', markerColor);
			};

			applyBarChrome(this.sessionBar, { fillCaution: CC.COLORS.AMBER_WARNING, fillWarn: CC.COLORS.RED_WARNING });
			applyBarChrome(this.weeklyBar, { fillCaution: CC.COLORS.AMBER_WARNING, fillWarn: CC.COLORS.RED_WARNING });
			if (this.refreshBtn) this.refreshBtn.style.color = boldColor;
			if (this.exportBtn) this.exportBtn.style.color = boldColor;
			if (this.lengthValueSpan) this.lengthValueSpan.style.color = boldColor;
		}

		initialize() {
			// Header container (tokens + cache timer)
			this.headerContainer = document.createElement('div');
			this.headerContainer.className = 'text-text-500 text-xs !px-1 cc-header';

			this.headerDisplay = document.createElement('span');
			this.headerDisplay.className = 'cc-headerItem';

			this.lengthGroup = document.createElement('span');
			this.lengthDisplay = document.createElement('span');
			this.cachedDisplay = document.createElement('span');
			this.cacheTimeSpan = null; // reference to inner time span

			this.lengthGroup.appendChild(this.lengthDisplay);
			this.headerDisplay.appendChild(this.lengthGroup);

			// Usage line (session + weekly)
			this._initUsageLine();
			this._initExportButton();

			this._setupTooltips();
			this._observeDom();
			this._observeTheme();
		}

		_observeTheme() {
			// Watch for theme changes (data-mode attribute on <html>)
			const observer = new MutationObserver(() => this.refreshProgressChrome());
			observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode'] });
		}

		_observeDom() {
			// Track pending reattach attempts independently
			let usageReattachPending = false;
			let headerReattachPending = false;
			// waitForElement resolves synchronously when the anchor already exists, so
			// the pending flags alone are no throttle. Without this, a layout we cannot
			// attach to would re-run the search on every mutation batch - which during
			// token streaming is hundreds of times a second.
			const RETRY_MS = 1000;
			let lastUsageAttempt = 0;
			let lastHeaderAttempt = 0;

			this.domObserver = new MutationObserver(() => {
				const now = Date.now();
				const usageMissing = this.usageLine && !document.contains(this.usageLine);
				const headerMissing = !document.contains(this.headerContainer);

				if (usageMissing && !usageReattachPending && now - lastUsageAttempt > RETRY_MS) {
					lastUsageAttempt = now;
					usageReattachPending = true;
					CC.waitForElement(CC.DOM.CHAT_INPUT, 60000).then((el) => {
						usageReattachPending = false;
						if (el) this.attachUsageLine();
					});
				}

				if (headerMissing && !headerReattachPending && now - lastHeaderAttempt > RETRY_MS) {
					lastHeaderAttempt = now;
					headerReattachPending = true;
					CC.waitForElement(CC.DOM.CHAT_MENU_TRIGGER, 60000).then((el) => {
						headerReattachPending = false;
						if (el) this.attachHeader();
					});
				}
			});
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

			this.sessionBar = document.createElement('div');
			this.sessionBar.className = 'cc-bar cc-bar--usage';
			this.sessionBarFill = document.createElement('div');
			this.sessionBarFill.className = 'cc-bar__fill';
			this.sessionMarker = document.createElement('div');
			this.sessionMarker.className = 'cc-bar__marker cc-hidden';
			this.sessionMarker.style.left = '0%';
			this.sessionBar.appendChild(this.sessionBarFill);
			this.sessionBar.appendChild(this.sessionMarker);

			this.weeklyUsageSpan = document.createElement('span');
			this.weeklyUsageSpan.className = 'cc-usageText';

			this.weeklyBar = document.createElement('div');
			this.weeklyBar.className = 'cc-bar cc-bar--usage';
			this.weeklyBarFill = document.createElement('div');
			this.weeklyBarFill.className = 'cc-bar__fill';
			this.weeklyMarker = document.createElement('div');
			this.weeklyMarker.className = 'cc-bar__marker cc-hidden';
			this.weeklyMarker.style.left = '0%';
			this.weeklyBar.appendChild(this.weeklyBarFill);
			this.weeklyBar.appendChild(this.weeklyMarker);

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

			this.refreshProgressChrome();

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
			this.exportBtn.appendChild(
				svgIcon('cc-exportIcon', 11, [
					['path', { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' }],
					['polyline', { points: '7 10 12 15 17 10' }],
					['line', { x1: '12', y1: '15', x2: '12', y2: '3' }]
				])
			);

			this.exportMenu = document.createElement('div');
			this.exportMenu.className = 'bg-bg-200 text-text-100 border-border-300 cc-exportMenu cc-hidden';
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

			document.addEventListener('click', () => this._closeExportMenu());
			document.addEventListener('keydown', (e) => {
				if (e.key === 'Escape') this._closeExportMenu();
			});
		}

		_openExportMenu() {
			const rect = this.exportBtn.getBoundingClientRect();
			this.exportMenu.classList.remove('cc-hidden');
			const menuRect = this.exportMenu.getBoundingClientRect();
			let left = rect.left;
			if (left + menuRect.width > window.innerWidth - 8) left = window.innerWidth - menuRect.width - 8;
			this.exportMenu.style.left = `${Math.max(8, left)}px`;
			this.exportMenu.style.top = `${rect.bottom + 6}px`;
		}

		_closeExportMenu() {
			this.exportMenu?.classList.add('cc-hidden');
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
			this.lengthTooltip = makeTooltip(
				"Approximate tokens (excludes system prompt).\nUses a generic tokenizer, may differ from Claude's count.\nBecomes invalid after context compaction.\nMax context: Sonnet 5 1M · Opus 4.8 500K · other models 200K (paid plans). Free plan: 200K (Haiku & Sonnet only)."
			);
			setupTooltip(
				this.lengthGroup,
				this.lengthTooltip,
				{ topOffset: 8 }
			);

			setupTooltip(
				this.exportBtn,
				makeTooltip('Export this conversation as Markdown or plain text.\nActive branch only - edited-away versions are not included.'),
				{ topOffset: 8 }
			);

			setupTooltip(
				this.cachedDisplay,
				makeTooltip("Messages sent while cached are significantly cheaper."),
				{ topOffset: 8 }
			);

			setupTooltip(
				this.sessionGroup,
				makeTooltip("5-hour session window.\nThe bar shows how much of it you have used."),
				{ topOffset: 8 }
			);

			setupTooltip(
				this.weeklyGroup,
				makeTooltip("7-day usage window.\nThe bar shows how much of it you have used."),
				{ topOffset: 8 }
			);
		}

		attach() {
			this.attachHeader();
			this.attachUsageLine();
			this.refreshProgressChrome();
		}

		attachHeader() {
			const anchor = document.querySelector(CC.DOM.CHAT_MENU_TRIGGER);
			if (anchor) {
				if (anchor.nextElementSibling !== this.headerContainer) anchor.after(this.headerContainer);
			} else {
				// Not every Claude variant ships the title testid. Fall back to the
				// header's own title group so the counter and the export button stay
				// reachable instead of vanishing.
				// The previous Claude design ships neither testid - only a semantic
				// <header> - so fall through to that before giving up.
				const header =
					document.querySelector(CC.DOM.CHAT_HEADER) || document.querySelector(CC.DOM.HEADER_FALLBACK);
				if (!header) return;
				const host = findHeaderTitleGroup(header) || header;
				if (this.headerContainer.parentElement !== host) host.appendChild(this.headerContainer);
			}
			this._renderHeader();
			this.refreshProgressChrome();
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
			this._alignToComposer(card);
			this.refreshProgressChrome();
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
				this._renderCache('-:--', '');
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

		_renderCache(text, color) {
			this.cacheTimeSpan = Object.assign(document.createElement('span'), {
				className: 'cc-cacheTime',
				textContent: text
			});
			this.cacheTimeSpan.style.color = color;
			this.cachedDisplay.replaceChildren(document.createTextNode('Cached Context Timer:\u00A0'), this.cacheTimeSpan);
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
				textContent: `~${totalTokens.toLocaleString()} tokens`
			});
			this.lengthValueSpan.style.color = this.getProgressChrome().boldColor;
			this.lengthDisplay.replaceChildren(document.createTextNode('Token Counter: '), this.lengthValueSpan);
			this.lengthGroup.replaceChildren(this.lengthDisplay);

			// Cache timer: only present while the context is actually cached.
			const now = Date.now();
			if (typeof cachedUntil === 'number' && cachedUntil > now) {
				this.lastCachedUntilMs = cachedUntil;
				const secondsLeft = Math.max(0, Math.ceil((cachedUntil - now) / 1000));
				this._renderCache(formatSeconds(secondsLeft), this.getProgressChrome().cacheActiveColor);
			} else {
				this.lastCachedUntilMs = null;
				this._clearCache();
			}

			this._renderHeader();
		}

		_renderHeader() {
			this.headerContainer.replaceChildren();
			if (!this.lengthDisplay.textContent) return;

			const { tokenCounter, cacheTimer, exportButton } = this.settings;
			const parts = [];
			if (tokenCounter) parts.push(this.lengthGroup);
			if (cacheTimer && this.cachedDisplay.textContent) parts.push(this.cachedDisplay);

			if (parts.length) {
				const children = [];
				for (const part of parts) {
					if (children.length) children.push(document.createTextNode('\u00A0|\u00A0'));
					children.push(part);
				}
				this.headerDisplay.replaceChildren(...children);
				this.headerContainer.appendChild(this.headerDisplay);
			}

			if (exportButton && this.exportBtn) this.headerContainer.appendChild(this.exportBtn);
		}

		setUsage(usage) {
			this.refreshProgressChrome();
			const session = usage?.five_hour || null;
			const weekly = usage?.seven_day || null;
			const hasAnyUsage =
				!!(session && typeof session.utilization === 'number') || !!(weekly && typeof weekly.utilization === 'number');
			this.hasUsageData = hasAnyUsage;
			if (hasAnyUsage) this.usageUnavailable = false;

			this.hasSessionData = !!(session && typeof session.utilization === 'number');
			if (session && typeof session.utilization === 'number') {
				const rawPct = session.utilization;
				const pct = Math.round(rawPct * 10) / 10;
				this.sessionResetMs = session.resets_at ? Date.parse(session.resets_at) : null;
				const resetText = this.sessionResetMs ? ` (resets in ${formatResetCountdown(this.sessionResetMs)})` : '';
				this.sessionUsageSpan.textContent = `Hourly: ${pct}%${resetText}`;

				const width = Math.max(0, Math.min(100, rawPct));
				this.sessionBarFill.style.width = `${width}%`;
				this.sessionBarFill.classList.toggle('cc-caution', width >= 75 && width < 90);
				this.sessionBarFill.classList.toggle('cc-warn', width >= 90);
				this.sessionBarFill.classList.toggle('cc-full', width >= 99.5);
			} else {
				this.sessionUsageSpan.textContent = '';
				this.sessionBarFill.style.width = '0%';
				this.sessionBarFill.classList.remove('cc-caution', 'cc-warn', 'cc-full');
				this.sessionResetMs = null;
			}

			const hasWeekly = !!(weekly && typeof weekly.utilization === 'number');
			this.hasWeeklyData = hasWeekly;
			this._syncUsageVisibility();

			if (hasWeekly) {
				this.weeklyUsageSpan.classList.remove('cc-hidden');
				this.weeklyBar.classList.remove('cc-hidden');

				const rawPct = weekly.utilization;
				const pct = Math.round(rawPct * 10) / 10;
				this.weeklyResetMs = weekly.resets_at ? Date.parse(weekly.resets_at) : null;
				const resetText = this.weeklyResetMs ? ` (resets in ${formatResetCountdown(this.weeklyResetMs)})` : '';
				this.weeklyUsageSpan.textContent = `Weekly: ${pct}%${resetText}`;

				const width = Math.max(0, Math.min(100, rawPct));
				this.weeklyBarFill.style.width = `${width}%`;
				this.weeklyBarFill.classList.toggle('cc-caution', width >= 75 && width < 90);
				this.weeklyBarFill.classList.toggle('cc-warn', width >= 90);
				this.weeklyBarFill.classList.toggle('cc-full', width >= 99.5);
			} else {
				this.weeklyUsageSpan.classList.add('cc-hidden');
				this.weeklyBar.classList.add('cc-hidden');
				this.weeklyResetMs = null;
				this.weeklyBarFill.classList.remove('cc-caution', 'cc-warn', 'cc-full');
			}

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
					this._renderCache('-:--', '');
				} else {
					this._clearCache();
				}
				this._renderHeader();
			}

			// Reset countdown text
			if (this.sessionResetMs && this.sessionUsageSpan?.textContent) {
				const idx = this.sessionUsageSpan.textContent.indexOf('(resets in');
				if (idx !== -1) {
					const prefix = this.sessionUsageSpan.textContent.slice(0, idx + '(resets in '.length);
					this.sessionUsageSpan.textContent = `${prefix}${formatResetCountdown(this.sessionResetMs)})`;
				}
			}

			if (this.weeklyResetMs && this.weeklyUsageSpan?.textContent) {
				const idx = this.weeklyUsageSpan.textContent.indexOf('(resets in');
				if (idx !== -1) {
					const prefix = this.weeklyUsageSpan.textContent.slice(0, idx + '(resets in '.length);
					this.weeklyUsageSpan.textContent = `${prefix}${formatResetCountdown(this.weeklyResetMs)})`;
				}
			}

			// The markers advance with the clock, not with usage, so they move on
			// every tick rather than only when a fresh reading arrives.
			this._updateMarkers();
		}
	}

	CC.ui = {
		CounterUI
	};
})();
