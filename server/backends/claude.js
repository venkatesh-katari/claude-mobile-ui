// @ts-check

import { execFileSync } from 'node:child_process';
import {
  createReadStream,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';

/** @typedef {import('./types.js').BackendAdapter} BackendAdapter */
/** @typedef {import('./types.js').BackendDescriptor} BackendDescriptor */
/** @typedef {import('./types.js').NormalizedEvent} NormalizedEvent */
/** @typedef {import('./types.js').NormalizedMessage} NormalizedMessage */
/** @typedef {import('./types.js').SessionSummary} SessionSummary */
/** @typedef {import('./types.js').TurnRequest} TurnRequest */

const CLI_PERMISSION_MODES = new Set([
  'plan', 'acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk',
]);
const MODELS = [
  { value: 'claude-sonnet-5', label: 'Sonnet', description: 'Best balance of speed and quality' },
  { value: 'claude-opus-4-8', label: 'Opus', description: 'Most capable, slower' },
  { value: 'haiku', label: 'Haiku', description: 'Fastest for lighter tasks' },
];
const MODEL_IDS = new Set(MODELS.map(model => model.value));
const PERMISSION_MODES = [
  { value: 'plan', label: 'Plan', description: 'Read-only analysis; no changes' },
  { value: 'acceptEdits', label: 'Accept Edits', description: 'Approve file edits; deny shell commands' },
  { value: 'auto', label: 'Auto', description: 'Approve every action automatically' },
  { value: 'default', label: 'Default', description: 'Use the CLI default' },
  { value: 'bypassPermissions', label: 'Bypass', description: 'Skip permission checks' },
];

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

/** @param {string} content */
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  /** @type {Record<string, string>} */
  const frontmatter = {};
  const lines = match[1].split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const property = lines[index].match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (!property) continue;
    let value = property[2].trim();
    if (value === '|' || value === '>') {
      const blockLines = [];
      while (index + 1 < lines.length && /^\s+\S/.test(lines[index + 1])) {
        index += 1;
        blockLines.push(lines[index].replace(/^\s\s/, ''));
      }
      value = blockLines.join(value === '|' ? '\n' : ' ').trim();
    } else if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    frontmatter[property[1]] = value;
  }
  return frontmatter;
}

/** @param {string} directory @param {string} prefix */
function listSkillsInDir(directory, prefix) {
  if (!existsSync(directory)) return [];
  const skills = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillFile = join(directory, entry.name, 'SKILL.md');
    if (!existsSync(skillFile)) continue;
    try {
      const metadata = parseFrontmatter(readFileSync(skillFile, 'utf-8'));
      const name = metadata.name || entry.name;
      skills.push({
        invoke: prefix ? `${prefix}:${name}` : name,
        name,
        description: metadata.description || '',
      });
    } catch {
      // A malformed third-party skill must not break the entire picker.
    }
  }
  return skills;
}

/** @param {string} directory @param {string} prefix */
function listCommandsInDir(directory, prefix) {
  if (!existsSync(directory)) return [];
  const commands = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const name = entry.name.slice(0, -3);
    try {
      const metadata = parseFrontmatter(readFileSync(join(directory, entry.name), 'utf-8'));
      if (metadata['hide-from-slash-command-tool'] === 'true') continue;
      commands.push({
        invoke: prefix ? `${prefix}:${name}` : name,
        name,
        description: metadata.description || '',
        argumentHint: metadata['argument-hint'] || '',
      });
    } catch {
      // A malformed third-party command must not break the entire picker.
    }
  }
  return commands;
}

/**
 * Claude's print-mode stream contains both token deltas and completed
 * assistant messages. The parser suppresses completed text after deltas while
 * retaining tool blocks, so consumers never need Claude-specific de-dup logic.
 */
export class ClaudeEventParser {
  constructor() {
    this.hasStreamedText = false;
  }

  /** @param {string} rawLine @returns {NormalizedEvent[]} */
  parseLine(rawLine) {
    const line = rawLine.trim();
    if (!line) return [];
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return [];
    }

