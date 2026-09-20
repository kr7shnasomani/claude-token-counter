// Flat config (ESLint 10). Deliberately narrow: this catches genuine mistakes and
// unsafe constructs, not style. Formatting is not enforced, so the linter never
// argues with a diff that is otherwise fine.
const js = require('@eslint/js');

const browser = {
	document: 'readonly', window: 'readonly', navigator: 'readonly', location: 'readonly',
	console: 'readonly', fetch: 'readonly', Request: 'readonly', Response: 'readonly',
	Blob: 'readonly', URL: 'readonly', Headers: 'readonly', FormData: 'readonly',
	setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
	MutationObserver: 'readonly', TextEncoder: 'readonly', TextDecoder: 'readonly',
	crypto: 'readonly', history: 'readonly', Intl: 'readonly', getComputedStyle: 'readonly',
	globalThis: 'readonly', chrome: 'readonly', browser: 'readonly', HTMLElement: 'readonly',
	Element: 'readonly', Node: 'readonly', CustomEvent: 'readonly', Event: 'readonly'
};

const node = {
	require: 'readonly', module: 'writable', process: 'readonly', console: 'readonly',
	__dirname: 'readonly', __filename: 'readonly', Buffer: 'readonly',
	setTimeout: 'readonly', clearTimeout: 'readonly'
};

const rules = {
	...js.configs.recommended.rules,

	// The reasons this project exists in a page it does not control.
	'no-eval': 'error',
	'no-implied-eval': 'error',
	'no-new-func': 'error',
	'no-script-url': 'error',

	// Mistakes that have actually bitten this codebase.
	'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
	'no-undef': 'error',
	'no-shadow': 'error',
	'no-return-await': 'error',
	'require-atomic-updates': 'off',
	eqeqeq: ['error', 'smart'],
	'no-var': 'error',
	'prefer-const': 'error'
};

module.exports = [
	{
		// 2 MB of minified third-party code. Linting it produces nothing but noise,
		// and its integrity is guarded by the hash in THIRD_PARTY_NOTICES.md instead.
		ignores: ['src/vendor/**', 'node_modules/**', 'dist/**']
	},
	{
		files: ['src/**/*.js'],
		languageOptions: { ecmaVersion: 2022, sourceType: 'script', globals: browser },
		rules
	},
	{
		files: ['test/**/*.js', 'eslint.config.js'],
		languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs', globals: { ...node, ...browser } },
		rules
	}
];
