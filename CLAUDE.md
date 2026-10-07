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

- `src/injected/bridge.js` runs in the **page's own world**. It is injected as a
  `<script src>` by `bridge-client.js` and patches `window.fetch` and
  `history.pushState`/`replaceState` before the app loads. It sees every request
  claude.ai makes, including the SSE stream.
- `src/content/*.js` runs in the **isolated content script world** and owns all
  UI.

They cannot call each other. The only channel is `window.postMessage`, tagged
`cc: 'ClaudeCounter'`, matched by request id for request/response and broadcast
for one-way events. Both sides check `event.source === window` and the origin,
and the bridge addresses replies to `window.location.origin` rather than `'*'`.
Ids that end up in a URL path are validated against `ID_PATTERN` first.

## Things that are not obvious and will bite

**Claude ships more than one composer design.** The usage row is anchored in
three tiers: `[data-cds="ChatComposer"]`, Claude's own design-system attribute;
then a `rounded-composer` class, which exists only on some variants; then by
*shape* — the nearest ancestor of `[data-testid="chat-input"]` that is a flex
column with a corner radius and a painted background. The header has its own
three-tier fallback (`chat-title-split` → `chat-header` → semantic `<header>`).
Do not replace either with a single selector; that is exactly what broke before.
The composer tiers are not covered by a test — they need a real page — and the
header tiers are tested only for being reachable, not for how they look, so these
are the most fragile code here.

**Every header tier must be reachable.** `attachHeader` falls back from
`chat-title-split` to `chat-header` to a semantic `<header>`. It used to run only
once a waiter had seen the title testid, so on a layout without it the fallbacks
were unreachable and the counter and timer never appeared while the composer's
usage row did (reports filed as `Claude UI: class`). There are no waiters now:
`handleUrlChange` and the DOM observer in `ui.js` call `attachHeader` and
`attachUsageLine` directly, and each does nothing until its anchor exists. The
observer searches at most once a second (it runs on every mutation batch, which
during streaming is hundreds a second) and schedules one retry when a batch fell
inside that window, because an idle page sends no second batch to look again on.
`test/header-attach.test.js` pins each tier from the observer, and the retry.

**There are two ways to learn a reply has finished, and the newer layout only
has one.** The older layout streams the reply from a `/completion` request the
bridge can read. The newer one sends over its own RPC (`PerformAction`) and
writes the reply to a connection opened earlier (`StreamTimeline`, Connect
protobuf), so the bridge never sees a reply start or end and the token count and
cache timer froze after the first message. The page marks a reply in progress
with `data-is-streaming="true"` on the assistant message (and `aria-busy` on the
send button): `main.js` `watchStreaming()` watches that attribute, so it works
in every language, and refetches when it clears. It stands down for two seconds
after a bridge-announced end so a layout with both does not fetch twice. Usage is
refreshed over REST after each such reply, since the stream's `message_limit`
event is not readable here (free tier, whose REST usage is null, therefore does
not update live on the newer layout). `test/dom-streaming.test.js` covers it.

**The extension must stay visible whatever claude.ai does.** `ui._ensureShown()`
runs every tick: a header counter or usage row that has something to show but
has not been painted for three ticks is lifted onto `document.body` and floated
as a pill (`.cc-floating`), and tried in its real place again every 30 seconds
(no flicker: a floating part is excluded from the faster re-attach checks). It
never floats on a guess: with no layout to ask (`getClientRects` absent, as in
the test shim) a part counts as painted. Reports list what floated.
`test/always-shown.test.js` covers it.

**The export button docks into Claude's own action group.** In a chat it is
moved to be the first child of `[data-testid="wiggle-controls-actions"]` (left
of the page icon) and takes the classes, design-system attributes and paint
child of an icon-only button already there, so size, colour and hover match
without us copying Claude's CSS; the icon is our own 18px SVG because Claude's
are font glyphs. Claude re-renders and rearranges that group as panels open, so
`_exportStale()` is checked from the throttled DOM observer and the button put
back. The group is drawn after the header, so the button is held back
(`holdExport()`, `EXPORT_DOCK_GRACE_MS`) rather than shown beside the counter and
then jumping. The hold restarts on every navigation (`handleUrlChange`) and
whenever the group goes away, not once per page load: timed from load, any chat
opened after four seconds flashed the button in the header (reported on 1.0.11).
With an artifact panel open (seen 2026-10-08) Claude keeps the group but hides
it, with only a non-icon Share button in it, so there is nothing to copy; the
button then docks right before the header's pop-out icon
(`[data-testid="chat-pop-out"]`, `exportAt: 'popout'`). Only if neither exists
within the hold does it settle in the header beside the counter. A conversation with 0 tokens shows no chip, not "0 tokens". Docked, it is not in `headerContainer`, so its setting and
"there is a conversation" rules are applied to it directly
(`_syncExportVisibility`). A button that has already settled in the header is left there on later redraws, and moving between the two docking spots re-borrows the new neighbour's look.
`test/export-dock.test.js` covers it; whether it
actually looks right needs a real page.

