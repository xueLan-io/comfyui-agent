import { randomUUID } from 'node:crypto';

export const GOVERNANCE_SOURCES = Object.freeze(['ipc', 'mcp', 'cli', 'internal', 'recovery', 'scheduler']);
const REQUIRED_OWNER_FIELDS = ['principalId', 'tenantId', 'projectId', 'sessionId'];

function requiredString(name, value) {
  if (typeof value !== 'string' || !value.trim()) throw Object.assign(new Error(`${name} is required`), { code: 'GOVERNANCE_CONTEXT_INVALID' });
  return value.trim();
}

export function createGovernanceContext(input = {}) {
  const context = {
    principalId: requiredString('principalId', input.principalId),
    tenantId: requiredString('tenantId', input.tenantId),
    projectId: requiredString('projectId', input.projectId),
    sessionId: requiredString('sessionId', input.sessionId),
    requestId: requiredString('requestId', input.requestId || `request_${randomUUID()}`),
    taskId: requiredString('taskId', input.taskId || `task_${randomUUID()}`),
    traceId: requiredString('traceId', input.traceId || `trace_${randomUUID()}`),
    source: input.source || 'internal',
    policyVersion: String(input.policyVersion || '1'),
    deadline: input.deadline ?? null,
  };
  if (!GOVERNANCE_SOURCES.includes(context.source)) throw Object.assign(new Error(`Invalid governance source: ${context.source}`), { code: 'GOVERNANCE_CONTEXT_INVALID' });
  return Object.freeze(context);
}

export function assertGovernanceContext(context, { sideEffect = true } = {}) {
  if (!context || typeof context !== 'object') throw Object.assign(new Error('Governance context is required'), { code: 'AUTHENTICATION_REQUIRED' });
  for (const field of REQUIRED_OWNER_FIELDS) requiredString(field, context[field]);
  if (!GOVERNANCE_SOURCES.includes(context.source)) throw Object.assign(new Error('Invalid governance source'), { code: 'GOVERNANCE_CONTEXT_INVALID' });
  if (sideEffect && (!context.requestId || !context.taskId || !context.traceId)) throw Object.assign(new Error('Lifecycle identifiers are required'), { code: 'GOVERNANCE_CONTEXT_INVALID' });
  return context;
}

export function sameGovernanceOwner(left = {}, right = {}) {
  return REQUIRED_OWNER_FIELDS.every(field => left[field] === right[field]);
}

export function bindOwner(resource = {}, context) {
  assertGovernanceContext(context);
  return Object.freeze({ ...resource, principalId: context.principalId, tenantId: context.tenantId, projectId: context.projectId, sessionId: context.sessionId });
}