    if (event.type === 'stream_event') {
      const delta = event.event;
      if (delta?.type === 'content_block_delta' && delta.delta?.type === 'text_delta' && delta.delta.text) {
        this.hasStreamedText = true;
        return [{ type: 'text-delta', text: delta.delta.text }];
      }
      return [];
    }

    if (event.type === 'assistant') {
      const content = Array.isArray(event.message?.content) ? event.message.content : [];
      /** @type {NormalizedEvent[]} */
      const normalized = [];
      if (!this.hasStreamedText) {
        for (const block of content) {
          if (block.type === 'text' && block.text) normalized.push({ type: 'text-delta', text: block.text });
        }
      }
      for (const block of content) {
        if (block.type === 'tool_use' && block.name) {
          normalized.push({
            type: 'tool-use',
            id: block.id || `claude-tool-${normalized.length}`,
            name: block.name,
            input: block.input && typeof block.input === 'object' ? block.input : {},
            status: 'started',
          });
        }
      }
      this.hasStreamedText = false;
      return normalized;
    }

    if (event.type === 'result') {
      return [{
        type: 'turn-complete',
        sessionId: event.session_id,
        cost: event.total_cost_usd ? { usd: event.total_cost_usd } : undefined,
        durationMs: event.duration_ms,
      }];
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
 *   projectsDirectory?: string,
 *   ideDirectory?: string,
 *   command?: string,
 *   mobileEntrypoint?: string,
 *   cliVersion?: string,
 * }} [options]
 * @returns {BackendAdapter}
 */
