import express from 'express';
import multer from 'multer';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { networkInterfaces, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createHttpServer } from 'node:http';
import { createClaudeBackend } from './server/backends/claude.js';
import { createCodexBackend } from './server/backends/codex.js';
import { createSessionPathFilter } from './server/session-path-filter.js';
import {
  BackendRequestError,
  parseBackendId,
  sessionKey,
  validateAdapter,
} from './server/backends/contract.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3456;
const ACCESS_PIN = process.env.ACCESS_PIN || '';
const sessionPathFilter = createSessionPathFilter(process.env.SESSION_IGNORE_GLOBS);
const backendRegistry = new Map([
  ['claude', validateAdapter(createClaudeBackend())],
  ['codex', validateAdapter(createCodexBackend())],
]);

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function getBackend(value, { requireAvailable = true } = {}) {
  const backendId = parseBackendId(value);
  const backend = backendRegistry.get(backendId);
  if (!backend) throw new BackendRequestError(`Unsupported backend: ${backendId}`);
  const descriptor = backend.describe();
  if (requireAvailable && !descriptor.available) {
    throw new BackendRequestError(descriptor.unavailableReason || `${descriptor.label} is unavailable`);
  }
  return backend;
}

function sendRouteError(res, error) {
  const status = error instanceof BackendRequestError ? 400 : 500;
  res.status(status).json({ error: getErrorMessage(error) });
}

// ============================================================================
// PIN authentication middleware
// ============================================================================

// Track failed attempts per IP: { attempts: N, lockedUntil: timestamp }
const pinFailures = new Map();
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60 * 1000; // 5 minutes

function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
}

function pinAuth(req, res, next) {
  if (!ACCESS_PIN) return next(); // no PIN configured — open access

  // Static assets are served before this middleware is registered, so skip check
  const ip = getClientIp(req);
  const record = pinFailures.get(ip);

  if (record && record.lockedUntil > Date.now()) {
    const secsLeft = Math.ceil((record.lockedUntil - Date.now()) / 1000);
    return res.status(429).json({ error: `Too many failed attempts. Try again in ${secsLeft}s.` });
  }

  const pin = req.headers['x-pin'] || req.query._pin;
  if (pin === ACCESS_PIN) {
    pinFailures.delete(ip); // reset on success
    return next();
  }

  // Wrong PIN — record failure
  const attempts = (record?.attempts || 0) + 1;
  if (attempts >= MAX_ATTEMPTS) {
    pinFailures.set(ip, { attempts, lockedUntil: Date.now() + LOCKOUT_MS });
    return res.status(429).json({ error: `Too many failed attempts. Locked for 5 minutes.` });
  }
  pinFailures.set(ip, { attempts, lockedUntil: 0 });
  return res.status(401).json({ error: 'Invalid PIN', attemptsLeft: MAX_ATTEMPTS - attempts });
}

// Serve static files without PIN (the lock screen itself must load)
const distDir = join(__dirname, 'dist');
const publicDir = join(__dirname, 'public');
app.use(express.static(existsSync(distDir) ? distDir : publicDir));

// All /api routes require PIN
app.use('/api', pinAuth);

// Process supervision is shared across backends. Adapters own only invocation,
// event parsing, and persistence semantics.
const activeProcesses = new Map();
const MAX_CONCURRENT = Math.max(1, parseInt(process.env.MAX_CONCURRENT || '3', 10) || 3);
// streamBuffers: processId -> { events: [...], done: bool }
const streamBuffers = new Map();
// activeSessionIds: composite backend/session key -> processId
const activeSessionIds = new Map();

// ============================================================================
// API: Auth check — returns whether PIN is required and validates it
// ============================================================================
app.get('/api/auth/check', (_req, res) => {
  // If we reach here, PIN passed (or not configured)
  res.json({ ok: true, pinRequired: !!ACCESS_PIN });
});

// ============================================================================
// API: Server status
// ============================================================================
app.get('/api/status', (_req, res) => {
  res.json({
    activeSessions: activeProcesses.size,
    maxSessions: MAX_CONCURRENT,
    busy: activeProcesses.size >= MAX_CONCURRENT,
  });
});

