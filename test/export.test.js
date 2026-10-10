// Payload shapes below mirror what claude.ai actually returns (verified against
// live conversations): text/thinking/tool_use/tool_result blocks, message-level
// attachments and files, create_file for generated documents, str_replace edits.
const { load, section, t, report } = require('./harness');

const X = load('src/content/constants.js', 'src/content/tokens.js', 'src/content/export.js').ClaudeCounter.exportChat;
const ROOT = '00000000-0000-4000-8000-000000000000';

const conv = {
	uuid: 'c1', name: 'Quarterly Stock Reconciliation', model: 'claude-sonnet-4-5',
	current_leaf_message_uuid: 'm4',
	chat_messages: [
		{ uuid: 'm1', parent_message_uuid: ROOT, sender: 'human', created_at: '2026-08-27T09:00:00Z',
			content: [{ type: 'text', text: 'Reconcile these orders' }],
			attachments: [{ file_name: 'orders.csv', file_size: 10751, file_type: 'csv', extracted_content: 'a,b,c' }],
			files: [{ file_kind: 'image', file_name: 'receipt.JPG' }] },
		{ uuid: 'm2', parent_message_uuid: 'm1', sender: 'assistant', created_at: '2026-08-27T09:01:00Z',
			content: [
				{ type: 'thinking', thinking: 'SECRET REASONING' },
				{ type: 'text', text: 'On it.' },
				{ type: 'tool_use', name: 'bash_tool', input: { command: 'ls' } },
				{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'NOISE' }] },
				{ type: 'tool_use', name: 'bash_tool', input: { command: 'cat' } },
				{ type: 'tool_use', name: 'web_search', input: { query: 'x' } },
				{ type: 'tool_use', name: 'create_file',
					input: { description: 'report', path: '/home/claude/build.py', file_text: 'VERSION = 1\nHas ``` a fence\n' } },
				{ type: 'tool_use', name: 'present_files', input: { filepaths: ['/home/claude/build.py'] } },
				{ type: 'text', text: 'Done - see the file.' }
			] },
		// Abandoned retry hanging off m1: must never reach the export.
		{ uuid: 'm3', parent_message_uuid: 'm1', sender: 'assistant', created_at: '2026-08-27T09:00:30Z',
			content: [{ type: 'text', text: 'ABANDONED BRANCH' }] },
		{ uuid: 'm4', parent_message_uuid: 'm2', sender: 'human', created_at: '2026-08-27T09:05:00Z',
			content: [{ type: 'text', text: 'thanks' }] }
	]
};

// A later turn edits the file twice, edits it once with a stale match, and edits
// a file that was never created in this transcript.
const edited = JSON.parse(JSON.stringify(conv));
edited.current_leaf_message_uuid = 'm5';
edited.chat_messages.push({
	uuid: 'm5', parent_message_uuid: 'm4', sender: 'assistant', created_at: '2026-08-27T09:10:00Z',
	content: [
		{ type: 'tool_use', name: 'str_replace', input: { path: '/home/claude/build.py', old_str: 'VERSION = 1', new_str: 'VERSION = 2' } },
		{ type: 'tool_use', name: 'str_replace', input: { path: '/home/claude/build.py', old_str: 'a fence', new_str: 'a FENCE' } },
		{ type: 'tool_use', name: 'str_replace', input: { path: '/home/claude/build.py', old_str: 'NOT PRESENT', new_str: 'x' } },
		{ type: 'tool_use', name: 'str_replace', input: { path: '/home/claude/ghost.py', old_str: 'a', new_str: 'b' } }
	]
});

const legacy = {
	name: 'Legacy', current_leaf_message_uuid: 'a1',
	chat_messages: [{ uuid: 'a1', parent_message_uuid: ROOT, sender: 'assistant', created_at: '2026-08-27T09:00:00Z',
		content: [{ type: 'tool_use', name: 'artifacts',
			input: { command: 'create', id: 'chart', title: 'Sales Chart', language: 'python', content: 'print(1)' } }] }]
};

const md = X.buildMarkdown(conv);
const txt = X.buildText(conv);
const mdEdited = X.buildMarkdown(edited);

