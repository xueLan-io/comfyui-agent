import { sanitizeContextValue } from '../schemas/context-sanitizer.mjs';
import { TRACE_SCHEMA_VERSION } from '../../runtime/trace-contract.mjs';

export const TASK_STATES = [
  'idle',
  'classifying',
  'clarifying',
  'planning',
  'awaiting_confirmation',
  'executing',
  'observing',
  'retrying',
  'replanning',
  'completed',
  'failed',
  'cancelled',
  'abandoned',
  'submit_unknown',
  'observe_timeout',
  'archive_failed',
];

export const TASK_STATUS = ['queued', ...TASK_STATES, 'error'];

export const TASK_TRANSITIONS = {
  idle: ['classifying', 'cancelled'],
  classifying: ['clarifying', 'planning', 'executing', 'failed', 'cancelled'],
  clarifying: ['idle', 'classifying', 'planning', 'awaiting_confirmation', 'failed', 'cancelled'],
  planning: ['awaiting_confirmation', 'executing', 'completed', 'failed', 'cancelled'],
  awaiting_confirmation: ['executing', 'classifying', 'idle', 'failed', 'cancelled'],
  executing: ['observing', 'failed', 'cancelled'],
  observing: ['retrying', 'replanning', 'executing', 'completed', 'failed', 'cancelled', 'observe_timeout', 'submit_unknown', 'archive_failed'],
  retrying: ['executing', 'failed', 'cancelled'],
  replanning: ['executing', 'failed', 'cancelled'],
  completed: ['classifying', 'idle'],
  failed: ['classifying', 'idle'],
  cancelled: ['classifying', 'idle'],
  abandoned: ['classifying', 'idle'],
  submit_unknown: ['observing', 'failed', 'cancelled'],
  observe_timeout: ['observing', 'failed', 'cancelled'],
  archive_failed: ['completed', 'failed'],
  queued: ['idle', 'classifying', 'failed', 'cancelled'],
  error: ['idle', 'classifying'],
};

export function canTransition(from, to) {
  return from === to || TASK_TRANSITIONS[from]?.includes(to) === true;
}

export class TaskManager {
  constructor(store) {
    this.store = store;
    this.tasks = [];
    this._byId = new Map();
  }

  async load() {
    if (!this.store) return;
    await this.store.load();
    const stored = this.store.get('tasks');
    if (Array.isArray(stored)) this.tasks = stored;
    this._byId.clear();
    for (const task of this.tasks) this._byId.set(task.id, task);
  }

