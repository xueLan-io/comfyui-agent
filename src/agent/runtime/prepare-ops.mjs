// Generation/file/workflow preparation and prepared-run execution subsystem,
// extracted from agent.mjs. Functions operate on the agent and are
// behavior-preserving moves; the Agent methods delegate here one line each.
// Internal calls go back through agent instance methods so subclass/test
// overrides keep working.

import { initTurn, nextTraceId } from '../events/agent-events.mjs';
import { buildAgentContext } from '../schemas/context-schema.mjs';
import { validatePlan } from '../schemas/plan-schema.mjs';
import { confirmationForPlan } from '../schemas/confirmation-schema.mjs';
import { PromptEnhanceTool } from '../tools/prompt/enhance.mjs';
import { checkEditedPrompt } from '../optimizer/prompt-guard.mjs';
import { assertConfirmationBinding } from '../../runtime/governance/operation-gateway.mjs';
import { WorkflowMutationPreviewTool, WorkflowMutationCommitTool } from '../tools/comfyui/workflow-mutation-tools.mjs';

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
