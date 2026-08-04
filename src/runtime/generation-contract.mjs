import { randomUUID } from 'node:crypto';

const SOURCES = new Set(['direct', 'ai']);

function copyObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

export function normalizeGenerationRequest(input = {}) {
  const source = input.source || 'direct';
  if (!SOURCES.has(source)) throw new Error(`Unsupported generation source: ${source}`);
  if (typeof input.workflowName !== 'string' || !input.workflowName.trim()) {
    throw new Error('Workflow name is required');
  }
  if (typeof input.positive !== 'string') throw new Error('Positive prompt must be a string');
  if (typeof input.negative !== 'string') throw new Error('Negative prompt must be a string');

  return {
    requestId: input.requestId || randomUUID(),
    turnId: input.turnId || '',
    projectId: input.projectId || '',
    sessionId: input.sessionId || '',
    source,
    workflowName: input.workflowName,
    positive: input.positive,
    negative: input.negative,
    settings: copyObject(input.settings),
    nodeOverrides: copyObject(input.nodeOverrides),
    outputNodeIds: Array.isArray(input.outputNodeIds) ? [...input.outputNodeIds] : null,
    media: copyObject(input.media),
    origin: input.origin || source,
    executionPolicy: {
      retry: input.executionPolicy?.retry ?? source !== 'direct',
      evaluate: input.executionPolicy?.evaluate ?? source !== 'direct',
      mutatePrompt: input.executionPolicy?.mutatePrompt ?? source !== 'direct',
    },
  };
}

export function directGenerationRequest(input = {}) {
  return normalizeGenerationRequest({
    ...input,
    source: 'direct',
    executionPolicy: {
      ...(input.executionPolicy || {}),
      mutatePrompt: false,
    },
  });
}

export function assertDirectExecutionPolicy(request) {
  if (request.source !== 'direct') throw new Error('Direct runtime received a non-direct request');
  if (request.executionPolicy.mutatePrompt) {
    throw new Error('Direct runtime cannot enable prompt mutation');
  }
  return request;
}