  create({ id, kind, message = '', workflowName = '', traceId = '', intent = '', projectId = '', sessionId = '', requestId = '' }) {
    const task = {
      id,
      taskId: id,
      kind,
      message,
      workflowName,
      status: 'queued',
      state: 'queued',
      traceId,
      requestId: requestId || id,
      projectId,
      sessionId,
      currentStep: '',
      currentAttempt: 0,
      promptId: '',
      attempts: [],
      lastError: '',
      needsConfirmation: false,
      feedback: [],
      request: message,
      intent,
      plan: {},
      steps: [],
      retries: [],
      replans: [],
      timings: {},
      result: {},
      error: null,
      traceError: null,
      completedAt: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.tasks.push(task);
    this._byId.set(id, task);
    return task;
  }

  update(id, patch) {
    const task = this._byId.get(id);
    if (!task) return null;
    Object.assign(task, patch, { updatedAt: Date.now() });
    return task;
  }

  transition(id, state, patch = {}) {
    const task = this._byId.get(id);
    if (!task) return null;
    const current = task.state || task.status || 'queued';
    if (!canTransition(current, state)) {
      throw new Error(`Invalid task state transition: ${current} -> ${state}`);
    }
    return this.update(id, { ...patch, status: state, state });
  }

  addFeedback(id, type, details = {}) {
    const task = this._byId.get(id);
    if (!task) return null;
    if (!Array.isArray(task.feedback)) task.feedback = [];
    const feedback = { type, ...details, createdAt: Date.now() };
    task.feedback.push(feedback);
    task.updatedAt = Date.now();
    return feedback;
  }

  recordPlan(id, plan) {
    return this.update(id, { plan: sanitizeContextValue(plan) });
  }

  recordStep(id, step) {
    const task = this._byId.get(id);
    if (!task) return null;
    if (!Array.isArray(task.steps)) task.steps = [];
    const record = sanitizeContextValue(step);
    task.steps.push(record);
    if (record.stepId && Number.isFinite(record.duration_ms)) {
      const timing = task.timings[record.stepId] || { total_ms: 0, attempts: [] };
      timing.total_ms += record.duration_ms;
      timing.attempts.push(record.duration_ms);
      task.timings[record.stepId] = timing;
    }
    task.updatedAt = Date.now();
    return record;
  }

  beginAttempt(id, { stepId = '', attempt = 1 } = {}) {
    const task = this._byId.get(id);
    if (!task) return null;
    if (!Array.isArray(task.attempts)) task.attempts = [];
    const attemptRecord = {
      attemptId: `${task.id}_attempt_${task.attempts.length + 1}`,
      stepId,
      attempt,
      promptId: '',
      phase: 'executing',
      submittedAt: 0,
      observedAt: 0,
    };
    task.attempts.push(attemptRecord);
    task.currentAttempt = attempt;
    task.updatedAt = Date.now();
    return attemptRecord;
  }

  updateAttempt(id, attemptId, patch = {}) {
    const task = this._byId.get(id);
    const attempt = task?.attempts?.find(item => item.attemptId === attemptId);
    if (!attempt) return null;
    Object.assign(attempt, sanitizeContextValue(patch));
    task.updatedAt = Date.now();
    return attempt;
  }

  recordRetry(id, retry) {
    const task = this._byId.get(id);
    if (!task) return null;
    if (!Array.isArray(task.retries)) task.retries = [];
    task.retries.push(sanitizeContextValue(retry));
    task.updatedAt = Date.now();
    return retry;
  }

  recordReplan(id, replan) {
    const task = this._byId.get(id);
    if (!task) return null;
    if (!Array.isArray(task.replans)) task.replans = [];
    task.replans.push(sanitizeContextValue(replan));
    task.updatedAt = Date.now();
    return replan;
  }

  complete(id, { result = {}, error = null } = {}) {
    return this.update(id, {
      result: sanitizeContextValue(result),
      traceError: error ? sanitizeContextValue(error) : null,
      completedAt: Date.now(),
    });
  }

  getTrace(id) {
    const task = this._byId.get(id);
    if (!task) return null;
    return sanitizeContextValue({
      schemaVersion: TRACE_SCHEMA_VERSION,
      taskId: task.taskId || task.id,
      requestId: task.requestId || task.id,
      traceId: task.traceId || '',
      projectId: task.projectId || '',
      sessionId: task.sessionId || '',
      request: task.request || task.message || '',
      intent: task.intent || '',
      plan: task.plan || {},
      steps: task.steps || [],
      retries: task.retries || [],
      replans: task.replans || [],
      timings: task.timings || {},
      result: task.result || {},
      promptId: task.promptId || '',
      attempts: task.attempts || [],
      error: task.traceError || task.error || null,
      createdAt: task.createdAt || 0,
      completedAt: task.completedAt || 0,
    });
  }

  get(id) {
    return this._byId.get(id);
  }

  list(limit = 50) {
    return [...this.tasks].slice(-limit).reverse();
  }

  async persist() {
    if (!this.store) return;
    this.store.set('tasks', this.tasks.slice(-200));
    try {
      await this.store.save();
      return true;
    } catch {
      return false;
    }
  }

  markAbandoned() {
    const terminal = new Set(['completed', 'failed', 'cancelled', 'abandoned', 'error']);
    let changed = false;
    for (const task of this.tasks) {
      const state = task.state || task.status;
      if (terminal.has(state) || state === 'idle') continue;
      this.update(task.id, { status: 'abandoned', state: 'abandoned', lastError: 'Interrupted by restart', error: 'Interrupted by restart' });
      changed = true;
    }
    if (changed) void this.persist();
    return changed;
  }

  recoverInterrupted() {
    const recoverable = [];
    let changed = false;
    for (const task of this.tasks) {
      const state = task.state || task.status;
      if (['completed', 'failed', 'cancelled', 'abandoned', 'error', 'idle'].includes(state)) continue;
      if (['submit_unknown', 'observe_timeout', 'archive_failed'].includes(state)) {
        recoverable.push(task);
        continue;
      }
      if (task.promptId || task.attempts?.some(attempt => attempt.promptId)) {
        this.update(task.id, { status: 'observing', state: 'observing', lastError: 'Interrupted locally; remote prompt requires observation' });
        recoverable.push(task);
      } else {
        this.update(task.id, { status: 'abandoned', state: 'abandoned', lastError: 'Interrupted before ComfyUI submission', error: 'Interrupted before ComfyUI submission' });
      }
      changed = true;
    }
    if (changed) void this.persist();
    return recoverable;
  }
}
