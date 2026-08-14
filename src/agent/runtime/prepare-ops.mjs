// Generation/file/workflow preparation and prepared-run execution subsystem,
// extracted from agent.mjs. Functions operate on the agent and are
// behavior-preserving moves; the Agent methods delegate here one line each.
// Internal calls go back through agent instance methods so subclass/test
// overrides keep working.

import { randomUUID } from 'node:crypto';
import { emit, AgentEventTypes, initTurn, nextTraceId } from '../events/agent-events.mjs';
import { buildAgentContext } from '../schemas/context-schema.mjs';
import { validatePlan } from '../schemas/plan-schema.mjs';
import { confirmationForPlan } from '../schemas/confirmation-schema.mjs';
import { PromptEnhanceTool } from '../tools/prompt/enhance.mjs';
import { checkEditedPrompt } from '../optimizer/prompt-guard.mjs';
import { assertConfirmationBinding } from '../../runtime/governance/operation-gateway.mjs';
import { WorkflowMutationPreviewTool, WorkflowMutationCommitTool } from '../tools/comfyui/workflow-mutation-tools.mjs';
import { ComfyUITool } from '../tools/comfyui/index.mjs';
import { promptProfileLabel } from '../tools/comfyui/prompt-profile.mjs';
import { normalizeRuntimeParameters, freezeRuntimeRequest, runtimeRequestDigest } from '../../runtime/runtime-parameters-contract.mjs';
import { attachMediaToPlan } from './planner.mjs';
import { assessPromptReadiness } from '../tools/prompt/readiness.mjs';
import { researchCharacterIfPlanned, shouldResearchCharacter } from './research-ops.mjs';
import { APPEARANCE_FIELDS } from '../research/appearance.mjs';

export function newRequestId() {
  return `request_${randomUUID()}`;
}

export function isCancellationError(error) {
  return Boolean(
    error?.code === 'LLM_CANCELLED'
      || error?.name === 'AbortError'
      || /取消|cancelled|canceled/i.test(String(error?.message || '')),
  );
}

export function emitTiming(stage, data = {}) {
  emit(AgentEventTypes.PROGRESS, { ...data, scope: 'timing', stage });
}

export function timingOutcome(error) {
  return isCancellationError(error) ? 'cancelled' : 'error';
}

export function aiFailure(originalRequest, error) {
  const message = error instanceof Error ? error.message : String(error);
  const normalizedError = /^(?:timeout|timed out|request timed out)$/i.test(message.trim())
    || /(?:语言模型|本地模型).*(?:超时|没有响应)/i.test(message)
    ? '\u8bed\u8a00\u6a21\u578b\u8bf7\u6c42\u8d85\u65f6\uff0c\u8bf7\u68c0\u67e5\u6a21\u578b\u5730\u5740\u3001\u4ee3\u7406\u548c\u672c\u5730\u6a21\u578b\u662f\u5426\u5df2\u542f\u52a8\u540e\u91cd\u8bd5\u3002'
    : message;
  const failure = {
    action: 'ai_failed',
    error: normalizedError,
    originalRequest,
    choices: ['retry_ai', 'direct_original'],
  };
  if (error?.code) failure.code = error.code;
  if (error?.code === 'CLOUD_POLICY_BLOCKED') {
    failure.code = error.code;
    failure.policyDecision = error.policyDecision || null;
    failure.choices = [...failure.choices, 'force_cloud'];
  }
  return failure;
}

function researchPreview(context) {
  if (!context) return null;
  const fields = ['hair', 'eyes', 'outfit', 'accessories', 'silhouette'];
  return {
    status: context.researchStatus || 'unknown',
    message: context.researchMessage || '',
    sources: context.sources || [],
    facts: Object.fromEntries(fields.map(field => [field, context[field] || ''])),
    evidence: context.evidence || [],
    unknownFields: fields.filter(field => !context[field]),
  };
}

// 调研失败/被禁用时给用户显式提示，而不是让结果静默退化。
function researchWarnings(context) {
  if (!context) return [];
  const status = context.researchStatus || '';
  if (status === 'disabled') {
    return ['联网检索已在设置中关闭，外观细节将依据模型自身知识补全。'];
  }
  if (status === 'search_failed') {
    return ['在线检索失败，外观细节将依据模型自身知识补全。'];
  }
  if (status === 'no_sources') {
    return ['在线检索未返回可用资料，外观细节可能不准确。'];
  }
  if (status === 'extraction_failed') {
    return ['外观事实抽取失败，已保留部分检索到的信息。'];
  }
  return [];
}

