# Session conflict detection (desktop ↔ mobile)

How the app decides whether opening a session on mobile is safe, or risks
colliding with a still-running desktop Claude Code session. If you see a
conflict warning that seems wrong (or don't see one when you expected one),
this is where to look.

## The problem this solves

Two completely different situations both looked identical to earlier
versions of this feature:

1. **A real conflict** — you started/resumed a session on desktop (VSCode,
   Cursor, or a terminal) and it's still open, then you open the same
   session on mobile. Both could write to the same session file at once.
2. **A false alarm** — you started a session on mobile, your phone locked or
   the tab closed while Claude was still responding, and when you came back
   the app treated your *own* still-running (or just-finished) mobile stream
   as if it were a conflicting desktop session and offered "Take Over."

The old implementation couldn't tell these apart because it only checked
`activeSessionIds` — a map populated *exclusively* by this server's own
`/api/chat` spawns (see `CLAUDE_CODE_ASSUMPTIONS.md` section 7 for the original
scoping note). It never actually looked at desktop at all; it just mislabeled
"my own mobile stream is active" as "active on desktop."

## The two-part fix

### 1. Tag mobile-spawned sessions at the source

`server.js`'s `/api/chat` spawns `claude` with:

```js
env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'claude-mobile-ui' }
```

`CLAUDE_CODE_ENTRYPOINT` is a real environment variable the CLI reads at
launch and writes verbatim, unvalidated, into the `entrypoint` field of every
`user`-type line in the session's `.jsonl` file. Verified values seen in the
wild: `claude-vscode` (VSCode/Cursor extension), `sdk-cli` (programmatic/SDK
invocations), `cli` (plain terminal — also what unmodified `claude -p` shows,
since nothing else sets this var).

By setting it to `claude-mobile-ui` ourselves, every turn this server spawns
is permanently, verifiably marked as mobile-origin. `getSessionOrigin()` in
`server.js` reads a session's `.jsonl` and returns the `entrypoint` of its
**most recent** `user` line — i.e. "who touched this last."

**Limitation:** this is forward-looking only. Turns written before this
change (including your own pre-existing mobile sessions) show `cli`, not
`claude-mobile-ui`, until the next time mobile writes to them — at which
point they self-correct.

### 2. Real-time liveness check via IDE lock files

Knowing "desktop touched this last" isn't enough on its own — a session
desktop used yesterday and finished with should NOT trigger a warning today.
`~/.claude/ide/*.lock` are real files the CLI's IDE integration writes, one
per currently-running IDE-attached `claude` session:

```json
{"pid": 1665, "workspaceFolders": ["/path/to/project"], "ideName": "Cursor", "transport": "ws", "authToken": "..."}
```

`isDesktopLiveForCwd()` in `server.js` scans these files and returns `true`
only if it finds one whose `pid` is still alive (`process.kill(pid, 0)`
doesn't throw) **and** whose `workspaceFolders` includes the session's
project directory.

**Limitations:**
- **Project-level, not session-level.** If desktop has session A open in a
  project and you open unrelated session B in the *same* project on mobile,
  this will still flag B — the lock file can't tell which session within
  the project is actually live.
- **IDE-only.** A desktop session running in a plain terminal (not through
  the VSCode/Cursor extension) writes no lock file and won't be detected.

## Decision flow (`GET /api/sessions/:sessionId/conflict-check`)

1. Is the session in this server's own `activeSessionIds` (i.e. mobile is
   already streaming it right now)? → **not a conflict** — the caller
   should reconnect via `/api/streams/active-by-session`, not warn.
2. Read the session's `.jsonl`. Is the most recent `user` line's
   `entrypoint === 'claude-mobile-ui'`? → **not a conflict** — mobile
   touched it last.
3. Otherwise, is there a live IDE lock file matching this session's project
   directory? → **conflict** if yes, otherwise **not a conflict**.

`SessionList.jsx`'s `handleOpenSession` calls this endpoint before opening
any session and shows a warning sheet ("Continue Anyway" / "Go Back") only
when `conflict: true`. There's deliberately no "Take Over" button anymore —
the only PID this mechanism finds is from a lock file, and killing it isn't
safe to do blindly (it may not be the exact `claude` process, and could be
tied to the whole IDE window rather than just that session).

## If this seems wrong

- **False positive** (warning shown but nothing is actually live): almost
  certainly the project-level granularity limitation above — check if
  desktop has a *different* session open in the same project directory.
- **False negative** (no warning, but desktop really is running the same
  session): check whether desktop is using a plain terminal rather than the
  VSCode/Cursor extension — no lock file exists for that case. This is a
  known gap, not a bug.
- **Warning never clears for an old session**: likely a pre-existing session
  from before this feature shipped, still showing `entrypoint: 'cli'` from
  desktop's last real touch, combined with a genuinely live desktop lock —
  open it once from mobile (accepting the warning) and it'll self-correct
  going forward.
- To inspect the raw signal yourself: `python3 -c "import json; [print(json.loads(l).get('entrypoint')) for l in open('<path-to-session>.jsonl') if json.loads(l).get('type')=='user']"` and `cat ~/.claude/ide/*.lock`.

## Related

- `CLAUDE_CODE_ASSUMPTIONS.md` section 7 — the original note that desktop
  conflict detection didn't exist at all; superseded by this doc.
- `README.md` "Desktop ↔ Mobile Handoff" section — user-facing description
  of the feature this powers.
