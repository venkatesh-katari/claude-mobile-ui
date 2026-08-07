# Claude Code CLI assumptions

This app is a thin wrapper around the `claude` CLI and its on-disk session
files. None of what's listed below is a documented/stable public API — it's
all reverse-engineered from CLI behavior on the versions noted. When the CLI
updates and something in the UI breaks (blank titles, renames not saving,
missing messages, chat not starting), check here first.

Last verified against: `claude --version` → **2.1.220**

How to re-verify: run `claude --help` and diff against the flags below, and
inspect a real session file under `~/.claude/projects/<project>/` for the
JSONL shapes below.

---

## 1. Session storage layout

**Assumption:** Sessions live at `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`,
one line-delimited JSON file per session. `<encoded-cwd>` is the project's
absolute path with `/` replaced by `-`.

- Code: `server.js` — `CLAUDE_PROJECTS_DIR`, `findSessionFile()`
- Known drift: the path-encoding scheme naively does `path.replaceAll('-', '/')`
  to decode a directory name back to a path (`server.js`, `/api/directories`
  and `getProjectInfo`). This is **already wrong** for any real path that
  contains a literal dash (e.g. this repo: `claude-mobile-ui` decodes to
  `claude/mobile/ui`). Not CLI drift, just a pre-existing bug — worth fixing
  separately, listed here so it isn't mistaken for a new regression.

**If this breaks:** session list appears empty; "Open Project" folder picker
shows wrong paths.

---

## 2. `sessions-index.json` may not exist

**Assumption (outdated, now handled defensively):** older Claude Code CLI
versions maintained `~/.claude/projects/<project>/sessions-index.json` with
one entry per session (`sessionId`, `summary`, `firstPrompt`, `messageCount`,
`created`, `modified`, `gitBranch`). The app originally read/wrote titles
exclusively through this file.

**Current reality (verified 2026-08-07):** newer CLI versions do **not**
write this file at all. Confirmed by checking
`~/.claude/projects/-Users-vkatari-dev-tools-claude-mobile-ui/` — 22 session
`.jsonl` files, zero `sessions-index.json`.

