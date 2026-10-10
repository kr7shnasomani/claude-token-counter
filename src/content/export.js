(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	const SENDER_LABEL = { human: 'You', assistant: 'Claude' };

	// Tools whose payload is a document the user asked for, rather than plumbing.
	const FILE_TOOLS = new Set(['create_file', 'artifacts']);

	const FENCE_LANG = {
		md: 'markdown', markdown: 'markdown', txt: '', text: '',
		js: 'javascript', mjs: 'javascript', ts: 'typescript', tsx: 'tsx', jsx: 'jsx',
		py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', sh: 'bash',
		html: 'html', css: 'css', json: 'json', yaml: 'yaml', yml: 'yaml',
		csv: 'csv', sql: 'sql', xml: 'xml'
	};

	function basename(path) {
		if (typeof path !== 'string') return '';
		const parts = path.split('/');
		return parts[parts.length - 1] || path;
	}

	function fenceLanguage(name) {
		const ext = (name.split('.').pop() || '').toLowerCase();
		return FENCE_LANG[ext] ?? '';
	}

	/** A fence long enough to survive backticks inside the content. */
	function fenceFor(text) {
		let longest = 0;
		for (const run of String(text).match(/`+/g) || []) longest = Math.max(longest, run.length);
		return '`'.repeat(Math.max(3, longest + 1));
	}

	function formatBytes(bytes) {
		if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '';
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	function formatDateTime(value) {
		const ms = typeof value === 'number' ? value : Date.parse(value);
		if (!Number.isFinite(ms)) return '';
		return new Date(ms).toLocaleString(undefined, {
			day: 'numeric', month: 'short', year: 'numeric',
			hour: '2-digit', minute: '2-digit'
		});
	}

	function slugify(name) {
		const base = String(name || 'claude-conversation')
			.toLowerCase()
			// Letters and digits of any script: a Chinese or Hindi title is still a name.
			.replace(/[^\p{L}\p{N}]+/gu, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 60);
		return base || 'claude-conversation';
	}

	/** A tool_use block that produced a document, or null. */
	function asGeneratedFile(item) {
		if (item?.type !== 'tool_use' || !FILE_TOOLS.has(item.name)) return null;
		const input = item.input || {};

		// Newer file-based flow.
		if (typeof input.file_text === 'string') {
			return { name: basename(input.path) || 'untitled', text: input.file_text };
		}
		// Classic artifacts tool.
		if (typeof input.content === 'string' && input.command !== 'delete') {
			return { name: input.title || input.id || 'artifact', text: input.content, lang: input.language };
		}
		return null;
	}

	/** What a generated file is known by across turns: its path, or an artifact's id. */
	function fileKey(item) {
		const input = item?.input || {};
		if (typeof input.path === 'string') return input.path;
		return item?.name === 'artifacts' && typeof input.id === 'string' ? `artifact:${input.id}` : null;
	}

	/** Apply one str_replace edit. Literal match on the first occurrence only. */
	function applyEdit(text, oldStr, newStr) {
		if (typeof text !== 'string' || typeof oldStr !== 'string') return null;
		const at = text.indexOf(oldStr);
		if (at === -1) return null;
		return text.slice(0, at) + (typeof newStr === 'string' ? newStr : '') + text.slice(at + oldStr.length);
	}

	/**
	 * Walk the whole trunk once and replay every file edit, so a generated file is
	 * exported as it ended up rather than as it was first written. A file can be
	 * created once and then edited many times across later turns.
	 */
	function replayFiles(trunk) {
		const byPath = new Map();
		const orphans = new Set();

		for (const message of trunk) {
			for (const item of Array.isArray(message?.content) ? message.content : []) {
				if (item?.type !== 'tool_use') continue;
				const input = item.input || {};

				const key = fileKey(item);
				// The classic artifacts tool edits in place with the same old/new pair.
				const isEdit = item.name === 'str_replace' || (item.name === 'artifacts' && input.command === 'update');
				if (FILE_TOOLS.has(item.name) && !isEdit) {
					const file = asGeneratedFile(item);
					if (file && key) byPath.set(key, { text: file.text, edits: 0, failed: 0 });
					continue;
				}

				if (isEdit && key) {
					const state = byPath.get(key);
					if (!state) {
						// Created outside this transcript (a shell heredoc, an earlier
						// branch): there is no base text to apply the edit to.
						if (item.name === 'str_replace') orphans.add(input.path);
						continue;
					}
					const next = applyEdit(state.text, input.old_str, input.new_str);
					if (next === null) state.failed += 1;
					else {
						state.text = next;
						state.edits += 1;
					}
				}
			}
		}

		return { byPath, orphans, noted: new Set() };
	}

	/**
	 * Reduce one message to an ordered list of renderable blocks.
	 * Tool plumbing collapses into a single summary rather than pages of JSON.
	 */
	function messageBlocks(message, files) {
		const blocks = [];
		const toolCounts = new Map();

		for (const item of Array.isArray(message?.content) ? message.content : []) {
			if (item?.type === 'text') {
				if (typeof item.text === 'string' && item.text.trim()) blocks.push({ kind: 'text', text: item.text.trim() });
				continue;
			}
			if (item?.type === 'tool_use') {
				const file = asGeneratedFile(item);
				if (file) {
					const state = files?.byPath.get(fileKey(item));
					blocks.push({ kind: 'file', ...file, ...(state ? { text: state.text, edits: state.edits, failed: state.failed } : {}) });
					continue;
				}
				if (item.name === 'str_replace' && files) {
					const path = item.input?.path;
					if (path && files.orphans.has(path) && !files.noted.has(path)) {
						files.noted.add(path);
						blocks.push({ kind: 'orphanEdit', name: basename(path) });
					}
				}
				if (item.name) toolCounts.set(item.name, (toolCounts.get(item.name) || 0) + 1);
			}
			// tool_result is the machine side of a call; the summary above covers it.
		}

		for (const a of Array.isArray(message?.attachments) ? message.attachments : []) {
			blocks.push({
				kind: 'attachment',
				name: a?.file_name || `untitled.${a?.file_type || 'file'}`,
				size: formatBytes(a?.file_size)
			});
		}
		for (const f of Array.isArray(message?.files) ? message.files : []) {
			blocks.push({ kind: 'media', name: f?.file_name || 'file', mediaKind: f?.file_kind || 'file' });
		}

		if (toolCounts.size) {
			const parts = [...toolCounts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name));
			blocks.push({ kind: 'tools', text: parts.join(', ') });
		}

		return blocks;
	}

	/** "(final version, 7 edits applied)" - so replayed content isn't mistaken for the original. */
	function editNote(block) {
		if (!block.edits) return '';
		const parts = [`final version, ${block.edits} edit${block.edits === 1 ? '' : 's'} applied`];
		if (block.failed) parts.push(`${block.failed} could not be applied`);
		return `(${parts.join('; ')})`;
	}

	const attachmentSize = (block) => (block.size ? ` (${block.size})` : '');

	// How each format lays out a conversation. `turn` opens a message; every other
	// entry renders one block kind. Both return lines.
	const MARKDOWN = {
		head: (title, meta) => [`# ${title}`, '', `*${meta}*`, ''],
		turn: (who, when) => ['---', '', when ? `## ${who} · ${when}` : `## ${who}`, ''],
		orphanEdit: (b) => [`*\u{270F}\u{FE0F} Edited \`${b.name}\` - created outside this transcript, content unavailable.*`, ''],
		file: (b) => {
			const fence = fenceFor(b.text);
			const note = editNote(b);
			return [
				`**Generated file: \`${b.name}\`**${note && ` *${note}*`}`, '',
				`${fence}${b.lang || fenceLanguage(b.name)}`, b.text, fence, ''
			];
		},
		attachment: (b) => [`\u{1F4CE} *Attachment: ${b.name}${attachmentSize(b)}*`, ''],
		media: (b) => [`\u{1F5BC}\u{FE0F} *${b.mediaKind}: ${b.name}*`, ''],
		tools: (b) => [`*\u{1F527} Used: ${b.text}*`, '']
	};

	const RULE = '='.repeat(60);
	const THIN = '-'.repeat(60);
	const PLAIN = {
		head: (title, meta) => [title, meta, RULE, ''],
		turn: (who, when) => [when ? `${who.toUpperCase()}  (${when})` : who.toUpperCase(), THIN],
		orphanEdit: (b) => [`[edited ${b.name} - created outside this transcript, content unavailable]`, ''],
		file: (b) => {
			const note = editNote(b);
			return [`--- generated file: ${b.name}${note && ` ${note}`} ---`, b.text, `--- end of ${b.name} ---`, ''];
		},
		attachment: (b) => [`[attachment: ${b.name}${attachmentSize(b)}]`, ''],
		media: (b) => [`[${b.mediaKind}: ${b.name}]`, ''],
		tools: (b) => [`[used: ${b.text}]`, '']
	};

	function render(conversation, layout) {
		const trunk = CC.tokens.buildTrunk(conversation);
		const files = replayFiles(trunk);

		const meta = [`Exported ${formatDateTime(Date.now())}`, `${trunk.length} message${trunk.length === 1 ? '' : 's'}`];
		if (conversation?.model) meta.push(conversation.model);
		const out = layout.head(conversation?.name || 'Claude conversation', meta.join(' · '));

		for (const message of trunk) {
			const who = SENDER_LABEL[message?.sender] || message?.sender || 'Unknown';
			out.push(...layout.turn(who, formatDateTime(message?.created_at)));
			for (const block of messageBlocks(message, files)) {
				out.push(...(block.kind === 'text' ? [block.text, ''] : layout[block.kind](block)));
			}
		}

		// One blank line between blocks at most. Decided on the blocks, not on the joined
		// text: a file or a code block keeps every blank line it was written with.
		return out.filter((line, i) => line !== '' || out[i - 1] !== '').join('\n').trimEnd() + '\n';
	}

	const buildMarkdown = (conversation) => render(conversation, MARKDOWN);
	const buildText = (conversation) => render(conversation, PLAIN);

	const FORMATS = {
		md: { build: buildMarkdown, ext: 'md', mime: 'text/markdown' },
		txt: { build: buildText, ext: 'txt', mime: 'text/plain' }
	};

	function buildFile(conversation, format) {
		const spec = FORMATS[format] || FORMATS.md;
		// Local date, not UTC: an evening export in a UTC+ timezone would otherwise be
		// stamped with yesterday's date and disagree with the header inside the file.
		const now = new Date();
		const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
		return {
			filename: `${slugify(conversation?.name)}-${stamp}.${spec.ext}`,
			mime: spec.mime,
			content: spec.build(conversation)
		};
	}

	/** Hand the file to the browser. Uses a blob URL, so no `downloads` permission. */
	function download(conversation, format) {
		const file = buildFile(conversation, format);
		const url = URL.createObjectURL(new Blob([file.content], { type: `${file.mime};charset=utf-8` }));
		const link = document.createElement('a');
		link.href = url;
		link.download = file.filename;
		link.style.display = 'none';
		document.body.appendChild(link);
		link.click();
		link.remove();
		setTimeout(() => URL.revokeObjectURL(url), 10000);
		return file.filename;
	}

	CC.exportChat = { buildMarkdown, buildText, buildFile, download, slugify };
})();
