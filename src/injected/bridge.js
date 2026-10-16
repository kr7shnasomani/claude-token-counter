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
		// Nothing of ours may stand between claude.ai and its own request: whatever
		// goes wrong in here, the request still goes out exactly as asked.
		let url;
		let path;
		let completion;
		try {
			url = toAbsoluteUrl(args[0]);
			path = url.split('?')[0];

			// Learn the org id from any org-scoped call claude.ai makes. The content
			// script otherwise depends entirely on a `lastActiveOrg` cookie, and without
			// it every usage request is skipped in silence. claude.ai's own calls only,
			// and only an id that could be one.
			const orgId = safeId(url.match(/^https:\/\/claude\.ai\/api\/organizations\/([^/?#]+)/)?.[1]);
			if (orgId && orgId !== lastSeenOrgId) {
				lastSeenOrgId = orgId;
				post('cc:org', { orgId });
			}

			// Detect generation start (completion requests). The method may live on a
			// Request object rather than in the init, depending on how it was called.
			const method = String(args[1]?.method || (args[0] instanceof Request ? args[0].method : 'GET')).toUpperCase();
			completion = url && method === 'POST' && /\/(retry_)?completion$/.test(path)
				? (getConversationMeta(url) || {})
				: null;
			if (completion) post('cc:generation_start', {});
		} catch {
			url = '';
			path = '';
			completion = null;
		}

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
			if (!response.ok) handleRefusal(response);
			post('cc:generation_end', completion);
		} else if (path && response.ok && TIMELINE.test(path)) {
			handleTimeline(response);
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

	/** The request's absolute URL, resolved the way fetch itself resolves it. */
	function toAbsoluteUrl(input) {
		const raw = input instanceof Request ? input.url : input instanceof URL ? input.href : typeof input === 'string' ? input : '';
		try {
			return raw ? new URL(raw, window.location.href).href : '';
		} catch {
			return '';
		}
	}

	function getConversationMeta(url) {
		// /api/organizations/{orgId}/chat_conversations/{conversationId}
		const match = url.match(/^https:\/\/claude\.ai\/api\/organizations\/([^/]+)\/chat_conversations\/([^/?]+)/);
		return match ? { orgId: match[1], conversationId: match[2] } : null;
	}

	async function handleConversationResponse({ orgId, conversationId }, response) {
		try {
			if (!response.ok) return;
			const data = await response.clone().json();
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
					// Only one event is read here; a long reply is thousands of lines.
					if (!line.startsWith('data:') || !line.includes('message_limit')) continue;
					const raw = line.slice(5).trim();
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

	/**
	 * The send refused for hitting the limit still reports usage, as the same
	 * message_limit object JSON-encoded in `error.message`. On a free plan it is the
	 * last reading that window gets: after it the composer is gone.
	 */
	async function handleRefusal(response) {
		try {
			const inner = (await response.clone().json())?.error?.message;
			const limit = typeof inner === 'string' ? JSON.parse(inner) : inner;
			if (limit?.windows) post('cc:message_limit', { ...limit, via: 'refusal' });
		} catch {
			// not a limit refusal
		}
	}

	// The newer layout sends over Connect RPC and gets its replies on this stream,
	// binary protobuf, where message_limit also travels. REST usage is null on the
	// free plan, so without reading it a free account on that layout never had usage.
	const TIMELINE = /\.ConversationService\/StreamTimeline$/;

	// Conversation.Status: RUNNING, WAITING_FOR_INPUT and RECOVERING are a turn in
	// progress; IDLE, COMPLETED and ERROR end it.
	const BUSY = new Set([2, 3, 6]);
	const ENDED = new Set([1, 4, 5]);
	// Far above any real message; a length past it means the framing was misread.
	const MAX_FRAME_BYTES = 64 * 1024 * 1024;
	const UTF8 = new TextDecoder();

	/**
	 * Reads a clone of the timeline stream. Two things travel on it that the newer
	 * layout has nowhere else: message_limit (usage), posted in the completion
	 * stream's shape, and the conversation's status, whose busy-to-ended edge is the
	 * end of a reply, posted as generation_end exactly as a completion stream's close
	 * is. The page's own `data-is-streaming` attribute is still watched, but a short
	 * reply can flip it on and off between two looks. Field numbers are from
	 * claude.ai's own schema (2026-10-07), see `timelineEvent`.
	 */
	async function handleTimeline(response) {
		// Per conversation: one stream can carry updates for more than one chat, and
		// another chat going idle must not end this one's reply.
		const busy = new Set();
		try {
			const reader = response.clone().body?.getReader?.();
			if (!reader) return;
			// Grown by doubling and compacted after each pass: a long chat's first
			// message is the whole conversation, and appending chunk by chunk to a
			// fresh copy each time cost a full copy per chunk.
			let buf = new Uint8Array(1 << 16);
			let used = 0;
			reading: while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				if (used + value.length > buf.length) {
					const grown = new Uint8Array(Math.max(buf.length * 2, used + value.length));
					grown.set(buf.subarray(0, used));
					buf = grown;
				}
				buf.set(value, used);
				used += value.length;
				// Connect framing: one flags byte, a 4-byte big-endian length, the message.
				let pos = 0;
				while (used - pos >= 5) {
					const len = ((buf[pos + 1] << 24) | (buf[pos + 2] << 16) | (buf[pos + 3] << 8) | buf[pos + 4]) >>> 0;
					// Out of step with the framing; nothing after this can be trusted, and
					// a copy left unread would buffer the rest of the stream.
					if (len > MAX_FRAME_BYTES) {
						reader.cancel().catch(() => {});
						break reading;
					}
					if (used - pos < 5 + len) break;
					const flags = buf[pos];
					// A view, not a copy: it is read in full before the buffer is compacted.
					const frame = buf.subarray(pos + 5, pos + 5 + len);
					pos += 5 + len;
					if (flags & 2) continue; // end-of-stream trailer, JSON
					// One message that does not decode is skipped, not the rest of the stream.
					try {
						const payload = flags & 1 ? new Uint8Array(await new Response(new Blob([frame]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()) : frame;
						const { limit, status, conversationId } = timelineEvent(payload);
						if (limit) post('cc:message_limit', limit);
						const id = safeId(conversationId) || '';
						if (BUSY.has(status) && !busy.has(id)) {
							busy.add(id);
							post('cc:generation_start', { conversationId: id || undefined });
						} else if (ENDED.has(status)) {
							// An update that does not name its chat cannot be matched, so it ends
							// whatever was running rather than leave a reply never ending.
							let ended = [];
							if (id && busy.has(id)) ended = [id];
							else if (!id || busy.has('')) ended = [...busy];
							for (const endedId of ended) {
								busy.delete(endedId);
								post('cc:generation_end', { conversationId: endedId || undefined });
							}
						}
					} catch {
						// not a message we can read
					}
				}
				buf.copyWithin(0, pos, used);
				used -= pos;
				// The first message can be the whole chat; do not hold its size all day.
				if (buf.length > 1 << 20 && used < 1 << 16) buf = buf.slice(0, 1 << 16);
			}
		} catch {
			// best-effort; the page reads its own copy regardless
		}
		// A stream that closes or goes out of step mid-reply still ends the wait.
		for (const id of busy) post('cc:generation_end', { conversationId: id || undefined });
	}

	/**
	 * One timeline message: StreamTimelineResponse.event = 1; on the event,
	 * update = 1 (ConversationUpdate: conversation = 2, a Conversation whose id = 1
	 * and status = 3) or message_limit = 4 (windows = 13, a map of "5h"/"7d" to a
	 * window: status = 1 with 3 meaning exceeded, resets_at = 2 as a Timestamp,
	 * utilization = 3 as a double). A field that is absent is simply not reported.
	 */
	function timelineEvent(payload) {
		const event = protoFields(payload)[1]?.[0];
		if (!event) return {};
		const fields = protoFields(event);
		const update = fields[1]?.[0];
		const conversation = update && protoFields(update)[2]?.[0];
		if (conversation) {
			const c = protoFields(conversation);
			return { status: c[3]?.[0], conversationId: c[1] && UTF8.decode(c[1][0]) };
		}
		return { limit: timelineLimit(fields[4]?.[0]) };
	}

	function timelineLimit(limit) {
		if (!limit) return null;
		const windows = {};
		for (const entry of protoFields(limit)[13] || []) {
			const e = protoFields(entry);
			const key = e[1] && UTF8.decode(e[1][0]);
			if (!key || !e[2]) continue;
			const w = protoFields(e[2][0]);
			const resetsAt = w[2] && protoFields(w[2][0])[1]?.[0];
			if (typeof resetsAt !== 'number') continue;
			windows[key] = { status: w[1]?.[0] === 3 ? 'exceeded_limit' : 'within_limit', resets_at: resetsAt, utilization: w[3]?.[0] ?? 0 };
		}
		return Object.keys(windows).length ? { windows, via: 'timeline' } : null;
	}


	/**
	 * One level of a protobuf message as { fieldNumber: [values] }: varints as numbers,
	 * 64-bit fixed as doubles (the only fixed64 read here is one), length-delimited as
	 * bytes to decode further. Throws on malformed input; callers are in a try.
	 */
	function protoFields(bytes) {
		const out = {};
		let pos = 0;
		const varint = () => {
			let v = 0;
			for (let shift = 0; ; shift += 7) {
				if (pos >= bytes.length || shift > 63) throw new Error('bad varint');
				const b = bytes[pos++];
				v += (b & 0x7f) * 2 ** shift;
				if (b < 0x80) return v;
			}
		};
		while (pos < bytes.length) {
			const tag = varint();
			const wire = tag % 8;
			let value;
			if (wire === 0) value = varint();
			else if (wire === 1) { value = new DataView(bytes.buffer, bytes.byteOffset + pos, 8).getFloat64(0, true); pos += 8; }
			else if (wire === 2) { const n = varint(); value = bytes.subarray(pos, pos + n); pos += n; }
			else if (wire === 5) { pos += 4; continue; }
			else throw new Error('bad wire type');
			if (pos > bytes.length) throw new Error('truncated');
			(out[Math.floor(tag / 8)] ||= []).push(value);
		}
		return out;
	}

	// An HTTP error still answers with JSON (a rate limit, an expired session), and
	// read as data it became an empty conversation, a "no usage" account and a FREE
	// plan. It is a failure, and is reported as one.
	async function getJson(url) {
		const res = await originalFetch(url, { method: 'GET', credentials: 'include' });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		return res.json();
	}

	window.addEventListener('message', async (event) => {
		if (event.source !== window) return;
		const data = event.data;
		if (!data || data.cc !== CC_MARKER) return;
		// This runs before the content script exists, so an org id seen in that time
		// went to nobody. Said again when the content script arrives.
		if (data.type === 'cc:hello') {
			if (lastSeenOrgId) post('cc:org', { orgId: lastSeenOrgId });
			return;
		}
		if (data.type !== 'cc:request') return;

		const { requestId, kind, payload } = data;
		try {
			if (kind === 'usage') {
				const orgId = safeId(payload?.orgId);
				if (!orgId) throw new Error('Invalid orgId');
				postResponse(requestId, true, await getJson(`https://claude.ai/api/organizations/${orgId}/usage`), null);
				return;
			}

			if (kind === 'orgs') {
				postResponse(requestId, true, await getJson('https://claude.ai/api/organizations'), null);
				return;
			}

			if (kind === 'conversation') {
				const orgId = safeId(payload?.orgId);
				const conversationId = safeId(payload?.conversationId);
				if (!orgId || !conversationId) throw new Error('Invalid orgId/conversationId');

				const url = `https://claude.ai/api/organizations/${orgId}/chat_conversations/${conversationId}?tree=true&rendering_mode=messages&render_all_tools=true`;
				// Answered once, in the response: broadcasting it as well meant cloning a
				// whole conversation across the world boundary twice per refresh.
				postResponse(requestId, true, await getJson(url), null);
				return;
			}

			throw new Error(`Unknown request kind: ${kind}`);
		} catch (e) {
			postResponse(requestId, false, null, e?.message || String(e));
		}
	});
})();
