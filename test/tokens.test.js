// The count follows what the model sees: after a compaction, the summary and what
// came after it. The compaction_summary shape is claude.ai's own (seen 2026-10-15).
const { loadWith, section, t, report } = require('./harness');

// A word count stands in for the vendored tokenizer, which needs browser globals.
const { computeConversationMetrics } = loadWith({
	setup: (x) => { x.GPTTokenizer_o200k_base = { countTokens: (text) => text.split(/\s+/).filter(Boolean).length }; }
}, 'src/content/constants.js', 'src/content/tokens.js').ClaudeCounter.tokens;
const ROOT = '00000000-0000-4000-8000-000000000000';
const msg = (uuid, parent, sender, text, extra = {}) => ({ uuid, parent_message_uuid: parent, sender, created_at: '2026-10-15T10:00:00Z', content: [{ type: 'text', text }], ...extra });
const long = 'word '.repeat(5000);

section('a chat with no compaction counts the whole branch');
{
	const conv = { current_leaf_message_uuid: 'b', chat_messages: [msg('a', ROOT, 'human', long), msg('b', 'a', 'assistant', 'ok')] };
	t('counts everything', computeConversationMetrics(conv).totalTokens > 4000);
}

section('a compacted chat counts from its last summary');
{
	const conv = {
		current_leaf_message_uuid: 'e',
		chat_messages: [
			msg('a', ROOT, 'human', long),
			msg('b', 'a', 'assistant', long, { compaction_summary: [{ type: 'text', text: long }] }),
			msg('c', 'b', 'human', long),
			msg('d', 'c', 'assistant', 'reply', { compaction_summary: [{ type: 'text', text: 'short summary' }] }),
			msg('e', 'd', 'human', 'next')
		]
	};
	const n = computeConversationMetrics(conv).totalTokens;
	t('only the summary and what follows', n === 4, String(n));
}

section('a summary on another branch does not count');
{
	const conv = {
		current_leaf_message_uuid: 'b',
		chat_messages: [
			msg('a', ROOT, 'human', long),
			msg('b', 'a', 'assistant', 'ok'),
			msg('x', 'a', 'assistant', 'other', { compaction_summary: [{ type: 'text', text: 's' }] })
		]
	};
	t('the active branch is counted whole', computeConversationMetrics(conv).totalTokens > 4000);
}

process.exit(report('tokens'));
