// Everything the extension adds to claude.ai explains itself the way Claude's own
// controls do: a short tooltip after a brief hover, and the dense details of the
// token counter in a popover on click. These fire real events at the real UI.
const { load, section, t, report } = require('./harness');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function make() {
	const ctx = load('src/content/constants.js', 'src/content/ui.js');
	const ui = new ctx.ClaudeCounter.ui.CounterUI();
	ui.initialize();
	const body = ctx.document.body || (ctx.document.body = ctx.document.createElement('body'));
	const tip = () => body.children.find((c) => c.className.includes('cc-tooltip') && !c.className.includes('cc-tooltipTrigger'));
	return { ctx, ui, tip, body };
}
const mouse = { pointerType: 'mouse' };
const touch = { pointerType: 'touch' };

(async () => {
	section('one tooltip serves every trigger');
	{
		const { ui, tip, body } = make();
		const triggers = { 'token count': ui.lengthGroup, 'cache timer': ui.cachedDisplay, export: ui.exportBtn,
			refresh: ui.refreshBtn, 'hourly bar': ui.sessionGroup, 'weekly bar': ui.weeklyGroup };
		for (const [label, el] of Object.entries(triggers)) t(label + ' is a tooltip trigger', el.classList.contains('cc-tooltipTrigger'));

		ui.exportBtn.fire('pointerenter', mouse);
		await sleep(100);
		t('nothing shows before the delay', !tip() || !tip().classList.contains('cc-tooltip--on'));
		await sleep(250);
		t('then it appears', tip() && tip().classList.contains('cc-tooltip--on'));
		t('  with its own text', tip().textContent.startsWith('Export as Markdown'));

		ui.refreshBtn.fire('pointerenter', mouse);
		ui.exportBtn.fire('pointerleave', mouse);
		await sleep(350);
		t('another trigger reuses the same box', tip().textContent.startsWith('Refresh usage'));
		t('  and there is only ever one', body.children.filter((c) => /(^| )cc-tooltip( |$)/.test(c.className)).length === 1);
	}

	section('leaving or clicking dismisses it, and a quick pass shows nothing');
	{
		const { ui, tip } = make();
		ui.sessionGroup.fire('pointerenter', mouse);
		await sleep(100);
		ui.sessionGroup.fire('pointerleave', mouse);
		await sleep(300);
		t('passing over without stopping shows no tooltip', !tip() || !tip().classList.contains('cc-tooltip--on'));

		ui.sessionGroup.fire('pointerenter', mouse);
		await sleep(350);
		t('shown after a pause', tip().classList.contains('cc-tooltip--on'));
		ui.sessionGroup.fire('pointerleave', mouse);
		t('hidden on leave', !tip().classList.contains('cc-tooltip--on'));

		ui.sessionGroup.fire('pointerenter', mouse);
		await sleep(350);
		ui.sessionGroup.fire('pointerdown', mouse);
		t('a click dismisses it', !tip().classList.contains('cc-tooltip--on'));
		ui.weeklyGroup.fire('pointerleave', mouse);
		ui.sessionGroup.fire('pointerenter', mouse);
		await sleep(350);
		ui.weeklyGroup.fire('pointerleave', mouse);
		t('another element leaving does not hide this one', tip().classList.contains('cc-tooltip--on'));
	}

	section('touch: a long press, not a hover');
	{
		const { ui, tip } = make();
		ui.sessionGroup.fire('pointerenter', touch);
		await sleep(350);
		t('hover from a finger shows nothing', !tip());
		ui.sessionGroup.fire('pointerdown', touch);
		await sleep(600);
		t('a held press shows it', tip() && tip().classList.contains('cc-tooltip--on'));
		const quick = make();
		quick.ui.sessionGroup.fire('pointerdown', touch);
		quick.ui.sessionGroup.fire('pointerup', touch);
		await sleep(600);
		t('a tap does not', !quick.tip());
	}

	section('keyboard focus shows it; a click that happens to focus does not');
	{
		const { ui, tip } = make();
		ui.exportBtn.matches = (q) => q === ':focus-visible' && false;
		ui.exportBtn.fire('focus');
		t('mouse-driven focus shows nothing', !tip());
		ui.exportBtn.matches = (q) => q === ':focus-visible';
		ui.exportBtn.fire('focus');
		t('keyboard focus shows it', tip() && tip().classList.contains('cc-tooltip--on'));
		ui.exportBtn.fire('blur');
		t('and blur hides it', !tip().classList.contains('cc-tooltip--on'));
	}

	section('the text is short, and says what each thing is');
	{
		const { ui, tip } = make();
		const read = async (el) => { el.fire('pointerenter', mouse); await sleep(350); const x = tip().textContent; el.fire('pointerleave', mouse); return x; };
		const texts = {
			tokens: await read(ui.lengthGroup), cache: await read(ui.cachedDisplay),
			hourly: await read(ui.sessionGroup), weekly: await read(ui.weeklyGroup)
		};
		t('every tooltip fits Claude\'s 240px box in a few lines (under 130 characters)', Object.values(texts).every((x) => x.length < 130), JSON.stringify(texts));
		t('token count says approximate and excludes the system prompt', /Approximate/.test(texts.tokens) && /system prompt/.test(texts.tokens));
		t('token count points to the popover', /Click for details/.test(texts.tokens));
		t('cache timer says why it matters', /cheaper/.test(texts.cache));
		t('hourly names its window', /5-hour/.test(texts.hourly));
		t('weekly names its window', /7-day/.test(texts.weekly));
		t('both bars explain the thin line', /thin line/.test(texts.hourly) && /thin line/.test(texts.weekly));
	}

	section('the token counter opens a popover with the context sizes');
	{
		const { ui, ctx } = make();
		const pop = ui.contextPopover;
		const closed = () => pop.classList.contains('cc-hidden');
		t('closed to begin with', closed());
		t('the trigger is a real button for the keyboard',
			ui.lengthGroup.getAttribute('role') === 'button' && ui.lengthGroup.getAttribute('tabindex') === '0' &&
			ui.lengthGroup.getAttribute('aria-haspopup') === 'dialog' && ui.lengthGroup.getAttribute('aria-expanded') === 'false');

		const stop = () => { stop.called = true; };
		ui.lengthGroup.fire('click', { stopPropagation: stop });
		t('a click opens it', !closed() && stop.called);
		t('  and says so for assistive tech', ui.lengthGroup.getAttribute('aria-expanded') === 'true');
		const text = pop.textContent;
		const rows = pop.children.map((r) => r.children.map((c) => c.textContent));
		const row = (name) => rows.find((r) => r[0] === name);
		t('names families, not versions', ['Fable', 'Opus', 'Sonnet', 'Haiku'].every((m) => row(m)) && !/\d\.\d/.test(text.replace(/\u2013/g, '')), text);
		t('free and paid sit side by side under their own headings', rows[0].join('|') === 'Context window|Free|Paid');
		t('Sonnet: 1M on both', row('Sonnet').join('|') === 'Sonnet|1M|1M');
		t('Haiku: 200K either way', row('Haiku').join('|') === 'Haiku|200K|200K');
		t('Opus and Fable are paid only', row('Opus')[1] === '\u2014' && row('Opus')[2] === '1M' && row('Fable')[1] === '\u2014' && row('Fable')[2] === '1M');
		t('older models are one line for both plans', row('Older models').length === 2 && /500K/.test(row('Older models')[1]) && /same on Free and Paid/.test(text) && /newest version/.test(text));
		t('the compaction note is last, and the free-plan sentence is gone', /compaction/.test(pop.children[pop.children.length - 1].textContent) && !/Free plan:/.test(text));
		t('is labelled for screen readers', pop.getAttribute('role') === 'dialog' && !!pop.getAttribute('aria-label'));

		ui.lengthGroup.fire('click', { stopPropagation() {} });
		t('clicking again closes it', closed() && ui.lengthGroup.getAttribute('aria-expanded') === 'false');

		ui.lengthGroup.fire('click', { stopPropagation() {} });
		ctx.document.fire('click');
		t('a click elsewhere closes it', closed());

		ui.lengthGroup.fire('click', { stopPropagation() {} });
		ctx.document.fire('keydown', { key: 'Escape' });
		t('Escape closes it', closed());

		let prevented = false;
		ui.lengthGroup.fire('keydown', { key: 'Enter', preventDefault() { prevented = true; }, stopPropagation() {} });
		t('Enter opens it from the keyboard', !closed() && prevented);
		ctx.document.fire('keydown', { key: 'Escape' });
		ui.lengthGroup.fire('keydown', { key: ' ', preventDefault() {}, stopPropagation() {} });
		t('so does Space', !closed());
	}

	section('the "Click for details" cue is reachable and works');
	{
		const { ui, tip } = make();
		ui.lengthGroup.fire('pointerenter', mouse);
		await sleep(350);
		t('the token tooltip offers its action', tip().classList.contains('cc-tooltip--action') && /Click for details/.test(tip().textContent));

		ui.lengthGroup.fire('pointerleave', mouse);
		await sleep(80);
		tip().fire('pointerenter', mouse);
		await sleep(350);
		t('it stays while the pointer travels onto it', tip().classList.contains('cc-tooltip--on'));

		tip().fire('click', { stopPropagation() {} });
		t('clicking the cue opens the popover', !ui.contextPopover.classList.contains('cc-hidden'));
		t('  and the tooltip steps aside', !tip().classList.contains('cc-tooltip--on') && !tip().classList.contains('cc-tooltip--action'));
	}

	section('a tooltip nobody moves onto still goes away');
	{
		const { ui, tip } = make();
		ui.lengthGroup.fire('pointerenter', mouse);
		await sleep(350);
		ui.lengthGroup.fire('pointerleave', mouse);
		t('not at the instant of leaving (the grace period)', tip().classList.contains('cc-tooltip--on'));
		await sleep(300);
		t('but soon after', !tip().classList.contains('cc-tooltip--on'));

		ui.lengthGroup.fire('pointerenter', mouse);
		await sleep(350);
		tip().fire('pointerenter', mouse);
		tip().fire('pointerleave', mouse);
		t('leaving the tooltip itself hides it', !tip().classList.contains('cc-tooltip--on'));
	}

	section('only the token counter\'s tooltip is interactive');
	{
		const { ui, tip } = make();
		ui.sessionGroup.fire('pointerenter', mouse);
		await sleep(350);
		t('the hourly tooltip is plain, with no action', !tip().classList.contains('cc-tooltip--action'));
		tip().fire('click', { stopPropagation() {} });
		t('clicking a plain tooltip does nothing', ui.contextPopover.classList.contains('cc-hidden'));
		ui.sessionGroup.fire('pointerleave', mouse);
		t('and it leaves at once, as before', !tip().classList.contains('cc-tooltip--on'));
	}

	section('opening the popover takes the tooltip away');
	{
		const { ui, tip } = make();
		ui.lengthGroup.fire('pointerenter', mouse);
		await sleep(350);
		t('the tooltip is up', tip().classList.contains('cc-tooltip--on'));
		ui.lengthGroup.fire('click', { stopPropagation() {} });
		t('a click on the same element replaces it with the popover', !tip().classList.contains('cc-tooltip--on') && !ui.contextPopover.classList.contains('cc-hidden'));
	}

	section('only one of our floating boxes is open at a time');
	{
		const { ui } = make();
		ui.lengthGroup.fire('click', { stopPropagation() {} });
		ui.exportBtn.fire('click', { stopPropagation() {} });
		t('opening the export menu closes the popover', ui.contextPopover.classList.contains('cc-hidden') && !ui.exportMenu.classList.contains('cc-hidden'));
		ui.lengthGroup.fire('click', { stopPropagation() {} });
		t('and the other way round', !ui.contextPopover.classList.contains('cc-hidden') && ui.exportMenu.classList.contains('cc-hidden'));
	}

	section('the export menu is built from our own surface, not borrowed classes');
	{
		const { ui } = make();
		t('no borrowed Claude utility classes on the menu', !/bg-bg|text-text|border-border/.test(ui.exportMenu.className));
		t('still a menu with two items', ui.exportMenu.getAttribute('role') === 'menu' && ui.exportMenu.children.length === 2);
	}

	process.exit(report('tooltip'));
})();
