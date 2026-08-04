const DEFAULT_RULES = [
  {
    id: 'retry_on_failure',
    condition: (evalResult) => evalResult?.scores?.technical < 0.5,
    action: { type: 'retry', modification: 'regenerate', maxAttempts: 3 },
    priority: 1,
  },
  {
    id: 'rewrite_on_misalignment',
    condition: (evalResult) => typeof evalResult?.scores?.alignment === 'number' && evalResult.scores.alignment < 0.6,
    action: { type: 'rewrite_prompt', modification: 'improve prompt alignment', maxAttempts: 2 },
    priority: 2,
  },
  {
    id: 'change_seed_on_low_quality',
    condition: (evalResult) => typeof evalResult?.scores?.creative === 'number' && evalResult.scores.creative < 0.5,
    action: { type: 'change_seed', modification: 'try different seed', maxAttempts: 2 },
    priority: 3,
  },
  {
    id: 'accept_good_result',
    condition: (evalResult) => (evalResult?.scores?.overall || 1) >= 0.7 && (evalResult?.scores?.alignment ?? 1) >= 0.6,
    action: { type: 'accept', modification: '' },
    priority: 0,
  },
];

const DEFAULT_LIMITS = {
  maxRetriesPerStep: 3,
  maxRetriesPerTask: 8,
};

const NON_RETRYABLE = [
  /invalid tool input/i,
  /unknown tool/i,
  /workflow (?:not found|directory|path)/i,
  /invalid workflow/i,
  /node[^\n]*(?:not found|missing|unknown|does not exist)/i,
  /filename required/i,
  /outside the configured directory/i,
  /path is outside/i,
  /permission denied/i,
];

const TRANSIENT_COMFYUI = [
  /econnrefused|econnreset|etimedout/i,
  /fetch failed/i,
  /connection|network|websocket/i,
  /queue/i,
  /timed? ?out|temporar(?:y|ily)|service unavailable/i,
  /\b(?:502|503|504)\b/,
];

export function classifyFailure(error, { tool = '', action = '' } = {}) {
  const message = typeof error === 'string' ? error : error?.message || error?.reason || '';
  if (error?.failureType) {
    return {
      type: error.failureType,
      retryable: error.retryable === true,
      replan: error.replan === true,
      reason: message || error.failureType,
      userMessage: error.userMessage || failureUserMessage(error.failureType, message),
    };
  }

  if (error?.name === 'AbortError' || /cancel/i.test(message)) {
    return { type: 'cancelled', retryable: false, reason: message || 'Execution cancelled', userMessage: '任务已取消' };
  }
  if (tool === 'filesystem' || tool === 'filesystem_mutate') {
    return { type: 'filesystem', retryable: false, reason: 'Filesystem operations are not retried automatically', userMessage: '文件操作失败，未自动重试' };
  }
  if (NON_RETRYABLE.some(pattern => pattern.test(message))) {
    const type = /workflow/i.test(message) ? 'workflow_not_found'
      : /node/i.test(message) ? 'node_not_found'
        : 'parameter';
    return { type, retryable: false, reason: message || type, userMessage: failureUserMessage(type, message) };
  }
  if (/selected output node|output node did not produce/i.test(message)) {
    return { type: 'output_mismatch', retryable: false, replan: true, reason: message, userMessage: failureUserMessage('output_mismatch', message) };
  }
  if (/ComfyUI generation timeout/i.test(message)) {
    return { type: 'timeout', retryable: false, reason: message, userMessage: failureUserMessage('timeout', message) };
  }
  if (tool === 'comfyui' && TRANSIENT_COMFYUI.some(pattern => pattern.test(message))) {
    return { type: 'comfyui_transient', retryable: true, reason: message || 'Temporary ComfyUI failure', userMessage: '模型服务连接失败' };
  }
  return { type: 'permanent', retryable: false, reason: message || `The ${action || tool || 'tool'} operation failed`, userMessage: failureUserMessage('permanent', message) };
}

function failureUserMessage(type, message = '') {
  if (/plan validation failed|replan validation failed/i.test(message)) return '任务计划无效';
  if (type === 'workflow_not_found') return '工作流不存在';
  if (type === 'node_not_found') return '节点不存在';
  if (type === 'reference_not_connected') return '参考图没有接入任何加载节点';
  if (type === 'prompt_not_injected') return '当前工作流没有可注入的正向提示词输入';
  if (type === 'negative_prompt_unsupported') return '当前工作流没有可用负面提示词输入';
  if (type === 'timeout') return 'ComfyUI 执行超时';
  if (type === 'output_mismatch' || type === 'empty_output') return '输出节点没有产生图片';
  if (type === 'comfyui_transient') return '模型服务连接失败';
  if (type === 'comfyui_upload') return '参考文件上传失败';
  if (type === 'cancelled') return '任务已取消';
  return message || '任务执行失败';
}

