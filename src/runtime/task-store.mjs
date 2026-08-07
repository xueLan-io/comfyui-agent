import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export class TaskStore {
  constructor(filePath) { this.filePath = filePath; this.tasks = new Map(); this.flushPromise = Promise.resolve(); }
  async load() { try { const data = JSON.parse(await readFile(this.filePath, 'utf8')); for (const task of Array.isArray(data) ? data : []) if (task?.id) this.tasks.set(task.id, structuredClone(task)); } catch (error) { if (error.code !== 'ENOENT') throw error; } return this; }
  get(id) { return this.tasks.get(String(id)) ? structuredClone(this.tasks.get(String(id))) : null; }
  list({ limit = 100, state } = {}) { return [...this.tasks.values()].filter(task => !state || task.state === state).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, limit).map(task => structuredClone(task)); }
  put(task) { if (!task?.id) throw new Error('Task id is required'); const value = { ...structuredClone(task), updatedAt: task.updatedAt || Date.now() }; this.tasks.set(String(value.id), value); void this.flush(); return structuredClone(value); }
  delete(id) { const result = this.tasks.delete(String(id)); if (result) void this.flush(); return result; }
  async flush() { this.flushPromise = this.flushPromise.then(async () => { await mkdir(dirname(this.filePath), { recursive: true }); const temp = `${this.filePath}.tmp`; await writeFile(temp, JSON.stringify([...this.tasks.values()], null, 2)); await rename(temp, this.filePath); }); await this.flushPromise; return true; }
}
