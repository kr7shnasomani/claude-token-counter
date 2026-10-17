# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm test                        # every suite via test/run.js
node test/security.test.js      # one suite (each file runs standalone)
npm run lint                    # eslint .
```

There is **no build step**. Load the repo root as an unpacked extension and
reload it after editing; content script changes need an extension reload, not
just a page refresh.

`.npmrc` sets `ignore-scripts=true` and CI installs with `npm ci
--ignore-scripts`. Do not install packages without asking first — this project
ships no runtime dependencies and that is deliberate.

## Two halves, two JavaScript worlds

claude.ai's own network traffic is invisible to a normal content script, so the
extension is split:

- `src/injected/bridge.js` runs in the **page's own world**. The manifest declares
  it as a content script with `world: "MAIN"` and `run_at: "document_start"`, so it
  patches `window.fetch` and `history.pushState`/`replaceState` before claude.ai's
  first script runs. That order matters: claude.ai's network code keeps the `fetch`
  it finds (seen 2026-10-15: a tap added after load never saw the timeline stream
  reconnect), so a bridge that arrived later, as the old `<script src>` injection at
  document idle did, could go blind without anything failing. Nothing is
  web-accessible any more. The bridge is in place before the content script exists,
  so what it saw in that time (the org id) it posts again when the content script
  greets it (`cc:hello`); `handleUrlChange` still fetches the first conversation
  itself.
- `src/content/*.js` runs in the **isolated content script world** and owns all
  UI.

They cannot call each other. The only channel is `window.postMessage`, tagged
`cc: 'ClaudeCounter'`, matched by request id for request/response and broadcast
for one-way events. Both sides check `event.source === window`; the content script
also checks the origin, and the bridge addresses replies to `window.location.origin`
rather than `'*'`. The bridge answers an HTTP error as a failed request, never as
data (`getJson`): a 429 or 401 still carries JSON, and read as data it was an empty
export, a "no usage" account and a `FREE` plan.
Ids that end up in a URL path are validated against `ID_PATTERN` first.

## Things that are not obvious and will bite

**Claude ships more than one composer design.** The usage row is anchored in
three tiers: `[data-cds="ChatComposer"]`, Claude's own design-system attribute;
then a `rounded-composer` class, which exists only on some variants; then by
*shape* — the nearest ancestor of `[data-testid="chat-input"]` that is a flex
column with a corner radius and a painted background. The header has its own
three-tier fallback (`chat-title-split`, or `session-title-split` on the newer layout
(seen 2026-10-15) → `chat-header` → semantic `<header>`).
Do not replace either with a single selector; that is exactly what broke before.
The composer tiers are not covered by a test — they need a real page — and the
header tiers are tested only for being reachable, not for how they look, so these
are the most fragile code here.
The usage row wraps (`flex-wrap`, each group `flex: 1 1 240px`) rather than overlap:
at phone width the two labels ran into each other and the bars shrank to nothing
(seen 2026-10-15 on a 390px window; one line from about 520px of composer up).

**Every header tier must be reachable.** `attachHeader` falls back from the
title testid (`chat-title-split` or `session-title-split`) to `chat-header` to a
semantic `<header>`. It used to run only
once a waiter had seen the title testid, so on a layout without it the fallbacks
were unreachable and the counter and timer never appeared while the composer's
usage row did (reports filed as `Claude UI: class`). There are no waiters now:
`handleUrlChange` and the DOM observer in `ui.js` call `attachHeader` and
`attachUsageLine` directly, and each does nothing until its anchor exists. The
observer searches at most once a second (it runs on every mutation batch, which
during streaming is hundreds a second) and schedules one retry when a batch fell
inside that window, because an idle page sends no second batch to look again on.
`test/header-attach.test.js` pins each tier from the observer, and the retry.

**Two layouts, two transports, and each has its own reply and usage signals.**
The older layout streams the reply from a `/completion` request (SSE): its close is
the reply's end and its `message_limit` event is usage. The newer one (a
`bardhub-claudechat-root` page) sends with a Connect RPC, `PerformAction`, and
receives everything on a long-lived `StreamTimeline` stream (Connect framing,
protobuf, often gzip per frame). The bridge reads a clone of that stream with a
minimal decoder for two paths only (`handleTimeline`, `timelineEvent`; field
numbers from claude.ai's schema of 2026-10-07, checked against real frames on
2026-10-15): the conversation's status, whose busy-to-ended edge is posted as
`cc:generation_end` (start as `cc:generation_start`, both naming the conversation,
since a stream can belong to another chat), and `message_limit`, posted in the SSE
shape with `via: 'timeline'`. On the free plan REST usage is null, so for a free
account on the newer layout the stream is the only usage source; until it was read
such accounts had no usage at all (reports from 2026-10-11 on). A send refused at
the limit carries the same object JSON-encoded in `error.message`
(`handleRefusal`), and a window whose status is exceeded reads as 100%, since its
utilization can say 0.98. As a second, DOM-level signal `main.js`
`watchStreaming()` watches `data-is-streaming="true"` on the assistant message
(language-independent) and refetches when it clears; it reads the mutation
records' old values too, because a one-word reply turned the flag on and off
between two looks and was missed (seen 2026-10-15). Both report one reply, so
whichever comes second within `SIGNAL_OVERLAP_MS` (two seconds) is dropped, in
either order, and the page's signal also refreshes usage over REST after a reply. `test/dom-streaming.test.js` and
`test/live-refresh.test.js` cover these with real wire bytes. The reader is built to
survive what it cannot predict: a message that does not decode is skipped rather
than ending the read, a length beyond `MAX_FRAME_BYTES` (framing out of step) stops
it instead of buffering forever, a stream cut mid-reply still ends the wait, and its
buffer grows by doubling, since a long chat's first message is the whole
conversation (a 3 MB message in 4 KB chunks is a test).

**The extension must stay visible whatever claude.ai does.** `ui._ensureShown()`
runs every tick: a header counter or usage row that has something to show but
has not been painted for three ticks is lifted onto `document.body` and floated
as a pill (`.cc-floating`), and tried in its real place again every 30 seconds
(no flicker: a floating part is excluded from the faster re-attach checks). It
never floats on a guess: with no layout to ask (`getClientRects` absent, as in
the test shim) a part counts as painted. It floats only where there is a chat (a
`/chat/` path or a chat input on the page): sign-in, settings and the like have no
composer because they are not chats, and the usage pill used to appear over them
(seen on `/oauth/authorize`); a floating part is taken down on leaving for one. Reports list what floated.
A free account out of messages has no composer either: Claude puts a notice in its place
(`[data-testid="free-limit-panel"]`, seen 2026-10-14) and the pill used to float over the
disclaimer below it. The row now goes right after that notice (`composer=limit` and
`Claude UI: limit` in reports; `CC.uiVariant === 'limit'` is the only state) and moves
home when the composer returns; how it sits there needs a real page.
`test/always-shown.test.js` covers it.

**The export button sits beside Claude's top-right controls, never inside them.**
It is our own element, in our own look (a quiet 32px icon button, `.cc-exportBtn--docked`),
inserted as a *sibling* right before `[data-testid="wiggle-controls-actions"]`. An earlier
design moved it into that group wearing the classes of an icon button already there; Claude
draws the group differently in every layout (icon buttons; an artifact panel hiding it with
only Share inside; a task-style "Step 5 of 6" chat with only a text Share button), so each
layout meant a new rule and, in the last, a Share-shaped box wedged between Claude's own.
Do not borrow Claude's classes or enter its groups again. With an artifact panel open
(seen 2026-10-08) the group is hidden, so the button goes right before the header's pop-out
icon (`[data-testid="chat-pop-out"]`, `exportAt: 'popout'`). Claude re-renders that area as
panels open, so `_exportStale()` is checked from the throttled DOM observer and the button put
back. The controls are drawn after the header, so the button is held back (`holdExport()`,
`EXPORT_DOCK_GRACE_MS`) rather than shown beside the counter and then jumping. The hold
restarts on every navigation (`handleUrlChange`) and whenever the controls go away, not once
per page load: timed from load, any chat opened after four seconds flashed the button in the
header (reported on 1.0.11). Only if neither anchor exists within the hold does it settle in
the header beside the counter, and a button that has settled there is left there on later
redraws. A conversation with 0 tokens shows no chip, not "0 tokens". Docked, it is not in
`headerContainer`, so its setting and "there is a conversation" rules are applied to it
directly (`_syncExportVisibility`). `test/export-dock.test.js` covers it; `composer.html`
draws the docked look beside a mock group, but where it lands in Claude's own row (that row's
flex rules are not ours) needs a real page. The menu takes focus when it opens and Escape
hands it back to the button: the menu sits at the end of `document.body`.

**Colours live in the stylesheet, not in script.** `styles.css` defines the
`--cc-*` custom properties on `:root` and overrides them under
`html[data-mode="dark"]`, so a theme change needs no code. Do not set colours
from JS. The docked export button's size and icon size are stylesheet rules too
(`.cc-exportBtn--docked`); its colour is inherited from the header at full opacity,
as Claude's own icon buttons beside it are, and its hover reads Claude's
`--cds-fill-ghost-hover` (at 70% opacity in our own colour it read visibly greyer
than its neighbours, seen 2026-10-16). Whether a colour is *right* needs a real page; `composer.html`
(below) renders every coloured part, and flipping `data-mode` on it is the check.

**The counter and timer are one chip, and their labels are not drawn.** The
header shows `18 tokens | ● 2:16` in a quiet pill beside Claude's title; the
words "Token Counter:" and "Cached Context Timer:" stay in the DOM as
screen-reader text (`.cc-sr`) and the tooltips explain them, so `textContent`
(and the tests that read it) still carries them. The dot is the cached signal:
green while a countdown runs, muted while a reply is awaited. The five minutes is
Anthropic's standard prompt-cache lifetime, not anything claude.ai publishes about
itself, and its help centre documents a cheaper-on-the-limit effect only for
project content (checked 2026-10-17), so the tooltip says "estimate" and "can use
less", never "significantly cheaper". The separator is a
drawn element, not a `|` character. A floating pill drops the chip's own
background. `composer.html` has a mock Claude header to judge it against.

**Everything hoverable uses Claude's own tooltip, measured rather than guessed.**
One shared `.cc-tooltip` node serves the chip's two parts, the export and refresh
buttons and both usage bars, and the export menu and the context popover use
Claude's popover surface. Values read off claude.ai on 2026-10-07: tooltip
`#20201f` on `#f0efec` (dark; Claude inverts it to `#0b0b0b` on `#fff` in light),
13px/18px, padding 3px 8px, radius 6px, max-width 240px, a 1px inner white ring at
10% and a soft shadow, 0.12s fade, shown after a short delay; popover/menu
`#20201f`, radius 12px, ring plus `0 8px 24px` shadow, rows 32px at 14px/20px.
Claude's tooltip colours are the CSS variables `--cds-tooltip-bg`/`-fg`, which
`styles.css` reads with our own values as the fallback, so a restyle on their side
is followed for free. The popup's `[data-tip]` labels use the same spec.
Re-measure when Claude changes it: open its "+" menu and hover a sidebar button.

**The context sizes in the popover are sourced, not remembered.** They are by
family (the newest version of each) and were checked on 2026-10-15 against
Anthropic's help article "How large is the context window on paid Claude plans?"
and claude.com/pricing: Fable, Opus, Sonnet and Haiku (5.5, out 2026-10-07) 1M in
chat, older versions 200K-500K by version. The article's table has a column per
surface; Haiku 5.5's 500K is Cowork's, not chat's. Free has Sonnet and Haiku only,
with the same windows as paid; the article itself covers paid plans only, so the
Free column rests on the pricing page. A third-party claim of "Free = 200K" and the extension's own earlier
"Free plan: 200K" are not supported by either. Re-check when a model ships.

A tooltip that offers an action (the token counter's "Click for details") is
interactive: it stays while the pointer is on it (`TOOLTIP_GRACE_MS` to cross the
gap) and clicking it opens the popover. It was not at first, and a user reaching
for the cue found it gone. Do not give a tooltip a "click" cue without that.
`test/tooltip.test.js` fires real events at the real UI.

**A chat with no count is read again, a few times.** A new chat is read the moment
its first message is sent, before the server has it, and an empty read showed
"0 tokens" that stayed (reported on 1.0.11, in a case where the reply-end signal
was apparently also missed). `main.js` `tick()` re-reads a conversation that has
produced no count every `EMPTY_REFRESH_MS`, up to `EMPTY_REFRESH_MAX` times, reset
on navigation and on a reply's end; a count of 0 is not shown at all.
`test/empty-refresh.test.js` covers it. The root cause (a missed end-of-reply signal
on that layout) was not reproduced, so this is a net under it, not a diagnosis.

**A requested conversation is answered once.** The bridge returns a fetched
conversation in the response only; `main.js` `fetchConversation` feeds it to the
counter. The `cc:conversation` broadcast is for conversations the page itself
fetched. Doing both cloned a whole conversation across the world boundary twice
per refresh.

**Counting is not cached.** The tokenizer counts about 1 MB in 30 ms, so every
refresh counts the whole trunk. A per-message cache used to key on a SHA-256 that
had to be fetched from the page world one `postMessage` round trip per message,
which cost far more than the counting it saved.

**A number on screen must belong to what is on screen.** Each case here once did not,
and `test/wrong-data.test.js` pins them. The stored snapshot is seeded only when its
`orgId` is this org's, and not before an org id is known (it is tried again when the
bridge names the org): after switching account, a plan that reports nothing on
demand kept the other account's bars. A window whose reset has passed is dropped by
`applyUsageUpdate` whichever source sent it. A window whose reset passes while the page is open is cleared to
"—" before the refresh, which on such a plan returns nothing and left "92% (resets in
0s)" standing. And a navigation clears the count before fetching the new chat's, or a
failed fetch left the last chat's on it. An empty-but-successful usage answer is asked
again hourly, not on the five-minute retry meant for failures, nor on every
navigation. A usage answer that was in flight when a reply's stream brought a newer
reading is dropped, not applied over it. An answer still carrying a window that has
already ended (the server just after a rollover) shows that window as "—" and asks
again in `USAGE_ROLLOVER_RETRY_MS`, up to three times, instead of latching "resets in
0s". A reply start or end for another chat than the one on screen is ignored.

**The plan travels with the diagnostics, not the usage snapshot.** The snapshot
is written only once an account reports usage, so a plan kept there was
"unknown" in every free-tier report (issue 9 on 1.0.10: `Plan: unknown`, `Claude
UI: unknown`). `resolvePlanLabel` is shared and bounded (three attempts in all, one at a time,
whoever asks), and an answer with no organisation in it is no plan rather than FREE.
`publishDiagnostics` resolves the plan itself (three attempts, only
once an org id exists, never guessed as FREE) and the popup falls back to it. When
*both* lines are unknown the popup now says no claude.ai tab has reported: a tab
open before install is not injected until reloaded. `test/plan.test.js` covers it.
Issue links point at `kr7shnasomani`; the old `kr1shnasomani` only redirects, and
would misroute reports if anyone claimed that name.

**Bug reports carry diagnostics.** `ui.getDiagnostics()` is published to
`cc:diag` (its own key - the usage snapshot is never written for free accounts
with no usage) and the popup appends it to the issue: Claude's build id/date from
`<html data-build-id>`, composer and header tier, which parts are actually
painted, and the last five swallowed errors. `usageFrom` (its own `Usage from:` line)
says which path the last usage reading came by: `usage` (REST), `sse` (completion
stream), `timeline` (the newer layout's stream), `refusal` (a send refused at the
limit) or `none`, the first thing a "usage not showing" report needs. A `via` the
bridge did not set is read as `sse`, so a page script cannot write into a report. Plain facts only, never ids or
conversation text. Claude has no public UI-version name; build id plus the tier
labels is the best identifier available.

**claude.ai does not refetch the conversation after a reply.** It renders the
reply from the completion stream, so the token count and cache timer - both
computed from the tree - only move if the extension asks. The bridge posts
`cc:generation_end` when a completion stream closes (or is refused, fails, or is
stopped) and `main.js` refetches then, retrying once if the tree does not yet
end in the reply. This is why `handleEventStream` reads to the end instead of
stopping at `message_limit`. Before this, both froze after the first message
until a reload; `test/live-refresh.test.js` runs the real bridge to pin it.

**Not every plan reports usage the same way.** On free tier the REST endpoint
returns `null` for every window - before *and* after a message - and the SSE
`message_limit` event is the only source. This is a server-side change that
arrived with the August 2026 redesign; before it, free tier did get figures on
load. What was checked on 2026-09-10, against a live free account: the account
has one org and the `lastActiveOrg` cookie matches the org claude.ai itself
calls, so it is not a wrong-org bug; and every field of the full `/usage`
response is `null`, including the newer `limits` array (`[]`), which some forks
read as a fallback. If free-tier usage ever seems to reappear, re-dump the whole
response rather than just `five_hour`/`seven_day`. The row shows an explanatory
hint rather than sitting blank. Whether a window has ended is one rule,
`CC.windowEnded`, shared by the page and the popup. A stored window whose `resets_at` has passed is
dropped; one that has not is kept, because usage only rises between messages, so
it is a floor rather than a stale figure. A window with no current reading keeps
its slot marked `—` rather than vanishing, so the row never collapses to a lone
bar.

**The plan badge is not a capability lookup for every plan.** `claude_max` and
`claude_pro` are capabilities and match directly. Team and Enterprise are not: a
real Team org (verified 2026-09-20) reports exactly `["raven", "chat"]`, so
`raven` is the organisation tier and covers both. The two are separated by
`raven_type` on the org object (`"team"` here), not by anything in
`capabilities`. `claude_team` sat in `PLAN_LABELS` for three releases and never
matched anything - that string is the value of a reporting field on the org
object. An org carrying `raven` with an unrecognised `raven_type` falls back to
`TEAM` rather than dropping to `FREE`, Team being much the commoner of the two.
The label is cosmetic - it appears in the
popup heading and in a bug report - so a wrong one misleads rather than breaks.

**No payload says how long a usage window is.** `five_hour`/`seven_day` and
`5h`/`7d` are names, not durations, and only `resets_at` is ever sent. The
elapsed-time marker on each bar therefore infers its window start by subtracting
a nominal length (`CC.CONST.SESSION_WINDOW_MS` / `WEEKLY_WINDOW_MS`). That
inference is falsifiable and is checked every tick: meaningfully more time
remaining than the window is long proves the nominal wrong for that account, and
the marker hides itself. "Meaningfully" is `WINDOW_NOMINAL_TOLERANCE_MS` — the
reset time is the server's clock and `Date.now()` is the browser's, so a window
that just opened reads as slightly over nominal on any browser running behind,
and without that margin seconds of ordinary skew would cost the marker for the
whole session. The verdict is latched per window, because the contradiction is visible
only early in an over-long window — later readings look ordinary while the
marker they imply is badly out of place. The latch is in memory, so it is
re-learned per page load. Do not "simplify" this into an unconditional
`resets_at - 5h`; that is what it is deliberately not.

**Per-model weekly limits come from the `limits` list, and only reach the popup.**
Max, Team and Enterprise accounts get a separate Fable allowance. It is not a
named field of the usage response (`seven_day_*` stayed null for it); it is an
entry `{kind: 'weekly_scoped', percent, resets_at, scope: {model: {display_name:
'Fable'}}}` in `limits`, taken from a real response on 2026-10-08. `CC.scopedWindows`
reads them, `parseUsageFromUsageEndpoint` carries them, the snapshot stores them
as `scoped`, and the popup draws one bar each. A usage reading that came from the
message stream carries none, so the last known ones are kept. The on-page row does
not show them (not asked for; add it on purpose). `test/scoped-limits.test.js` runs the real content script and popup against it. A scoped entry whose
`display_name` is empty is skipped rather than drawn nameless. Other scope kinds
(`surface`) are ignored until one is seen on a real response.

**The popup's bars deliberately have no elapsed-time marker.** The page row and
the popup are not meant to match here. The marker answers "am I burning quota
faster than the clock", which is a question you ask while working in a
conversation; the popup is a glance at where the limits stand. Adding one for
consistency is a change to make on purpose, not a gap to close.

**The version lives in three places** — `manifest.json`, `package.json` and
`package-lock.json` (its top and its root package). `test/packaging.test.js`
fails if they disagree, and CI and the release workflow run it.

## Conversation data

`tokens.js` reconstructs the *active branch* by walking back from
`current_leaf_message_uuid` through each `parent_message_uuid`. claude.ai stores
every edit and every abandoned retry in one flat `chat_messages` array, so this
walk is what separates the conversation as it reads from its dead ends.
After an automatic compaction the model sees Claude's summary, not the turns it
replaced, so the count starts from the last trunk message carrying
`compaction_summary` (an array of text blocks, seen 2026-10-15) and adds the
summary text. The count is still well under Claude's own: the conversation JSON has
no thinking text on 5-series models (only short `summaries`, while preserved thinking
stays in context), no system prompt or tools, and claude.ai's tokenizer for newer
models yields more tokens than `o200k_base`. Compaction points read off a real
account on 2026-10-15 fell anywhere from 13K to 294K characters of visible text, so
no multiplier on the visible count predicts compaction; do not add one as if it did.
Claude's exact figure exists but cannot be had on demand: the newer layout's
`message_limit` has a `context_breakdown` (field 16: used, window and auto-compact
threshold tokens; field 14 the same as JSON) that feeds a hidden "context ring" in
claude.ai's own code, yet on 2026-10-15/16 it never arrived, not even on a Sonnet 4.6
chat about half full. Nothing a client sends asks for it (no capability flag, no
`/context` request), and the older layout's SSE has no such field. Reading it when
present was built and taken out again: a count that switched source mid-chat would
jump. `test/tokens.test.js` covers the compaction rule.
`export.js` reuses the same walk, and additionally replays `str_replace` edits
onto files created by `create_file` so an exported file matches the version that
was actually used rather than the one first written. The classic `artifacts` tool
edits in place with `command: 'update'` and the same `old_str`/`new_str`; those are
replayed too, keyed by the artifact's `id` (`fileKey`). Blank lines are tidied
between blocks only, never inside one: a global `\n{3,}` replace used to take the
double blank lines out of every exported Python file and code block. Filenames keep
letters and digits of any script.

## Popup and settings

The popup is a separate document and cannot read the content script's memory,
though it does load `src/content/constants.js` ahead of `popup.js`, so the storage
keys, settings defaults, plan labels, `getStorage`/`storageGet` and the usage-window
normaliser (`CC.usageWindow`) exist once and are shared, not mirrored.
The content script mirrors each usage reading into `chrome.storage.local`
(`cc:usageSnapshot`); the popup renders that snapshot with a timestamp. Pressing
refresh requests the optional claude.ai host permission at that moment, so the
popup asks for nothing at install.

Settings (`cc:settings`) are written by the popup and applied by
`ui.applySettings()` via `storage.onChanged`, so open tabs update without a
reload. Visibility is decided by settings **and** data: a setting must never
reveal a row that has no data behind it.

## Tests

`test/harness.js` runs the real content scripts in Node against a small DOM
shim, so the suites exercise shipped code rather than a copy. When a test fails
in a way that looks impossible, suspect the shim before the code — it has been
wrong four times: `classList` not reflecting `className`, a missing
`createElementNS`, the reverse of the first — `className` not reflecting
later `classList` mutations, which let a snapshot record a marker as hidden
while `classList` reported it visible (the set is the single source of truth now
and the string derives from it, as in a real element) — and `appendChild` leaving
a node in its old parent as well, which hid a usage row stranded beside the limit
notice. The shim has `after` too, as the code uses it.

`test/security.test.js` is a guard, not documentation: it fails on `eval`,
`innerHTML`, widened permissions, anything web-accessible, a page-world script
other than the bridge or one not loaded at `document_start`, a Chrome or Firefox
floor below where that works (111, 128), an id pattern in the bridge or popup that
would let an id leave its URL path (it tests the shipped patterns, not a copy), an
unpinned action, a lockfile entry without an integrity hash, an install that could
run lifecycle scripts, or a vendored tokenizer whose SHA-256 is not the one in
`THIRD_PARTY_NOTICES.md`. The scripts it scans come from the manifest and
`popup.html`, so a new file is covered without being listed.

`test/inventory.test.js` exists because the elapsed-time marker was deleted in a
3,800-line release commit and shipped missing: every other suite tests a
*behaviour* someone thought to write down, so a part with no suite of its own
could vanish silently. It asserts the inventory instead — every element is
built, attached, and styled — and diffs the rendered tree against
`test/snapshots/ui-structure.txt`. Adding a part means adding a line to `PARTS`
(the suite fails if you don't); removing one means deleting a line, which a
reviewer can see. Regenerate the snapshot with `UPDATE_SNAPSHOT=1 npm test` only
after reading the diff.

The harness can load `main.js`, which needs `window.location`, `setInterval`,
`document.hidden` and `fetch` to exist. `setInterval` is a no-op stub — the real
one would keep the test process alive — so suites drive `tick()` themselves, and
`fetch` rejects so a stray request fails loudly instead of hanging. To drive
`tick()`, pass your own `setInterval` to `loadWith` and capture the callback (see
`test/plan.test.js`). `popup.test.js` still matches against popup *source text*,
because the popup is its own document; prefer a behaviour test where one is
possible.

## What the suites cannot reach

Composer anchoring, the header fallback, and anything about whether a thing is
actually *visible* need real layout, and the shim has none: it can prove the
marker element exists and carries `cc-hidden`, never that it is painted.
`test/fixtures/composer.html` covers that gap by hand. Serve the repo and open
it:

```bash
python3 -m http.server 8777   # then open /test/fixtures/composer.html
```

It builds all three composer variants — `[data-cds="ChatComposer"]`, the
`rounded-composer` class, and one with neither so the shape heuristic has to
find it — and attaches a real `CounterUI` to each, plus a mock Claude header for the
counter chip. It has already earned its
keep twice: it caught `uiVariant` reporting `new` for two different layouts, and
`.cc-usageRow` having no layout of its own. Both were invisible to `npm test`.
The stylesheet and scripts load with cache-busters; without them the browser
happily verifies the previous version.

It is not part of `npm test` and does not run in CI — there is no browser there.

## Permissions

`storage` only, with `https://claude.ai/*` as an *optional* host permission. The
content scripts run on `https://claude.ai/*` only, which is the site access a
browser lists at install. Widening any of this is a product decision,
not a refactor, and CI asserts the current values.
