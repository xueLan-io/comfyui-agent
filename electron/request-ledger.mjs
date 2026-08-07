import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

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
        if (entry?.requestId) this.entries.set(entry.requestId, entry);
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

  begin(requestId, { source = '', fingerprint = '', taskId = '', previewId = '', principalId = '', tenantId = '', projectId = '', sessionId = '', serviceId = '', traceId = '', schemaVersion = 1 } = {}) {
    if (!requestId) throw new Error('requestId is required');
    const existing = this.entries.get(requestId);
    if (existing) {
      const identity = { serviceId, principalId, tenantId, projectId, sessionId, fingerprint };
      const identityFields = Object.keys(identity);
      if (identityFields.some(field => existing[field] && identity[field] && existing[field] !== identity[field])) {
        const error = new Error('requestId is already associated with a different request');
        error.code = existing.serviceId || serviceId ? 'REQUEST_IDENTITY_CONFLICT' : 'REQUEST_ID_CONFLICT';
        throw error;
      }
      return existing;
    }
    const entry = { schemaVersion, requestId, serviceId, principalId, tenantId, projectId, sessionId, source, fingerprint, taskId, traceId, previewId, state: 'created', recovery: { state: 'none', attempts: 0 }, preview: null, result: null, error: null, updatedAt: Date.now() };
    this.entries.set(requestId, entry);
    this.metrics?.increment('request.created');
    void this.persist();
    return entry;
  }

  update(requestId, patch = {}) {
    const entry = this.entries.get(requestId);
    if (!entry) return null;
    Object.assign(entry, clone(patch), { updatedAt: Date.now() });
    void this.persist();
    return entry;
  }

  complete(requestId, result) {
    this.metrics?.increment('request.completed');
    return this.update(requestId, { state: 'completed', result, error: null });
  }

  fail(requestId, error) {
    this.metrics?.increment('request.failed');
    return this.update(requestId, { state: 'failed', error: error ? { message: error.message || String(error), code: error.code || '' } : null });
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
