import express from 'express';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, existsSync, createReadStream, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, networkInterfaces } from 'node:os';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createHttpServer } from 'node:http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3456;
const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');
const ACCESS_PIN = process.env.ACCESS_PIN || '';

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

// Track active Claude processes and their buffered output for reconnect
const activeProcesses = new Map();
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '2', 10);
// streamBuffers: processId -> { events: [...], done: bool }
const streamBuffers = new Map();
// activeSessionIds: sessionId -> processId — detect desktop/mobile conflicts
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
// API: List all projects
// ============================================================================
function getProjectInfo(dirName) {
  const projectDir = join(CLAUDE_PROJECTS_DIR, dirName);
  const indexPath = join(projectDir, 'sessions-index.json');
  let sessionCount = 0;
  let originalPath = '';

  if (existsSync(indexPath)) {
    try {
      const data = JSON.parse(readFileSync(indexPath, 'utf-8'));
      sessionCount = (data.entries || []).length;
      originalPath = data.originalPath || '';
    } catch {}
  }

  // Fallback: count .jsonl files directly in the project dir
  if (sessionCount === 0) {
    try {
      const jsonlFiles = readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));
      sessionCount = jsonlFiles.length;
    } catch {}
  }

  // Derive originalPath from dir name if not in index
  if (!originalPath) {
    originalPath = dirName.replace(/^-/, '/').replace(/-/g, '/');
  }

  return { id: dirName, originalPath, sessionCount };
}

