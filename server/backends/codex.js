// @ts-check

import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import { SessionNotFoundError } from './claude.js';

/** @typedef {import('./types.js').BackendAdapter} BackendAdapter */
/** @typedef {import('./types.js').BackendDescriptor} BackendDescriptor */
/** @typedef {import('./types.js').BackendOption} BackendOption */
/** @typedef {import('./types.js').NormalizedEvent} NormalizedEvent */
/** @typedef {import('./types.js').NormalizedMessage} NormalizedMessage */
/** @typedef {import('./types.js').SessionSummary} SessionSummary */
/** @typedef {import('./types.js').TokenUsage} TokenUsage */
/** @typedef {import('./types.js').TurnRequest} TurnRequest */
/** @typedef {{ sessionId: string, projectPath: string, filePath: string, created: string, modified: string, modifiedMs: number, gitBranch: string }} CodexCatalogEntry */
/** @typedef {{ slug?: unknown, display_name?: unknown, description?: unknown, visibility?: unknown, priority?: unknown }} RawCodexModel */

const CATALOG_TTL_MS = 5_000;
const PERMISSION_MODES = [
  { value: 'read-only', label: 'Read only', description: 'Allow inspection without workspace edits' },
  { value: 'workspace-write', label: 'Workspace write', description: 'Allow edits within the working directory' },
  { value: 'approve-for-me', label: 'Auto review', description: 'Automatically review approvals in a workspace-write sandbox' },
];
const DEFAULT_MODEL = {
  value: 'default',
  label: 'Codex configuration',
  description: 'Use the model selected in Codex settings',
};

/** @param {string} command */
function readCliVersion(command) {
  try {
    return execFileSync(command, ['--version'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
    }).trim();
  } catch {
    return '';
  }
}

/**
 * `codex debug models` is the same catalog used by the interactive selector.
 * Prefer its refreshed, account-aware result and fall back to the catalog
 * bundled with the installed binary when refresh or authentication fails.
 *
 * @param {string} command
 * @returns {BackendOption[]}
 */
function readModelCatalog(command) {
  for (const args of [['debug', 'models'], ['debug', 'models', '--bundled']]) {
    try {
      const output = execFileSync(command, args, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5_000,
        maxBuffer: 2 * 1024 * 1024,
      });
      const payload = JSON.parse(output);
      if (!Array.isArray(payload.models)) continue;
      const catalog = /** @type {RawCodexModel[]} */ (payload.models);
      const seen = new Set();
      const models = catalog
        .filter((model) => model?.visibility === 'list' && typeof model.slug === 'string' && model.slug)
        .sort((left, right) => {
          const leftPriority = typeof left.priority === 'number' ? left.priority : Number.MAX_SAFE_INTEGER;
          const rightPriority = typeof right.priority === 'number' ? right.priority : Number.MAX_SAFE_INTEGER;
          return leftPriority - rightPriority;
        })
        .filter((model) => {
          if (seen.has(model.slug)) return false;
          seen.add(model.slug);
          return true;
        })
        .map((model) => ({
          value: /** @type {string} */ (model.slug),
          label: stringValue(model.display_name) || /** @type {string} */ (model.slug),
          description: stringValue(model.description),
        }));
      if (models.length > 0) return [DEFAULT_MODEL, ...models];
    } catch {
      // Older CLIs may not expose this debug command. The default option below
      // remains valid because it delegates model selection back to Codex.
    }
  }
  return [DEFAULT_MODEL];
}

/**
 * Rollout metadata is always the first JSONL record. Reading only that record
 * keeps project discovery proportional to session count rather than total
 * conversation history size.
 *
 * @param {string} filePath
 */
function readFirstLine(filePath) {
  const descriptor = openSync(filePath, 'r');
  const chunks = [];
  const chunkSize = 64 * 1024;
  let total = 0;
  try {
    while (total < 2 * 1024 * 1024) {
      const chunk = Buffer.allocUnsafe(chunkSize);
      const bytesRead = readSync(descriptor, chunk, 0, chunk.length, total);
      if (bytesRead === 0) break;
      const slice = chunk.subarray(0, bytesRead);
      const newline = slice.indexOf(0x0a);
      if (newline >= 0) {
        chunks.push(slice.subarray(0, newline));
        return Buffer.concat(chunks).toString('utf-8');
      }
      chunks.push(slice);
      total += bytesRead;
    }
    return Buffer.concat(chunks).toString('utf-8');
  } finally {
    closeSync(descriptor);
  }
}

