import type { ChildProcess } from 'node:child_process';

export type BackendId = 'claude' | 'codex';

export interface BackendCapabilities {
  conflictDetection: boolean;
  dollarCost: boolean;
  interactiveQuestions: boolean;
  partialTextStreaming: boolean;
  skillsPicker: boolean;
  toolUse: boolean;
}

export interface BackendOption {
  value: string;
  label: string;
  description?: string;
}

export interface BackendDescriptor {
  eventProtocolVersion: 1;
  id: BackendId;
  label: string;
  available: boolean;
  unavailableReason?: string;
  cliVersion?: string;
  capabilities: BackendCapabilities;
  defaultModel: string;
  defaultPermissionMode: string;
  models: BackendOption[];
  permissionModes: BackendOption[];
}

export interface ProjectSummary {
  backend: BackendId;
  id: string;
  originalPath: string;
  sessionCount: number;
}

export interface SessionSummary {
  backend: BackendId;
  sessionId: string;
  summary: string;
  firstPrompt: string;
  messageCount: number;
  created?: string;
  modified?: string;
  gitBranch?: string;
  projectPath: string;
}

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ToolPart {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  output?: string;
  status?: 'started' | 'completed' | 'failed';
  isError?: boolean;
}

export type MessagePart = TextPart | ToolPart;

export type NormalizedMessage =
  | { role: 'user'; content: string; timestamp?: string }
  | { role: 'assistant'; parts: MessagePart[]; timestamp?: string }
  | { role: 'tool_result'; toolUseId: string; content: string; isError: boolean };

export type NormalizedEvent =
  | { type: 'process-id'; id: string; backend: BackendId }
  | { type: 'session-started'; sessionId: string }
  | { type: 'text-delta'; text: string }
  | ({ type: 'tool-use' } & Omit<ToolPart, 'type'>)
  | { type: 'warning'; message: string }
  | { type: 'error'; message: string }
  | {
      type: 'turn-complete';
      sessionId?: string;
      cost?: { usd?: number; tokens?: TokenUsage };
      durationMs?: number;
    }
  | { type: 'stream-complete'; exitCode: number | null };

export interface TokenUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
}

export interface TurnRequest {
  message: string;
  sessionId?: string | null;
  projectPath?: string | null;
  permissionMode?: string | null;
  model?: string | null;
}

export interface SpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  prompt: string;
}

export interface EventParser {
  parseLine(rawLine: string): NormalizedEvent[];
  flush(rawRemainder: string): NormalizedEvent[];
}

export interface BackendAdapter {
  readonly id: BackendId;
  describe(): BackendDescriptor;
  buildSpawnSpec(request: TurnRequest): SpawnSpec;
  createEventParser(): EventParser;
  listProjects(): ProjectSummary[];
  listSessions(projectId: string): SessionSummary[];
  readSessionMessages(sessionId: string): Promise<NormalizedMessage[]>;
  renameSession(sessionId: string, summary: string): boolean;
  saveInitialTitle(sessionId: string, summary: string): void;
  listDirectories(): string[];
  listSlashItems(projectPath: string): { skills: unknown[]; commands: unknown[] };
  checkConflict(sessionId: string): { conflict: boolean; reason: string | null };
}

export interface RunningProcess {
  backend: BackendId;
  child: ChildProcess;
  sessionId: string | null;
}