app.get('/api/projects', (_req, res) => {
  try {
    if (!existsSync(CLAUDE_PROJECTS_DIR)) {
      return res.json([]);
    }
    const dirs = readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => getProjectInfo(d.name))
      .filter(p => p.sessionCount > 0)
      .sort((a, b) => b.sessionCount - a.sessionCount);

    res.json(dirs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// API: List sessions for a project
// ============================================================================
app.get('/api/projects/:projectId/sessions', (req, res) => {
  try {
    const projectDir = join(CLAUDE_PROJECTS_DIR, req.params.projectId);
    const indexPath = join(projectDir, 'sessions-index.json');

    let entries = [];
    let originalPath = '';

    // Try reading from sessions-index.json first
    if (existsSync(indexPath)) {
      try {
        const data = JSON.parse(readFileSync(indexPath, 'utf-8'));
        originalPath = data.originalPath || '';
        entries = (data.entries || []).map(e => ({
          sessionId: e.sessionId,
          summary: e.summary || e.firstPrompt || '(no title)',
          firstPrompt: e.firstPrompt || '',
          messageCount: e.messageCount || 0,
          created: e.created,
          modified: e.modified,
          gitBranch: e.gitBranch || '',
          projectPath: e.projectPath || data.originalPath || '',
        }));
      } catch {}
    }

    // Fallback: discover sessions from .jsonl files not in the index
    if (existsSync(projectDir)) {
      const indexedIds = new Set(entries.map(e => e.sessionId));
      const jsonlFiles = readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));
      for (const file of jsonlFiles) {
        const sessionId = file.replace('.jsonl', '');
        if (indexedIds.has(sessionId)) continue;
        const filePath = join(projectDir, file);
        try {
          const stat = statSync(filePath);
          // Read first line to get a summary
          const content = readFileSync(filePath, 'utf-8');
          const firstLine = content.split('\n').find(l => l.trim());
          let summary = '(no title)';
          let messageCount = 0;
          if (firstLine) {
            try {
              const msg = JSON.parse(firstLine);
              if (msg.type === 'human' && msg.message?.content) {
                summary = msg.message.content.slice(0, 100);
              }
            } catch {}
          }
          messageCount = content.split('\n').filter(l => l.trim()).length;
          entries.push({
            sessionId,
            summary,
            firstPrompt: summary,
            messageCount,
            created: stat.birthtime.toISOString(),
            modified: stat.mtime.toISOString(),
            gitBranch: '',
            projectPath: originalPath || req.params.projectId.replace(/^-/, '/').replace(/-/g, '/'),
          });
        } catch {}
      }
    }

    entries.sort((a, b) => new Date(b.modified) - new Date(a.modified));
    res.json(entries);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// API: Rename a session (update summary in sessions-index.json)
// ============================================================================
app.patch('/api/sessions/:sessionId', (req, res) => {
  try {
    const { sessionId } = req.params;
    const { summary } = req.body;
    if (!summary || typeof summary !== 'string') {
      return res.status(400).json({ error: 'summary is required' });
    }

    // Find which project dir contains this session
    if (!existsSync(CLAUDE_PROJECTS_DIR)) return res.status(404).json({ error: 'Not found' });

    const dirs = readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const dir of dirs) {
      const indexPath = join(CLAUDE_PROJECTS_DIR, dir.name, 'sessions-index.json');
      if (!existsSync(indexPath)) continue;
      try {
        const data = JSON.parse(readFileSync(indexPath, 'utf-8'));
        const entry = (data.entries || []).find(e => e.sessionId === sessionId);
        if (entry) {
          entry.summary = summary.trim();
          writeFileSync(indexPath, JSON.stringify(data, null, 2), 'utf-8');
          return res.json({ ok: true });
        }
      } catch {}
    }
    res.status(404).json({ error: 'Session not found' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// API: Get full conversation for a session (read JSONL)
// ============================================================================
app.get('/api/sessions/:sessionId/messages', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const jsonlPath = findSessionFile(sessionId);

    if (!jsonlPath) {
      return res.status(404).json({ error: 'Session file not found' });
    }

    const messages = await parseSessionJsonl(jsonlPath);
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// API: List known project directories (for new chat folder picker)
// ============================================================================
app.get('/api/directories', (_req, res) => {
  try {
    if (!existsSync(CLAUDE_PROJECTS_DIR)) {
      return res.json([]);
    }
    const dirs = readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => {
        const indexPath = join(CLAUDE_PROJECTS_DIR, d.name, 'sessions-index.json');
        let originalPath = '';
        if (existsSync(indexPath)) {
          try {
            const data = JSON.parse(readFileSync(indexPath, 'utf-8'));
            originalPath = data.originalPath || '';
          } catch {}
        }
        // Decode directory name back to path if no originalPath
        if (!originalPath) {
          originalPath = '/' + d.name.replaceAll('-', '/');
        }
        return originalPath;
      })
      .filter(Boolean)
      .sort();

    res.json(dirs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
// API: Send a message (new or continue session) — SSE streaming
// ============================================================================
app.post('/api/chat', (req, res) => {
  const { message, sessionId, projectPath, permissionMode, model } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'message is required' });
  }

  if (activeProcesses.size >= MAX_CONCURRENT) {
    return res.status(429).json({
      error: `Claude is busy (${activeProcesses.size}/${MAX_CONCURRENT} sessions active). Try again shortly.`,
      busy: true,
    });
  }

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];

  // Add permission mode if specified
  const validModes = ['default', 'plan', 'acceptEdits', 'auto', 'bypassPermissions'];
  if (permissionMode && validModes.includes(permissionMode)) {
    args.push('--permission-mode', permissionMode);
  }

  const validModels = ['sonnet', 'opus', 'haiku'];
  if (model && validModels.includes(model)) {
    args.push('--model', model);
  }

  if (sessionId) {
    args.push('--resume', sessionId);
  }

  const cwd = projectPath || homedir();
  console.log(`[chat] spawning claude with args: ${args.join(' ')}, cwd: ${cwd}`);
  const claudeProcess = spawn('claude', args, {
    cwd,
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  console.log(`[chat] claude process pid: ${claudeProcess.pid}`);

  const processId = Date.now().toString(36);
  activeProcesses.set(processId, claudeProcess);
  if (sessionId) activeSessionIds.set(sessionId, processId);

  // Buffer all events so clients can reconnect and replay
  const streamBuf = { events: [], done: false };
  streamBuffers.set(processId, streamBuf);

  function emitEvent(obj) {
    const data = `data: ${JSON.stringify(obj)}\n\n`;
    streamBuf.events.push(obj);
    res.write(data);
  }

  // Send the process ID so the client can abort/reconnect
  emitEvent({ type: 'process-id', id: processId });

  // Write the user message to stdin (newline required)
  claudeProcess.stdin.write(message + '\n');
  claudeProcess.stdin.end();

  let buffer = '';
  let titleSaved = false;
  let hasStreamedText = false; // true once we've forwarded any text_delta events

  claudeProcess.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'stream_event') {
          // --include-partial-messages emits raw API stream events; extract text deltas
          const ev = obj.event;
          if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta?.text) {
            hasStreamedText = true;
            emitEvent({ type: 'assistant', message: { content: [{ type: 'text', text: ev.delta.text }] } });
          }
        } else if (obj.type === 'assistant') {
          if (hasStreamedText) {
            // Text was already sent as deltas — only forward tool_use blocks to avoid duplicating text
            const content = obj.message?.content || [];
            const toolBlocks = content.filter(b => b.type === 'tool_use');
            if (toolBlocks.length > 0) {
              emitEvent({ ...obj, message: { ...obj.message, content: toolBlocks } });
            }
            hasStreamedText = false; // reset for the next assistant turn
          } else {
            emitEvent(obj);
          }
        } else if (obj.type === 'result') {
          emitEvent(obj);
        }
        // Auto-title: once we get a session_id from the result, write the first
        // user message as the session summary so the home screen is never "(no title)"
        if (obj.type === 'result' && obj.session_id) {
          // Register new session ID so conflict detection works mid-stream
          if (!sessionId) activeSessionIds.set(obj.session_id, processId);
        }
        if (obj.type === 'result' && obj.session_id && !titleSaved && !sessionId) {
          titleSaved = true;
          const title = message.trim().slice(0, 80).replace(/\n/g, ' ');
          try {
            const allDirs = readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true })
              .filter(d => d.isDirectory())
              .map(d => d.name);
            for (const dir of allDirs) {
              const indexPath = join(CLAUDE_PROJECTS_DIR, dir, 'sessions-index.json');
              if (!existsSync(indexPath)) continue;
              const data = JSON.parse(readFileSync(indexPath, 'utf-8'));
              const entry = (data.entries || []).find(e => e.sessionId === obj.session_id);
              if (entry) {
                entry.summary = title;
                writeFileSync(indexPath, JSON.stringify(data, null, 2), 'utf-8');
                break;
              }
            }
          } catch {}
        }
      } catch {
        // Not JSON, skip
      }
    }
  });

  claudeProcess.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    console.error('[claude stderr]', text.trim().slice(0, 200));
    if (text.includes('Error') || text.includes('error')) {
      emitEvent({ type: 'error', message: text.trim() });
    }
  });

  claudeProcess.on('close', (code) => {
    processFinished = true;
    console.log(`[claude] process exited with code ${code}`);
    if (buffer.trim()) {
      const remaining = buffer.trim();
      const jsonMatches = remaining.match(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g);
      if (jsonMatches) {
        for (const match of jsonMatches) {
          try {
            const obj = JSON.parse(match);
            if (obj.type === 'assistant' || obj.type === 'result') {
              emitEvent(obj);
            }
          } catch {}
        }
      }
    }
    emitEvent({ type: 'done', exitCode: code });
    streamBuf.done = true;
    res.end();
    activeProcesses.delete(processId);
    if (sessionId) activeSessionIds.delete(sessionId);
    setTimeout(() => streamBuffers.delete(processId), 5 * 60 * 1000);
  });

  claudeProcess.on('error', (err) => {
    emitEvent({ type: 'error', message: err.message });
    streamBuf.done = true;
    res.end();
    activeProcesses.delete(processId);
    if (sessionId) activeSessionIds.delete(sessionId);
    setTimeout(() => streamBuffers.delete(processId), 5 * 60 * 1000);
  });

  let processFinished = false;
  res.on('close', () => {
    console.log(`[chat] response closed, processFinished=${processFinished}`);
    // Keep process alive — client can reconnect via /api/stream/:processId/replay
    // Process will clean itself up when Claude finishes
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

  // Replay all buffered events
  for (const obj of buf.events) {
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  }

  if (buf.done) {
    res.end();
    return;
  }

  // Process is still running — attach as a live listener by polling the buffer length
  let lastIndex = buf.events.length;
  const interval = setInterval(() => {
    const newEvents = buf.events.slice(lastIndex);
    for (const obj of newEvents) {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    }
    lastIndex = buf.events.length;

    if (buf.done) {
      clearInterval(interval);
      res.end();
    }
  }, 100);

  res.on('close', () => clearInterval(interval));
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

// ============================================================================
// API: Abort a running process
// ============================================================================
app.post('/api/abort/:processId', (req, res) => {
  const proc = activeProcesses.get(req.params.processId);
  if (proc && !proc.killed) {
    proc.kill('SIGTERM');
    activeProcesses.delete(req.params.processId);
    res.json({ ok: true });
  } else {
    res.status(404).json({ error: 'Process not found or already finished' });
  }
});

// ============================================================================
// API: List active session IDs (conflict detection)
// ============================================================================
app.get('/api/sessions/active', (_req, res) => {
  res.json([...activeSessionIds.keys()]);
});

// ============================================================================
// API: Take over a session — abort the conflicting process then let caller resume
// ============================================================================
app.post('/api/sessions/:sessionId/takeover', (req, res) => {
  const { sessionId } = req.params;
  const processId = activeSessionIds.get(sessionId);
  if (!processId) return res.json({ ok: true, wasActive: false });

  const proc = activeProcesses.get(processId);
  if (proc && !proc.killed) proc.kill('SIGTERM');
  activeProcesses.delete(processId);
  activeSessionIds.delete(sessionId);

  // Mark stream buffer done so any replay clients get a clean close
  const buf = streamBuffers.get(processId);
  if (buf) { buf.done = true; }

  res.json({ ok: true, wasActive: true });
});

// ============================================================================
// Helpers
// ============================================================================

function findSessionFile(sessionId) {
  // Search all project dirs for the session JSONL
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return null;

  const dirs = readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory());

  for (const dir of dirs) {
    const candidate = join(CLAUDE_PROJECTS_DIR, dir.name, `${sessionId}.jsonl`);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function parseSessionJsonl(filePath) {
  return new Promise((resolve, reject) => {
    const messages = [];
    const rl = createInterface({
      input: createReadStream(filePath),
      crlfDelay: Infinity,
    });

    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const obj = JSON.parse(line);

        if (obj.type === 'user') {
          const msg = obj.message || {};
          let text = '';
          if (typeof msg.content === 'string') {
            text = msg.content;
          } else if (Array.isArray(msg.content)) {
            text = msg.content
              .filter(c => c.type === 'text')
              .map(c => c.text)
              .join('\n');
          } else if (typeof msg === 'string') {
            text = msg;
          }
          if (text) {
            messages.push({
              role: 'user',
              content: text,
              timestamp: obj.timestamp,
            });
          }
        } else if (obj.type === 'assistant') {
          const msg = obj.message || {};
          const content = msg.content || [];
          const parts = [];

          for (const block of content) {
            if (block.type === 'text') {
              parts.push({ type: 'text', text: block.text });
            } else if (block.type === 'tool_use') {
              parts.push({
                type: 'tool_use',
                name: block.name,
                input: block.input,
                id: block.id,
              });
            }
          }

          if (parts.length > 0) {
            messages.push({
              role: 'assistant',
              parts,
              timestamp: obj.timestamp,
            });
          }
        } else if (obj.type === 'tool_result' || (obj.type === 'user' && obj.message?.content?.some?.(c => c.type === 'tool_result'))) {
          // Tool results — extract relevant content
          const msg = obj.message || {};
          const content = msg.content || [];
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'tool_result') {
                messages.push({
                  role: 'tool_result',
                  toolUseId: block.tool_use_id,
                  content: typeof block.content === 'string'
                    ? block.content
                    : JSON.stringify(block.content),
                  isError: block.is_error || false,
                });
              }
            }
          }
        }
      } catch {
        // Skip malformed lines
      }
    });

    rl.on('close', () => resolve(messages));
    rl.on('error', reject);
  });
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