/** @param {unknown} value @returns {Record<string, any>} */
function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/** @param {unknown} value */
function stringValue(value) {
  return typeof value === 'string' ? value : '';
}

/** @param {unknown} value */
function serializedValue(value) {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

/** @param {string} text */
function isInjectedContext(text) {
  const trimmed = text.trimStart();
  return trimmed.startsWith('<environment_context>')
    || trimmed.startsWith('<recommended_plugins>')
    || trimmed.startsWith('<permissions ')
    || trimmed.startsWith('<skills_instructions>')
    || trimmed.startsWith('<apps_instructions>')
    || trimmed.startsWith('<plugins_instructions>');
}

/** @param {unknown} content */
function extractMessageText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter(part => part?.type === 'input_text' || part?.type === 'output_text')
    .map(part => stringValue(part.text))
    .filter(text => text && !isInjectedContext(text))
    .join('\n');
}

/** @param {unknown} value @returns {Record<string, any>} */
function parseToolInput(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return objectValue(parsed);
  } catch {
    return { value };
  }
}

/** @param {string} type */
function toolNameFor(type) {
  switch (type) {
    case 'command_execution': return 'Bash';
    case 'file_change': return 'Edit';
    case 'web_search': return 'WebSearch';
    case 'mcp_tool_call': return 'MCP';
    default: return type || 'Tool';
  }
}

/** @param {Record<string, any>} item */
function normalizeStreamTool(item) {
  if (!item?.type || !item.id) return null;
  if (item.type === 'command_execution') {
    return {
      id: item.id,
      name: 'Bash',
      input: { command: stringValue(item.command) },
      output: stringValue(item.aggregated_output),
      isError: typeof item.exit_code === 'number' && item.exit_code !== 0,
    };
  }
  if (item.type === 'file_change') {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    return {
      id: item.id,
      name: 'Edit',
      input: {
        file_path: stringValue(changes[0]?.path),
        changes,
      },
    };
  }
  if (item.type === 'mcp_tool_call' || item.type === 'web_search') {
    return {
      id: item.id,
      name: item.name || toolNameFor(item.type),
      input: objectValue(item.arguments || item.input || item.query),
      output: stringValue(item.result || item.output),
      isError: item.status === 'failed',
    };
  }
  return null;
}

/** @param {Record<string, any>} usage @returns {TokenUsage} */
function normalizeUsage(usage) {
  return {
    inputTokens: usage.input_tokens,
    cachedInputTokens: usage.cached_input_tokens,
    cacheWriteInputTokens: usage.cache_write_input_tokens,
    outputTokens: usage.output_tokens,
    reasoningOutputTokens: usage.reasoning_output_tokens,
  };
}

export class CodexEventParser {
  /** @param {string} rawLine @returns {NormalizedEvent[]} */
  parseLine(rawLine) {
    const line = rawLine.trim();
    if (!line) return [];
    let event;
    try { event = JSON.parse(line); } catch { return []; }

    if (event.type === 'thread.started' && event.thread_id) {
      return [{ type: 'session-started', sessionId: event.thread_id }];
    }
    if ((event.type === 'item.started' || event.type === 'item.completed') && event.item) {
      const item = event.item;
      if (event.type === 'item.completed' && item.type === 'agent_message' && item.text) {
        return [{ type: 'text-delta', text: item.text }];
      }
      if (event.type === 'item.completed' && item.type === 'error') {
        const message = stringValue(item.message) || 'Codex reported an unknown error';
        const isPolicyFallback = /disallowed by requirements|falling back to required value/i.test(message);
        return [{ type: isPolicyFallback ? 'warning' : 'error', message }];
      }
      const tool = normalizeStreamTool(item);
      if (tool) {
        const failed = tool.isError || item.status === 'failed';
        return [{
          type: 'tool-use',
          ...tool,
          status: event.type === 'item.started' ? 'started' : failed ? 'failed' : 'completed',
        }];
      }
      return [];
    }
    if (event.type === 'turn.completed') {
      return [{ type: 'turn-complete', cost: { tokens: normalizeUsage(objectValue(event.usage)) } }];
    }
    if (event.type === 'turn.failed') {
      return [{ type: 'error', message: event.error?.message || event.message || 'Codex turn failed' }];
    }
    if (event.type === 'error') {
      return [{ type: 'error', message: event.message || 'Codex process error' }];
    }
    return [];
  }

