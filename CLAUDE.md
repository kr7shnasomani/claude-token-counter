# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm test                        # all 9 suites via test/run.js
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
Neither is covered by a test — they need a real page — so they are the most
fragile code here.

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

The popup is a separate document and cannot read the content script's memory.
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
`fetch` rejects so a stray request fails loudly instead of hanging. A few older
assertions in `settings.test.js` still match against `main.js` *source text*;
they predate the harness being able to run it, and are worth converting to real
behaviour tests when that file is next touched.

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
find it — and attaches a real `CounterUI` to each. It has already earned its
keep twice: it caught `uiVariant` reporting `new` for two different layouts, and
`.cc-usageRow` having no layout of its own. Both were invisible to `npm test`.
The stylesheet and scripts load with cache-busters; without them the browser
happily verifies the previous version.

It is not part of `npm test` and does not run in CI — there is no browser there.

## Permissions

`storage` only, with `https://claude.ai/*` as an *optional* host permission.
Nothing at install time triggers a warning. Widening this is a product decision,
not a refactor, and CI asserts the current values.
