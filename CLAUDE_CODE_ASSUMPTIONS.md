# Claude Code CLI assumptions

This app is a thin wrapper around the `claude` CLI and its on-disk session
files. None of what's listed below is a documented/stable public API — it's
all reverse-engineered from CLI behavior on the versions noted. When the CLI
updates and something in the UI breaks (blank titles, renames not saving,
missing messages, chat not starting), check here first.

Last verified against: `claude --version` → **2.1.258** (checked 2026-09-07)

How to re-verify: run `claude --help` and diff against the flags below, and
inspect a real session file under `~/.claude/projects/<project>/` for the
JSONL shapes below.

---

## 1. Session storage layout

**Assumption:** Sessions live at `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`,
one line-delimited JSON file per session. `<encoded-cwd>` is the project's
absolute path with `/` replaced by `-`.

- Code: `server/backends/claude.js` — `projectsDirectory`, `findSessionFile()`
- **Fixed (2026-08-07):** the path-encoding scheme used to naively do
  `path.replaceAll('-', '/')` to decode a directory name back to a path
  (the former `server.js` directory/project helpers). This was wrong for
  any real path containing a literal dash (e.g. this repo: `claude-mobile-ui`
  decoded to `claude/mobile/ui`), which broke `/api/directories`, the
  session-list fallback `projectPath`, and — surfaced directly by this bug —
  the `/` picker not finding this repo's own project-level skill, since it
  was querying the wrong (dash-expanded) directory for `.claude/skills`.
  Fixed via the Claude adapter's `deriveCwdFromProjectDir()`, which reads the `cwd` field already
  present on every JSONL line in a real session file (confirmed present on
  `attachment`/`user`/`assistant` line types) instead of guessing from the
  directory name. Dash-decoding is now only a last-resort fallback when a
  project dir has zero session files to read a `cwd` from.

**If this breaks:** session list appears empty; "Open Project" folder picker
shows wrong paths.

---

## 2. `sessions-index.json` may not exist

**Assumption (outdated, now handled defensively):** older Claude Code CLI
versions maintained `~/.claude/projects/<project>/sessions-index.json` with
one entry per session (`sessionId`, `summary`, `firstPrompt`, `messageCount`,
`created`, `modified`, `gitBranch`). The app originally read/wrote titles
exclusively through this file.

**Current reality (re-verified 2026-08-24, CLI 2.1.232):** the file is
written **inconsistently** — some projects have it, most don't. As of this
check, 3 of ~30 projects had a `sessions-index.json` (they did not at the
2026-08-07 check, when zero projects had one), while this repo's own project
still has none. So the CLI has partially resumed writing it, but you cannot
rely on it being present for any given project. The code already handles this
correctly: `getProjectInfo()` and `/api/projects/:id/sessions` both do a
per-project `existsSync(indexPath)` check and fall back to derivation when
absent, so a mix of indexed and non-indexed projects both list correctly
(smoke-tested 2026-08-24: an indexed project shows its stored title, a
non-indexed project derives one — both with correct `projectPath`).

**Current handling:** `server/backends/claude.js` treats the index as optional;
the backend-agnostic routes in `server.js` delegate listing and renaming to it,
falling back to:
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
`server/backends/claude.js`, which scans the whole file for `ai-title` first, then falls
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
  `file-history-delta`, `system`, `last-prompt`, and (new as of CLI 2.1.232,
  seen 2026-08-24) `atis-latch` and `mode`. These are passed over
  silently (the per-line guards in `readSessionMessages` and
  `deriveSessionSummary` swallows anything that doesn't match a known
  `type`), so new unknown line types are safe by construction — but a
  **renamed or reshaped existing type** (e.g. `assistant` content blocks
  changing shape) would silently drop content instead of erroring.

- Code: `readSessionMessages()` in `server/backends/claude.js`

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

- Code: `buildSpawnSpec()` and `ClaudeEventParser` in
  `server/backends/claude.js`; shared process supervision remains in
  `server.js`.

**Verified current flag validity (re-checked 2026-09-07, CLI 2.1.258 — no
change since 2026-08-31/2.1.246; `--permission-mode` choices are still
`acceptEdits, auto, bypassPermissions, manual, dontAsk, plan` and `--model`
still takes aliases or full names):**
- `--output-format stream-json`, `--include-partial-messages`,
  `--verbose`, `-p`, `--resume <id>` — all present in `claude --help`.
- `--model <model>` — CLI still documents accepting **aliases** (`sonnet`,
  `opus`, `fable`) or full model names (e.g. `claude-fable-5`). The code's
  hardcoded allowlist (`claude-sonnet-5`, `claude-opus-4-8`, `haiku`) is
  still narrower than what the CLI's flag format accepts, and still mixes
  an alias (`haiku`) with full names for the other two — stylistically
  inconsistent, but **not a live bug**: re-verified today by actually
  spawning `claude -p --model <id> ...` for all three hardcoded values
  (capped with `--max-budget-usd` to keep the test cheap) and confirming
  each resolves to a valid `canonicalModel` (`claude-sonnet-5`,
  `claude-opus-4-8`, and `haiku` → `claude-haiku-4-5`) with no error. No
  drift here despite the allowlist/format inconsistency.
