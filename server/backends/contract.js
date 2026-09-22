// @ts-check

/** @typedef {import('./types.js').BackendAdapter} BackendAdapter */
/** @typedef {import('./types.js').BackendId} BackendId */

export const DEFAULT_BACKEND = 'claude';
export const BACKEND_IDS = /** @type {const} */ (['claude', 'codex']);

/**
 * Converts an untrusted request value into a registered backend id.
 * Missing values intentionally retain compatibility with pre-Codex clients.
 *
 * @param {unknown} value
 * @returns {BackendId}
 */
export function parseBackendId(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_BACKEND;
  if (value === 'claude' || value === 'codex') return value;
  throw new BackendRequestError(`Unsupported backend: ${String(value)}`);
}

/**
 * Session ids are only unique within a backend. This key is used exclusively
 * for in-memory ownership maps; it is never exposed as a CLI session id.
 *
 * @param {BackendId} backend
 * @param {string} sessionId
 */
export function sessionKey(backend, sessionId) {
  return `${backend}:${sessionId}`;
}

export class BackendRequestError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'BackendRequestError';
  }
}

/**
 * Fails fast at startup if an adapter drifts from the server contract.
 * JSDoc supplies editor/compiler help; this check protects production too.
 *
 * @param {BackendAdapter} adapter
 * @returns {BackendAdapter}
 */
export function validateAdapter(adapter) {
  /** @type {(keyof BackendAdapter)[]} */
  const methods = [
    'describe', 'buildSpawnSpec', 'createEventParser', 'listProjects',
    'listSessions', 'readSessionMessages', 'renameSession', 'saveInitialTitle',
    'listDirectories', 'listSlashItems', 'checkConflict',
  ];
  if (!BACKEND_IDS.includes(adapter.id)) {
    throw new TypeError(`Invalid backend adapter id: ${String(adapter.id)}`);
  }
  for (const method of methods) {
    if (typeof adapter[method] !== 'function') {
      throw new TypeError(`Backend "${adapter.id}" is missing ${method}()`);
    }
  }
  const descriptor = adapter.describe();
  if (descriptor.id !== adapter.id) {
    throw new TypeError(`Backend "${adapter.id}" returned a mismatched descriptor id`);
  }
  if (descriptor.eventProtocolVersion !== 1) {
    throw new TypeError(`Backend "${adapter.id}" uses an unsupported event protocol version`);
  }
  return adapter;
}
