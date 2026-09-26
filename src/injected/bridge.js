(() => {
	'use strict';

	const CC_MARKER = 'ClaudeCounter';

	// Capture original fetch before anyone else can wrap it
	const originalFetch = window.fetch;

	// Wrap history methods early to detect SPA navigation (before frameworks cache them)
	const originalPushState = history.pushState.bind(history);
	const originalReplaceState = history.replaceState.bind(history);

	history.pushState = function (...args) {
		const result = originalPushState(...args);
		window.dispatchEvent(new CustomEvent('cc:urlchange'));
		return result;
	};

	history.replaceState = function (...args) {
		const result = originalReplaceState(...args);
		window.dispatchEvent(new CustomEvent('cc:urlchange'));
		return result;
	};

	let lastSeenOrgId = null;

	window.fetch = async (...args) => {
		const url = toAbsoluteUrl(args[0]);
		const opts = args[1] || {};

		// Learn the org id from any org-scoped call claude.ai makes. The content
		// script otherwise depends entirely on a `lastActiveOrg` cookie, and without
		// it every usage request is skipped in silence.
		if (url) {
			const orgMatch = url.match(/\/api\/organizations\/([^/?#]+)/);
			if (orgMatch && orgMatch[1] !== lastSeenOrgId) {
				lastSeenOrgId = orgMatch[1];
				post('cc:org', { orgId: lastSeenOrgId });
			}
		}

		// Detect generation start (completion requests). The method may live on a
		// Request object rather than in the init, depending on how it was called.
		const method = String(opts.method || (args[0] instanceof Request ? args[0].method : 'GET')).toUpperCase();
		const completion = url && method === 'POST' && (url.includes('/completion') || url.includes('/retry_completion'))
			? (getConversationMeta(url) || {})
			: null;
		if (completion) post('cc:generation_start', {});

		let response;
		try {
			response = await originalFetch.apply(window, args);
		} catch (e) {
			if (completion) post('cc:generation_end', completion);
			throw e;
		}

		const contentType = response.headers.get('content-type') || '';
		if (contentType.includes('event-stream')) {
			handleEventStream(response, completion);
		} else if (completion) {
			// A refused completion (rate limit, error) answers with JSON, not a stream.
			post('cc:generation_end', completion);
		}

		// Catch conversation tree fetches
		if (url && url.includes('/chat_conversations/') && url.includes('tree=')) {
			const meta = getConversationMeta(url);
			if (meta) {
				handleConversationResponse(meta, response);
			}
		}

		return response;
	};

	// Payloads carry whole conversations. Address them to this origin rather than
	// '*' so the browser refuses to deliver if the page is ever not claude.ai.
	const TARGET_ORIGIN = window.location.origin;

	// Org and conversation ids land in a URL path. Refuse anything containing a
	// slash, dot or colon so a crafted request cannot walk to another endpoint.
	const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

	function safeId(value) {
		return typeof value === 'string' && ID_PATTERN.test(value) ? value : null;
	}

	function post(type, payload) {
		window.postMessage({ cc: CC_MARKER, type, payload }, TARGET_ORIGIN);
	}

	function postResponse(requestId, ok, payload, error) {
		window.postMessage(
			{
				cc: CC_MARKER,
				type: 'cc:response',
				requestId,
				ok,
				payload,
				error
			},
			TARGET_ORIGIN
		);
	}

	function toAbsoluteUrl(input) {
		if (typeof input === 'string') {
			if (input.startsWith('/')) return `https://claude.ai${input}`;
			return input;
		}
		if (input instanceof URL) return input.href;
		if (input instanceof Request) return input.url;
		return '';
	}

	function getConversationMeta(url) {
		// /api/organizations/{orgId}/chat_conversations/{conversationId}
		const match = url.match(/^https:\/\/claude\.ai\/api\/organizations\/([^/]+)\/chat_conversations\/([^/?]+)/);
		return match ? { orgId: match[1], conversationId: match[2] } : null;
	}

	async function handleConversationResponse({ orgId, conversationId }, response) {
		try {
			const cloned = response.clone();
			const data = await cloned.json();
			post('cc:conversation', { orgId, conversationId, data });
		} catch {
			// ignore parse failures
		}
	}

	/**
	 * Reads a clone of an SSE response. For a completion stream, its end is the
	 * only signal that a reply has landed: claude.ai renders the reply from the
	 * stream and does not refetch the conversation tree afterwards, so the token
	 * count and cache timer would otherwise stay at whatever the page loaded with.
	 * That is why this reads to the end rather than stopping at `message_limit`.
	 */
	async function handleEventStream(response, completion) {
		try {
			const cloned = response.clone();
			const reader = cloned.body?.getReader?.();
			if (!reader) return;
			const decoder = new TextDecoder();
			let buffer = '';

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split(/\r\n|\r|\n/);
				buffer = lines.pop() || '';
				for (const line of lines) {
					if (!line.startsWith('data:')) continue;
					const raw = line.slice(5).trim();
					if (!raw) continue;
					try {
						const json = JSON.parse(raw);
						if (json?.type === 'message_limit' && json.message_limit) {
							post('cc:message_limit', json.message_limit);
						}
					} catch {
						// ignore
					}
				}
			}
		} catch {
			// best-effort; don't break claude.ai. A stopped generation lands here
			// too, and still leaves a partial reply worth counting.
		} finally {
			if (completion) post('cc:generation_end', completion);
		}
	}

	window.addEventListener('message', async (event) => {
		if (event.source !== window) return;
		const data = event.data;
		if (!data || data.cc !== CC_MARKER) return;
		if (data.type !== 'cc:request') return;

		const { requestId, kind, payload } = data;
		try {
			if (kind === 'hash') {
				const text = typeof payload?.text === 'string' ? payload.text : '';
				if (!text || !crypto?.subtle?.digest) {
					postResponse(requestId, false, null, 'Hash unavailable');
					return;
				}
				const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
				const bytes = new Uint8Array(buffer);
				const hash = Array.from(bytes.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
				postResponse(requestId, true, { hash }, null);
				return;
			}

			if (kind === 'usage') {
				const orgId = safeId(payload?.orgId);
				if (!orgId) throw new Error('Invalid orgId');
				const res = await originalFetch(`https://claude.ai/api/organizations/${orgId}/usage`, {
					method: 'GET',
					credentials: 'include'
				});
				const json = await res.json();
				postResponse(requestId, true, json, null);
				return;
			}

			if (kind === 'orgs') {
				const res = await originalFetch('https://claude.ai/api/organizations', {
					method: 'GET',
					credentials: 'include'
				});
				const json = await res.json();
				postResponse(requestId, true, json, null);
				return;
			}

			if (kind === 'conversation') {
				const orgId = safeId(payload?.orgId);
				const conversationId = safeId(payload?.conversationId);
				if (!orgId || !conversationId) throw new Error('Invalid orgId/conversationId');

				const url = `https://claude.ai/api/organizations/${orgId}/chat_conversations/${conversationId}?tree=true&rendering_mode=messages&render_all_tools=true`;
				const res = await originalFetch(url, {
					method: 'GET',
					credentials: 'include'
				});
				const json = await res.json();
				post('cc:conversation', { orgId, conversationId, data: json });
				postResponse(requestId, true, json, null);
				return;
			}

			throw new Error(`Unknown request kind: ${kind}`);
		} catch (e) {
			postResponse(requestId, false, null, e?.message || String(e));
		}
	});
})();
