import { readFile } from 'node:fs/promises';
export class AuditStore {
  constructor({ sink } = {}) { this.sink = sink; this.events = []; }
  async append(event) { const result = await this.sink.emit(event); this.events.push(result); return result; }
  query({ principalId, tenantId, projectId, sessionId, action } = {}) { return this.events.filter(event => (!principalId || event.principalId === principalId) && (!tenantId || event.tenantId === tenantId) && (!projectId || event.projectId === projectId) && (!sessionId || event.sessionId === sessionId) && (!action || event.action === action)); }
  async export({ dryRun = true, ...scope } = {}) { const events = this.query(scope); return dryRun ? events : JSON.stringify(events); }
  static async readJsonl(filePath) { const text = await readFile(filePath, 'utf8'); return text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)); }
}
