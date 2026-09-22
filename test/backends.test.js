import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createClaudeBackend, ClaudeEventParser } from '../server/backends/claude.js';
import { createCodexBackend, CodexEventParser } from '../server/backends/codex.js';
import { appendTextDelta, completeTurn, upsertToolEvent } from '../src/chat/events.js';

function parseFixture(Parser, name) {
  const parser = new Parser();
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf-8')
    .trim()
    .split('\n')
    .flatMap(line => parser.parseLine(line));
}

test('Claude parser normalizes deltas, tools, and completion without duplicate text', () => {
  const events = parseFixture(ClaudeEventParser, 'claude/stream.jsonl');
  assert.deepEqual(events, [
    { type: 'text-delta', text: 'Hello' },
    {
      type: 'tool-use',
      id: 'tool-1',
      name: 'Read',
      input: { file_path: 'README.md' },
      status: 'started',
    },
    {
      type: 'turn-complete',
      sessionId: 'claude-session',
      cost: { usd: 0.0123 },
      durationMs: 1200,
    },
  ]);
});

test('Codex parser maps chunked messages, lifecycle tools, policy warnings, and token usage', () => {
  const events = parseFixture(CodexEventParser, 'codex/stream.jsonl');
  assert.equal(events[0].type, 'session-started');
  assert.equal(events[1].type, 'warning');
  assert.deepEqual(events[2], { type: 'text-delta', text: 'Working on it.' });
  assert.deepEqual(events[3], {
    type: 'tool-use',
    id: 'item-2',
    name: 'Bash',
    input: { command: 'pwd' },
    output: '',
    isError: false,
    status: 'started',
  });
  assert.equal(events[4].status, 'completed');
  assert.equal(events[4].output, '/tmp/project\n');
  assert.deepEqual(events.at(-1), {
    type: 'turn-complete',
    cost: {
      tokens: {
        inputTokens: 100,
        cachedInputTokens: 40,
        cacheWriteInputTokens: 0,
        outputTokens: 25,
        reasoningOutputTokens: 5,
      },
    },
  });
});

test('stream reducer preserves text around a tool and updates the tool in place', () => {
  let messages = [];
  messages = appendTextDelta(messages, 'Before');
  messages = upsertToolEvent(messages, {
    id: 'tool-1', name: 'Bash', input: { command: 'pwd' }, status: 'started',
  });
  messages = upsertToolEvent(messages, {
    id: 'tool-1', name: 'Bash', input: { command: 'pwd' }, output: '/tmp', status: 'completed',
  });
  messages = appendTextDelta(messages, 'After');
  messages = completeTurn(messages, { cost: { tokens: { inputTokens: 10, outputTokens: 5 } } });

  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0].parts.map(part => part.type), ['text', 'tool_use', 'text']);
  assert.equal(messages[0].parts[1].output, '/tmp');
  assert.equal(messages[0]._streaming, false);
  assert.deepEqual(messages[0].tokens, { inputTokens: 10, outputTokens: 5 });
});

test('Claude adapter preserves invocation and parses tool results from user records', async t => {
  const root = mkdtempSync(join(tmpdir(), 'claude-adapter-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projectsDirectory = join(root, '.claude', 'projects');
  const projectDirectory = join(projectsDirectory, '-tmp-project');
  mkdirSync(projectDirectory, { recursive: true });
  writeFileSync(join(projectDirectory, 'session-1.jsonl'), [
    JSON.stringify({ type: 'user', cwd: '/tmp/project', timestamp: '2026-01-01T00:00:00Z', message: { content: 'Question' } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:00:01Z', message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'a.ts' } }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] } }),
  ].join('\n'));
  const backend = createClaudeBackend({ homeDirectory: root, projectsDirectory, cliVersion: 'test' });
  const spec = backend.buildSpawnSpec({ message: 'Question', projectPath: '/tmp/project', permissionMode: 'default', model: 'haiku' });
  assert.deepEqual(spec.args, ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--model', 'haiku']);
  assert.equal(backend.listProjects()[0].backend, 'claude');
  const messages = await backend.readSessionMessages('session-1');
  assert.equal(messages.find(message => message.role === 'tool_result')?.content, 'ok');
});

test('Codex adapter discovers projects and excludes injected context from history', async t => {
  const root = mkdtempSync(join(tmpdir(), 'codex-adapter-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sessionsDirectory = join(root, '.codex', 'sessions');
  const dayDirectory = join(sessionsDirectory, '2026', '09', '11');
  mkdirSync(dayDirectory, { recursive: true });
  const sessionId = 'codex-session';
  writeFileSync(join(dayDirectory, `rollout-${sessionId}.jsonl`), [
    JSON.stringify({ type: 'session_meta', timestamp: '2026-09-11T00:00:00Z', payload: { id: sessionId, cwd: '/tmp/project', git: { branch: 'main' } } }),
    JSON.stringify({ type: 'response_item', timestamp: '2026-09-11T00:00:01Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>hidden</environment_context>' }] } }),
    JSON.stringify({ type: 'response_item', timestamp: '2026-09-11T00:00:02Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Build the adapter' }] } }),
    JSON.stringify({ type: 'response_item', timestamp: '2026-09-11T00:00:03Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done' }] } }),
  ].join('\n'));
  const backend = createCodexBackend({
    homeDirectory: root,
    sessionsDirectory,
    sessionIndexPath: join(root, '.codex', 'session_index.jsonl'),
    titleOverridesPath: join(root, '.codex', 'title-overrides.json'),
    cliVersion: 'test',
    models: [
      { value: 'default', label: 'Codex configuration' },
      { value: 'gpt-test', label: 'GPT Test', description: 'Test model' },
    ],
  });
  const project = backend.listProjects()[0];
  assert.equal(project.backend, 'codex');
  const session = backend.listSessions(project.id)[0];
  assert.equal(session.summary, 'Build the adapter');
  assert.equal(session.messageCount, 2);
  const messages = await backend.readSessionMessages(sessionId);
  assert.deepEqual(messages.map(message => message.role), ['user', 'assistant']);
  assert.equal(messages[0].content, 'Build the adapter');

  const newTurn = backend.buildSpawnSpec({ message: 'Hello', projectPath: '/tmp/project', permissionMode: 'workspace-write', model: 'default' });
  assert.deepEqual(newTurn.args, ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write', '--thread-source', 'claude-mobile-ui', '-']);
  const resume = backend.buildSpawnSpec({ message: 'Again', sessionId, projectPath: '/tmp/project', permissionMode: 'read-only', model: 'default' });
  assert.deepEqual(resume.args, ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', 'resume', sessionId, '-']);
  const explicitModel = backend.buildSpawnSpec({ message: 'Hello', projectPath: '/tmp/project', permissionMode: 'read-only', model: 'gpt-test' });
  assert.deepEqual(explicitModel.args, ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '--model', 'gpt-test', '--thread-source', 'claude-mobile-ui', '-']);
  const unknownModel = backend.buildSpawnSpec({ message: 'Hello', projectPath: '/tmp/project', permissionMode: 'read-only', model: 'untrusted-model' });
  assert.equal(unknownModel.args.includes('untrusted-model'), false);
});
