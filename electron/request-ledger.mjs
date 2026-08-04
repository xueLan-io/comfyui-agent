import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

function clone(value) {
  return value && typeof value === 'object' ? structuredClone(value) : value;
}

export class RequestLedger {
  constructor() {
    this.entries = new Map();
    this.filePath = '';
    this.loaded = false;
    this.persistPromise = Promise.resolve();
  }

  async load(filePath) {
    this.filePath = filePath;
    try {
      const data = JSON.parse(await readFile(filePath, 'utf8'));
      for (const entry of Array.isArray(data) ? data : []) {
        if (entry?.requestId) this.entries.set(entry.requestId, entry);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    this.loaded = true;
  }

  async persist() {
    if (!this.filePath) return false;
    this.persistPromise = this.persistPromise.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const temp = `${this.filePath}.tmp`;
      await writeFile(temp, JSON.stringify([...this.entries.values()], null, 2));
      await rename(temp, this.filePath);
    });
    await this.persistPromise;
    return true;
  }

  get(requestId = '') {
    return requestId ? this.entries.get(requestId) || null : null;
  }

  begin(requestId, { source = '', fingerprint = '', taskId = '', previewId = '' } = {}) {
    if (!requestId) throw new Error('requestId is required');
    const existing = this.entries.get(requestId);
    if (existing) {
      if (existing.fingerprint && fingerprint && existing.fingerprint !== fingerprint) {
        const error = new Error('requestId is already associated with a different request');
        error.code = 'REQUEST_ID_CONFLICT';
        throw error;
      }
      return existing;
    }
    const entry = { requestId, source, fingerprint, taskId, previewId, state: 'created', preview: null, result: null, error: null, updatedAt: Date.now() };
    this.entries.set(requestId, entry);
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
    return this.update(requestId, { state: 'completed', result, error: null });
  }

  fail(requestId, error) {
    return this.update(requestId, { state: 'failed', error: error ? { message: error.message || String(error), code: error.code || '' } : null });
  }

  snapshot(requestId) {
    const entry = this.get(requestId);
    return entry ? clone(entry) : null;
  }
}
