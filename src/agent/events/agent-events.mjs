import { createEvent } from '../schemas/event-schema.mjs';

const LISTENERS = new Map();

export const AgentEventTypes = {
  STATUS: 'agent:status',
  STEP: 'agent:step',
  TOOL_CALL: 'agent:tool-call',
  TOOL_RESULT: 'agent:tool-result',
  MESSAGE: 'agent:message',
  ERROR: 'agent:error',
  PLAN: 'agent:plan',
  TASK: 'agent:task',
  TRACE: 'agent:trace',
  PROGRESS: 'agent:progress',
  FEEDBACK: 'agent:feedback',
  CONTEXT_USAGE: 'agent:context-usage',
};

let projectId = '';
let sessionId = '';
let turnId = '';
let traceCounter = 0;

export function initSession(projectOrSessionId = '', activeSessionId = '') {
  if (projectOrSessionId && typeof projectOrSessionId === 'object') {
    projectId = projectOrSessionId.projectId || '';
    sessionId = projectOrSessionId.sessionId || `session_${Date.now()}`;
    return;
  }
  if (activeSessionId) {
    projectId = projectOrSessionId || '';
    sessionId = activeSessionId;
    return;
  }
  projectId = '';
  sessionId = projectOrSessionId || `session_${Date.now()}`;
}

export function nextTraceId() {
  traceCounter++;
  return `trace_${traceCounter}_${Date.now()}`;
}

export function initTurn(activeTurnId = '') {
  turnId = activeTurnId || '';
}

export function emit(type, data = {}) {
  const event = createEvent(type, {
    projectId,
    sessionId,
    turnId,
    traceId: data.traceId || '',
    ...data,
  });

  const handlers = LISTENERS.get(type) || [];
  for (const fn of handlers) {
    try { fn(event); } catch (e) { console.error('Agent event error:', e); }
  }
}

export function on(type, fn) {
  if (!LISTENERS.has(type)) LISTENERS.set(type, []);
  LISTENERS.get(type).push(fn);
  return () => {
    const arr = LISTENERS.get(type);
    if (arr) {
      const idx = arr.indexOf(fn);
      if (idx >= 0) arr.splice(idx, 1);
    }
  };
}

export function off(type, fn) {
  const arr = LISTENERS.get(type);
  if (arr) {
    const idx = arr.indexOf(fn);
    if (idx >= 0) arr.splice(idx, 1);
  }
}