section('active branch only');
t('abandoned branch excluded (md)', !md.includes('ABANDONED BRANCH'));
t('abandoned branch excluded (txt)', !txt.includes('ABANDONED BRANCH'));
t('every trunk message present', (md.match(/^## /gm) || []).length === 3);

section('nothing leaks that should not');
t('thinking is never exported', !md.includes('SECRET REASONING') && !txt.includes('SECRET REASONING'));
t('raw tool_result payload not dumped', !md.includes('NOISE'));

section('generated files');
t('file heading rendered', md.includes('**Generated file: `build.py`**'));
t('file body included', md.includes('VERSION = 1'));
t('fence outgrows inner backticks', md.includes('````'));
t('legacy artifacts tool still handled', X.buildMarkdown(legacy).includes('Sales Chart') && X.buildMarkdown(legacy).includes('print(1)'));

section('str_replace replay');
t('exports the final content, not the original', mdEdited.includes('VERSION = 2') && !mdEdited.includes('VERSION = 1'));
t('applies every matching edit', mdEdited.includes('a FENCE'));
t('labels replayed files', mdEdited.includes('final version, 2 edits applied'));
t('reports edits that could not be applied', mdEdited.includes('1 could not be applied'));
t('unmatched edit does not corrupt content', !mdEdited.includes('NOT PRESENT'));
t('notes files created outside the transcript', mdEdited.includes('ghost.py') && mdEdited.includes('content unavailable'));
t('unedited files carry no label', md.includes('**Generated file: `build.py`**\n'));

section('attachments and media');
t('attachment with human size', md.includes('orders.csv (10.5 KB)'));
t('image listed', md.includes('receipt.JPG'));

section('document structure');
t('title heading', md.startsWith('# Quarterly Stock Reconciliation'));
t('model in metadata', md.includes('claude-sonnet-4-5'));
t('speaker labels', md.includes('## You') && md.includes('## Claude'));
t('repeated tool counted', md.includes('bash_tool x2') || md.includes('bash_tool ×2'));
t('plain text has rules and captions', txt.includes('='.repeat(60)) && txt.includes('YOU') && txt.includes('CLAUDE'));
t('no runs of blank lines', !/\n{3,}/.test(md) && !/\n{3,}/.test(txt));

section('filenames');
const f1 = X.buildFile(conv, 'md');
const f2 = X.buildFile(conv, 'txt');
const today = new Date();
const local = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
t('slugged and dated', f1.filename === `quarterly-stock-reconciliation-${local}.md`, f1.filename);
t('stamp is local date, not UTC', f1.filename.includes(local));
t('txt extension and mime', f2.filename.endsWith('.txt') && f2.mime === 'text/plain');
t('unknown format falls back to markdown', X.buildFile(conv, 'bogus').filename.endsWith('.md'));

section('content is exported as written');
{
	const m = (uuid, parent, sender, content) => ({ uuid, parent_message_uuid: parent, sender, created_at: '2026-08-27T09:00:00Z', content });
	const py = 'import os\n\n\ndef a():\n    return 1\n\n\ndef b():\n    return 2';
	const spaced = { name: 'T', current_leaf_message_uuid: 'b', chat_messages: [
		m('a', ROOT, 'human', [{ type: 'text', text: 'make it' }]),
		m('b', 'a', 'assistant', [{ type: 'text', text: 'Here:\n```\none\n\n\n\nfive\n```' },
			{ type: 'tool_use', name: 'create_file', input: { path: '/out/app.py', file_text: py } }])] };
	t('a file keeps its blank lines (markdown)', X.buildMarkdown(spaced).includes(py));
	t('a file keeps its blank lines (plain text)', X.buildText(spaced).includes(py));
	t('so does a code block in a message', X.buildMarkdown(spaced).includes('one\n\n\n\nfive'));

	const updated = { name: 'T', current_leaf_message_uuid: 'c', chat_messages: [
		m('a', ROOT, 'human', [{ type: 'text', text: 'plan it' }]),
		m('b', 'a', 'assistant', [{ type: 'tool_use', name: 'artifacts', input: { command: 'create', id: 'doc1', title: 'Plan', content: 'Budget: 100' } }]),
		m('c', 'b', 'assistant', [{ type: 'tool_use', name: 'artifacts', input: { command: 'update', id: 'doc1', old_str: 'Budget: 100', new_str: 'Budget: 250' } }])] };
	const out = X.buildMarkdown(updated);
	t('an artifact update is replayed onto the artifact', out.includes('Budget: 250') && !out.includes('Budget: 100'));
	t('and said to be the final version', out.includes('final version, 1 edit applied'));
	t('a non-Latin title still names the file', X.slugify('项目计划 第二版') === '项目计划-第二版' && X.slugify('Отчёт за квартал') === 'отчёт-за-квартал');
}

section('robustness');
t('empty conversation', X.buildMarkdown({ name: 'x', chat_messages: [] }).length > 0);
t('missing fields', X.buildMarkdown({}).length > 0);
t('untitled slug fallback', X.slugify('!!!') === 'claude-conversation');

process.exit(report('export'));
