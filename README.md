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

**Android**
1. Transfer `rootCA.pem` to your phone (use a cable or local file share)
2. Go to **Settings → Security → Install a certificate → CA certificate**
3. Select `rootCA.pem`

### Step 4 — Start in HTTPS mode

```bash
./start.sh --https
```

You should now be able to open `https://192.168.x.x:3456` on your phone with a valid green lock.

### Custom cert paths

If you stored certs elsewhere:

```bash
./start.sh --https --cert /path/to/cert.pem --key /path/to/key.pem
```

Or via environment variables:

```bash
CERT_PATH=/path/to/cert.pem KEY_PATH=/path/to/key.pem node server.js
```

---

## Features

| Feature | HTTP | HTTPS |
|---|---|---|
| Browse & search past sessions | ✅ | ✅ |
| Chat with Claude (streaming) | ✅ | ✅ |
| Reconnect after phone sleep | ✅ | ✅ |
| File explorer with preview | ✅ | ✅ |
| Syntax-highlighted code preview | ✅ | ✅ |
| Markdown & text file rendering | ✅ | ✅ |
| Session search & rename | ✅ | ✅ |
| Export conversation as Markdown | ✅ | ✅ |
| Tool use display (expand/collapse) | ✅ | ✅ |
| PIN authentication | ✅ | ✅ |
| Completion sound (Web Audio) | ✅ | ✅ |
| Tab title badge when Claude replies | ✅ | ✅ |
| Voice input | ❌ | ✅ |
| Push notifications | ❌ | ✅ |
| PWA (install to home screen) | ❌ | ✅ |

---

## PIN Authentication

Set an `ACCESS_PIN` environment variable to password-protect the UI:

```bash
ACCESS_PIN=1234 ./start.sh --https
```

Anyone opening the URL will be prompted for the PIN. After 5 wrong attempts the IP is locked out for 5 minutes. Without `ACCESS_PIN` set, the server is open (fine for solo use, not recommended when sharing).

---

## Voice Input

Tap the 🎤 button next to the message input to dictate your prompt. Requires HTTPS. The button is automatically hidden on HTTP or browsers that don't support the Web Speech API.

---

## Notifications

When Claude finishes a long response:
- The tab title updates to `✓ Claude replied` if the tab is in the background
- A short chime plays via Web Audio (works on HTTP too)
- A Web Push notification appears if you've granted permission (HTTPS only)

To enable push notifications, tap **"Enable notifications"** on the New Chat setup screen. You'll be prompted by the browser once — after that it's automatic.

---

## PWA — Install to Home Screen

With HTTPS enabled, you can install Claude Mobile as a standalone app:

**iOS Safari:** tap the Share button → **Add to Home Screen**

**Android Chrome:** tap the browser menu → **Install app** (or wait for the install banner)

Once installed, it opens fullscreen with no browser chrome, just like a native app.

---

## Reconnect After Sleep

If your phone screen locks mid-response, the server keeps Claude running. When you reopen the app it automatically replays the buffered output and resumes the live stream — you won't miss any of the response.

---

## File Explorer & Preview

Tap 📂 in the chat header to open the file explorer. From there:
- Browse the project directory tree
- Tap **+** on any file or folder to insert its path into the chat input
- Tap a file to preview it:
  - `.md` / `.mdx` — rendered markdown
  - `.txt` — plain text
  - Code files (`.ts`, `.js`, `.py`, `.go`, `.java`, etc.) — syntax highlighted
  - First 50 KB shown for large files, with a truncation notice
  - **Raw / Preview** toggle for `.md` and `.txt` files

---

## Session Search & Rename

- Use the search bar on the session list to filter across all projects instantly
- Tap the ✎ pencil icon on any session to rename it inline — saved back to Claude's session index

---

## Export Conversation

Tap the **↓** button in the chat header to download the full conversation as a `.md` file. Works on HTTP.

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