// ============================================================================
// API: Backends, projects, and sessions
// ============================================================================
app.get('/api/backends', (_req, res) => {
  res.json([...backendRegistry.values()].map(backend => backend.describe()));
});

app.get('/api/projects', (_req, res) => {
  const projects = [];
  for (const backend of backendRegistry.values()) {
    if (!backend.describe().available) continue;
    try {
      projects.push(...backend.listProjects().filter(project => !sessionPathFilter.isIgnored(project.originalPath)));
    } catch (error) {
      console.error(`[${backend.id}] failed to list projects:`, getErrorMessage(error));
    }
  }
  projects.sort((left, right) => right.sessionCount - left.sessionCount || left.originalPath.localeCompare(right.originalPath));
  res.json(projects);
});

app.get('/api/projects/:projectId/sessions', (req, res) => {
  try {
    const backend = getBackend(req.query.backend);
    const sessions = backend
      .listSessions(req.params.projectId)
      .filter(session => !sessionPathFilter.isIgnored(session.projectPath));
    res.json(sessions);
  } catch (error) {
    sendRouteError(res, error);
  }
});

app.patch('/api/sessions/:sessionId', (req, res) => {
  try {
    const backend = getBackend(req.body?.backend ?? req.query.backend);
    const summary = req.body?.summary;
    if (typeof summary !== 'string' || !summary.trim()) {
      return res.status(400).json({ error: 'summary is required' });
    }
    const normalizedSummary = summary.trim().slice(0, 160);
    if (!backend.renameSession(req.params.sessionId, normalizedSummary)) {
      return res.status(404).json({ error: 'Session not found' });
    }
    res.json({ ok: true });
  } catch (error) {
    sendRouteError(res, error);
  }
});

app.get('/api/sessions/:sessionId/messages', async (req, res) => {
  try {
    const backend = getBackend(req.query.backend);
    res.json(await backend.readSessionMessages(req.params.sessionId));
  } catch (error) {
    const status = error?.name === 'SessionNotFoundError' ? 404 : error instanceof BackendRequestError ? 400 : 500;
    res.status(status).json({ error: getErrorMessage(error) });
  }
});

app.get('/api/directories', (_req, res) => {
  const directories = new Set();
  for (const backend of backendRegistry.values()) {
    if (!backend.describe().available) continue;
    try {
      for (const directory of backend.listDirectories()) {
        if (!sessionPathFilter.isIgnored(directory)) directories.add(directory);
      }
    } catch (error) {
      console.error(`[${backend.id}] failed to list directories:`, getErrorMessage(error));
    }
  }
  res.json([...directories].sort());
});

// ============================================================================
// API: List files in a directory (for Explorer)
// ============================================================================
const HIDDEN_DIRS = new Set(['.git', 'node_modules', '.next', '.vite', '__pycache__', '.DS_Store', '.cache', 'dist', 'build', '.turbo']);

// In-memory cache for directory listings (60s TTL)
const fileCache = new Map();
const FILE_CACHE_TTL = 60_000;

function readDirCached(dir, showHidden, bust = false) {
  const key = `${dir}::${showHidden}`;
  if (!bust && fileCache.has(key)) {
    const cached = fileCache.get(key);
    if (Date.now() - cached.ts < FILE_CACHE_TTL) return cached.data;
  }
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter(e => {
      if (!showHidden && (e.name.startsWith('.') || HIDDEN_DIRS.has(e.name))) return false;
      return true;
    })
    .map(e => {
      const fullPath = join(dir, e.name);
      let size = 0;
      try {
        const st = statSync(fullPath);
        size = st.size;
      } catch {}
      return {
        name: e.name,
        path: fullPath,
        isDir: e.isDirectory(),
        size,
      };
    })
    .sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  fileCache.set(key, { data: entries, ts: Date.now() });
  return entries;
}

const TEXT_EXTENSIONS = new Set([
  'js','jsx','ts','tsx','mjs','cjs','json','json5','jsonc',
  'yaml','yml','toml','ini','env','sh','bash','zsh','fish',
  'py','rb','go','rs','java','kt','swift','c','cpp','h','hpp',
  'css','scss','sass','less','html','htm','xml','svg',
  'md','mdx','txt','log','csv','gitignore','gitattributes',
  'dockerfile','makefile','rakefile','procfile',
  'tf','hcl','sql','graphql','gql','prisma',
]);
const FILE_PREVIEW_MAX = 50 * 1024; // 50 KB