  /** @param {string} rawRemainder @returns {NormalizedEvent[]} */
  flush(rawRemainder) {
    return this.parseLine(rawRemainder);
  }
}

/**
 * @param {{
 *   homeDirectory?: string,
 *   sessionsDirectory?: string,
 *   sessionIndexPath?: string,
 *   titleOverridesPath?: string,
 *   command?: string,
 *   cliVersion?: string,
 *   enabled?: boolean,
 *   models?: BackendOption[],
 * }} [options]
 * @returns {BackendAdapter}
 */
export function createCodexBackend(options = {}) {
  const homeDirectory = options.homeDirectory || homedir();
  const sessionsDirectory = options.sessionsDirectory || join(homeDirectory, '.codex', 'sessions');
  const sessionIndexPath = options.sessionIndexPath || join(homeDirectory, '.codex', 'session_index.jsonl');
  const titleOverridesPath = options.titleOverridesPath || join(homeDirectory, '.codex', 'claude-mobile-ui-title-overrides.json');
  const command = options.command || 'codex';
  const enabled = options.enabled ?? process.env.CODEX_ENABLED !== '0';
  const cliVersion = enabled ? options.cliVersion ?? readCliVersion(command) : '';
  const models = enabled && cliVersion ? options.models ?? readModelCatalog(command) : [DEFAULT_MODEL];
  const modelIds = new Set(models.map(model => model.value));

  /** @type {{ timestamp: number, sessions: any[] } | null} */
  let catalogCache = null;
  /** @type {Map<string, { modifiedMs: number, value: { summary: string, firstPrompt: string, messageCount: number } }>} */
  const summaryCache = new Map();

  function describe() {
    /** @type {BackendDescriptor} */
    const descriptor = {
      eventProtocolVersion: 1,
      id: 'codex',
      label: 'Codex CLI',
      available: enabled && Boolean(cliVersion),
      cliVersion,
      capabilities: {
        conflictDetection: false,
        dollarCost: false,
        interactiveQuestions: false,
        partialTextStreaming: false,
        skillsPicker: false,
        toolUse: true,
      },
      defaultModel: 'default',
      defaultPermissionMode: 'read-only',
      models,
      permissionModes: PERMISSION_MODES,
    };
    if (!enabled) descriptor.unavailableReason = 'Codex support is disabled by CODEX_ENABLED=0';
    else if (!cliVersion) descriptor.unavailableReason = 'Codex CLI is not installed or not executable';
    return descriptor;
  }

  /** @param {TurnRequest} request */
  function buildSpawnSpec(request) {
    const args = ['exec', '--json', '--skip-git-repo-check'];
    if (request.permissionMode === 'approve-for-me') args.push('--approve-for-me');
    else if (request.permissionMode === 'workspace-write') args.push('--sandbox', 'workspace-write');
    else args.push('--sandbox', 'read-only');
    if (request.model && request.model !== 'default' && modelIds.has(request.model)) {
      args.push('--model', request.model);
    }
    if (request.sessionId) {
      args.push('resume', request.sessionId, '-');
    } else {
      args.push('--thread-source', 'claude-mobile-ui', '-');
    }
    return {
      command,
      args,
      cwd: request.projectPath || homeDirectory,
      env: { ...process.env },
      prompt: request.message,
    };
  }

  /** @param {string} directory @param {string[]} output */
  function collectSessionFiles(directory, output) {
    if (!existsSync(directory)) return;
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) collectSessionFiles(path, output);
      else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) output.push(path);
    }
  }

  function readThreadNames() {
    /** @type {Map<string, string>} */
    const names = new Map();
    if (!existsSync(sessionIndexPath)) return names;
    try {
      for (const line of readFileSync(sessionIndexPath, 'utf-8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.id && entry.thread_name) names.set(entry.id, entry.thread_name);
        } catch {
          // The append-only index may have a partially-written final line.
        }
      }
    } catch {
      // Session discovery still works without the optional title index.
    }
    return names;
  }

  function readTitleOverrides() {
    if (!existsSync(titleOverridesPath)) return {};
    try { return JSON.parse(readFileSync(titleOverridesPath, 'utf-8')); } catch { return {}; }
  }

  function buildCatalog() {
    if (!enabled || !existsSync(sessionsDirectory)) return [];
    /** @type {string[]} */
    const files = [];
    collectSessionFiles(sessionsDirectory, files);
    /** @type {CodexCatalogEntry[]} */
    const sessions = [];
    for (const filePath of files) {
      try {
        const firstLine = readFirstLine(filePath);
        if (!firstLine) continue;
        const record = JSON.parse(firstLine);
        if (record.type !== 'session_meta') continue;
        const metadata = objectValue(record.payload);
        const sessionId = stringValue(metadata.id || metadata.session_id);
        const cwd = stringValue(metadata.cwd);
        if (!sessionId || !cwd) continue;
        const stats = statSync(filePath);
        sessions.push({
          sessionId,
          projectPath: cwd,
          filePath,
          created: stringValue(record.timestamp || metadata.timestamp) || stats.birthtime.toISOString(),
          modified: stats.mtime.toISOString(),
          modifiedMs: stats.mtimeMs,
          gitBranch: stringValue(metadata.git?.branch),
        });
      } catch {
        // Ignore corrupt or concurrently-written rollout files individually.
      }
    }
    return sessions;
  }

  function getCatalog() {
    if (catalogCache && Date.now() - catalogCache.timestamp < CATALOG_TTL_MS) return catalogCache.sessions;
    const sessions = buildCatalog();
    catalogCache = { timestamp: Date.now(), sessions };
    return sessions;
  }

  /** @param {string} projectPath */
  function encodeProjectId(projectPath) {
    return Buffer.from(projectPath, 'utf-8').toString('base64url');
  }

  /** @param {string} projectId */
  function decodeProjectId(projectId) {
    if (!projectId || basename(projectId) !== projectId) throw new Error('Invalid Codex project id');
    try { return Buffer.from(projectId, 'base64url').toString('utf-8'); } catch { throw new Error('Invalid Codex project id'); }
  }

  function listProjects() {
    /** @type {Map<string, number>} */
    const counts = new Map();
    for (const session of getCatalog()) counts.set(session.projectPath, (counts.get(session.projectPath) || 0) + 1);
    return [...counts.entries()]
      .map(([originalPath, sessionCount]) => ({
        backend: /** @type {const} */ ('codex'),
        id: encodeProjectId(originalPath),
        originalPath,
        sessionCount,
      }))
      .sort((left, right) => right.sessionCount - left.sessionCount || left.originalPath.localeCompare(right.originalPath));
  }

  /** @param {string} filePath @param {number} modifiedMs */
  function deriveSessionSummary(filePath, modifiedMs) {
    const cached = summaryCache.get(filePath);
    if (cached?.modifiedMs === modifiedMs) return cached.value;
    let firstPrompt = '';
    let messageCount = 0;
    for (const line of readFileSync(filePath, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (record.type !== 'response_item') continue;
      const payload = objectValue(record.payload);
      if (payload.type !== 'message') continue;
      if (payload.role === 'user') {
        const text = extractMessageText(payload.content);
        if (text) {
          messageCount += 1;
          if (!firstPrompt) firstPrompt = text.trim().slice(0, 100);
        }
      } else if (payload.role === 'assistant' && extractMessageText(payload.content)) {
        messageCount += 1;
      }
    }
    const value = { summary: firstPrompt || '(no title)', firstPrompt, messageCount };
    summaryCache.set(filePath, { modifiedMs, value });
    return value;
  }

  /** @param {string} projectId @returns {SessionSummary[]} */
  function listSessions(projectId) {
    const projectPath = decodeProjectId(projectId);
    const titles = readThreadNames();
    const overrides = readTitleOverrides();
    return getCatalog()
      .filter(session => session.projectPath === projectPath)
      .map(session => {
        const derived = deriveSessionSummary(session.filePath, session.modifiedMs);
        return {
          backend: /** @type {const} */ ('codex'),
          sessionId: session.sessionId,
          summary: overrides[session.sessionId] || titles.get(session.sessionId) || derived.summary,
          firstPrompt: derived.firstPrompt,
          messageCount: derived.messageCount,
          created: session.created,
          modified: session.modified,
          gitBranch: session.gitBranch,
          projectPath: session.projectPath,
        };
      })
      .sort((left, right) => Date.parse(right.modified || '') - Date.parse(left.modified || ''));
  }

  /** @param {string} sessionId */
  function findSession(sessionId, refresh = false) {
    if (refresh) catalogCache = null;
    return getCatalog().find(session => session.sessionId === sessionId) || null;
  }

  /** @param {string} sessionId @returns {Promise<NormalizedMessage[]>} */
  async function readSessionMessages(sessionId) {
    const session = findSession(sessionId);
    if (!session) throw new SessionNotFoundError(sessionId);
    /** @type {NormalizedMessage[]} */
    const messages = [];
    /** @type {{ role: 'assistant', parts: any[], timestamp?: string } | null} */
    let currentAssistant = null;
    /** @param {string | undefined} timestamp */
    const ensureAssistant = timestamp => {
      if (!currentAssistant) {
        currentAssistant = { role: 'assistant', parts: [], timestamp };
        messages.push(currentAssistant);
      }
      return currentAssistant;
    };

    for (const line of readFileSync(session.filePath, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (record.type !== 'response_item') continue;
      const payload = objectValue(record.payload);
      if (payload.type === 'message') {
        const text = extractMessageText(payload.content);
        if (!text) continue;
        if (payload.role === 'user') {
          currentAssistant = null;
          messages.push({ role: 'user', content: text, timestamp: record.timestamp });
        } else if (payload.role === 'assistant') {
          ensureAssistant(record.timestamp).parts.push({ type: 'text', text });
        }
        continue;
      }
      if (payload.type === 'agent_message' && payload.text) {
        ensureAssistant(record.timestamp).parts.push({ type: 'text', text: payload.text });
        continue;
      }
      if (payload.type === 'custom_tool_call' || payload.type === 'function_call') {
        const callId = stringValue(payload.call_id || payload.id);
        const input = parseToolInput(payload.input ?? payload.arguments);
        const rawName = stringValue(payload.name);
        const name = rawName === 'exec' || rawName === 'exec_command' ? 'Bash' : rawName || 'Tool';
        const normalizedInput = name === 'Bash' && input.cmd ? { ...input, command: input.cmd } : input;
        ensureAssistant(record.timestamp).parts.push({
          type: 'tool_use',
          id: callId,
          name,
          input: normalizedInput,
          status: 'completed',
        });
        continue;
      }
      if (payload.type === 'custom_tool_call_output' || payload.type === 'function_call_output') {
        const callId = stringValue(payload.call_id || payload.id);
        messages.push({
          role: 'tool_result',
          toolUseId: callId,
          content: serializedValue(payload.output),
          isError: false,
        });
        currentAssistant = null;
      }
    }
    return messages.filter(message => message.role !== 'assistant' || message.parts.length > 0);
  }

  /** @param {string} sessionId @param {string} summary */
  function renameSession(sessionId, summary) {
    if (!findSession(sessionId, true)) return false;
    const overrides = readTitleOverrides();
    overrides[sessionId] = summary.trim();
    writeFileSync(titleOverridesPath, JSON.stringify(overrides, null, 2), 'utf-8');
    return true;
  }

  /** @param {string} sessionId @param {string} summary */
  function saveInitialTitle(sessionId, summary) {
    catalogCache = null;
    renameSession(sessionId, summary.trim().slice(0, 80).replace(/\n/g, ' '));
  }

  function listDirectories() {
    return [...new Set(getCatalog().map(session => session.projectPath).filter(Boolean))].sort();
  }

  return {
    id: 'codex',
    describe,
    buildSpawnSpec,
    createEventParser: () => new CodexEventParser(),
    listProjects,
    listSessions,
    readSessionMessages,
    renameSession,
    saveInitialTitle,
    listDirectories,
    listSlashItems: () => ({ skills: [], commands: [] }),
    checkConflict: () => ({ conflict: false, reason: null }),
  };
}