**Colours live in the stylesheet, not in script.** `styles.css` defines the
`--cc-*` custom properties on `:root` and overrides them under
`html[data-mode="dark"]`, so a theme change needs no code. Do not set colours
from JS: an inline colour also beats the classes the docked export button borrows
from Claude. Whether a colour is *right* needs a real page; `composer.html`
(below) renders every coloured part, and flipping `data-mode` on it is the check.

**The counter and timer are one chip, and their labels are not drawn.** The
header shows `18 tokens | ● 2:16` in a quiet pill beside Claude's title; the
words "Token Counter:" and "Cached Context Timer:" stay in the DOM as
screen-reader text (`.cc-sr`) and the tooltips explain them, so `textContent`
(and the tests that read it) still carries them. The dot is the cached signal:
green while a countdown runs, muted while a reply is awaited. The separator is a
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
family (the newest version of each) and were checked on 2026-10-07 against
Anthropic's help article "How large is the context window on paid Claude plans?"
and claude.com/pricing: Fable, Opus and Sonnet 1M, Haiku 200K, older versions
200K-500K by version. Free has Sonnet and Haiku only, with the same windows as
paid; the article itself covers paid plans only, so the Free column rests on the
pricing page. A third-party claim of "Free = 200K" and the extension's own earlier
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

**The plan travels with the diagnostics, not the usage snapshot.** The snapshot
is written only once an account reports usage, so a plan kept there was
"unknown" in every free-tier report (issue 9 on 1.0.10: `Plan: unknown`, `Claude
UI: unknown`). `publishDiagnostics` resolves the plan itself (three attempts, only
once an org id exists, never guessed as FREE) and the popup falls back to it. When
*both* lines are unknown the popup now says no claude.ai tab has reported: a tab
open before install is not injected until reloaded. `test/plan.test.js` covers it.
Issue links point at `kr7shnasomani`; the old `kr1shnasomani` only redirects, and
would misroute reports if anyone claimed that name.

**Bug reports carry diagnostics.** `ui.getDiagnostics()` is published to
`cc:diag` (its own key - the usage snapshot is never written for free accounts
with no usage) and the popup appends it to the issue: Claude's build id/date from
`<html data-build-id>`, composer and header tier, which parts are actually
painted, and the last five swallowed errors. Plain facts only, never ids or
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
hint rather than sitting blank. A stored window whose `resets_at` has passed is
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

**The version lives in two places** — `manifest.json` and `package.json`. CI and
the release workflow both refuse to proceed if they disagree.

## Conversation data

`tokens.js` reconstructs the *active branch* by walking back from
`current_leaf_message_uuid` through each `parent_message_uuid`. claude.ai stores
every edit and every abandoned retry in one flat `chat_messages` array, so this
walk is what separates the conversation as it reads from its dead ends.
`export.js` reuses the same walk, and additionally replays `str_replace` edits
onto files created by `create_file` so an exported file matches the version that
was actually used rather than the one first written.

## Popup and settings

The popup is a separate document and cannot read the content script's memory,
though it does load `src/content/constants.js` ahead of `popup.js`, so the storage
keys, settings defaults, plan labels, `getStorage`/`storageGet` and the usage-window
normaliser (`CC.usageWindow`) exist once and are shared, not mirrored.
The content script mirrors each usage reading into `chrome.storage.local`
(`cc:usageSnapshot`); the popup renders that snapshot with a timestamp. Pressing
refresh requests the optional claude.ai host permission at that moment, so a
fresh install shows no permission warning.

Settings (`cc:settings`) are written by the popup and applied by
`ui.applySettings()` via `storage.onChanged`, so open tabs update without a
reload. Visibility is decided by settings **and** data: a setting must never
reveal a row that has no data behind it.

## Tests

`test/harness.js` runs the real content scripts in Node against a small DOM
shim, so the suites exercise shipped code rather than a copy. When a test fails
in a way that looks impossible, suspect the shim before the code — it has been
wrong three times: `classList` not reflecting `className`, a missing
`createElementNS`, and the reverse of the first — `className` not reflecting
later `classList` mutations, which let a snapshot record a marker as hidden
while `classList` reported it visible. The set is the single source of truth now
and the string derives from it, as in a real element.

`test/security.test.js` is a guard, not documentation: it fails on `eval`,
`innerHTML`, widened permissions, an unpinned action, a lockfile entry without an
integrity hash, or an install that could run lifecycle scripts.

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

`storage` only, with `https://claude.ai/*` as an *optional* host permission.
Nothing at install time triggers a warning. Widening this is a product decision,
not a refactor, and CI asserts the current values.
