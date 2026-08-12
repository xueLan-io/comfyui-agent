const IDLE = 'idle';
const PREPARING = 'preparing';
const PREVIEW = 'preview';
const RUNNING = 'running';
const STOPPING = 'stopping';
const COMPLETED = 'completed';
const ERROR = 'error';
const CANCELLED = 'cancelled';

const TRANSITIONS = {
  [IDLE]:       [PREPARING, PREVIEW, RUNNING, STOPPING, ERROR],
  [PREPARING]:  [PREVIEW, RUNNING, COMPLETED, ERROR, CANCELLED, IDLE],
  [PREVIEW]:    [RUNNING, CANCELLED, IDLE, ERROR],
  [RUNNING]:    [PREVIEW, STOPPING, COMPLETED, ERROR, CANCELLED, IDLE],
  [STOPPING]:   [IDLE, COMPLETED, ERROR, CANCELLED],
  [COMPLETED]:  [IDLE, PREPARING, RUNNING, ERROR],
  [ERROR]:      [IDLE, PREPARING, PREVIEW, RUNNING],
  [CANCELLED]:  [IDLE, PREPARING, RUNNING],
};

const TERMINAL_STATES = new Set([COMPLETED, ERROR, CANCELLED]);
const ACTIVE_STATES = new Set([PREPARING, PREVIEW, RUNNING, STOPPING]);

export function canTransition(from, to) {
  if (from === to) return true;
  const allowed = TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}

export function isTerminal(phase) {
  return TERMINAL_STATES.has(phase);
}

export function isActive(phase) {
  return ACTIVE_STATES.has(phase);
}

export function normalizeUiPhase(phase) {
  if (phase === COMPLETED) return 'completed';
  if (phase === PREVIEW) return 'preview';
  if (phase === STOPPING) return 'stopping';
  return phase || IDLE;
}

export function transitionGeneration(current, next, patch = {}) {
  if (!canTransition(current, next)) {
    return { phase: current, applied: false, reason: `Invalid transition: ${current} → ${next}` };
  }
  return { phase: next, applied: true, patch };
}

export function restorePhase(target, patch = {}) {
  return { phase: target, applied: true, patch, restored: true };
}

export { IDLE, PREPARING, PREVIEW, RUNNING, STOPPING, COMPLETED, ERROR, CANCELLED };