**Current handling:** `server.js` (`/api/projects/:id/sessions`, the PATCH
rename route) treats the index as optional, falling back to:
- Titles: derived per-session from the JSONL itself (see #3 below).
- Renames: persisted in a sidecar `title-overrides.json` in the same project
  dir (our own format, not a CLI convention) when there's no index entry to
  write into.

**Re-verify by:** `ls ~/.claude/projects/*/sessions-index.json`. If this
comes back for *all* projects again on some future CLI version, the
override/derivation fallback becomes dead code (harmless) rather than wrong
— no urgent action needed either way, but worth simplifying the code back
down if the index is reliably present again.

---

## 3. Title derivation from JSONL line types

**Assumption:** each session `.jsonl` contains typed lines. The two that
matter for titling:
- `{"type": "ai-title", "sessionId": "...", "aiTitle": "..."}` — the
  CLI-generated conversation title. Appears once, NOT on the first line
  (observed as late as line 11 of a 127-line file) — it's written
  asynchronously after the CLI generates it.
- `{"type": "user", "message": {"role": "user", "content": "..." | [...]}}`
  — a real user turn. `content` is either a plain string or an array of
  content blocks (`{"type": "text", "text": "..."}` among others, e.g. tool
  results). This is the fallback title source if no `ai-title` line exists
  yet (e.g. very first turn of a fresh session, before the CLI has generated
  one).

**Known drift already hit:** the code used to assume `type: 'human'` for
user turns (an older/different CLI's naming) and only checked the *first*
line of the file for a title. Both were wrong for the current CLI
(`type: 'user'`, title on a later line) and were the direct cause of most
sessions showing "(no title)". Fixed in `deriveSessionSummary()` in
`server.js`, which scans the whole file for `ai-title` first, then falls
back to the first `user` turn's text.

**If this breaks again:** sessions show "(no title)" despite Claude Code
desktop showing a real title. Re-check the `type` values and field names by
running `python3 -c "import json; [print(json.loads(l)['type']) for l in
open('<session>.jsonl')]" | sort -u` on a real session file, and compare
against the read logic in `deriveSessionSummary()`.

---

## 4. Message JSONL shapes (for rendering conversation history)

**Assumption:** besides `user`/`ai-title`, sessions contain:
- `{"type": "assistant", "message": {"content": [...]}}` — content blocks of
  type `text` and `tool_use` (`name`, `input`, `id`).
- Tool results come back as a `user`-typed line whose `message.content`
  array contains blocks of type `tool_result` (`tool_use_id`, `content`,
  `is_error`).
- Other line types seen in real files but currently ignored by the parser:
  `queue-operation`, `attachment`, `file-history-snapshot`,
  `file-history-delta`, `system`, `last-prompt`. These are passed over
  silently (the `try/catch` per-line in `parseSessionJsonl` and
  `deriveSessionSummary` swallows anything that doesn't match a known
  `type`), so new unknown line types are safe by construction — but a
  **renamed or reshaped existing type** (e.g. `assistant` content blocks
  changing shape) would silently drop content instead of erroring.

- Code: `parseSessionJsonl()` in `server.js`

**If this breaks:** messages render blank, tool calls disappear, or partial
history is shown with no error surfaced anywhere (fails silently by design
of the try/catch — this is the highest-risk assumption to silently rot).

---

## 5. `claude -p` (headless/print mode) CLI invocation

**Assumption:** spawning `claude -p --output-format stream-json --verbose
--include-partial-messages [--permission-mode <mode>] [--model <model>]
[--resume <sessionId>]` with the prompt piped to stdin, produces
newline-delimited JSON on stdout with a stable set of `type`s: `stream_event`
(raw Anthropic API stream events, used for text deltas via
`content_block_delta` / `text_delta`), `assistant` (full assistant message,
used to pick up `tool_use` blocks once text has already streamed via
deltas), and `result` (turn completion, carries `session_id`).

- Code: `/api/chat` route in `server.js`

**Verified current flag validity (2026-08-07, CLI 2.1.220):**
- `--output-format stream-json`, `--include-partial-messages`,
  `--verbose`, `-p`, `--resume <id>` — all present in `claude --help`.
- `--model <model>` — CLI now documents accepting **aliases** (`sonnet`,
  `opus`, `fable`) or full model names (e.g. `claude-fable-5`). The code's
  hardcoded allowlist (`claude-sonnet-5`, `claude-opus-4-8`, `haiku`) is
  narrower than what the CLI accepts, and mixes an alias (`haiku`) with full
  names for the other two — inconsistent, and will silently drop the
  `--model` flag entirely (falls through to CLI default) if the user's
  saved model value isn't in this exact list.
- `--permission-mode <mode>` — **discrepancy found:** the CLI's own
  `--help` lists valid choices as `acceptEdits, auto, bypassPermissions,
  manual, dontAsk, plan`. The code's `validModes` allowlist is `default,
  plan, acceptEdits, auto, bypassPermissions` — it includes `default`
  (not in the CLI's list) and omits `manual` and `dontAsk` (which the CLI
  does accept). Passing `--permission-mode default` was tested directly
  against the CLI and does NOT error (likely silently ignored / same as
  omitting the flag), so this "works" today by accident, not by contract.

**If this breaks:** `--model`/`--permission-mode` silently no-ops instead of
applying the user's chosen setting (wrong model/permissions used, no error
shown to the user); or, if a future CLI version starts hard-validating
`--permission-mode` values it used to accept, `/api/chat` would fail outright
with a spawn/stderr error for anyone using "default" mode.

**Re-verify by:** `claude --help | grep -A6 -- '--model\|--permission-mode'`
and compare literal choices against `validModes/validModels` in `server.js`.

---

## 6. Stream JSON event shapes (`stream_event`, `assistant`, `result`)

**Assumption:** `content_block_delta` events have shape
`{event: {type: 'content_block_delta', delta: {type: 'text_delta', text}}}`
— this is the raw Anthropic Messages API streaming event shape passed through
`--include-partial-messages`, not a Claude Code–specific format. It's more
likely to be stable than Claude Code's own internal formats since it's a
public API shape, but the code depends on `--include-partial-messages`
continuing to pass those events through verbatim.

- Code: `/api/chat` stdout handler in `server.js`

**If this breaks:** streamed text stops appearing incrementally (would fall
back to nothing rendering until a full `assistant` message arrives, since
the de-dup logic assumes deltas are always sent first).

---

## 7. No supported way to detect "is Claude already running for this session on another device"

**Assumption:** the "desktop ↔ mobile conflict detection" feature (README:
"Desktop ↔ Mobile Handoff") sounds like it detects any external `claude`
process holding a session — but it does **not**. It only tracks sessions
*this server itself* spawned (`activeProcesses` / `activeSessionIds` Maps in
`server.js`, populated solely inside the `/api/chat` handler). There is no
OS-level process scan, lockfile check, or session-file lock of any kind.

**Practical implication:** if you resume a session in the actual desktop
Claude Code CLI (not through this mobile server) while also having it open
via this app, the app's "Live" badge and conflict warning will **not**
detect that — because the process wasn't spawned by this server. The
feature only catches conflicts between two *mobile-server-spawned* accesses
to the same session (e.g. two phones, or a phone and a stale reconnect).

**If this "breaks" (i.e. if you were relying on it for true desktop
detection):** it was never doing that; re-scope the README claim or
implement real detection (e.g. checking `~/.claude/ide/*.lock` or an
active-session marker the CLI itself writes, if one exists in a future
version) before trusting it for actual desktop-CLI conflicts.

**Re-verify by:** re-reading `server.js` for any file-based or process-scan
based check — currently there is none; it's 100% in-memory and scoped to
processes this server spawned.

---

## Suggested periodic check

1. `claude --version` — note any version bump since "Last verified" above.
2. `claude --help` — diff flags against sections 5.
3. Pick one real session `.jsonl` and dump the distinct `type` values —
   diff against sections 2–4.
4. `ls ~/.claude/projects/*/sessions-index.json` — see if it's back/gone.
5. Run through Rename, New Chat, and a multi-turn conversation in the app
   itself and confirm titles, streaming, and history render correctly.
