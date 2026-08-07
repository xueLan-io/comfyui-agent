import { createHash, randomUUID } from 'node:crypto';

const SECRET_KEYS = /token|secret|api[-_]?key|cookie|authorization|password|credential/i;
export function redactAuditData(value, key = '') {
  if (SECRET_KEYS.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return value.length > 2048 ? `[REDACTED_STRING length=${value.length} digest=${createHash('sha256').update(value).digest('hex')}]` : value;
  if (Array.isArray(value)) return value.map(item => redactAuditData(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactAuditData(item, name)]));
  return value;
}
export function createAuditEvent(input = {}) {
  return { schemaVersion: 1, eventId: input.eventId || `audit_${randomUUID()}`, sequence: input.sequence ?? 0, timestamp: input.timestamp ?? Date.now(), principalId: input.principalId || '', tenantId: input.tenantId || '', projectId: input.projectId || '', sessionId: input.sessionId || '', requestId: input.requestId || '', taskId: input.taskId || '', traceId: input.traceId || '', source: input.source || 'internal', action: input.action || 'unknown', decision: input.decision || 'allow', reason: input.reason || '', policyVersion: String(input.policyVersion || '1'), data: redactAuditData(input.data || {}) };
}
