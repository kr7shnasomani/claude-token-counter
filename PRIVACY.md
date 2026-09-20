# Privacy Policy for Claude Token Counter

**Last updated:** August 30, 2026

## Overview

Claude Token Counter is a browser extension that operates entirely within your browser. It does not collect, transmit, or store any personal data on external servers.

## Data Accessed

### Cookies
The extension reads the `lastActiveOrg` cookie from `claude.ai` solely to identify your active Claude organization. This is used to query Claude's own API on your behalf for usage data. The cookie value is never stored, logged, or transmitted outside of `claude.ai`.

### Network Requests
The extension makes requests exclusively to the following Claude API endpoints:
- `https://claude.ai/api/organizations/{orgId}/usage` — to fetch your session and weekly usage data
- `https://claude.ai/api/organizations/{orgId}/chat_conversations/{conversationId}` — to fetch conversation data for token counting

No data from these responses is ever sent to any external server.

### Website Content
The extension reads text content from Claude.ai pages, including conversation data and streaming API responses, for the purposes of token counting, usage display, and chat export. This data is processed locally and never transmitted externally.

### Chat Export
The export feature converts conversation data into a Markdown file that is saved directly to your device via the browser's download mechanism. No conversation content is sent to any external server during export.

## Data Storage

The extension uses `chrome.storage.local` (browser-local storage) for three purposes:

- **Usage snapshot** — The latest usage-bar reading (the two windows' percentages and reset times), your organisation id, plan name, and which Claude layout was detected, saved so the toolbar popup can display them without requiring a Claude.ai tab to be open. No token count, cache timer, or conversation content is stored.
- **User settings** — A single settings object recording which on-page elements you have switched off, persisted so preferences survive page reloads and browser restarts.
- **Bug-report draft** — The feedback form in the popup auto-saves draft text so it is not lost if the popup is closed accidentally.

All stored data remains on your device. The extension does **not** use:
- `localStorage` or `sessionStorage`
- Any remote database or analytics service

## Third Parties

This extension does not integrate any third-party analytics, advertising, or tracking services. The only vendored third-party code is the `gpt-tokenizer` library (MIT licensed, by Bazyli Brzoska), which runs entirely locally for token counting.

## External Servers

This extension makes **no requests** to any server outside of `claude.ai`. No data ever leaves your browser to any server controlled by the extension author.

## Changes to This Policy

Any updates to this policy will be reflected in this file on the GitHub repository with an updated date at the top.

## Contact

For questions or concerns, open an issue on the [GitHub repository](https://github.com/kr1shnasomani/claude-token-counter).