export function diffParameters(before = {}, after = {}) {
  const changes = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    const previous = before[key];
    const current = after[key];
    if (JSON.stringify(previous) === JSON.stringify(current)) continue;
    changes.push({ parameter: key, before: previous, after: current });
  }
  return changes;
}

export class RetryPolicy {
  constructor(rules = DEFAULT_RULES, options = {}) {
    this.rules = [...rules].sort((a, b) => a.priority - b.priority);
    this.maxRetriesPerStep = options.maxRetriesPerStep ?? DEFAULT_LIMITS.maxRetriesPerStep;
    this.maxRetriesPerTask = options.maxRetriesPerTask ?? DEFAULT_LIMITS.maxRetriesPerTask;
    this.attempts = new Map();
    this.stepAttempts = new Map();
    this.taskRetries = 0;
  }

  evaluate(evalResult, context = {}) {
    if (!evalResult) return { action: 'accept', modification: '', shouldRetry: false };

    for (const rule of this.rules) {
      try {
        if (rule.condition(evalResult)) {
          if (rule.action.type === 'accept') {
            return { action: 'accept', modification: '', shouldRetry: false, ruleId: rule.id };
          }

          return this._limitDecision({
            action: rule.action.type,
            modification: evalResult.recommendation?.modification || rule.action.modification,
            ruleId: rule.id,
            maxAttempts: rule.action.maxAttempts,
          }, context);
        }
      } catch {
        // A malformed evaluation must not create a retry loop.
      }
    }

    return { action: 'accept', modification: '', shouldRetry: false };
  }

  evaluateFailure(failure, context = {}) {
    const normalized = failure?.type
      ? failure
      : classifyFailure(failure, context);
    const retryContract = context.toolContract?.retry;
    if (!normalized.retryable || retryContract?.mode === 'never' || context.tool !== 'comfyui') {
      return {
        action: 'accept',
        modification: normalized.reason || 'failure is not retryable',
        shouldRetry: false,
        failureType: normalized.type,
        replan: normalized.replan === true,
        userMessage: normalized.userMessage,
      };
    }

    const action = normalized.type === 'empty_output' ? 'change_seed' : 'retry';
    return this._limitDecision({
      action,
      modification: normalized.reason || (action === 'change_seed' ? 'regenerate with a new seed' : 'retry ComfyUI operation'),
      failureType: normalized.type,
      userMessage: normalized.userMessage,
      maxAttempts: this.maxRetriesPerStep,
    }, context);
  }

  _limitDecision(decision, context = {}) {
    const ruleAttempts = decision.ruleId ? (this.attempts.get(decision.ruleId) || 0) : 0;
    const stepAttempts = context.stepId ? (this.stepAttempts.get(context.stepId) || 0) : 0;
    const contractLimit = context.toolContract?.retry?.max_attempts;
    const ruleLimit = Math.min(decision.maxAttempts || this.maxRetriesPerStep, contractLimit || this.maxRetriesPerStep);
    const stepLimit = context.stepId ? Math.min(this.maxRetriesPerStep, ruleLimit) : ruleLimit;

    if (ruleAttempts >= ruleLimit || stepAttempts >= stepLimit || this.taskRetries >= this.maxRetriesPerTask) {
      return {
        ...decision,
        action: 'accept',
        modification: 'retry limit reached',
        shouldRetry: false,
        attempt: stepAttempts,
        taskAttempt: this.taskRetries,
        exhausted: true,
      };
    }

    if (decision.ruleId) this.attempts.set(decision.ruleId, ruleAttempts + 1);
    if (context.stepId) this.stepAttempts.set(context.stepId, stepAttempts + 1);
    this.taskRetries++;
    return {
      ...decision,
      shouldRetry: true,
      attempt: stepAttempts + 1,
      taskAttempt: this.taskRetries,
      maxAttempts: stepLimit,
      maxTaskRetries: this.maxRetriesPerTask,
    };
  }

  reset() {
    this.attempts.clear();
    this.stepAttempts.clear();
    this.taskRetries = 0;
  }
}
