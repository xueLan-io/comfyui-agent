// Chat assembly helpers (degradation retry loop + local offline replies),
// extracted from agent.mjs. Behavior-preserving moves: the Agent methods
// delegate here one line each.

import { emit, AgentEventTypes } from '../events/agent-events.mjs';

export async function chatWithDegradation(agent, { buildRequest, isLocal, taskId, traceId, streamMessageId = '' }) {
  // Retrying an empty response must not change the conversation. Context
  // degradation is reserved for genuine local-model interruptions. A
  // reasoning model can burn the whole output budget on thinking; retry such
  // empty responses with a larger maxTokens instead of the same budget.
  const attempts = isLocal ? [0, 1, 2] : [0];
  const retriedEmptyResponses = new Set();
  const retriedTransientResponses = new Set();
  const retriedBudgetResponses = new Set();
  let budgetBump = 0;
  let effortOverride = '';
  let lastError;
  for (let index = 0; index < attempts.length; index++) {
    const attempt = attempts[index];
    const request = buildRequest(attempt, budgetBump);
    if (effortOverride) request.options = { ...request.options, reasoningEffort: effortOverride };
    if (index > 0 && attempt > attempts[index - 1]) {
      emit(AgentEventTypes.PROGRESS, {
        scope: 'llm-context',
        stage: 'degrading',
        percent: 15 + attempt * 12,
        message: `本地模型响应中断，正在缩小上下文后重试（第 ${attempt + 1} 次）`,
        taskId,
        traceId,
      });
      emit(AgentEventTypes.MESSAGE, {
        role: 'agent',
        content: '',
        streaming: true,
        done: false,
        messageId: streamMessageId || `${taskId}:response`,
        taskId,
        traceId,
        attempt,
        reset: true,
      });
    }
    emit(AgentEventTypes.CONTEXT_USAGE, {
      ...request.telemetry,
      retryAttempt: attempt,
      taskId,
      traceId,
    });
    try {
      const result = await agent.llm.chat({ ...request.options, degradationAttempt: attempt });
      if (!String(result?.content || '').trim()) {
        const error = new Error('语言模型返回了空响应');
        error.code = 'EMPTY_MODEL_RESPONSE';
        if (result?.finishReason === 'length') error.budgetExhausted = true;
        throw error;
      }
      return { result, telemetry: request.telemetry, retryAttempt: attempt };
    } catch (error) {
      lastError = error;
      if (error?.code === 'LLM_CANCELLED' || /取消|cancelled|canceled/i.test(String(error?.message || ''))) throw error;
      if (error?.code === 'EMPTY_MODEL_RESPONSE' && error?.budgetExhausted === true && !retriedBudgetResponses.has(attempt)) {
        retriedBudgetResponses.add(attempt);
        budgetBump += 4096;
        effortOverride = effortOverride || 'low';
        agent.taskManager.recordRetry(taskId, {
          attempt: attempt + 1,
          code: error.code || '',
          message: '模型输出预算被思考耗尽，已扩大输出预算后重试',
          kind: 'budget_exhausted',
        });
        if (streamMessageId) {
          emit(AgentEventTypes.MESSAGE, {
            role: 'agent',
            content: '',
            streaming: true,
            done: false,
            messageId: streamMessageId,
            taskId,
            traceId,
            attempt,
            reset: true,
          });
        }
        attempts.splice(index + 1, 0, attempt);
        continue;
      }
      const retryable = error?.code === 'EMPTY_MODEL_RESPONSE'
        || ['LLM_NETWORK_ERROR', 'LLM_STREAM_INTERRUPTED'].includes(error?.code);
      const retrySet = error?.code === 'EMPTY_MODEL_RESPONSE'
        ? retriedEmptyResponses
        : retriedTransientResponses;
      if (retryable && !retrySet.has(attempt)) {
        retrySet.add(attempt);
        agent.taskManager.recordRetry(taskId, {
          attempt: attempt + 1,
          code: error.code || '',
          message: error.message || '语言模型请求失败',
          kind: error.code === 'EMPTY_MODEL_RESPONSE' ? 'empty_response' : 'transient_connection',
        });
        // A retry replaces, rather than appends to, a partial streaming reply.
        if (streamMessageId) {
          emit(AgentEventTypes.MESSAGE, {
            role: 'agent',
            content: '',
            streaming: true,
            done: false,
            messageId: streamMessageId,
            taskId,
            traceId,
            attempt,
            reset: true,
          });
        }
        attempts.splice(index + 1, 0, attempt);
        continue;
      }
      if (error?.code === 'EMPTY_MODEL_RESPONSE') {
        throw error;
      }
      if (['LLM_NETWORK_ERROR', 'LLM_STREAM_INTERRUPTED'].includes(error?.code)) {
        throw error;
      }
      if (!isLocal || index === attempts.length - 1) throw error;
    }
  }
  throw lastError || new Error('本地模型请求失败');
}

