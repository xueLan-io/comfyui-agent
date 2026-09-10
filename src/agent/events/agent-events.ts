import { createEvent } from '../schemas/event-schema.ts';
import type { AgentEvent, AgentEventType } from '../schemas/event-schema.ts';

const LISTENERS = new Map<string, Array<(event: AgentEvent) => void>>();

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
} as const satisfies Record<string, AgentEventType>;

export type AgentEventUnsubscribe = () => void;

let projectId = '';
let sessionId = '';
let turnId = '';
let traceCounter = 0;

export function initSession(
  projectOrSessionId: string | { projectId?: string; sessionId?: string } = '',
  activeSessionId = '',
): void {
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

export function nextTraceId(): string {
  traceCounter++;
  return `trace_${traceCounter}_${Date.now()}`;
}

export function initTurn(activeTurnId = ''): void {
  turnId = activeTurnId || '';
}

export function emit(type: AgentEventType, data: Record<string, any> = {}): AgentEvent {
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
  return event;
}

export function on(type: AgentEventType, fn: (event: AgentEvent) => void): AgentEventUnsubscribe {
  if (!LISTENERS.has(type)) LISTENERS.set(type, []);
  LISTENERS.get(type)!.push(fn);
  return () => {
    const arr = LISTENERS.get(type);
    if (arr) {
      const idx = arr.indexOf(fn);
      if (idx >= 0) arr.splice(idx, 1);
    }
  };
}

export function off(type: AgentEventType, fn: (event: AgentEvent) => void): void {
  const arr = LISTENERS.get(type);
  if (arr) {
    const idx = arr.indexOf(fn);
    if (idx >= 0) arr.splice(idx, 1);
  }
}
