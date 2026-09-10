// Execution loop, retry orchestration, and result recording subsystem,
// extracted from agent.mjs. Functions operate on the agent (runtime) and are
// behavior-preserving moves: the Agent methods delegate here one line each.

import { randomInt } from 'node:crypto';import { emit, AgentEventTypes } from '../events/agent-events.ts';
import { classifyFailure, diffParameters } from '../optimizer/retry-policy.mjs';
import { attachMediaToPlan } from './planner.ts';
import { PromptEnhanceTool } from '../tools/prompt/enhance.mjs';
import type { AgentPlan, PlanStep } from '../schemas/plan-schema.ts';
import type { StepExecutionResult } from './executor.ts';

export function backoffDelay(attempt: number, signal?: AbortSignal): Promise<void> {
  const base = Math.min(1000 * 2 ** (attempt - 1), 8000);
  const jitter = Math.floor(Math.random() * Math.min(base, 1000));
  const ms = base + jitter;
  if (!signal) return new Promise(resolve => setTimeout(resolve, ms));
  // 重试间隔是执行链里最长的不可中断等待（最长约 9 秒）；不感知取消时，
  // cancel 后新任务已启动、旧流程还会从睡眠中醒来改写共享状态。
  return new Promise((resolve, reject) => {
    const abortError = () => {
      const reason = signal.reason;
      if (reason instanceof Error) return reason;
      const error = new Error(String(reason || 'cancelled'));
      error.name = 'AbortError';
      return error;
    };
    if (signal.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function resultSummary(agent: any, result: any): Record<string, any> {
  if (!result || typeof result !== 'object') return {};
  return {
    promptId: result.promptId || '',
    imageCount: Array.isArray(result.images) ? result.images.length : 0,
    videoCount: Array.isArray(result.videos) ? result.videos.length : 0,
    mediaCount: Array.isArray(result.media) ? result.media.length : 0,
    status: result.executionStatus || result.status || '',
    workflowName: result.workflowName || '',
  };
}

export function recordGenerationArtifact(agent: any, result: any, compiledPrompt: Record<string, any> = {}, metadata: Record<string, any> = {}): Record<string, any> | null {
  if (!result || typeof result !== 'object') return null;
  const memory = agent.sessionManager.getSessionMemory?.() || {};
  const artifact = {
    artifactId: `artifact_${Date.now()}_${randomInt(36 ** 6).toString(36).padStart(6, '0')}`,
    taskId: metadata.taskId || agent._taskId,
    promptVersion: (Number(memory.currentPromptVersion) || 0) + 1,
    positive: compiledPrompt?.positive || result.positive || result.enhanced || agent.project.get('lastPrompt') || '',
    negative: compiledPrompt?.negative || result.negative || '',
    constraints: compiledPrompt?.constraints || result.constraints || {},
    workflow: metadata.workflow || result.workflowName || agent.project.get('workflow') || '',
    parameters: metadata.parameters || {},
    images: Array.isArray(result.images) ? result.images : [],
    videos: Array.isArray(result.videos) ? result.videos : [],
    media: Array.isArray(result.media) ? result.media : [],
    createdAt: Date.now(),
  };
  agent.sessionManager.setSessionMemory?.({
    activeGoal: metadata.intent || memory.activeGoal || '',
    currentArtifactId: artifact.artifactId,
    currentPromptVersion: artifact.promptVersion,
    generationHistory: [...(memory.generationHistory || []), artifact].slice(-50),
    currentWorkflow: artifact.workflow,
    lastParameters: artifact.parameters,
    confirmedConstraints: artifact.constraints,
  });
  agent.sessionManager.setSessionState?.({ currentArtifactId: artifact.artifactId });
  return artifact;
}

export function recordArtifact(agent: any, result: any, metadata: Record<string, any> = {}): Record<string, any> | null {
  return recordGenerationArtifact(agent, result, metadata.compiledPrompt || {}, metadata);
}

export async function replanPlan(agent: any, plan: AgentPlan, stepIndex: number, step: PlanStep, output: StepExecutionResult, ctx: Record<string, any>, completedSteps: any[]): Promise<AgentPlan | null> {
  if (agent._replanCount >= agent._maxReplans) return null;
  agent._transitionState('replanning', {
    currentStep: step.id,
    lastError: output.failure?.reason || output.error,
    message: 'Replanning remaining steps',
  });
  const completedIds = new Set(completedSteps.map(item => item.id));
  const workflow = ctx.workflowManifest || {};
  try {
    const replanned = await agent.planner.replan({
      userGoal: ctx.userRequest,
      completedSteps,
      currentError: output.failure?.reason || output.error,
      failureType: output.failure?.type || '',
      workflow: {
        name: workflow.workflowName || ctx.project?.currentWorkflow || '',
        modelType: workflow.modelType || '',
        outputNodes: (workflow.outputNodes || []).map((node: any) => ({ id: node.id, type: node.type })),
        promptProfile: {
          family: workflow.promptProfile?.family || '',
          supportsNegative: workflow.promptProfile?.supportsNegative,
        },
      },
      resultSummary: agent._resultSummary(output.result),
      remainingSteps: plan.steps.slice(stepIndex).map(item => ({
        id: item.id,
        tool: item.tool,
        description: item.description,
        expected_output: item.expected_output,
      })),
    }, {
      tools: agent.tools,
      workflowDir: agent.workflowDir,
      availableWorkflows: ctx.availableWorkflows,
      workflowManifest: ctx.workflowManifest,
      eventMeta: ctx.eventMeta,
    });
    // 重规划期间运行可能已被取消并被新任务取代；不得再写任务记录。
    if (ctx.runEpoch !== undefined && ctx.runEpoch !== agent._runEpoch) return null;
    attachMediaToPlan(replanned, ctx.attachedMedia);
    // 重规划产出的 web 调研步骤在这里剥离：调研只应由规划前的预消费阶段
    //（researchCharacterIfPlanned）执行，执行阶段再跑会阻塞链条；
    // run-flow 对残留 web 步骤失败另有「按可选跳过」的兜底。
    const remainingSteps = replanned.steps
      .filter((item: any) => !completedIds.has(item.id) && item.tool !== 'web');
    const remainingIds = new Set(remainingSteps.map((item: any) => item.id).filter(Boolean));
    const steps = remainingSteps
      .map((item: any) => ({ ...item, depends_on: (item.depends_on || []).filter((id: any) => !completedIds.has(id) && remainingIds.has(id)) }));
    if (steps.length === 0) return null;
    agent._replanCount++;
    agent.taskManager.update(agent._taskId, { replanCount: agent._replanCount });
    agent.taskManager.recordReplan(agent._taskId, {
      attempt: agent._replanCount,
      failedStep: step.id,
      error: output.error || '',
      plan: { ...replanned, steps },
      createdAt: Date.now(),
    });
    emit(AgentEventTypes.TASK, { taskId: agent._taskId, action: 'replanned', replanCount: agent._replanCount, traceId: agent._traceId });
    agent._transitionState('executing', { message: 'Executing replanned steps', lastError: '' });
    return { ...replanned, steps };
  } catch (error) {
    const err = error as Error;
    agent.taskManager.recordReplan(agent._taskId, {
      attempt: agent._replanCount + 1,
      failedStep: step.id,
      error: err.message,
      createdAt: Date.now(),
    });
    return null;
  }
}

// Retry rotations write ctx.executionSettings/ctx.compiledPrompt, which the
// executor reads only for non-frozen steps — frozen steps replay their baked
// snapshot verbatim. Sync the snapshot so retries actually change inputs.
function syncFrozenStepInput(step: PlanStep, ctx: Record<string, any>): void {
  if (step.tool !== 'comfyui' || !step.input?.frozenRuntimeRequest) return;
  const frozen = structuredClone(step.input.frozenRuntimeRequest);
  if (ctx.compiledPrompt?.positive) {
    frozen.prompt = {
      ...(frozen.prompt || {}),
      positive: ctx.compiledPrompt.positive,
      negative: typeof ctx.compiledPrompt.negative === 'string' ? ctx.compiledPrompt.negative : (frozen.prompt?.negative || ''),
    };
  }
  if (ctx.executionSettings && Object.keys(ctx.executionSettings).length > 0) {
    frozen.settings = { ...(frozen.settings || {}), ...ctx.executionSettings };
  }
  step.input.frozenRuntimeRequest = frozen;
}

export async function executeWithRetry(agent: any, step: PlanStep, ctx: Record<string, any>): Promise<any> {
  // 本步所属运行的代际。cancel() 提前置 _running=false 后新任务可立即启动
  // （agent._taskId/_state 已易主）；旧运行的 await 恢复后不得再写共享状态。
  const superseded = () => ctx.runEpoch !== undefined && ctx.runEpoch !== agent._runEpoch;
  agent._currentAttemptId = agent.taskManager.beginAttempt(agent._taskId, { stepId: step.id, attempt: 1 })?.attemptId || '';
  ctx.attemptId = agent._currentAttemptId;
  ctx.currentAttempt = 1;
  let output = await agent.executor.executeStep(step, ctx);
  if (superseded()) return { superseded: true };
  let attempt = 1;
  agent._recordStepAttempt(step, output, attempt, ctx);
  if (agent._taskId) {
    agent._transitionState('observing', {
      currentStep: step.id,
      currentAttempt: 1,
      promptId: output.result?.promptId || ctx.lastPromptId || '',
      lastError: output.error || '',
      message: 'Observing result',
    });
  }
  for (;;) {
    // 取消竞态：取消标志已置位但本步已抢救回真实结果（生成已完成）时，
    // 不应把成果当作 skipped 丢弃。
    if (output.skipped || (agent.executor.cancelled && !(output.result?.media?.length > 0))) {
      return output.skipped ? output : { skipped: true, reason: 'cancelled' };
    }

    const decision = ctx.executionPolicy?.retry === false
      ? { action: 'accept', shouldRetry: false }
      : await agent._retryDecision(step, ctx, output, attempt);
    if (superseded()) return { superseded: true };
    if (!decision.shouldRetry) {
      if (decision.exhausted && decision.failureType === 'empty_output') {
        return {
          error: 'ComfyUI completed without a valid image output after retry limit',
          failure: { type: 'empty_output', retryable: false, reason: decision.modification },
        };
      }
      return output;
    }
    if (agent.executor.cancelled) return { skipped: true, reason: 'cancelled' };

    if (agent._taskId) {
      agent._transitionState('retrying', {
        currentStep: step.id,
        currentAttempt: decision.attempt + 1,
        lastError: decision.modification,
        message: `Retrying ${step.id}`,
      });
    }

    const before = agent._retryParameters(step, ctx);
    const previousPositive = output.result?.compiledPrompt?.positive || ctx.compiledPrompt?.positive || ctx.enhancedPrompt || '';
    if (decision.action === 'rewrite_prompt') {
      const recompiled = await agent._recompilePrompt(ctx, decision);
      if (superseded()) return { superseded: true };
      if (recompiled?.positive && recompiled.positive !== previousPositive) {
        ctx.compiledPrompt = recompiled;
      } else {
        agent._rotateRetryParameters(ctx, decision);
      }
    } else {
      agent._rotateRetryParameters(ctx, decision);
    }
    syncFrozenStepInput(step, ctx);
    if (agent.executor.cancelled) return { skipped: true, reason: 'cancelled' };

    const after = agent._retryParameters(step, ctx);
    emit(AgentEventTypes.STATUS, {
      status: 'retrying',
      uiStatus: 'running',
      state: 'retrying',
      message: `Retry ${decision.attempt}/${decision.maxTaskRetries}: ${decision.modification}`,
      taskId: agent._taskId,
      traceId: agent._traceId,
      requestId: agent._requestId,
      stepId: step.id,
      retry: {
        reason: decision.modification,
        failureType: decision.failureType || decision.ruleId || 'evaluation',
        attempt: decision.attempt,
        taskAttempt: decision.taskAttempt,
        parameterChanges: diffParameters(before, after),
      },
    });
    agent.taskManager.recordRetry(agent._taskId, {
      stepId: step.id,
      reason: decision.modification,
      failureType: decision.failureType || decision.ruleId || 'evaluation',
      attempt: decision.attempt,
      taskAttempt: decision.taskAttempt,
      parameterChanges: diffParameters(before, after),
      createdAt: Date.now(),
    });
    if (agent._taskId) agent._transitionState('executing', { currentStep: step.id, currentAttempt: decision.attempt + 1, message: 'Executing retry' });
    await backoffDelay(attempt, agent.executor.runSignal);
    if (superseded()) return { superseded: true };
    agent._currentAttemptId = agent.taskManager.beginAttempt(agent._taskId, { stepId: step.id, attempt: attempt + 1 })?.attemptId || '';
    ctx.attemptId = agent._currentAttemptId;
    ctx.currentAttempt = attempt + 1;
    output = await agent.executor.executeStep(step, ctx);
    if (superseded()) return { superseded: true };
    attempt++;
    agent._recordStepAttempt(step, output, attempt, ctx);
    if (agent._taskId) agent._transitionState('observing', {
      currentStep: step.id,
      currentAttempt: decision.attempt + 1,
      promptId: output.result?.promptId || ctx.lastPromptId || '',
      lastError: output.error || '',
      message: 'Observing retry result',
    });
  }
}

export async function retryDecision(agent: any, step: PlanStep, ctx: Record<string, any>, output: StepExecutionResult, attempt = 1): Promise<any> {
  const policyContext = { stepId: step.id, tool: step.tool, action: step.input?.action, toolContract: agent.tools[step.tool] };
  if (output.error) {
    const failure = output.failure || classifyFailure(output.error, policyContext);
    return agent.retryPolicy.evaluateFailure(failure, policyContext);
  }

  if (step.tool !== 'comfyui') return { action: 'accept', shouldRetry: false };
  const images = output.result?.images;
  if (!Array.isArray(images) || images.length === 0) {
    return agent.retryPolicy.evaluateFailure({
      type: 'empty_output',
      retryable: true,
      reason: 'ComfyUI completed without a valid image output',
    }, policyContext);
  }

  if (ctx.executionPolicy?.evaluate === false) return { action: 'accept', shouldRetry: false };
  const evaluation = await agent.evaluator.evaluate(
    output.result,
    ctx.userRequest,
    { stepId: step.id },
    { promptIssues: agent._collectPromptIssues(output.result), skipVision: attempt >= 2 },
  );
  return agent.retryPolicy.evaluate(evaluation, policyContext);
}

export function retryParameters(agent: any, step: PlanStep, ctx: Record<string, any>): Record<string, any> {
  return {
    workflowName: step.input?.workflowName || ctx.project?.currentWorkflow || '',
    prompt: ctx.compiledPrompt?.positive || ctx.enhancedPrompt || step.input?.prompt || ctx.userRequest || '',
    negative: ctx.compiledPrompt?.negative || '',
    settings: { ...(step.input?.settings || {}), ...(ctx.executionSettings || {}) },
  };
}

export function rotateRetryParameters(ctx: Record<string, any>, decision: any): void {
  if (ctx._retryParamIndex === undefined) ctx._retryParamIndex = 0;
  const index = ctx._retryParamIndex;
  ctx.executionSettings = { ...(ctx.executionSettings || {}), seed: randomInt(2 ** 32) };
  if (decision.attempt >= 2 && (decision.failureType === 'empty_output' || decision.failureType !== 'comfyui_transient')) {
    const common = ctx.workflowManifest?.commonSettings || {};
    const settings = { ...ctx.executionSettings };
    if (index >= 1) settings.sampler = ['euler_ancestral', 'dpmpp_2m_sde', 'uni_pc'].find(item => item !== (settings.sampler || common.sampler)) || 'euler_ancestral';
    if (index >= 2) settings.scheduler = ['normal', 'karras', 'exponential'].find(item => item !== (settings.scheduler || common.scheduler)) || 'normal';
    ctx.executionSettings = settings;
  }
  ctx._retryParamIndex = (index + 1) % 3;
}

export function recordStepAttempt(agent: any, step: PlanStep, output: StepExecutionResult, attempt: number, ctx: Record<string, any>): void {
  if (!agent._taskId) return;
  agent.taskManager.recordStep(agent._taskId, {
    stepId: step.id,
    tool: step.tool,
    description: step.description,
    input: step.input || {},
    attempt,
    attemptId: agent._currentAttemptId,
    promptId: output.result?.promptId || ctx.lastPromptId || '',
    status: output.skipped ? 'skipped' : output.error ? 'failed' : 'completed',
    result: resultSummary(agent, output.result),
    error: output.error || null,
    duration_ms: output.duration_ms || 0,
    completedAt: Date.now(),
  });
  if (agent._currentAttemptId) {
    agent.taskManager.updateAttempt(agent._taskId, agent._currentAttemptId, {
      promptId: output.result?.promptId || ctx.lastPromptId || '',
      phase: output.skipped ? 'cancelled' : output.failure?.type === 'submit_unknown' ? 'submit_unknown' : output.error ? 'failed' : 'completed',
      observedAt: Date.now(),
    });
  }
  void agent.taskManager.persist();
}

export async function recompilePrompt(agent: any, ctx: Record<string, any>, decision: any): Promise<any> {
  const current = ctx.compiledPrompt || {};
  return PromptEnhanceTool.execute({
    prompt: ctx.userRequest,
    mode: current.mode || agent.promptMode,
    modelType: current.modelType,
    promptProfile: ctx.workflowManifest?.promptProfile || agent._lastManifest?.promptProfile || {},
    existingNegative: current.negative || '',
    constraints: current.constraints || {},
    contextPrompt: current.positive || '',
    intent: 'refine',
    customInstruction: decision.modification
      ? `Rewrite to fix the reported problem: ${decision.modification}`
      : 'Rewrite the prompt to better match the user request',
    budgets: agent.project.get('budgets') || undefined,
    llmProvider: agent.llm?.isConfigured ? agent.llm : undefined,
  });
}

export function collectPromptIssues(agent: any, result: any): any[] {
  return Array.isArray(result?.compiledPrompt?.issues) ? result.compiledPrompt.issues : [];
}

export function collectArtifacts(agent: any, result: any, step: PlanStep): void {
  if (result.artifacts && Array.isArray(result.artifacts)) {
    for (const art of result.artifacts) {
      art.source.taskId = agent._taskId;
      art.source.stepId = step.id;
      agent._artifacts.push(art);
    }
  }
  if (result.promptArtifact) {
    result.promptArtifact.source.taskId = agent._taskId;
    result.promptArtifact.source.stepId = step.id;
    agent._artifacts.push(result.promptArtifact);
  }
}