- `--permission-mode <mode>` — the discrepancy noted on 2026-08-24 was
  real and is now **fixed** (2026-08-31): the CLI's own `--help` lists
  valid choices as `acceptEdits, auto, bypassPermissions, manual, dontAsk,
  plan` — it does not accept `default`. The Claude adapter's `buildSpawnSpec()`
  previously included `'default'` in its passthrough allowlist and passed
  `--permission-mode default` straight to the CLI, relying on the
  undocumented fact that the CLI silently ignores unrecognized values
  instead of erroring. Changed to `CLI_PERMISSION_MODES` (`plan,
  acceptEdits, auto, bypassPermissions, manual, dontAsk` — the CLI's exact
  list minus nothing), which now excludes `'default'` so the flag is
  omitted entirely for that value (our own app-level sentinel for "use the
  CLI's own default behavior") instead of passing a value the CLI doesn't
  recognize. Also closes the previously-omitted `manual`/`dontAsk` gap,
  even though neither is exposed in the UI yet.

**If this breaks:** `--model` silently no-ops instead of applying the
user's chosen setting (wrong model used, no error shown to the user) if a
model ID the CLI stops accepting is still in the app's allowlist; or, if a
future CLI version starts hard-validating `--permission-mode` in a way that
rejects one of `CLI_PERMISSION_MODES`, `/api/chat` would fail outright with
a spawn/stderr error for anyone using that mode.

**Re-verify by:** `claude --help | grep -A6 -- '--model\|--permission-mode'`
and compare literal choices against `CLI_PERMISSION_MODES`/`validModels` in
`server/backends/claude.js`.

---

## 6. Stream JSON event shapes (`stream_event`, `assistant`, `result`)

**Assumption:** `content_block_delta` events have shape
`{event: {type: 'content_block_delta', delta: {type: 'text_delta', text}}}`
— this is the raw Anthropic Messages API streaming event shape passed through
`--include-partial-messages`, not a Claude Code–specific format. It's more
likely to be stable than Claude Code's own internal formats since it's a
public API shape, but the code depends on `--include-partial-messages`
continuing to pass those events through verbatim.

- Code: `ClaudeEventParser` in `server/backends/claude.js`

**If this breaks:** streamed text stops appearing incrementally (would fall
back to nothing rendering until a full `assistant` message arrives, since
the de-dup logic assumes deltas are always sent first).

---

## 7. Desktop conflict detection is Claude-specific and deliberately partial

**Assumption:** Claude IDE integrations continue to write `~/.claude/ide/*.lock`
records containing a live PID and `workspaceFolders`, and session `user` records
continue to preserve `CLAUDE_CODE_ENTRYPOINT`. The Claude adapter combines those
signals with this server's in-memory active-process map to distinguish a mobile
reconnect from a likely desktop conflict.

**Practical implication:** detection is project-level and IDE-only. A live
VSCode/Cursor Claude session can be detected, but a plain terminal session has
no IDE lock, and the lock does not identify which session within a project is
active. Codex reports this capability as unsupported rather than applying
Claude-specific heuristics.

**If this breaks:** conflict checks fail safe as "no conflict"; chat and session
history remain available. Revalidate the IDE lock schema and `entrypoint` field
before changing the adapter.

**Re-verify by:** reviewing `getSessionOrigin()` and
`isDesktopLiveForCwd()` in `server/backends/claude.js`, then following the
end-to-end decision flow in `SESSION_CONFLICT_DETECTION.md`.

---

## 8. `AskUserQuestion` text-fallback shape is not stable

**Assumption (outdated):** when `AskUserQuestion` isn't offered as a tool in
headless mode (see the project memory on this — same root cause as #7's
partial detection, unrelated feature), the model dumps its intended input as
plain assistant text shaped exactly like `{"questions": [...]}`, unwrapped
and unfenced. `parseInteractiveQuestion()` in `src/components/ChatView.jsx`
was written against this shape and validated against it live.

**Current reality (found 2026-09-25, CLI 2.1.281 — a jump from the
2.1.258 this doc was last verified against): the fallback shape is not
consistent.** Live-spawned `claude -p` tests against the current CLI produced
two different fallback behaviors for the same kind of prompt:
- Sometimes the model just asks in plain prose/markdown (numbered list, no
  JSON at all) — correctly falls through to normal text rendering, not a bug.
- Sometimes it dumps the tool's actual invocation shape — `{"tool":
  "AskUserQuestion", "input": {"questions": [...]}}` — wrapped in a
  ` ```json ` fence. The old parser's `text.trim()` + flat `payload.questions`
  check missed this entirely (fence breaks `JSON.parse`; even unfenced, the
  nested `payload.input.questions` never matched `payload.questions`).

**Fixed:** `parseInteractiveQuestion()` now strips a wrapping ` ``` `/` ```json `
fence before parsing, and reads `payload.questions ?? payload.input?.questions`,
and its returned `tool` comes from `payload.tool` when present instead of being
hardcoded — so `INTERACTIVE_QUESTION_RENDERERS` continues to dispatch by tool
name for either shape.

**If this breaks again:** the question renders as raw JSON/fenced text
instead of a tappable card. Re-verify by spawning `claude -p` directly (not
nested inside another agent session, which pollutes the declared tool list)
with a prompt that forces a clarifying question, and inspect the literal
`assistant` text block shape before assuming the old flat shape still holds.

---

## Suggested periodic check

1. `claude --version` — note any version bump since "Last verified" above.
2. `claude --help` — diff flags against sections 5.
3. Pick one real session `.jsonl` and dump the distinct `type` values —
   diff against sections 2–4.
4. `ls ~/.claude/projects/*/sessions-index.json` — see if it's back/gone.
5. Run through Rename, New Chat, and a multi-turn conversation in the app
   itself and confirm titles, streaming, and history render correctly.
6. Force a clarifying question (a prompt that demands a multiple-choice
   answer before proceeding) and check the raw `assistant` text shape against
   section 8 — the model's fallback format isn't guaranteed stable.