app.get('/api/file-content', (req, res) => {
  try {
    const filePath = req.query.path;
    if (!filePath || !existsSync(filePath)) {
      return res.status(400).json({ error: 'File not found' });
    }
    const stat = statSync(filePath);
    if (stat.isDirectory()) {
      return res.status(400).json({ error: 'Path is a directory' });
    }
    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    if (!TEXT_EXTENSIONS.has(ext)) {
      return res.status(415).json({ error: 'Binary or unsupported file type' });
    }
    if (stat.size > FILE_PREVIEW_MAX) {
      const content = readFileSync(filePath, 'utf-8').slice(0, FILE_PREVIEW_MAX);
      return res.json({ content, truncated: true, size: stat.size });
    }
    const content = readFileSync(filePath, 'utf-8');
    res.json({ content, truncated: false, size: stat.size });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/files', (req, res) => {
  try {
    const dir = req.query.dir;
    if (!dir || !existsSync(dir)) {
      return res.status(400).json({ error: 'Invalid directory' });
    }
    const showHidden = req.query.hidden === 'true';
    const bust = req.query.refresh === 'true';
    res.json(readDirCached(dir, showHidden, bust));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// API: Upload a file from the mobile client, save it to disk, hand back its
// path so it can be referenced in chat. Stored outside any project's git
// working tree — the agent process isn't path-sandboxed, so an absolute path
// here is just as readable to it as a file inside the project folder.
// ============================================================================
const UPLOAD_DIR = join(homedir(), '.claude-mobile-ui', 'uploads');
mkdirSync(UPLOAD_DIR, { recursive: true });
const UPLOAD_MAX_BYTES = 25 * 1024 * 1024; // 25 MB

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const safeName = file.originalname.replace(/[^\w.-]/g, '_').slice(-100) || 'upload';
      cb(null, `${Date.now()}-${randomUUID().slice(0, 8)}-${safeName}`);
    },
  }),
  limits: { fileSize: UPLOAD_MAX_BYTES },
});

app.post('/api/upload', (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      return res.status(status).json({ error: err.message });
    }
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    res.json({ path: req.file.path, name: req.file.originalname, size: req.file.size });
  });
});

app.get('/api/slash-items', (req, res) => {
  try {
    const backend = getBackend(req.query.backend);
    if (!backend.describe().capabilities.skillsPicker) {
      return res.status(404).json({ error: 'Skills and commands are not available for this backend' });
    }
    res.json(backend.listSlashItems(typeof req.query.projectPath === 'string' ? req.query.projectPath : ''));
  } catch (error) {
    sendRouteError(res, error);
  }
});