export async function prepareFileMutation(agent, userMessage, options = {}) {
  const queued = agent._enqueue(() => prepareFileMutation(agent, userMessage, options));
  if (queued) return queued;
  if (agent._state === 'awaiting_confirmation') throw new Error('A file change preview is awaiting confirmation');
  agent._running = true;
  agent._taskId = `task_${Date.now()}`;
  agent._traceId = nextTraceId();
  agent.taskManager?.create?.({ id: agent._taskId, kind: 'file_mutation', message: options.effectiveRequest || userMessage, traceId: agent._traceId, intent: 'file_edit', projectId: agent.sessionManager.activeProjectId });
  if (agent._state !== 'classifying') agent._transitionState('classifying', { message: 'Classifying file change...' });
  try {
    const request = options.effectiveRequest || userMessage;
    if (!options.turnId) agent._writeTurnMessage('user', userMessage, { intent: 'file_edit', action: 'prepare' });
    agent._transitionState('planning', { message: 'Planning file change...' });
    const ctx = buildAgentContext(request, {
      conversation: agent._conversationForLLM(6),
      project: {
        currentCharacter: agent.project.get('character'),
        currentStyle: agent.project.get('style'),
        currentModel: agent.project.get('model'),
        currentWorkflow: agent.project.get('workflow'),
        lastPrompt: agent.project.get('lastPrompt'),
        promptMode: agent.promptMode,
        budgets: agent.project.get('budgets') || null,
        confirmedConstraints: agent.project.get('confirmedConstraints') || {},
      },
      availableWorkflows: agent._listWorkflows(),
      workflowDir: agent.workflowDir,
      previousArtifacts: agent._artifacts.slice(-5),
    });
    ctx.filesystemRoots = agent._filesystemRoots();
    ctx.comfyRoot = agent.comfyRoot;
    const plan = options.plan || await agent.planner.createPlan(request, ctx);
    const validation = validatePlan(plan, { tools: agent.tools, context: ctx, maxSteps: agent.planner.maxSteps });
    if (!validation.valid) throw new Error(`Plan validation failed: ${validation.errors.join('; ')}`);
    if (!plan.steps.some(step => step.tool === 'filesystem_mutate')) throw new Error('The file change plan has no filesystem_mutate step');
    if (plan.steps.some(step => !['filesystem', 'filesystem_mutate'].includes(step.tool))) {
      throw new Error('File change plans may only use filesystem read and filesystem_mutate tools');
    }

    const previews = [];
    for (const step of plan.steps) {
      const previewStep = structuredClone(step);
      if (previewStep.tool === 'filesystem_mutate') previewStep.input.execute = false;
      const output = await agent.executor.executeStep(previewStep, ctx);
      if (output.error) throw new Error(output.error);
      previews.push({ stepId: step.id, result: output.result });
    }
    agent.taskManager?.recordPlan?.(agent._taskId, plan);
    const previewId = `preview_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const confirmation = confirmationForPlan(plan, { tools: agent.tools });
    agent._preparedRuns.clear();
    agent._preparedRuns.set(previewId, {
      kind: 'file_mutation',
      userMessage,
      effectiveRequest: request,
      plan,
      options,
      confirmation,
      status: 'prepared',
    });
    agent._transitionState('awaiting_confirmation', { message: 'Awaiting file change confirmation', needsConfirmation: true });
    const preview = { previewId, source: 'file_mutation', request, plan, previews, confirmation, needsConfirmation: true, status: 'prepared' };
    agent.sessionManager.setSessionState?.({
      preparedPreview: preview,
      pending: { kind: 'file_mutation', previewId, request, turnId: options.turnId || '' },
      taskStatus: 'awaiting_confirmation',
      needsConfirmation: true,
    });
    return preview;
  } catch (error) {
    agent.taskManager?.complete?.(agent._taskId, { error: { message: error.message, stage: 'prepare' } });
    if (agent._state !== 'cancelled' && agent._state !== 'failed') agent._transitionState('failed', { lastError: error.message, message: error.message });
    throw error;
  } finally {
    agent._running = false;
    await agent._drainQueue();
  }
}

export async function prepareWorkflowMutation(agent, input, options = {}) {
  const queued = agent._enqueue(() => prepareWorkflowMutation(agent, input, options));
  if (queued) return queued;
  if (agent._state === 'awaiting_confirmation') throw new Error('A workflow mutation preview is awaiting confirmation');
  agent._running = true;
  try {
    const request = { ...input, workflowDir: input.workflowDir || agent.workflowDir };
    const result = await WorkflowMutationPreviewTool.execute(request);
    if (result.error || result.code || !result.ready) return result;
    const previewId = result.previewId;
    agent._preparedRuns.clear();
    agent._preparedRuns.set(previewId, { kind: 'workflow_mutation', input: request, preview: result, options, status: 'prepared' });
    agent._transitionState('awaiting_confirmation', { message: 'Awaiting workflow mutation confirmation', needsConfirmation: true });
    const preview = { ...result, source: 'workflow_mutation', kind: 'workflow_mutation', needsConfirmation: true, status: 'prepared' };
    agent.sessionManager.setSessionState?.({ preparedPreview: preview, pending: { kind: 'workflow_mutation', previewId, request, turnId: options.turnId || '' }, taskStatus: 'awaiting_confirmation', needsConfirmation: true });
    return preview;
  } finally {
    agent._running = false;
    await agent._drainQueue();
  }
}

export async function runPrepared(agent, previewId, edits = {}) {
  if (edits.turnId) initTurn(edits.turnId);
  const prepared = agent._preparedRuns.get(previewId);
  if (!prepared) throw new Error('Prompt preview expired; prepare it again');
  if (prepared.status && prepared.status !== 'prepared') {
    const error = new Error('Generation preview is already being consumed');
    error.code = 'GENERATION_PREVIEW_BUSY';
    throw error;
  }
  // When a confirmation object is supplied and this prepared run carries a
  // digest, the confirmation must bind to this exact preview: same digest,
  // same request id, same preview id, accepted === true. This aligns the GUI
  // path with the MCP generation bridge and the direct generation path.
  if (edits.confirmation && prepared.requestDigest) {
    assertConfirmationBinding({
      confirmation: edits.confirmation,
      expectedDigest: prepared.requestDigest,
      requestId: prepared.requestId,
      previewId,
    });
  }
  prepared.status = 'consuming';
  agent.sessionManager.setSessionState?.({
    preparedPreview: { ...(agent.sessionManager.getSessionState?.().preparedPreview || {}), status: 'consuming' },
    taskStatus: 'consuming',
  });
  if (prepared.kind === 'file_mutation') {
    try {
      const result = await agent.run(prepared.userMessage, {
        ...prepared.options,
        turnId: edits.turnId || prepared.options.turnId || '',
        preparedPlan: prepared.plan,
        effectiveRequest: prepared.effectiveRequest,
        requestId: prepared.requestId,
        intent: 'file_edit',
        confirmedFileMutation: true,
      });
      agent._preparedRuns.delete(previewId);
      return result;
    } catch (error) {
      prepared.status = 'prepared';
      agent.sessionManager.setSessionState?.({
        preparedPreview: { ...(agent.sessionManager.getSessionState?.().preparedPreview || {}), status: 'prepared' },
        taskStatus: 'awaiting_confirmation',
      });
      throw error;
    }
  }
  if (prepared.kind === 'workflow_mutation') {
    try {
      const result = await WorkflowMutationCommitTool.execute({
        ...prepared.input,
        previewId,
        expectedHash: prepared.preview.baseRevision?.sha256,
        confirmation: edits.confirmation !== false,
      });
      if (!result.committed) throw Object.assign(new Error(result.error || result.code || 'Workflow mutation failed'), { code: result.code });
      agent._preparedRuns.delete(previewId);
      return result;
    } catch (error) {
      prepared.status = 'prepared';
      agent.sessionManager.setSessionState?.({ preparedPreview: { ...(agent.sessionManager.getSessionState?.().preparedPreview || {}), status: 'prepared' }, taskStatus: 'awaiting_confirmation' });
      throw error;
    }
  }
  let compiledPrompt = prepared.compiledPrompt;
  try {
    if (edits.appearanceFacts && prepared.compileInput?.llmProvider && prepared.compileInput.mode !== 'raw') {
      const referenceContext = {
        ...(prepared.compileInput.referenceContext || {}),
        ...edits.appearanceFacts,
      };
      compiledPrompt = await PromptEnhanceTool.execute({
        ...prepared.compileInput,
        referenceContext,
        onChunk: agent._thinkingStream(),
      });
      if (compiledPrompt.aiFailure) {
        throw new Error(compiledPrompt.error || 'Prompt compilation failed');
      }
    }
    const positive = typeof edits.positive === 'string' ? edits.positive.trim() : compiledPrompt.positive;
    if (!positive) throw new Error('Positive prompt cannot be empty');
    compiledPrompt = {
      ...prepared.compiledPrompt,
      ...compiledPrompt,
      positive,
      enhanced: positive,
      negative: typeof edits.negative === 'string' ? edits.negative.trim() : compiledPrompt.negative,
    };
    if (prepared.workflowName) agent.project.set?.('workflow', prepared.workflowName);
    const editIssues = checkEditedPrompt(compiledPrompt, { budgets: agent.project.get('budgets') });
    if (editIssues.length > 0) {
      const known = new Set((compiledPrompt.issues || []).map(issue => issue.detail));
      compiledPrompt.issues = [...(compiledPrompt.issues || []), ...editIssues.filter(issue => !known.has(issue.detail))];
    }
    const result = await agent.run(prepared.userMessage, {
      ...prepared.options,
      workflowManifest: prepared.workflowManifest,
      preparedPlan: prepared.plan,
      compiledPrompt,
      effectiveRequest: prepared.effectiveRequest || prepared.userMessage,
      requestId: prepared.requestId,
      intent: prepared.intent || 'generate',
    });
    agent._preparedRuns.delete(previewId);
    return result;
  } catch (error) {
    prepared.status = 'prepared';
    agent.sessionManager.setSessionState?.({
      preparedPreview: { ...(agent.sessionManager.getSessionState?.().preparedPreview || {}), status: 'prepared' },
      taskStatus: 'awaiting_confirmation',
    });
    throw error;
  }
}

export async function prepareGeneration(agent, userMessage, options = {}) {
  if (options.turnId) initTurn(options.turnId);
  const queued = agent._enqueue(() => prepareGeneration(agent, userMessage, options));
  if (queued) return queued;
  if (agent._state === 'awaiting_confirmation') {
    throw new Error('有待确认的生成预览，请先确认或取消当前预览。');
  }
  agent._running = true;
  agent._cancelRequested = false;
  if (options.projectId) agent.projectId = options.projectId;
  if (options.sessionId) agent.sessionId = options.sessionId;
  agent._taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  agent._requestId = options.requestId || newRequestId();
  agent._traceId = nextTraceId();
  agent.taskManager?.create?.({ id: agent._taskId, requestId: agent._requestId, kind: 'run', message: options.effectiveRequest || userMessage, traceId: agent._traceId, intent: options.intent || 'generate', projectId: agent.sessionManager.activeProjectId, sessionId: agent.sessionManager.activeSessionId });
  if (agent._state !== 'classifying') agent._transitionState('classifying', { message: 'Classifying request...' });
  try {
    const request = options.effectiveRequest || userMessage;
    const intent = options.intent || (/(图生图|img2img|局部重绘|inpaint|换背景|参考图)/i.test(request) ? 'edit' : 'generate');
    if (!agent.llm?.isConfigured) {
      const failure = aiFailure(request, 'AI generation requires a configured language model');
      agent.taskManager?.complete?.(agent._taskId, { error: { message: failure.error, stage: 'ai' } });
      agent._transitionState('failed', { lastError: failure.error, message: failure.error });
      return failure;
    }
    const previousImages = agent._lastImagesAsMedia();
    const readiness = options.readiness || assessPromptReadiness({
      request,
      intent,
      media: options.media,
      lastImages: previousImages,
      lastPrompt: agent.project.get('lastPrompt') || '',
      conversation: Array.isArray(agent.conversation.messages) ? agent.conversation.messages.slice(-8) : [],
    });
    if (readiness.readiness === 'clarify') {
      const decision = {
        intent,
        request,
        missing: readiness.missing,
        question: readiness.question,
      };
      const result = agent.clarify(userMessage, {
        ...decision,
        sourceTurnId: options.turnId || '',
        skipUserMessage: Boolean(options.turnId),
      });
      return { action: 'clarify', ...result, readiness };
    }

    if (!options.turnId) agent._writeTurnMessage('user', userMessage, { intent, action: 'prepare', attachments: messageAttachmentsOf(agent, options.media) });

    const previousWorkflow = agent._lastManifest?.workflowName || agent.project.get('workflow');
    let currentWorkflow = options.workflowName || previousWorkflow;
    let workflowManifest = options.workflowManifest
      || (agent._lastManifest?.workflowName === currentWorkflow ? agent._lastManifest : null);
    if (!workflowManifest && currentWorkflow && agent.workflowDir) {
      try {
        workflowManifest = await ComfyUITool.inspectWorkflow(currentWorkflow, agent.workflowDir);
      } catch (error) {
        const wrapped = new Error(`工作流「${currentWorkflow}」解析失败：${error.message}。请确认 ComfyUI 已启动且工作流文件可用。`);
        wrapped.failureType = 'workflow_inspect_failed';
        wrapped.retryable = true;
        wrapped.cause = error;
        throw wrapped;
      }
    }
    const selection = await agent._selectWorkflowForRequest(request, intent, options, currentWorkflow, workflowManifest);
    currentWorkflow = selection.workflowName;
    workflowManifest = selection.workflowManifest;
    if (!workflowManifest && currentWorkflow && agent.workflowDir) {
      try {
        workflowManifest = await ComfyUITool.inspectWorkflow(currentWorkflow, agent.workflowDir);
      } catch (error) {
        const wrapped = new Error(`工作流「${currentWorkflow}」解析失败：${error.message}。请确认 ComfyUI 已启动且工作流文件可用。`);
        wrapped.failureType = 'workflow_inspect_failed';
        wrapped.retryable = true;
        wrapped.cause = error;
        throw wrapped;
      }
    }
    if (!workflowManifest) {
      const error = new Error(`无法解析所选工作流「${currentWorkflow || '未选择'}」，无法开始生成`);
      error.failureType = 'workflow_inspect_failed';
      error.retryable = true;
      throw error;
    }
    if (workflowManifest.modelReady === false) {
      const missing = (workflowManifest.missingModels || workflowManifest.modelRequirements || [])
        .filter(item => item.available === false)
        .map(item => item.value);
      const error = new Error(`Workflow model files are missing: ${missing.join(', ')}`);
      error.failureType = 'model_missing';
      error.retryable = false;
      throw error;
    }
    agent._lastManifest = workflowManifest;
    agent.project.set?.('workflow', currentWorkflow);
    agent.sessionManager.setSessionMemory?.({
      activeGoal: request,
      currentWorkflow,
      style: agent.project.get('style') || '',
      unresolvedItems: readiness.missing || [],
    });

    const attachedMedia = {
      ...(options.media || {}),
      images: options.media?.images?.length ? options.media.images : intent === 'edit' ? previousImages : options.media?.images || [],
    };
    // 准备阶段（规划 + 提示词编译）总时限。单次 LLM 调用超时兜底后，
    // 多次重试仍可能串联超过预期时间；若到达该时限仍未完成，强制失败，
    // 保证前端永远收到终态而不是无限停留在"正在准备"。
    const PREPARE_DEADLINE_MS = 150000;
    const prepareDeadlineError = new Error('生成准备超时（150 秒）：语言模型服务长时间无响应，请检查模型配置或网络后重试。');
    prepareDeadlineError.code = 'LLM_TIMEOUT';
    const deadlineController = new AbortController();
    let deadlineTimer;
    const prepareDeadlinePromise = new Promise((_, reject) => {
      deadlineTimer = setTimeout(() => {
        deadlineController.abort(prepareDeadlineError);
        reject(prepareDeadlineError);
      }, PREPARE_DEADLINE_MS);
    });
    agent._transitionState('planning', { message: 'Planning task...' });
    const ctx = buildAgentContext(request, {
      conversation: agent._conversationForLLM(6),
      project: {
        currentCharacter: agent.project.get('character'),
        currentStyle: agent.project.get('style'),
        currentModel: agent.project.get('model'),
        currentWorkflow,
        lastPrompt: agent.project.get('lastPrompt'),
        promptMode: agent.promptMode,
        budgets: agent.project.get('budgets') || null,
        confirmedConstraints: agent.project.get('confirmedConstraints') || {},
        commonParameters: agent.project.get('commonParameters') || {},
        savedPreferences: agent.project.get('savedPreferences') || {},
        researchSettings: agent.project.get('researchSettings') || {},
      },
      availableWorkflows: agent._listWorkflows(),
      workflowDir: agent.workflowDir,
      previousArtifacts: agent._artifacts.slice(-5),
      workflowManifest,
      attachedMedia,
    });
    ctx.eventMeta = {
      taskId: agent._taskId,
      traceId: agent._traceId,
      turnId: options.turnId || '',
      ...(agent.projectId ? { projectId: agent.projectId } : {}),
      ...(agent.sessionId ? { sessionId: agent.sessionId } : {}),
    };
    ctx.filesystemRoots = agent._filesystemRoots();
    ctx.comfyRoot = agent.comfyRoot;
    const planStart = Date.now();
    let planOutcome = 'completed';
    emitTiming('plan_start', {
      ...ctx.eventMeta,
      timingPhase: 'plan',
      message: '规划中',
    });
    let plan;
    try {
      plan = await Promise.race([agent.planner.createPlan(request, { ...ctx, signal: deadlineController.signal }), prepareDeadlinePromise]);
    } catch (error) {
      planOutcome = timingOutcome(error);
      clearTimeout(deadlineTimer);
      if (agent._cancelRequested || agent._state === 'cancelled' || isCancellationError(error)) {
        return { cancelled: true, taskId: agent._taskId };
      }
      const failure = aiFailure(request, error);
      agent.taskManager?.complete?.(agent._taskId, { error: { message: failure.error, stage: 'ai' } });
      agent._transitionState('failed', { lastError: failure.error, message: failure.error });
      return failure;
    } finally {
      emitTiming('plan_end', {
        ...ctx.eventMeta,
        timingPhase: 'plan',
        duration_ms: Date.now() - planStart,
        outcome: planOutcome,
        message: '规划结束',
      });
    }
    attachMediaToPlan(plan, ctx.attachedMedia);
    if (agent._cancelRequested) return { cancelled: true, taskId: agent._taskId };
    // 在编译提示词之前先跑角色调研（若计划含 web 步骤），确保外观事实
    // 能作为 referenceContext 进入编译器；同时移除已消费的 web 步骤，
    // 避免确认后执行阶段再重复调研。
    // 规划器没输出 web 步骤时，只要意图路由器判定需要研究或启发式命中
    // 角色外观请求，也强制调研——恢复 v0.3.6「出图路径保证调研」的语义。
    const researchForced = options.execution?.needsResearch === true || shouldResearchCharacter(request, intent);
    await researchCharacterIfPlanned(agent, plan, ctx, request, { force: researchForced });
    agent._transitionState('planning', {
      message: intent === 'refine'
        ? '正在根据修改要求编译提示词...'
        : '正在根据执行计划编译提示词...',
    });
    const compileController = new AbortController();
    agent._promptCompileController = compileController;
    const enhanceStep = plan.steps.find(step => step.tool === 'prompt_enhance');
    const profile = workflowManifest.promptProfile || {};
    let enhanceMode = enhanceStep?.input?.mode || 'raw';
    const researchHasFacts = Boolean(ctx.characterResearch && APPEARANCE_FIELDS.some(field => String(ctx.characterResearch[field] || '').trim()));
    if (ctx.characterResearch?.sources?.length > 0 || researchHasFacts) {
      enhanceMode = 'anime-character';
    } else if (ctx.characterResearch && !enhanceStep) {
      // raw 模式 + 计划里含 web 调研步骤：把编译模式提升为 anime-character，
      // 让「无资料也要补全完整外观」的降级规则生效，而不是被 raw 的「保持原样」压掉。
      enhanceMode = 'anime-character';
    }
    const compileInput = {
      prompt: request,
      mode: enhanceMode,
      modelType: workflowManifest.modelType,
      promptProfile: profile,
      existingNegative: agent.project.get('lastCompiledPrompt')?.negative || profile.currentNegative || '',
      constraints: enhanceStep?.input?.constraints || {},
      customInstruction: enhanceStep?.input?.customInstruction,
      budgets: enhanceStep?.input?.budgets || agent.project.get('budgets') || undefined,
      conversation: ctx.conversation,
       contextPrompt: intent === 'refine' || intent === 'edit' ? agent.project.get('lastPrompt') || '' : '',
      intent,
      referenceContext: ctx.characterResearch,
      referenceImages: attachedMedia.images || [],
      imageDataUrl: image => ComfyUITool.client.imageDataUrl(image),
      llmProvider: agent.llm?.isConfigured ? agent.llm : undefined,
      onChunk: agent._thinkingStream(),
      requireAI: true,
      allowPolicyOverride: options.allowPolicyOverride === true,
      signal: compileController.signal,
      eventMeta: ctx.eventMeta,
      onTiming: event => emitTiming(event.stage, {
        ...ctx.eventMeta,
        ...event,
        scope: 'timing',
      }),
    };
    const enhanceStart = Date.now();
    let enhanceOutcome = 'completed';
    emitTiming('enhance_start', {
      ...ctx.eventMeta,
      timingPhase: 'enhance',
      message: '提示词增强中',
    });
    let compiledPrompt;
    try {
      compiledPrompt = await Promise.race([PromptEnhanceTool.execute(compileInput), prepareDeadlinePromise]);
      if (compiledPrompt?.aiFailure) enhanceOutcome = 'error';
    } catch (error) {
      enhanceOutcome = timingOutcome(error);
      throw error;
    } finally {
      clearTimeout(deadlineTimer);
      if (enhanceOutcome === 'completed' && (agent._cancelRequested || compileController.signal.aborted)) {
        enhanceOutcome = 'cancelled';
      }
      if (agent._promptCompileController === compileController) agent._promptCompileController = null;
      emitTiming('enhance_end', {
        ...ctx.eventMeta,
        timingPhase: 'enhance',
        duration_ms: Date.now() - enhanceStart,
        outcome: enhanceOutcome,
        message: '提示词增强结束',
      });
    }
    if (compiledPrompt?.cancelled || agent._cancelRequested || compileController.signal.aborted) {
      return { cancelled: true, taskId: agent._taskId };
    }
    if (compiledPrompt.aiFailure) {
      const failure = aiFailure(request, compiledPrompt.error);
      if (compiledPrompt.code) failure.code = compiledPrompt.code;
      if (compiledPrompt.policyDecision) failure.policyDecision = compiledPrompt.policyDecision;
      agent.taskManager?.complete?.(agent._taskId, { error: { message: failure.error, stage: 'ai' } });
      agent._transitionState('failed', { lastError: failure.error, message: failure.error });
      return failure;
    }

    emit(AgentEventTypes.TRACE, {
      stage: 'prompt_interpretation',
      rawInput: userMessage,
      interpretedPrompt: compiledPrompt.sourcePrompt || userMessage,
      promptResolved: compiledPrompt.promptResolved || false,
      promptResult: {
        positive: compiledPrompt.positive || '',
        negative: compiledPrompt.negative || '',
        tags: compiledPrompt.tags || [],
        issues: compiledPrompt.issues || [],
        referenceSources: ctx.characterResearch?.sources || [],
        appearanceFacts: ctx.characterResearch ? {
          hair: ctx.characterResearch.hair || '',
          eyes: ctx.characterResearch.eyes || '',
          outfit: ctx.characterResearch.outfit || '',
          accessories: ctx.characterResearch.accessories || '',
          silhouette: ctx.characterResearch.silhouette || '',
          evidence: ctx.characterResearch.evidence || [],
        } : null,
        researchStatus: ctx.characterResearch?.researchStatus || '',
        researchMessage: ctx.characterResearch?.researchMessage || '',
      },
    });

    plan.steps = plan.steps.filter(step => step.tool !== 'prompt_enhance');
    // 删除提示词增强步骤后，其余步骤可能残留对它的 depends_on 引用，
    // 二次校验会报 "depends_on: unknown step"，需同步清理悬空依赖。
    const remainingStepIds = new Set(plan.steps.map(step => step.id));
    for (const step of plan.steps) {
      if (Array.isArray(step.depends_on)) {
        step.depends_on = step.depends_on.filter(id => remainingStepIds.has(id));
      }
    }
    // LLM 计划里写的工作流名没有能力检测依据，统一对齐到按模式匹配
    // 选出的工作流，保证预览（preview.workflowName）与执行完全一致。
    for (const step of plan.steps) {
      if (step.tool === 'comfyui' && step.input) step.input.workflowName = currentWorkflow;
    }
    for (const step of plan.steps) {
      if (step.tool === 'comfyui') {
        step.input.compiledPrompt = compiledPrompt;
        const canonical = normalizeRuntimeParameters({
          workflowName: step.input.workflowName || currentWorkflow,
          workflowDir: step.input.workflowDir || agent.workflowDir || options.workflowDir || '',
          prompt: compiledPrompt.positive,
          prompts: compiledPrompt.positivePrompts,
          negativePrompt: compiledPrompt.negative,
          settings: { ...(options.settings || {}), ...(step.input.settings || {}) },
          nodeOverrides: { ...(options.nodeOverrides || {}), ...(step.input.nodeOverrides || {}) },
          images: step.input.images || ctx.attachedMedia?.images,
          masks: step.input.masks || ctx.attachedMedia?.masks,
          videos: step.input.videos || ctx.attachedMedia?.videos,
          outputNodeIds: step.input.outputNodeIds,
        });
        step.input.frozenRuntimeRequest = freezeRuntimeRequest(canonical);
        step.input.requestDigest = runtimeRequestDigest(step.input.frozenRuntimeRequest);
      }
    }
    if (!plan.steps.some(step => step.tool === 'comfyui')) throw new Error('The prepared plan has no ComfyUI execution step');
    agent.taskManager?.recordPlan?.(agent._taskId, plan);

    const previewId = `preview_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const confirmation = confirmationForPlan(plan, {
      tools: agent.tools || {},
      workflowName: currentWorkflow,
      previousWorkflow,
      settings: options.settings,
      nodeOverrides: options.nodeOverrides,
    });
    // Bind the confirmation to this exact prepared operation: the digest is
    // computed over the plan's frozen runtime inputs (prompt, settings,
    // media, outputs) and the request id, and must be echoed back verbatim
    // when the preview is executed (see runPrepared).
    const requestDigest = runtimeRequestDigest({
      requestId: agent._requestId,
      steps: plan.steps.map(step => ({ tool: step.tool, input: step.input.frozenRuntimeRequest || step.input })),
    });
    agent._preparedRuns.clear();
    agent._preparedRuns.set(previewId, {
      userMessage,
      effectiveRequest: request,
      intent,
      plan,
      compiledPrompt,
      workflowManifest,
      options,
      workflowName: currentWorkflow,
      confirmation,
      compileInput,
      requestId: agent._requestId,
      requestDigest,
      status: 'prepared',
    });
    agent._transitionState('awaiting_confirmation', {
      message: 'Awaiting confirmation',
      needsConfirmation: true,
    });
    agent.sessionManager.setSessionState?.({
      lastIntent: intent,
      pending: null,
      pendingIntent: { intent, action: 'prepare', target: 'new', sourceTurnId: options.turnId || '' },
      pendingRequest: request,
    });
    const targets = (profile.promptLists || []).flatMap(target => target.inputs.map(input => ({ nodeId: target.nodeId, input, polarity: 'positive' })));
    if (targets.length === 0) targets.push(...(profile.positiveTargets || []).map(target => ({ ...target, polarity: 'positive' })));
    if (profile.supportsNegative) targets.push(...(profile.negativeTargets || []).map(target => ({ ...target, polarity: 'negative' })));

    const preview = {
      previewId,
      status: 'prepared',
      requestId: agent._requestId,
      requestDigest,
      workflowName: currentWorkflow,
      source: 'ai',
      origin: 'agent',
      model: promptProfileLabel(profile),
      modelType: profile.family || workflowManifest.modelType || 'generic',
      format: profile.format || 'narrative',
      tags: compiledPrompt.tags || [],
      narrative: compiledPrompt.narrative || '',
      interpretedPrompt: compiledPrompt.sourcePrompt || userMessage,
      promptResolved: compiledPrompt.promptResolved || false,
      positive: compiledPrompt.positive || '',
      negative: compiledPrompt.negative || '',
      supportsNegative: profile.supportsNegative !== false,
      constraints: compiledPrompt.constraints || {},
      issues: compiledPrompt.issues || [],
      positiveTruncated: compiledPrompt.positiveTruncated || false,
      negativeTruncated: compiledPrompt.negativeTruncated || false,
      droppedPositive: compiledPrompt.droppedPositive || [],
      droppedNegative: compiledPrompt.droppedNegative || [],
      targets,
      readiness,
      warnings: [...(readiness.warnings || []), ...researchWarnings(ctx.characterResearch)],
      error: compiledPrompt.error,
      confirmation,
      research: researchPreview(ctx.characterResearch),
    };
    agent.sessionManager.setSessionState?.({
      preparedPreview: preview,
      pending: { kind: 'preview', previewId, request, turnId: options.turnId || '' },
      taskStatus: 'awaiting_confirmation',
      needsConfirmation: true,
    });
    return preview;
  } catch (error) {
    if (agent._cancelRequested || agent._state === 'cancelled' || isCancellationError(error)) {
      return { cancelled: true, taskId: agent._taskId };
    }
    agent.taskManager?.complete?.(agent._taskId, { error: { message: error.message, stage: 'prepare' } });
    if (agent._state !== 'cancelled' && agent._state !== 'failed') {
      agent._transitionState('failed', { lastError: error.message, message: error.message });
    }
    agent.sessionManager.setSessionState?.({
      taskStatus: 'failed',
      taskFailure: { message: error.message, taskId: agent._taskId, stage: 'prepare' },
      retryAction: { type: 'retry_prepare', request: options.effectiveRequest || userMessage },
    });
    throw error;
  } finally {
    agent._running = false;
    await agent._drainQueue();
  }
}

// messageAttachments normalization used by the prepare path (kept local to
// avoid importing the chat-intents helpers into the preparation module).
function messageAttachmentsOf(media = {}) {
  const source = media && typeof media === 'object' ? media : {};
  return [
    ...(source.images || []).map(item => ({ name: item?.name || item?.path?.split(/[\\/]/).pop() || '', kind: 'image' })),
    ...(source.videos || []).map(item => ({ name: item?.name || item?.path?.split(/[\\/]/).pop() || '', kind: 'video' })),
  ].filter(item => item.name);
}
