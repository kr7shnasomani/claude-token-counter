(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	function makeRequestId() {
		return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
	}

	class BridgeClient {
		constructor() {
			this._pending = new Map();
			this._listeners = new Map();

			window.addEventListener('message', (event) => {
				if (event.source !== window) return;
				if (event.origin !== 'https://claude.ai') return;
				const data = event.data;
				if (!data || data.cc !== 'ClaudeCounter') return;

				if (data.type === 'cc:response') {
					const { requestId, ok, payload, error } = data;
					const pending = this._pending.get(requestId);
					if (!pending) return;
					this._pending.delete(requestId);
					clearTimeout(pending.timeoutId);
					if (ok) pending.resolve(payload);
					else pending.reject(new Error(error || 'Bridge request failed'));
					return;
				}

				// Events
				this._emit(data.type, data.payload);
			});
		}

		_emit(type, payload) {
			const listeners = this._listeners.get(type);
			if (!listeners) return;
			for (const fn of listeners) {
				fn(payload);
			}
		}

		on(type, fn) {
			if (!this._listeners.has(type)) this._listeners.set(type, new Set());
			this._listeners.get(type).add(fn);
			return () => this._listeners.get(type)?.delete(fn);
		}

		request(kind, payload, { timeoutMs = 10000 } = {}) {
			const requestId = makeRequestId();
			return new Promise((resolve, reject) => {
				const timeoutId = setTimeout(() => {
					this._pending.delete(requestId);
					reject(new Error(`Bridge request timed out (${kind})`));
				}, timeoutMs);

				this._pending.set(requestId, { resolve, reject, timeoutId });
				window.postMessage(
					{
						cc: 'ClaudeCounter',
						type: 'cc:request',
						requestId,
						kind,
						payload
					},
					'https://claude.ai'
				);
			});
		}

		async requestUsage(orgId) {
			return this.request('usage', { orgId }, { timeoutMs: 15000 });
		}

		async requestOrgs() {
			return this.request('orgs', {}, { timeoutMs: 15000 });
		}

		async requestConversation(orgId, conversationId) {
			return this.request('conversation', { orgId, conversationId }, { timeoutMs: 20000 });
		}
	}

	/**
	 * The bridge is declared in the manifest to run in the page's own world at
	 * document_start, so it is in place before claude.ai's first script, and long
	 * before this one, so there is nothing to wait for. What it may have seen before
	 * we were listening (the org id) it says again when greeted.
	 */
	function connectBridge() {
		window.postMessage({ cc: 'ClaudeCounter', type: 'cc:hello' }, 'https://claude.ai');
	}

	CC.bridge = new BridgeClient();
	CC.connectBridge = connectBridge;
})();
