# Claude Mobile UI

A mobile-friendly web UI that lets you control Claude Code CLI from your phone on the same WiFi network. Browse past sessions, start new chats, explore files, and get notified when Claude finishes — all from your phone.

## Quick Start

```bash
npm install
npm run build
./start.sh          # HTTP mode (limited features)
./start.sh --https  # HTTPS mode (all features — recommended)
```

Open the Network URL printed in the terminal on your phone.

---

## Features

| Feature | HTTP | HTTPS |
|---|---|---|
| Browse & search past sessions | ✅ | ✅ |
| Chat with Claude (streaming) | ✅ | ✅ |
| Stop Claude mid-response | ✅ | ✅ |
| Active tool status line | ✅ | ✅ |
| Scroll-to-bottom FAB | ✅ | ✅ |
| Session cost tracker | ✅ | ✅ |
| Prompt history (last 20) | ✅ | ✅ |
| Quick prompt chips | ✅ | ✅ |
| Edit & resend a message | ✅ | ✅ |
| @ file mention in input | ✅ | ✅ |
| / skill & command picker | ✅ | ✅ |
| Reconnect after phone sleep | ✅ | ✅ |
| File explorer with preview | ✅ | ✅ |
| Syntax-highlighted code preview | ✅ | ✅ |
| Markdown & text file rendering | ✅ | ✅ |
| Session search & rename | ✅ | ✅ |
| Export conversation as Markdown | ✅ | ✅ |
| Tool use display (expand/collapse) | ✅ | ✅ |
| Retry failed messages | ✅ | ✅ |
| Desktop ↔ mobile conflict detection | ✅ | ✅ |
| PIN authentication | ✅ | ✅ |
| Completion sound (Web Audio) | ✅ | ✅ |
| Tab title badge when Claude replies | ✅ | ✅ |
| Haptic feedback | ✅ | ✅ |
| Voice input | ❌ | ✅ |
| Push notifications | ❌ | ✅ |
| PWA (install to home screen) | ❌ | ✅ |

---

## HTTPS Setup (Recommended)