export function createClaudeBackend(options = {}) {
  const homeDirectory = options.homeDirectory || homedir();
  const projectsDirectory = options.projectsDirectory || join(homeDirectory, '.claude', 'projects');
  const ideDirectory = options.ideDirectory || join(homeDirectory, '.claude', 'ide');
  const command = options.command || 'claude';
  const mobileEntrypoint = options.mobileEntrypoint || 'claude-mobile-ui';
  const cliVersion = options.cliVersion ?? readCliVersion(command);

  /** @type {any[] | null} */
  let pluginListCache = null;
  let pluginListCacheTimestamp = 0;

  function describe() {
    /** @type {BackendDescriptor} */
    const descriptor = {
      eventProtocolVersion: 1,
      id: 'claude',
      label: 'Claude Code',
      available: Boolean(cliVersion),
      cliVersion,
      capabilities: {
        conflictDetection: true,
        dollarCost: true,
        interactiveQuestions: true,
        partialTextStreaming: true,
        skillsPicker: true,
        toolUse: true,
      },
      defaultModel: 'claude-sonnet-5',
      defaultPermissionMode: 'plan',
      models: MODELS,
      permissionModes: PERMISSION_MODES,
    };
    if (!cliVersion) descriptor.unavailableReason = 'Claude Code CLI is not installed or not executable';
    return descriptor;
  }

  /** @param {TurnRequest} request */
  function buildSpawnSpec(request) {
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
    if (request.permissionMode && CLI_PERMISSION_MODES.has(request.permissionMode)) {
      args.push('--permission-mode', request.permissionMode);
    }
    if (request.model && MODEL_IDS.has(request.model)) args.push('--model', request.model);
    if (request.sessionId) args.push('--resume', request.sessionId);
    return {
      command,
      args,
      cwd: request.projectPath || homeDirectory,
      env: {
        ...process.env,
        ENABLE_SECURITY_REMINDER: '0',
        CLAUDE_CODE_ENTRYPOINT: mobileEntrypoint,
      },
      prompt: request.message,
    };
  }

  /** @param {string} projectDirectory @param {string} directoryName */
  function deriveCwdFromProjectDir(projectDirectory, directoryName) {
    try {
      const sessionFiles = readdirSync(projectDirectory).filter(file => file.endsWith('.jsonl'));
      for (const file of sessionFiles) {
        const content = readFileSync(join(projectDirectory, file), 'utf-8');
        for (const line of content.split('\n')) {
          if (!line.trim()) continue;
          try {
            const record = JSON.parse(line);
            if (record.cwd) return record.cwd;
          } catch {
            // Continue scanning a partially-written session.
          }
        }
      }
    } catch {
      // Fall back to the legacy lossy decoder below.
    }
    return directoryName.replace(/^-/, '/').replace(/-/g, '/');
  }

  /** @param {string} filePath */
  function deriveSessionSummary(filePath) {
    const lines = readFileSync(filePath, 'utf-8').split('\n');
    let aiTitle = '';
    let firstPrompt = '';
    let messageCount = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (record.type === 'ai-title' && record.aiTitle && !aiTitle) aiTitle = record.aiTitle;
      if (record.type === 'user' && !firstPrompt) {
        const content = record.message?.content;
        const text = typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content.filter(block => block.type === 'text').map(block => block.text).join('\n')
            : '';
        if (text) firstPrompt = text.trim().slice(0, 100);
      }
      if (record.type === 'user' || record.type === 'assistant') messageCount += 1;
    }
    return { summary: aiTitle || firstPrompt || '(no title)', firstPrompt, messageCount };
  }

  /** @param {string} directoryName */
  function getProjectInfo(directoryName) {
    const projectDirectory = join(projectsDirectory, directoryName);
    const indexPath = join(projectDirectory, 'sessions-index.json');
    let sessionCount = 0;
    let originalPath = '';
    if (existsSync(indexPath)) {
      try {
        const index = JSON.parse(readFileSync(indexPath, 'utf-8'));
        sessionCount = Array.isArray(index.entries) ? index.entries.length : 0;
        originalPath = index.originalPath || '';
      } catch {
        // Fall back to session files.
      }
    }
    if (sessionCount === 0) {
      try { sessionCount = readdirSync(projectDirectory).filter(file => file.endsWith('.jsonl')).length; } catch {}
    }
    if (!originalPath) originalPath = deriveCwdFromProjectDir(projectDirectory, directoryName);
    return { backend: /** @type {const} */ ('claude'), id: directoryName, originalPath, sessionCount };
  }

  function listProjects() {
    if (!existsSync(projectsDirectory)) return [];
    return readdirSync(projectsDirectory, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => getProjectInfo(entry.name))
      .filter(project => project.sessionCount > 0)
      .sort((left, right) => right.sessionCount - left.sessionCount);
  }

  /** @param {string} projectId */
  function projectDirectoryFor(projectId) {
    if (!projectId || projectId === '.' || projectId === '..' || basename(projectId) !== projectId) {
      throw new Error('Invalid Claude project id');
    }
    return join(projectsDirectory, projectId);
  }

  /** @param {string} projectId @returns {SessionSummary[]} */
  function listSessions(projectId) {
    const projectDirectory = projectDirectoryFor(projectId);
    const indexPath = join(projectDirectory, 'sessions-index.json');
    /** @type {SessionSummary[]} */
    let sessions = [];
    let originalPath = '';
    if (existsSync(indexPath)) {
      try {
        const index = JSON.parse(readFileSync(indexPath, 'utf-8'));
        originalPath = index.originalPath || '';
        sessions = (index.entries || []).map((/** @type {any} */ entry) => ({
          backend: 'claude',
          sessionId: entry.sessionId,
          summary: entry.summary || entry.firstPrompt || '(no title)',
          firstPrompt: entry.firstPrompt || '',
          messageCount: entry.messageCount || 0,
          created: entry.created,
          modified: entry.modified,
          gitBranch: entry.gitBranch || '',
          projectPath: entry.projectPath || index.originalPath || '',
        }));
      } catch {
        // Discover from JSONL below.
      }
    }
    if (existsSync(projectDirectory)) {
      const indexedIds = new Set(sessions.map(session => session.sessionId));
      for (const file of readdirSync(projectDirectory).filter(name => name.endsWith('.jsonl'))) {
        const sessionId = file.slice(0, -'.jsonl'.length);
        if (indexedIds.has(sessionId)) continue;
        const filePath = join(projectDirectory, file);
        try {
          const stats = statSync(filePath);
          const summary = deriveSessionSummary(filePath);
          sessions.push({
            backend: 'claude',
            sessionId,
            summary: summary.summary,
            firstPrompt: summary.firstPrompt || summary.summary,
            messageCount: summary.messageCount,
            created: stats.birthtime.toISOString(),
            modified: stats.mtime.toISOString(),
            gitBranch: '',
            projectPath: originalPath || deriveCwdFromProjectDir(projectDirectory, projectId),
          });
        } catch {
          // A single corrupt/in-flight session should not hide the project.
        }
      }
    }
    const overrides = readTitleOverrides(projectDirectory);
    for (const session of sessions) {
      if (overrides[session.sessionId]) session.summary = overrides[session.sessionId];
    }
    return sessions.sort((left, right) => Date.parse(right.modified || '') - Date.parse(left.modified || ''));
  }

  /** @param {string} sessionId */
  function findSessionFile(sessionId) {
    if (!sessionId || basename(sessionId) !== sessionId || !existsSync(projectsDirectory)) return null;
    for (const entry of readdirSync(projectsDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = join(projectsDirectory, entry.name, `${sessionId}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }

  /** @param {string} projectDirectory */
  function readTitleOverrides(projectDirectory) {
    const filePath = join(projectDirectory, 'title-overrides.json');
    if (!existsSync(filePath)) return {};
    try { return JSON.parse(readFileSync(filePath, 'utf-8')); } catch { return {}; }
  }

  /** @param {string} projectDirectory @param {Record<string, string>} overrides */
  function writeTitleOverrides(projectDirectory, overrides) {
    writeFileSync(join(projectDirectory, 'title-overrides.json'), JSON.stringify(overrides, null, 2), 'utf-8');
  }

  /** @param {string} sessionId @param {string} summary */
  function renameSession(sessionId, summary) {
    if (!sessionId || basename(sessionId) !== sessionId) return false;
    if (!existsSync(projectsDirectory)) return false;
    for (const project of readdirSync(projectsDirectory, { withFileTypes: true }).filter(entry => entry.isDirectory())) {
      const projectDirectory = join(projectsDirectory, project.name);
      const sessionFile = join(projectDirectory, `${sessionId}.jsonl`);
      const indexPath = join(projectDirectory, 'sessions-index.json');
      if (existsSync(indexPath)) {
        try {
          const index = JSON.parse(readFileSync(indexPath, 'utf-8'));
          const entry = (index.entries || []).find((/** @type {any} */ candidate) => candidate.sessionId === sessionId);
          if (entry) {
            entry.summary = summary.trim();
            writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf-8');
            return true;
          }
        } catch {
          // Use the sidecar when the CLI index is malformed.
        }
      }
      if (existsSync(sessionFile)) {
        const overrides = readTitleOverrides(projectDirectory);
        overrides[sessionId] = summary.trim();
        writeTitleOverrides(projectDirectory, overrides);
        return true;
      }
    }
    return false;
  }

  /** @param {string} sessionId @param {string} summary */
  function saveInitialTitle(sessionId, summary) {
    renameSession(sessionId, summary.trim().slice(0, 80).replace(/\n/g, ' '));
  }

  /** @param {string} sessionId @returns {Promise<NormalizedMessage[]>} */
  async function readSessionMessages(sessionId) {
    const filePath = findSessionFile(sessionId);
    if (!filePath) throw new SessionNotFoundError(sessionId);
    return new Promise((resolve, reject) => {
      /** @type {NormalizedMessage[]} */
      const messages = [];
      const reader = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
      reader.on('line', line => {
        if (!line.trim()) return;
        let record;
        try { record = JSON.parse(line); } catch { return; }
        if (record.type === 'user') {
          const content = record.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'tool_result') {
                messages.push({
                  role: 'tool_result',
                  toolUseId: block.tool_use_id,
                  content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
                  isError: Boolean(block.is_error),
                });
              }
            }
          }
          const text = typeof content === 'string'
            ? content
            : Array.isArray(content)
              ? content.filter(block => block.type === 'text').map(block => block.text).join('\n')
              : typeof record.message === 'string' ? record.message : '';
          if (text) messages.push({ role: 'user', content: text, timestamp: record.timestamp });
          return;
        }
        if (record.type !== 'assistant') return;
        /** @type {import('./types.js').MessagePart[]} */
        const parts = [];
        for (const block of Array.isArray(record.message?.content) ? record.message.content : []) {
          if (block.type === 'text' && block.text) parts.push({ type: 'text', text: block.text });
          if (block.type === 'tool_use') {
            parts.push({ type: 'tool_use', name: block.name, input: block.input || {}, id: block.id });
          }
        }
        if (parts.length) messages.push({ role: 'assistant', parts, timestamp: record.timestamp });
      });
      reader.on('close', () => resolve(messages));
      reader.on('error', reject);
    });
  }

  function listDirectories() {
    return [...new Set(listProjects().map(project => project.originalPath).filter(Boolean))].sort();
  }

  /** @returns {any[]} */
  function getEnabledPlugins() {
    const now = Date.now();
    if (pluginListCache && now - pluginListCacheTimestamp < 5 * 60_000) return pluginListCache;
    try {
      const output = execFileSync(command, ['plugin', 'list', '--json'], {
        encoding: 'utf-8',
        timeout: 5_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      pluginListCache = JSON.parse(output).filter((/** @type {any} */ plugin) => plugin.enabled);
      pluginListCacheTimestamp = now;
    } catch {
      pluginListCache ||= [];
    }
    return pluginListCache || [];
  }

  /** @param {string} projectPath */
  function listSlashItems(projectPath) {
    const skills = [];
    const commands = [];
    if (projectPath) {
      skills.push(...listSkillsInDir(join(projectPath, '.claude', 'skills'), ''));
      commands.push(...listCommandsInDir(join(projectPath, '.claude', 'commands'), ''));
    }
    skills.push(...listSkillsInDir(join(homeDirectory, '.claude', 'skills'), ''));
    commands.push(...listCommandsInDir(join(homeDirectory, '.claude', 'commands'), ''));
    for (const plugin of getEnabledPlugins()) {
      const pluginName = plugin.id.split('@')[0];
      skills.push(...listSkillsInDir(join(plugin.installPath, 'skills'), pluginName));
      commands.push(...listCommandsInDir(join(plugin.installPath, 'commands'), pluginName));
    }
    return { skills, commands };
  }

  /** @param {string} filePath */
  function getSessionOrigin(filePath) {
    let cwd = '';
    let lastEntrypoint = '';
    for (const line of readFileSync(filePath, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (record.cwd && !cwd) cwd = record.cwd;
      if (record.type === 'user' && record.entrypoint) lastEntrypoint = record.entrypoint;
    }
    return { cwd, lastEntrypoint };
  }

  /** @param {string} cwd */
  function isDesktopLiveForCwd(cwd) {
    if (!cwd || !existsSync(ideDirectory)) return false;
    let lockFiles;
    try { lockFiles = readdirSync(ideDirectory).filter(file => file.endsWith('.lock')); } catch { return false; }
    for (const file of lockFiles) {
      try {
        const lock = JSON.parse(readFileSync(join(ideDirectory, file), 'utf-8'));
        if (!lock.pid || !Array.isArray(lock.workspaceFolders)) continue;
        const matches = lock.workspaceFolders.some((/** @type {string} */ folder) => folder === cwd || cwd.startsWith(`${folder}/`));
        if (!matches) continue;
        try { process.kill(lock.pid, 0); return true; } catch { /* stale lock */ }
      } catch {
        // Ignore malformed or concurrently-removed lock files.
      }
    }
    return false;
  }

  /** @param {string} sessionId */
  function checkConflict(sessionId) {
    const filePath = findSessionFile(sessionId);
    if (!filePath) return { conflict: false, reason: null };
    const origin = getSessionOrigin(filePath);
    if (origin.lastEntrypoint === mobileEntrypoint) return { conflict: false, reason: null };
    const conflict = isDesktopLiveForCwd(origin.cwd);
    return { conflict, reason: conflict ? 'desktop-live' : null };
  }

  return {
    id: 'claude',
    describe,
    buildSpawnSpec,
    createEventParser: () => new ClaudeEventParser(),
    listProjects,
    listSessions,
    readSessionMessages,
    renameSession,
    saveInitialTitle,
    listDirectories,
    listSlashItems,
    checkConflict,
  };
}

export class SessionNotFoundError extends Error {
  /** @param {string} sessionId */
  constructor(sessionId) {
    super(`Session file not found: ${sessionId}`);
    this.name = 'SessionNotFoundError';
  }
}