// ============================================================================
// API: Send a message (new or continue session) — SSE streaming
// ============================================================================
app.post('/api/chat', (req, res) => {
  let backend;
  try {
    backend = getBackend(req.body?.backend);
  } catch (error) {
    return sendRouteError(res, error);
  }

  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  if (!message) return res.status(400).json({ error: 'message is required' });
  if (activeProcesses.size >= MAX_CONCURRENT) {
    return res.status(429).json({
      error: `Agent capacity reached (${activeProcesses.size}/${MAX_CONCURRENT} sessions active). Try again shortly.`,
      busy: true,
    });
  }

  let spawnSpec;
  try {
    spawnSpec = backend.buildSpawnSpec({
      message,
      sessionId: req.body?.sessionId,
      projectPath: req.body?.projectPath,
      permissionMode: req.body?.permissionMode,
      model: req.body?.model,
      effort: req.body?.effort,
    });
  } catch (error) {
    return res.status(400).json({ error: getErrorMessage(error) });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  console.log(`[chat] spawning ${backend.id}, cwd: ${spawnSpec.cwd}`);
  const child = spawn(spawnSpec.command, spawnSpec.args, {
    cwd: spawnSpec.cwd,
    env: spawnSpec.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const processId = randomUUID();
  let currentSessionId = req.body?.sessionId || null;
  activeProcesses.set(processId, { backend: backend.id, child, sessionId: currentSessionId });
  if (currentSessionId) activeSessionIds.set(sessionKey(backend.id, currentSessionId), processId);

  const streamBuffer = { events: [], done: false, backend: backend.id, sessionId: currentSessionId };
  streamBuffers.set(processId, streamBuffer);
  const parser = backend.createEventParser();
  let stdoutBuffer = '';
  let titleSaved = false;
  let processFinished = false;
  let finalized = false;
  let clientConnected = true;
  let emittedProcessError = false;

  res.on('error', () => {});

  function emitEvent(event) {
    streamBuffer.events.push(event);
    if (!clientConnected) return;
    try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch {}
  }

  function associateSession(sessionId) {
    if (!sessionId || sessionId === currentSessionId) return;
    if (currentSessionId) activeSessionIds.delete(sessionKey(backend.id, currentSessionId));
    currentSessionId = sessionId;
    streamBuffer.sessionId = sessionId;
    const running = activeProcesses.get(processId);
    if (running) running.sessionId = sessionId;
    activeSessionIds.set(sessionKey(backend.id, sessionId), processId);
  }

  function handleNormalizedEvent(event) {
    if (event.type === 'session-started' && event.sessionId) associateSession(event.sessionId);
    if (event.type === 'turn-complete') {
      if (event.sessionId) associateSession(event.sessionId);
      if (currentSessionId && !titleSaved && !req.body?.sessionId) {
        titleSaved = true;
        try { backend.saveInitialTitle(currentSessionId, message); } catch {}
      }
    }
    if (event.type === 'error') emittedProcessError = true;
    emitEvent(event);
  }

  emitEvent({ type: 'process-id', id: processId, backend: backend.id });
  child.stdin.on('error', error => handleNormalizedEvent({ type: 'error', message: getErrorMessage(error) }));
  child.stdin.end(`${spawnSpec.prompt}\n`);

  child.stdout.on('data', chunk => {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() || '';
    for (const line of lines) {
      for (const event of parser.parseLine(line)) handleNormalizedEvent(event);
    }
  });

  child.stderr.on('data', chunk => {
    const text = chunk.toString().trim();
    if (!text) return;
    console.error(`[${backend.id} stderr]`, text.slice(0, 500));
    if (/\berror\b/i.test(text)) handleNormalizedEvent({ type: 'error', message: text });
  });

  function cleanup() {
    activeProcesses.delete(processId);
    if (currentSessionId) activeSessionIds.delete(sessionKey(backend.id, currentSessionId));
    setTimeout(() => streamBuffers.delete(processId), 5 * 60 * 1000);
  }

  child.on('close', code => {
    if (finalized) return;
    finalized = true;
    processFinished = true;
    console.log(`[${backend.id}] process exited with code ${code}`);
    for (const event of parser.flush(stdoutBuffer)) handleNormalizedEvent(event);
    if (code && !emittedProcessError) {
      handleNormalizedEvent({ type: 'error', message: `${backend.describe().label} exited with code ${code}` });
    }
    emitEvent({ type: 'stream-complete', exitCode: code });
    streamBuffer.done = true;
    if (clientConnected) { try { res.end(); } catch {} }
    cleanup();
  });

  child.on('error', error => {
    if (finalized) return;
    finalized = true;
    processFinished = true;
    handleNormalizedEvent({ type: 'error', message: getErrorMessage(error) });
    emitEvent({ type: 'stream-complete', exitCode: null });
    streamBuffer.done = true;
    if (clientConnected) { try { res.end(); } catch {} }
    cleanup();
  });

  res.on('close', () => {
    clientConnected = false;
    console.log(`[chat] response closed, processFinished=${processFinished}`);
  });
});

// ============================================================================
// API: Replay buffered stream (reconnect after phone sleep)
// ============================================================================
app.get('/api/stream/:processId/replay', (req, res) => {
  const buf = streamBuffers.get(req.params.processId);
  if (!buf) {
    return res.status(404).json({ error: 'Stream not found or expired' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let clientConnected = true;
  res.on('error', () => {}); // swallow — e.g. ECONNRESET from a closed mobile connection

  // Replay all buffered events
  for (const obj of buf.events) {
    if (!clientConnected) break;
    try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { clientConnected = false; }
  }

  if (buf.done) {
    if (clientConnected) { try { res.end(); } catch {} }
    return;
  }

  // Process is still running — attach as a live listener by polling the buffer length
  let lastIndex = buf.events.length;
  const interval = setInterval(() => {
    if (!clientConnected) { clearInterval(interval); return; }
    const newEvents = buf.events.slice(lastIndex);
    for (const obj of newEvents) {
      try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { clientConnected = false; }
    }
    lastIndex = buf.events.length;

    if (buf.done) {
      clearInterval(interval);
      if (clientConnected) { try { res.end(); } catch {} }
    }
  }, 100);

  res.on('close', () => { clientConnected = false; clearInterval(interval); });
});

// ============================================================================
// API: List active stream IDs (for reconnect on page reload)
// ============================================================================
app.get('/api/streams/active', (_req, res) => {
  const active = [];
  for (const [id, buf] of streamBuffers) {
    if (!buf.done) active.push(id);
  }
  res.json(active);
});

// API: List active streams with their sessionId, so a client that lost its
// remembered processId (new device, sessionStorage wiped, app relaunched)
// can still discover a workflow still running for the session it opened.
app.get('/api/streams/active-by-session', (_req, res) => {
  const active = [];
  for (const processId of activeSessionIds.values()) {
    const buf = streamBuffers.get(processId);
    if (buf && !buf.done) active.push({ backend: buf.backend, sessionId: buf.sessionId, processId });
  }
  res.json(active);
});

// ============================================================================
// API: Abort a running process
// ============================================================================
app.post('/api/abort/:processId', (req, res) => {
  const running = activeProcesses.get(req.params.processId);
  if (running && !running.child.killed) {
    running.child.kill('SIGTERM');
    res.json({ ok: true });
  } else {
    res.status(404).json({ error: 'Process not found or already finished' });
  }
});

// ============================================================================
// API: List active session IDs (conflict detection)
// ============================================================================
app.get('/api/sessions/active', (_req, res) => {
  const active = [];
  for (const processId of activeSessionIds.values()) {
    const stream = streamBuffers.get(processId);
    if (stream && !stream.done && stream.sessionId) {
      active.push({ backend: stream.backend, sessionId: stream.sessionId });
    }
  }
  res.json(active);
});

// ============================================================================
// API: Take over a session — abort the conflicting process then let caller resume
// ============================================================================
app.post('/api/sessions/:sessionId/takeover', (req, res) => {
  try {
    const backend = getBackend(req.body?.backend ?? req.query.backend);
    const key = sessionKey(backend.id, req.params.sessionId);
    const processId = activeSessionIds.get(key);
    if (!processId) return res.json({ ok: true, wasActive: false });
    const running = activeProcesses.get(processId);
    if (running && !running.child.killed) running.child.kill('SIGTERM');
    res.json({ ok: true, wasActive: true });
  } catch (error) {
    sendRouteError(res, error);
  }
});

// ============================================================================
// API: Check whether opening a session on mobile risks a real desktop
// conflict (see docs/session-conflict-detection.md)
// ============================================================================
app.get('/api/sessions/:sessionId/conflict-check', (req, res) => {
  try {
    const backend = getBackend(req.query.backend);
    const key = sessionKey(backend.id, req.params.sessionId);
    if (activeSessionIds.has(key)) return res.json({ conflict: false, reason: null });
    res.json(backend.checkConflict(req.params.sessionId));
  } catch (error) {
    sendRouteError(res, error);
  }
});

// ============================================================================
// API: Git diff — repo detection, working-tree status, per-file unified diff
// ============================================================================
app.get('/api/git/status', (req, res) => {
  try {
    const cwd = req.query.cwd;
    if (!cwd || !existsSync(cwd)) return res.status(400).json({ error: 'Invalid cwd' });
    res.json(getGitStatus(cwd));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/git/diff', (req, res) => {
  try {
    const { cwd, file } = req.query;
    if (!cwd || !existsSync(cwd)) return res.status(400).json({ error: 'Invalid cwd' });
    if (!file) return res.status(400).json({ error: 'file is required' });
    res.json({ diff: getGitDiff(cwd, file) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Detects whether cwd is a git repo and, if so, lists working-tree changes
// (tracked + untracked) via `git status --porcelain=v1`. Paths come back
// relative to cwd (git's default `status.relativePaths` behavior), which
// matters because getGitDiff() below is called with exactly these paths.
function getGitStatus(cwd) {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd, stdio: ['ignore', 'ignore', 'ignore'] });
  } catch {
    return { isRepo: false, files: [] };
  }

  let out = '';
  try {
    out = execFileSync('git', ['status', '--porcelain=v1'], { cwd, encoding: 'utf-8' });
  } catch {
    return { isRepo: true, files: [] };
  }

  const STATUS_LABELS = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', U: 'conflicted' };
  const files = out.split('\n').filter(Boolean).map(line => {
    if (line.startsWith('??')) return { path: line.slice(3), status: 'untracked' };
    const code = line[0] !== ' ' ? line[0] : line[1];
    let path = line.slice(3);
    if (path.includes(' -> ')) path = path.split(' -> ')[1]; // renames: "old -> new"
    return { path, status: STATUS_LABELS[code] || 'modified' };
  });
  return { isRepo: true, files };
}

// Returns a real unified diff for one file, scoped to cwd. Uses execFileSync
// (argv-based, no shell) rather than execSync so a crafted `file` value from
// the client can't break out into shell syntax.
function getGitDiff(cwd, file) {
  const resolvedCwd = resolve(cwd);
  const resolvedFile = resolve(cwd, file);
  if (resolvedFile !== resolvedCwd && !resolvedFile.startsWith(resolvedCwd + sep)) {
    throw new Error('file must be inside cwd');
  }

  let statusLine = '';
  try {
    statusLine = execFileSync('git', ['status', '--porcelain=v1', '--', file], { cwd, encoding: 'utf-8' }).trim();
  } catch { /* not a repo / git failure — fall through, diff attempts below will also fail cleanly */ }

  // Untracked files have no HEAD entry, so `git diff HEAD` shows nothing for
  // them — diff against /dev/null instead so new files render as all-additions.
  if (statusLine.startsWith('??')) {
    try {
      return execFileSync('git', ['diff', '--no-index', '--', '/dev/null', file], { cwd, encoding: 'utf-8' });
    } catch (err) {
      // git diff --no-index exits 1 when the files differ — that's the normal case, not a failure
      return err.stdout || '';
    }
  }

  try {
    return execFileSync('git', ['diff', 'HEAD', '--', file], { cwd, encoding: 'utf-8' });
  } catch (err) {
    return err.stdout || '';
  }
}

// ============================================================================
// Start server — HTTPS if certs provided, HTTP fallback
// ============================================================================
const CERT_PATH = process.env.CERT_PATH;
const KEY_PATH = process.env.KEY_PATH;

function getLanIp() {
  const interfaces = networkInterfaces();
  for (const iface of Object.values(interfaces)) {
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return 'localhost';
}

function startServer() {
  const lanIp = getLanIp();
  const useHttps = CERT_PATH && KEY_PATH && existsSync(CERT_PATH) && existsSync(KEY_PATH);

  const onListen = () => {
    const proto = useHttps ? 'https' : 'http';
    console.log('');
    console.log('  Claude Mobile UI');
    console.log('  ─────────────────────────────────');
    if (useHttps) {
      console.log('  Mode:    HTTPS (all features enabled)');
    } else {
      console.log('  Mode:    HTTP (voice/push/PWA unavailable)');
      console.log('  Tip:     Set CERT_PATH and KEY_PATH for HTTPS');
    }
    console.log(`  Local:   ${proto}://localhost:${PORT}`);
    console.log(`  Network: ${proto}://${lanIp}:${PORT}`);
    console.log('');
    console.log('  Open the Network URL on your phone');
    console.log('  (same WiFi network required)');
    console.log('');
  };

  if (useHttps) {
    const creds = { key: readFileSync(KEY_PATH), cert: readFileSync(CERT_PATH) };
    createHttpsServer(creds, app).listen(PORT, '0.0.0.0', onListen);
  } else {
    createHttpServer(app).listen(PORT, '0.0.0.0', onListen);
  }
}

startServer();