export function localResponse(agent, text) {
  const t = text.trim().toLowerCase();
  if (/(当前|实际).*(提示词|prompt)|^(正向提示词|负向提示词|current prompt)/i.test(t)) {
    const manifest = agent._lastManifest;
    if (!manifest) return '当前没有加载的工作流。';
    const profile = manifest.promptProfile || {};
    const compiled = agent.project.get('lastCompiledPrompt') || {};
    const positive = compiled.positive || profile.currentPositive || '';
    const negative = profile.supportsNegative === false ? '不支持普通负向提示词' : compiled.negative || profile.currentNegative || '';
    return [
      `当前模型：${profile.family || manifest.modelType || 'generic'}`,
      `正向提示词：${positive || '未设置'}`,
      `负向提示词：${negative || '未设置'}`,
      `人物与镜头约束：${JSON.stringify(compiled.constraints || {})}`,
    ].join('\n');
  }
  const greetings = /^(你好|您好|hi\b|hello|hey|早|晚上好|下午好|在吗|在不在)/i;
  if (greetings.test(t)) {
    const wf = agent.project.get('workflow');
    const base = wf
      ? `你好，当前工作流是 ${wf}。`
      : '你好！';
    return base + '可以聊创作想法、提示词，也可以问我工作流设置。';
  }

  const helps = /^(help|帮助|怎么用|使用说明|功能|命令|\/help)$/i;
  if (helps.test(t)) {
    return 'ComfyUI 创作助手使用说明\n\n对话模式：讨论创作想法、了解工作流参数\n生成模式：直接描述画面，自动执行工作流\n节点控制：点击"节点控制"按钮可覆盖 seed/步数/CFG 等参数\n提示词优化：在右侧选择电影质感、动漫风格、写实摄影或概念设计模式\n你也可以直接问"当前参数有哪些"或"这个工作流有什么节点"。';
  }

  const params = /^(当前参数|参数|设置|配置|当前设置|current\s*(param|setting|config)|what\s*(param|setting))/i;
  if (params.test(t)) {
    const manifest = agent._lastManifest;
    if (!manifest) return '当前没有加载的工作流。请先选择一个工作流文件。';
    const s = manifest.commonSettings || {};
    const lines = [`工作流：${manifest.workflowName}（${manifest.activeNodeCount} 个激活节点）`];
    if (s.seed != null) lines.push(`Seed：${s.seed}`);
    if (s.steps != null) lines.push(`步数：${s.steps}`);
    if (s.cfg != null) lines.push(`CFG：${s.cfg}`);
    if (s.width && s.height) lines.push(`尺寸：${s.width}\u00d7${s.height}`);
    if (s.sampler) lines.push(`采样器：${s.sampler}`);
    if (s.scheduler) lines.push(`调度器：${s.scheduler}`);
    lines.push(`提示词模式：${agent.promptMode}`);
    return lines.join('\n');
  }

  const structure = /(节点|结构|输出节点|工作流里有什么|节点列表|node|output)/i;
  if (structure.test(t)) {
    const manifest = agent._lastManifest;
    if (!manifest) return null;
    const outputNodes = (manifest.outputNodes || []).slice(0, 20);
    const editableNodes = (manifest.editableNodes || []).slice(0, 20);
    const lines = [`工作流 ${manifest.workflowName} 的节点结构：`];
    lines.push(`输出节点（${manifest.outputNodeCount ?? outputNodes.length}）：`);
    for (const node of outputNodes) {
      lines.push(`${node.id} ${node.type}${node.group ? ` [${node.group}]` : ''}`);
    }
    lines.push(`可编辑节点：${manifest.editableNodeCount ?? editableNodes.length} 个`);
    if (editableNodes.length > 0) {
      const inputs = [...new Set(
        editableNodes.slice(0, 5).flatMap(node => (node.inputs || []).map(item => `${node.type}.${item.name}`)),
      )].slice(0, 8);
      if (inputs.length > 0) lines.push(`常用可编辑输入：${inputs.join('、')}`);
    }
    return lines.join('\n');
  }

  return null;
}