HTTPS unlocks voice input, push notifications, and PWA install. It uses [mkcert](https://github.com/FiloSottile/mkcert) to generate locally-trusted certificates — no domain or paid cert needed.

### Step 1 — Install mkcert (Mac)

```bash
brew install mkcert
mkcert -install
```

`mkcert -install` adds a local Certificate Authority (CA) to your Mac's trust store. Chrome, Safari, and Firefox will trust certs signed by it automatically on this machine.

### Step 2 — Generate certs for your LAN IP

```bash
mkdir -p ~/.certs/claude-mobile

mkcert \
  -cert-file ~/.certs/claude-mobile/cert.pem \
  -key-file  ~/.certs/claude-mobile/key.pem  \
  localhost 127.0.0.1 $(ipconfig getifaddr en0)
```

`$(ipconfig getifaddr en0)` fills in your current LAN IP (e.g. `192.168.1.42`). If you're on WiFi via a different interface, replace `en0` with `en1` or check with `ifconfig`.

> **Note:** If your Mac's IP changes (e.g. the router reassigns it), re-run Step 2 with the new IP.

### Adding another IP later

```bash
mkcert \
  -cert-file ~/.certs/claude-mobile/cert.pem \
  -key-file  ~/.certs/claude-mobile/key.pem  \
  localhost 127.0.0.1 192.168.1.42 192.168.1.99
```

Just re-run with all IPs listed together and restart the server.

### Step 3 — Trust the CA on your phone (once per device)

Find your mkcert CA root certificate:

```bash
mkcert -CAROOT
# prints something like: /Users/you/Library/Application Support/mkcert
```

The CA file is `rootCA.pem` inside that folder. Install it on each device:

**iOS (iPhone/iPad)**
1. AirDrop or email `rootCA.pem` to your phone
2. Tap the file → **Allow** to install profile
3. Go to **Settings → General → VPN & Device Management** → tap the new profile → **Install**
4. Go to **Settings → General → About → Certificate Trust Settings** → toggle on the mkcert CA

**Android (Firefox — recommended)**

Android Chrome does not trust user-installed CAs (Android 7+). Use Firefox instead:

1. Transfer `rootCA.pem` to your phone
2. In Firefox: go to **Settings → About Firefox** → tap the logo 5× to enable debug menu
3. Go to **Settings → Secret Settings** → enable **Use Android's CA certificate store** (Firefox 120+)

Or enable it via `about:config`:
1. Open Firefox → address bar → `about:config`
2. Search `security.enterprise_roots.enabled` → set to `true`

### Step 4 — Start in HTTPS mode

```bash
./start.sh --https
```

You should now be able to open `https://192.168.x.x:3456` on your phone with a valid green lock.

### Custom cert paths

```bash
./start.sh --https --cert /path/to/cert.pem --key /path/to/key.pem
```

Or via environment variables:

```bash
CERT_PATH=/path/to/cert.pem KEY_PATH=/path/to/key.pem node server.js
```

---

## Chat Features

### Stop Mid-Response

Tap the **■ Stop** button in the status bar while Claude is responding to immediately abort. Claude stops processing and the partial response is preserved.

### Active Tool Status

While Claude is running tools (reading files, running commands, searching), a status line shows exactly what's happening — e.g. `Write · server.js` or `Bash · npm install`. No more wondering if it's still working.

### Scroll-to-Bottom FAB

If you scroll up to re-read earlier messages while Claude is responding, a floating **↓** button appears. When Claude is actively responding it shows *"Responding…"* in orange. Tap it to jump back to the latest message.

### Session Cost

The running cost of the session (`$0.042`) is displayed under the conversation title and updates after each response.

### Edit & Resend

**Long-press** any of your own messages to edit it. This opens an inline edit field in place of the original message. Submitting clears all messages after that point and re-sends with your updated text — useful for correcting yourself without retyping.

### Prompt History

Tap the **history** icon (↺) in the input bar to see your last 20 prompts across sessions. Tap any to fill the input. Stored locally in the browser.

### Quick Prompt Chips

A scrollable row of common prompts appears above the input bar: `Review this code`, `Write tests`, `Explain this`, `Fix the bug`, and more. Tap any to instantly fill the input.

### @ File Mention

Tap the **@** button in the input bar (or type `@` in the message field) to open a file browser. Navigate your project directory and tap any file to insert its path at the cursor — no need to open the full file explorer.

### / Skill & Command Picker

Tap the **/** button in the input bar (or type `/` as the first character of the message) to open a picker of available Skills and Commands — the same custom skills/commands you'd see typing `/` in the Claude Code CLI itself. Covers project-level (`.claude/`), user-level (`~/.claude/`), and enabled-plugin sources, with a filter box to search by name or description. Tap any item to insert it (plugin-provided items are inserted with their `plugin-name:item-name` namespaced form, which is required for those to resolve correctly).

### Retry Failed Messages

If a message fails to send (network error, Claude busy), a **Retry** button appears under the failed message with the error reason. Tapping it re-sends the exact same message.

### Haptic Feedback

The app gives subtle haptic feedback on key actions:
- **Send** — 20ms
- **Long-press to edit** — 30ms  
- **Stop** — 40ms

---

## Voice Input

Tap the **🎤** microphone button next to the message input to dictate your prompt. Requires HTTPS. The button is automatically hidden on HTTP or browsers that don't support the Web Speech API.

---

## Notifications

When Claude finishes a long response:
- The tab title updates to `✓ Claude replied` if the tab is in the background
- A short chime plays via Web Audio (works on HTTP too)
- A Web Push notification appears if you've granted permission (HTTPS only)

To enable push notifications, tap **"Enable notifications"** on the New Chat setup screen.

---

## PWA — Install to Home Screen

With HTTPS enabled, you can install Claude Mobile as a standalone app:

**iOS Safari:** tap the Share button → **Add to Home Screen**

**Android Chrome / Firefox:** tap the browser menu → **Install app**

Once installed it opens fullscreen with no browser chrome, just like a native app.

---

## Desktop ↔ Mobile Handoff

### Safe handoff (finished session)

If you've been working in Claude Code CLI on your desktop and Claude has finished responding, you can switch to mobile and open the same session — it loads the full history and you continue normally.

### Conflict detection (active session)

If Claude is **still running** on your desktop when you try to open the same session on mobile, the app detects the conflict and shows a warning sheet with three options:

**Take Over** *(recommended)* — stops the desktop Claude process cleanly, then opens the session on mobile. No data loss, clean handoff.

**Continue Anyway** — opens the session without stopping the desktop process. Both will be writing to the same session file simultaneously, which can corrupt history. Only use this if you know what you're doing.

**Go Back** — cancels and returns to the session list.

### How it works

Active sessions show a green **Live** badge in the session list so you can see at a glance which sessions are currently running before you tap into them. The badge updates every 5 seconds.

### Best practice

- Finish your current turn on desktop before switching to mobile
- If you need to hand off mid-response, use **Take Over** — it's safe and instant

---

## Reconnect After Sleep

If your phone screen locks mid-response, the server keeps Claude running. When you reopen the app it automatically replays the buffered output and resumes the live stream — you won't miss any of the response.

---

## File Explorer & Preview

Tap the **folder** icon in the chat header to open the file explorer. From there:
- Browse the project directory tree
- Tap **+** on any file or folder to insert its path into the chat input
- Tap a file to preview it:
  - `.md` / `.mdx` — rendered markdown with table support
  - `.txt` — plain text
  - Code files (`.ts`, `.js`, `.py`, `.go`, `.java`, etc.) — syntax highlighted
  - First 50 KB shown for large files, with a truncation notice
  - **Raw / Preview** toggle for `.md` and `.txt` files

---

## Session Search & Rename

- Use the search bar on the session list (appears when you have 10+ sessions) to filter across all projects instantly
- Sessions are auto-titled from your first message
- Tap the **pencil** icon on any session card to rename it inline

---

## PIN Authentication

Set an `ACCESS_PIN` environment variable to password-protect the UI:

```bash
ACCESS_PIN=1234 ./start.sh --https
```

Anyone opening the URL will be prompted for the PIN. After 5 wrong attempts the IP is locked out for 5 minutes. Without `ACCESS_PIN` set, the server is open (fine for solo use, not recommended when sharing).

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3456` | Server port |
| `ACCESS_PIN` | *(none)* | PIN to protect the UI |
| `MAX_CONCURRENT` | `2` | Max simultaneous Claude processes |
| `CERT_PATH` | *(none)* | Path to TLS certificate (.pem) |
| `KEY_PATH` | *(none)* | Path to TLS private key (.pem) |

---

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Dev mode — Vite HMR + server with `--watch` |
| `npm run build` | Build React app to `dist/` |
| `./start.sh` | Start server in HTTP mode (caffeinate keeps Mac awake) |
| `./start.sh --https` | Start server in HTTPS mode |
| `./start.sh --stop` | Stop the running server |

---

## Requirements

- macOS (for `caffeinate`; the server itself runs anywhere Node 18+ is available)
- Node.js 18+
- Claude Code CLI (`claude`) installed and authenticated

---

## A note on stability

This app works by reading `claude`'s session files directly and spawning
`claude -p` under the hood — none of that is a stable, documented API, so it
can break when the CLI updates. [CLAUDE_CODE_ASSUMPTIONS.md](CLAUDE_CODE_ASSUMPTIONS.md)
lists every such assumption (file formats, JSONL shapes, CLI flags) along
with how to re-check each one after a `claude` upgrade.
