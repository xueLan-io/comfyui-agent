import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const RequestStates = Object.freeze({
  CREATED: 'created',
  QUEUED: 'queued',
  PREPARING: 'preparing',
  PREPARED: 'prepared',
  EXECUTING: 'executing',
  OBSERVING: 'observing',
  SUBMIT_UNKNOWN: 'submit_unknown',
  STOPPING: 'stopping',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  TIMED_OUT: 'timed_out',
  ARCHIVE_FAILED: 'archive_failed',
});

const TERMINAL_STATES = new Set([
  RequestStates.COMPLETED,
  RequestStates.FAILED,
  RequestStates.CANCELLED,
]);

// 这些状态只可能属于“上一个进程”的在途执行：进程重启后必然已死，
// 恢复流程会依据任务账本重新入账，这里直接丢弃以免 UI 误报恢复任务。
const STALE_ON_LOAD = new Set([
  RequestStates.CREATED,
  RequestStates.QUEUED,
  RequestStates.PREPARING,
  RequestStates.PREPARED,
  RequestStates.EXECUTING,
  RequestStates.OBSERVING,
  RequestStates.SUBMIT_UNKNOWN,
  RequestStates.STOPPING,
]);

const ACTIVE_STATES = new Set([
  RequestStates.CREATED,
  RequestStates.QUEUED,
  RequestStates.PREPARING,
  RequestStates.PREPARED,
  RequestStates.EXECUTING,
  RequestStates.OBSERVING,
  RequestStates.SUBMIT_UNKNOWN,
  RequestStates.STOPPING,
  RequestStates.TIMED_OUT,
  RequestStates.ARCHIVE_FAILED,
]);

function clone(value) {
  return value && typeof value === 'object' ? structuredClone(value) : value;
}

export class RequestLedger {
  constructor({ metrics, maxEntries = 2000, ttlMs = 30 * 24 * 60 * 60 * 1000 } = {}) {
    this.entries = new Map();
    this.filePath = '';
    this.loaded = false;
    this.persistPromise = Promise.resolve();
    this.metrics = metrics;
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
  }

  _prune() {
    const cutoff = Date.now() - this.ttlMs;
    for (const [requestId, entry] of this.entries) {
      if (entry.updatedAt < cutoff && !['created', 'prepared', 'executing', 'observing'].includes(entry.state)) this.entries.delete(requestId);
    }
    while (this.entries.size > this.maxEntries) {
      const oldest = [...this.entries.values()].filter(entry => !['created', 'prepared', 'executing', 'observing'].includes(entry.state)).sort((a, b) => a.updatedAt - b.updatedAt)[0];
      if (!oldest) break;
      this.entries.delete(oldest.requestId);
    }
  }

  async load(filePath) {
    this.filePath = filePath;
    try {
      const data = JSON.parse(await readFile(filePath, 'utf8'));
      for (const entry of Array.isArray(data) ? data : []) {
        if (entry?.requestId && !STALE_ON_LOAD.has(entry.state)) this.entries.set(entry.requestId, entry);
      }
      this._prune();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    this.loaded = true;
  }

  async persist() {
    if (!this.filePath) return false;
    const persist = this.persistPromise.catch(() => {}).then(async () => {
      this._prune();
      await mkdir(dirname(this.filePath), { recursive: true });
      const temp = `${this.filePath}.tmp`;
      await writeFile(temp, JSON.stringify([...this.entries.values()], null, 2));
      await rename(temp, this.filePath);
    });
    this.persistPromise = persist.catch(error => {
      this.metrics?.increment('request.persist_failed');
      return error;
    });
    await persist;
    return true;
  }

  get(requestId = '') {
    return requestId ? this.entries.get(requestId) || null : null;
  }

  list({ projectId = '', sessionId = '', states = null } = {}) {
    const wanted = Array.isArray(states) ? new Set(states) : null;
    return [...this.entries.values()]
      .filter(entry => (!projectId || entry.projectId === projectId)
        && (!sessionId || entry.sessionId === sessionId)
        && (!wanted || wanted.has(entry.state)))
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map(clone);
  }

  isTerminal(state = '') {
    return TERMINAL_STATES.has(state);
  }

  isActive(state = '') {
    return ACTIVE_STATES.has(state);
  }

  begin(requestId, { source = '', fingerprint = '', taskId = '', turnId = '', previewId = '', principalId = '', tenantId = '', projectId = '', sessionId = '', serviceId = '', traceId = '', schemaVersion = 1 } = {}) {
    if (!requestId) throw new Error('requestId is required');
    const existing = this.entries.get(requestId);
    if (existing) {
      const identity = { serviceId, principalId, tenantId, projectId, sessionId, fingerprint, turnId, taskId };
      const identityFields = Object.keys(identity);
      if (identityFields.some(field => existing[field] && identity[field] && existing[field] !== identity[field])) {
        const error = new Error('requestId is already associated with a different request');
        error.code = existing.serviceId || serviceId ? 'REQUEST_IDENTITY_CONFLICT' : 'REQUEST_ID_CONFLICT';
        throw error;
      }
      return existing;
    }
    const now = Date.now();
    const entry = { schemaVersion, requestId, serviceId, principalId, tenantId, projectId, sessionId, source, fingerprint, taskId, turnId, traceId, previewId, state: RequestStates.CREATED, recovery: { state: 'none', attempts: 0 }, preview: null, result: null, error: null, createdAt: now, updatedAt: now, revision: 1 };
    this.entries.set(requestId, entry);
    this.metrics?.increment('request.created');
    void this.persist();
    return entry;
  }

  update(requestId, patch = {}) {
    const entry = this.entries.get(requestId);
    if (!entry) return null;
    if (patch.state && !Object.values(RequestStates).includes(patch.state)) {
      const error = new Error(`Unknown request state: ${patch.state}`);
      error.code = 'REQUEST_STATE_INVALID';
      throw error;
    }
    if (TERMINAL_STATES.has(entry.state) && patch.state && patch.state !== entry.state) {
      const error = new Error(`Request is already terminal: ${entry.state}`);
      error.code = 'REQUEST_TERMINAL';
      throw error;
    }
    Object.assign(entry, clone(patch), { updatedAt: Date.now(), revision: (entry.revision || 0) + 1 });
    void this.persist();
    return entry;
  }

  complete(requestId, result) {
    this.metrics?.increment('request.completed');
    return this.update(requestId, { state: RequestStates.COMPLETED, result, error: null });
  }

  fail(requestId, error) {
    this.metrics?.increment('request.failed');
    return this.update(requestId, { state: error?.code === 'REQUEST_TIMEOUT' ? RequestStates.TIMED_OUT : RequestStates.FAILED, error: error ? { message: error.message || String(error), code: error.code || '' } : null });
  }

  archiveFailed(requestId, result = null, error = null) {
    this.metrics?.increment('request.archive_failed');
    return this.update(requestId, {
      state: 'archive_failed',
      result,
      error: error ? { message: error.message || String(error), code: error.code || 'ARCHIVE_FAILED' } : null,
    });
  }

  recover(requestId, { state = 'observing', taskId = '', promptId = '', recovery = 'restart' } = {}) {
    const entry = this.get(requestId);
    return this.update(requestId, { state, taskId, promptId, recovery: { state: recovery, attempts: (entry?.recovery?.attempts || 0) + 1, lastCheckedAt: Date.now() } });
  }

  snapshot(requestId) {
    const entry = this.get(requestId);
    return entry ? clone(entry) : null;
  }
}
