// Minimal DOM shim + module loader, so the content scripts can be exercised in Node.
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

class El {
	constructor(tag) {
		this.tag = tag;
		this.children = [];
		this._text = null;
		this.style = { setProperty(k, v) { this[k] = v; } };
		this.attrs = {};
		this.classList = {
			_s: new Set(),
			add: (...c) => c.forEach((x) => this.classList._s.add(x)),
			remove: (...c) => c.forEach((x) => this.classList._s.delete(x)),
			toggle: (c, f) => (f ? this.classList._s.add(c) : this.classList._s.delete(c)),
			contains: (c) => this.classList._s.has(c)
		};
	}
	get textContent() {
		return this._text !== null ? this._text : this.children.map((c) => c.textContent).join('');
	}
	set textContent(v) { this._text = String(v); this.children = []; }
	set innerHTML(v) { this._html = v; }
	// A real element's className and classList are two views of one value. The
	// shim used to keep them as two: `className` reflected only what was last
	// assigned, so any later classList.add/remove was invisible to it - which is
	// how a snapshot of `className` could record a marker as hidden while
	// classList reported it visible. The set is the single source of truth now,
	// and the string is derived from it, as in a real element.
	set className(v) {
		this.classList._s = new Set(String(v).split(/\s+/).filter(Boolean));
	}
	get className() { return [...this.classList._s].join(' '); }
	appendChild(c) { this._text = null; c.parentElement = this; this.children.push(c); return c; }
	append(...c) { for (const x of c) this.appendChild(x); }
	prepend(c) { this._text = null; c.parentElement = this; this.children.unshift(c); }
	replaceChildren(...c) { this._text = null; for (const x of c) x.parentElement = this; this.children = c; }
	remove() {
		const p = this.parentElement;
		if (p) p.children = p.children.filter((x) => x !== this);
		this.parentElement = null;
	}
	get firstElementChild() { return this.children[0] || null; }
	get nextElementSibling() {
		const sibs = this.parentElement ? this.parentElement.children : [];
		return sibs[sibs.indexOf(this) + 1] || null;
	}
	insertBefore(c, ref) {
		if (c.parentElement) c.remove();
		this._text = null;
		c.parentElement = this;
		const i = ref ? this.children.indexOf(ref) : -1;
		if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
		return c;
	}
	cloneNode() { const c = new El(this.tag); c.className = this.className; return c; }
	setAttribute(k, v) { this.attrs[k] = v; }
	getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
	removeAttribute(k) { delete this.attrs[k]; }
	hasAttribute(k) { return k in this.attrs; }
	// Handlers are recorded so a test can fire them with `fire(type, event)`.
	addEventListener(type, fn) { ((this._handlers = this._handlers || {})[type] = (this._handlers[type] || [])).push(fn); }
	fire(type, event = {}) { for (const fn of (this._handlers && this._handlers[type]) || []) fn(event); }
	getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
}

function makeContext() {
	const document = {
		documentElement: { dataset: { mode: 'dark' } },
		body: new El('body'),
		head: new El('head'),
		// main.js backs off its safety refresh on a hidden tab, and reads a cookie
		// to find the org id. Both need a value, not an absence.
		hidden: false,
		cookie: '',
		getElementById: () => null,
		createElement: (tag) => new El(tag),
		createElementNS: (_ns, tag) => new El(tag),
		createTextNode: (text) => { const n = new El('#text'); n.textContent = text; return n; },
		querySelector: () => null,
		contains: () => true,
		addEventListener(type, fn) { ((this._handlers = this._handlers || {})[type] = (this._handlers[type] || [])).push(fn); },
		fire(type, event = {}) { for (const fn of (this._handlers && this._handlers[type]) || []) fn(event); }
	};
	const ctx = {
		document, console, Date, Math, Object, String, Number, JSON, Array, Set, Map, RegExp,
		setTimeout, clearTimeout, isNaN, parseInt, parseFloat,
		Promise, URL, Error, TypeError, Symbol, Boolean, Function,
		// main.js starts a 1s countdown on load. Left real, it would keep the test
		// process alive forever; the suites drive `tick()` themselves instead.
		setInterval: () => 0,
		clearInterval: () => {},
		// Nothing under test should reach the network. A rejecting stub makes an
		// accidental request a visible failure rather than a silent hang.
		fetch: () => Promise.reject(new Error('no network in tests')),
		window: {
			getComputedStyle: () => ({}), innerWidth: 1000, innerHeight: 800,
			addEventListener() {}, removeEventListener() {}, postMessage() {},
			location: { pathname: '/chat/00000000-0000-4000-8000-000000000000', origin: 'https://claude.ai', href: 'https://claude.ai/' }
		},
		MutationObserver: class { observe() {} disconnect() {} }
	};
	ctx.window.window = ctx.window;
	ctx.globalThis = ctx;
	return vm.createContext(ctx);
}

/** Load content-script files into a fresh sandbox and return its globals. */
function load(...files) {
	return loadWith({}, ...files);
}

/**
 * Same, with extra globals installed *before* the files run - for code that
 * reads its environment at load time, such as `seedFromSnapshot()`, which fires
 * as main.js evaluates and needs a `chrome.storage` to already be there.
 */
function loadWith(globals, ...files) {
	const ctx = makeContext();
	// `setup(ctx)` runs on the sandbox before any file does, for tests that need
	// to shape the document (which makeContext builds) rather than replace it.
	const { setup, ...rest } = globals;
	Object.assign(ctx, rest);
	if (setup) setup(ctx);
	for (const f of files) {
		vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
	}
	return ctx;
}

/** A `chrome.storage.local` stand-in, preloaded with `items`. */
function fakeStorage(items = {}) {
	const store = { ...items };
	return {
		storage: {
			local: {
				get: (key, cb) => { const k = typeof key === 'string' ? key : null; const out = k && k in store ? { [k]: store[k] } : {}; if (cb) cb(out); return Promise.resolve(out); },
				set: (obj, cb) => { Object.assign(store, obj); if (cb) cb(); return Promise.resolve(); }
			},
			onChanged: { addListener() {} }
		},
		runtime: { getURL: (p) => 'chrome-extension://test/' + p, id: 'test' },
		_store: store
	};
}

let pass = 0;
let fail = 0;

function section(name) {
	console.log('\n  ' + name);
}

function t(label, cond, detail) {
	if (cond) {
		pass += 1;
		console.log('    PASS  ' + label);
	} else {
		fail += 1;
		console.log('    FAIL  ' + label);
		if (detail) console.log('          ' + detail);
	}
}

function report(suite) {
	console.log('\n  ' + (fail === 0 ? 'ALL PASS' : fail + ' FAILED') + '  ' + suite + ' (' + pass + '/' + (pass + fail) + ')');
	return fail;
}

module.exports = { load, loadWith, fakeStorage, section, t, report };
