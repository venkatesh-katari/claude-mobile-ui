# Codex CLI assumptions

This app integrates with Codex CLI through its non-interactive JSONL stream
and on-disk rollout files. These are CLI contracts rather than a versioned web
API, so this document records exactly what the adapter relies on and how to
re-check it after an upgrade.

Last verified against: `codex --version` → **codex-cli 0.154.0** on
**2026-09-11**.

## 1. Invocation and prompt transport

New turns are spawned as:

```text
codex exec --json --skip-git-repo-check [permission flags] --thread-source claude-mobile-ui -
```

Resumed turns are spawned as:

```text
codex exec --json --skip-git-repo-check [permission flags] resume <thread-id> -
```

The prompt is written to stdin. Using `-` is documented in `codex exec
--help` and `codex exec resume --help`; it avoids command-line length limits
and exposing prompt text in process listings. `--skip-git-repo-check` is
required because the UI permits home or non-Git directories.

Both new-thread and resume paths were exercised end to end through
`POST /api/chat`; the resumed turn retained the same thread and completed with
normalized text, usage, and exit events.

`--thread-source` applies to new threads only. A different source on resume
does not rewrite the original rollout metadata.

## 2. JSON stream granularity and shapes

`--json` emits one JSON object per line. Verified top-level events:

- `thread.started` with `thread_id`
- `turn.started`
- `item.started` and `item.completed`
- `turn.completed` with `usage`

Assistant text was observed only as a completed item:

```json
{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"..."}}
```

No token-delta event was emitted for an eight-paragraph response. The adapter
therefore declares `partialTextStreaming: false` and renders Codex output in
completed-message chunks.

Verified tool items include:

- `command_execution`: `command`, `aggregated_output`, `exit_code`, `status`
- `file_change`: `changes[]` containing `path` and `kind`, plus `status`

Both emit `item.started` and `item.completed` with a stable item id. The UI
uses that id to update one tool chip in place.

## 3. Usage and cost

`turn.completed.usage` contains:

- `input_tokens`
- `cached_input_tokens`
- `cache_write_input_tokens`
- `output_tokens`
- `reasoning_output_tokens`

It does not contain a dollar amount. The UI reports token counts and does not
maintain an application-owned model price table.

## 4. Enterprise policy overrides

This installation is enterprise managed. Values rejected by the policy
baseline are reported as completed error-shaped items while the turn
continues, for example:

```text
Configured value for `approval_policy` is disallowed by requirements;
falling back to required value OnRequest
```

The adapter classifies messages containing `disallowed by requirements` or
`falling back to required value` as nonfatal warnings and surfaces them in the
chat. Other error items remain errors.

In 0.154.0, `codex exec --help` exposes `--sandbox`, `--approve-for-me`, and
`--dangerously-bypass-approvals-and-sandbox`; it does not expose the RFC's
earlier `--ask-for-approval` flag. The app intentionally offers only:

- `read-only` → `--sandbox read-only`
- `workspace-write` → `--sandbox workspace-write`
- `approve-for-me` → `--approve-for-me`

The dangerous bypass mode is not exposed in the mobile UI.

## 5. Session storage and discovery

Rollouts live under:

```text
~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
```

The first record is `session_meta`. The adapter relies on `payload.id` (with
`payload.session_id` as a compatibility fallback), `payload.cwd`, optional
`payload.git.branch`, and the outer timestamp. Project ids exposed by the API
are base64url encodings of the exact cwd, avoiding the lossy path decoding
problem historically encountered with Claude directories.

`~/.codex/session_index.jsonl` is append-only and may contain repeated ids.
The adapter takes the last observed `thread_name` per id. User renames are
stored separately in `~/.codex/claude-mobile-ui-title-overrides.json`; the app
does not mutate Codex's append-only index.

## 6. Persisted message shapes

Rollout records are envelopes with outer `timestamp`, `ordinal`, `type`, and
`payload`. Conversation history is reconstructed primarily from
`type: "response_item"` records:

- User and assistant messages: `payload.type: "message"`, `payload.role`, and
  `payload.content[]` containing `input_text` or `output_text`.
- Tool calls: `custom_tool_call` or `function_call` with a stable `call_id`.
- Tool results: matching `custom_tool_call_output` or
  `function_call_output` records.

Codex may persist injected user-role context such as `<environment_context>`
and `<recommended_plugins>`. The adapter excludes those known envelopes from
titles and visible chat history.

## 7. Capabilities intentionally disabled

- **Desktop conflict detection:** writer-lock files persist after completion,
  and their live-lock semantics have not been proven reliable. The adapter
  returns no conflict warning rather than presenting a false safety signal.
- **Skills/commands picker:** Codex skill and plugin discovery has not yet been
  mapped to a stable file contract.
- **Interactive question card:** no Codex equivalent of Claude's headless
  `AskUserQuestion` fallback has been verified.

## 8. Model discovery

The adapter reads the installed CLI's account-aware model catalog with `codex
debug models`, the same catalog that feeds the interactive model selector. It
keeps entries whose `visibility` is `list`, orders them by `priority`, and maps
`slug`, `display_name`, and `description` into UI options. If catalog refresh
fails, it retries with `codex debug models --bundled`; older CLIs without either
command still get a safe "Codex configuration" option that omits `--model`.

Discovered slugs form the server-side allow-list, so an arbitrary model value
from a client is never forwarded to the CLI. The catalog is loaded once when
the server starts; restart the server after a Codex update or account-level
availability change.

## Re-verification checklist

1. Record `codex --version` and diff both exec help pages.
2. Replay `test/fixtures/codex/stream.jsonl` through the parser tests.
3. Run a long text-only prompt and check for new delta event types.
4. Run one shell command and one file edit; compare started/completed fields.
5. Start and resume a thread using stdin; verify the thread id is stable.
6. Inspect a newly written rollout's metadata and response item shapes.
7. Re-check writer-lock semantics before enabling conflict detection.
