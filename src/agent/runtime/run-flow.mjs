// Generation execution orchestration extracted from Agent.
import { attachMediaToPlan } from './planner.mjs';
import { ComfyUITool } from '../tools/comfyui/index.mjs';
import { initTurn, nextTraceId, emit, AgentEventTypes } from '../events/agent-events.mjs';
import { buildAgentContext } from '../schemas/context-schema.mjs';
import { validatePlan } from '../schemas/plan-schema.mjs';
import { messageAttachments } from './chat-intents.mjs';
import { newRequestId } from './prepare-ops.mjs';
import { classifyFailure } from '../optimizer/retry-policy.mjs';
import { normalizeGenerationResult } from '../../runtime/generation-contract.mjs';
import { researchCharacterIfPlanned, shouldResearchCharacter } from './research-ops.mjs';
import { APPEARANCE_FIELDS } from '../research/appearance.mjs';

export async function run(agent, userMessage, options = {}) {
    if (options.turnId) initTurn(options.turnId);
    const queued = agent._enqueue(() => agent.run(userMessage, options));
    if (queued) return queued;
    agent._running = true;
    agent._cancelRequested = false;
    agent.retryPolicy.reset();
    agent.executor.reset();
    agent._replanCount = 0;
    const effectiveRequest = options.effectiveRequest || userMessage;
    const intent = options.intent || 'generate';
      const preparedTask = Boolean(options.preparedPlan && agent._state === 'awaiting_confirmation' && agent.taskManager.get(agent._taskId));
    if (!preparedTask) {
      agent._taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      agent._requestId = options.requestId || newRequestId();
      agent._traceId = nextTraceId();
      agent.taskManager.create({ id: agent._taskId, requestId: agent._requestId, kind: 'run', message: effectiveRequest, traceId: agent._traceId, intent, projectId: agent.sessionManager.activeProjectId, sessionId: agent.sessionManager.activeSessionId });
    }
    const traceId = agent._traceId || nextTraceId();
    agent._traceId = traceId;
    void agent.taskManager.persist();

    if (!preparedTask) agent._writeTurnMessage('user', userMessage, {
      intent,
      action: 'prepare',
      attachments: messageAttachments(options.media),
    }, options.turnId || '');
    emit(AgentEventTypes.MESSAGE, { role: 'user', content: userMessage, taskId: agent._taskId, traceId });
    if (!preparedTask) agent._transitionState('classifying', { message: 'Processing...' });
    else agent._transitionState('executing', { message: 'Executing confirmed plan', needsConfirmation: false });

    const currentWorkflow = options.workflowName || agent.project.get('workflow');
    let workflowManifest = options.workflowManifest
      || (agent._lastManifest?.workflowName === currentWorkflow ? agent._lastManifest : null);
    if (!workflowManifest && currentWorkflow && agent.workflowDir) {
      try {
        workflowManifest = await ComfyUITool.inspectWorkflow(currentWorkflow, agent.workflowDir);
      } catch {}
    }
    if (workflowManifest) agent._lastManifest = workflowManifest;

    const previousImages = agent._lastImagesAsMedia();
    const attachedMedia = {
      ...(options.media || {}),
      images: options.media?.images?.length ? options.media.images : intent === 'edit' ? previousImages : options.media?.images || [],
    };
    const ctx = buildAgentContext(effectiveRequest, {
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
        commonParameters: agent.project.get('commonParameters') || {},
        savedPreferences: agent.project.get('savedPreferences') || {},
        researchSettings: agent.project.get('researchSettings') || {},
        skillId: options.skillId,
      },
      availableWorkflows: agent._listWorkflows(),
      workflowDir: agent.workflowDir,
      previousArtifacts: agent._artifacts.slice(-5),
      workflowManifest,
      attachedMedia,
      signal: options.signal,
    });
    ctx.filesystemRoots = agent._filesystemRoots();
    ctx.comfyRoot = agent.comfyRoot;
    ctx.signal = options.signal;
    ctx.onProgress = progress => {
        if (progress.promptId) {
        agent._currentPromptId = progress.promptId;
        agent.taskManager.update(agent._taskId, { promptId: progress.promptId });
        if (progress.stage === 'queued') {
          const currentPreview = agent.sessionManager.getSessionState?.().preparedPreview;
          if (currentPreview?.status === 'consuming') agent.sessionManager.setSessionState?.({
            preparedPreview: { ...currentPreview, status: 'submitted' },
            taskStatus: 'submitted',
          });
        }
        if (agent._currentAttemptId) agent.taskManager.updateAttempt(agent._taskId, agent._currentAttemptId, {
          promptId: progress.promptId,
          phase: progress.stage === 'queued' ? 'submitted' : progress.stage === 'completed' ? 'completed' : 'observing',
          ...(progress.stage === 'queued' ? { submittedAt: Date.now() } : {}),
          ...(progress.stage === 'completed' ? { observedAt: Date.now() } : {}),
        });
        agent.sessionManager.setSessionState?.({ promptId: progress.promptId });
        if (progress.stage === 'queued') agent._activePromptIds.add(progress.promptId);
        else if (['completed', 'error', 'interrupted', 'cancelled'].includes(progress.stage)) {
          agent._activePromptIds.delete(progress.promptId);
        }
      }
      emit(AgentEventTypes.PROGRESS, {
        ...progress,
        taskId: agent._taskId,
        traceId,
      });
    };
    ctx.clientId = options.clientId || '';
    ctx.executionSettings = options.settings || {};
    ctx.nodeOverrides = options.nodeOverrides || {};
    ctx.outputNodeIds = options.outputNodeIds || null;
    ctx.compiledPrompt = options.compiledPrompt || null;
    ctx.confirmedFileMutation = options.confirmedFileMutation === true;
    ctx.executionPolicy = options.executionPolicy || { retry: false, evaluate: false, mutatePrompt: false };
    ctx.eventMeta = { taskId: agent._taskId, traceId, turnId: options.turnId || '' };

    try {
      if (!preparedTask) agent._transitionState('planning', { message: 'Planning task...' });
      let plan = options.preparedPlan || await agent.planner.createPlan(effectiveRequest, ctx);
      const planValidation = validatePlan(plan, {
        tools: agent.tools,
        context: ctx,
        maxSteps: agent.planner.maxSteps,
      });
      if (!planValidation.valid) {
        throw new Error(`Plan validation failed: ${planValidation.errors.join('; ')}`);
      }
      attachMediaToPlan(plan, ctx.attachedMedia);
      // 直接执行路径（无预览）没有能力匹配选择，LLM 写的工作流名无效时
      // 回退到当前工作流，避免执行阶段因工作流文件不存在而失败。
      for (const step of plan.steps) {
        if (step.tool === 'comfyui' && step.input?.workflowName && step.input.workflowName !== currentWorkflow) {
          try {
            await agent.detectWorkflow(step.input.workflowName);
          } catch {
            step.input.workflowName = currentWorkflow;
          }
        }
      }
      // 执行前先跑角色调研（若计划含 web 步骤），把外观事实写入 ctx.characterResearch，
      // 供后续 prompt_enhance 步骤作为 referenceContext 使用；同时移除已消费的 web 步骤，
      // 避免调研结果永远到不了提示词编译器。规划器未输出 web 步骤时，
      // 意图路由器判定需要研究或启发式命中角色外观请求也会强制调研。
      const researchForced = options.execution?.needsResearch === true || shouldResearchCharacter(effectiveRequest, intent);
      await researchCharacterIfPlanned(agent, plan, ctx, effectiveRequest, { force: researchForced });
      // 直跑路径的执行器里，raw 模式的 prompt_enhance 步骤会直接返回原文、
      // 忽略 referenceContext。调研出事实后把该步骤模式提升为 anime-character，
      // 保证搜索到的外观事实真正进入编译器（与 prepare 路径的 mode 提升一致）。
      const researchHasFacts = Boolean(ctx.characterResearch && APPEARANCE_FIELDS.some(field => String(ctx.characterResearch[field] || '').trim()));
      if (ctx.characterResearch?.sources?.length > 0 || researchHasFacts) {
        for (const step of plan.steps) {
          if (step.tool === 'prompt_enhance' && step.input && (!step.input.mode || step.input.mode === 'raw')) {
            step.input.mode = 'anime-character';
          }
        }
      }
      agent.taskManager.recordPlan(agent._taskId, plan);
      emit(AgentEventTypes.TASK, { taskId: agent._taskId, action: 'plan_created', stepCount: plan.steps.length, traceId });
      agent.taskManager.update(agent._taskId, { workflowName: currentWorkflow });
      void agent.taskManager.persist();
      if (!preparedTask) agent._transitionState('executing', { message: 'Executing plan', needsConfirmation: false });

      let finalResult = null;

      const completedSteps = [];
      let i = 0;
      while (i < plan.steps.length) {
        const step = plan.steps[i];
        agent._transitionState('executing', { currentStep: step.id, currentAttempt: 1, promptId: ctx.lastPromptId || '', lastError: '' });
        ctx.onProgress?.({
          scope: 'agent',
          stage: 'step',
          stepId: step.id,
          percent: 20 + Math.round((i / plan.steps.length) * 70),
          message: step.description || `Executing ${step.tool}`,
        });
        const output = await agent._executeWithRetry(step, ctx);

        if (output.skipped) {
          agent.taskManager.complete(agent._taskId, { result: { cancelled: true, stepId: step.id } });
          if (agent._state !== 'cancelled') agent._transitionState('cancelled', { message: 'Cancelled', lastError: '' });
          agent.conversation.add('agent', 'Task was cancelled.');
          agent.taskManager.update(agent._taskId, { status: 'cancelled', state: 'cancelled' });
          void agent.taskManager.persist();
          agent.sessionManager.setSessionState?.({ phase: 'cancelled', lastTaskId: agent._taskId, pending: null });
          agent.sessionManager.clearCurrentTask?.();
          return { cancelled: true, taskId: agent._taskId };
        }

        if (output.error) {
          const failure = output.failure || classifyFailure(output.error, { tool: step.tool, stepId: step.id, action: step.input?.action });
          if (failure.replan && agent._replanCount < 1) {
            const replanned = await agent._replanPlan(plan, i, step, output, ctx, completedSteps);
            if (replanned) {
              plan = replanned;
              i = 0;
              continue;
            }
          }
          if (step.optional) {
            emit(AgentEventTypes.STEP, { stepId: step.id, tool: step.tool, status: 'skipped', description: `${step.description} (optional, failed)`, error: output.error });
            i++;
            continue;
          }
          const errorMsg = `Step "${step.description}" failed: ${failure.userMessage || output.error}`;
          agent.taskManager.complete(agent._taskId, { error: { message: errorMsg, stepId: step.id, type: failure.type } });
          emit(AgentEventTypes.ERROR, { message: errorMsg, stepId: step.id, taskId: agent._taskId, traceId });
          agent.conversation.add('agent', errorMsg);
          if (agent._state !== 'failed') agent._transitionState('failed', { lastError: errorMsg, message: errorMsg });
          agent.taskManager.update(agent._taskId, { status: 'failed', state: 'failed', error: errorMsg, lastError: errorMsg });
          void agent.taskManager.persist();
          agent.sessionManager.setSessionState?.({
            phase: 'error',
            lastIntent: intent,
            lastTaskId: agent._taskId,
            pending: null,
            taskStatus: 'failed',
            taskFailure: { message: errorMsg, taskId: agent._taskId, type: failure.type },
            retryAction: { type: 'retry', taskId: agent._taskId },
          });
          agent.sessionManager.clearCurrentTask?.();
          agent._running = false;
          return { error: errorMsg, taskId: agent._taskId };
        }

        if (output.result) {
          const normalizedResult = step.tool === 'comfyui'
            ? normalizeGenerationResult(output.result)
            : output.result;
          output.result = normalizedResult;
          agent._collectArtifacts(normalizedResult, step);

            if (normalizedResult.media?.length > 0) {
             finalResult = normalizedResult;
             if (normalizedResult.images?.length > 0) agent.project.set('lastImages', normalizedResult.images);
           }
          if (output.result.enhanced) {
            agent.project.set('lastPrompt', output.result.enhanced);
            agent.project.set('lastCompiledPrompt', {
              tags: output.result.tags || [],
              narrative: output.result.narrative || '',
              positive: output.result.positive || output.result.enhanced,
              negative: output.result.negative || '',
              constraints: output.result.constraints || {},
            });
            if (agent.promptMode !== 'raw') agent.project.set('style', agent.promptMode);
          }
        }

        completedSteps.push({ id: step.id, tool: step.tool, output: agent._resultSummary(output.result) });
        ctx.lastResult = output.result;
        i++;
      }

      if (options.compiledPrompt) {
        agent.project.set('lastPrompt', options.compiledPrompt.positive || userMessage);
        agent.project.set('lastCompiledPrompt', {
          tags: options.compiledPrompt.tags || [],
          narrative: options.compiledPrompt.narrative || '',
          positive: options.compiledPrompt.positive || userMessage,
          negative: options.compiledPrompt.negative || '',
          constraints: options.compiledPrompt.constraints || {},
        });
        agent.project.set('confirmedConstraints', options.compiledPrompt.constraints || {});
      }
      agent.project.set('lastGenerationSource', 'ai');
      agent.project.set('commonParameters', { ...(ctx.executionSettings || {}) });
      const response = agent._buildResponse(finalResult, userMessage);
      const artifact = agent._recordGenerationArtifact(finalResult, options.compiledPrompt, {
        taskId: agent._taskId,
        workflow: currentWorkflow,
        parameters: ctx.executionSettings,
        intent,
      });
      agent._writeTurnMessage('agent', response, {
        kind: 'completed',
        artifactId: artifact?.artifactId || '',
        images: finalResult?.images || [],
        videos: finalResult?.videos || [],
        media: finalResult?.media || [],
        prompt: options.compiledPrompt?.positive || '',
        negative: options.compiledPrompt?.negative || '',
      }, options.turnId || '');

      const taskResult = {
        source: 'ai',
        origin: 'agent',
        response,
         images: finalResult?.images || [],
         videos: finalResult?.videos || [],
         media: finalResult?.media || [],
        artifacts: agent._artifacts.slice(-10),
        promptId: ctx.lastPromptId,
        taskId: agent._taskId,
        artifactId: artifact?.artifactId || '',
        positive: options.compiledPrompt?.positive || '',
        negative: options.compiledPrompt?.negative || '',
        compiledPrompt: options.compiledPrompt || null,
        workflowName: currentWorkflow || '',
        settings: ctx.executionSettings || {},
      };
      agent.project.set('lastResult', agent._resultSummary(finalResult));
      agent.taskManager.complete(agent._taskId, { result: taskResult });
      emit(AgentEventTypes.MESSAGE, {
        role: 'agent',
        content: response,
        images: finalResult?.images || [],
        videos: finalResult?.videos || [],
        media: finalResult?.media || [],
        prompt: options.compiledPrompt?.positive || '',
        negative: options.compiledPrompt?.negative || '',
        taskId: agent._taskId,
        traceId,
        ...(options.turnId ? { messageId: `${options.turnId}:agent`, done: true } : {}),
      });
      agent._transitionState('completed', { message: 'Done', promptId: ctx.lastPromptId || '', lastError: '' });

       if (finalResult?.media?.length > 0) {
        agent.project.snapshot();
      }

      agent.taskManager.update(agent._taskId, {
        status: 'completed',
        state: 'completed',
        workflowName: currentWorkflow,
         images: finalResult?.images?.length || 0,
         videos: finalResult?.videos?.length || 0,
         media: finalResult?.media?.length || 0,
        promptId: ctx.lastPromptId,
      });
      void agent.taskManager.persist();
      agent.sessionManager.setSessionState?.({
        phase: 'completed',
        lastIntent: intent,
        lastTaskId: agent._taskId,
        pending: null,
        pendingIntent: null,
        pendingRequest: '',
        preparedPreview: null,
        taskStatus: 'completed',
        taskFailure: null,
        retryAction: null,
      });
      agent.sessionManager.clearCurrentTask?.();

      return taskResult;

    } catch (error) {
      if (agent._cancelRequested || agent._state === 'cancelled' || agent.executor.cancelled) {
        return { cancelled: true, taskId: agent._taskId };
      }
      const failure = classifyFailure(error, { tool: 'comfyui' });
      const userMessage = failure.userMessage || error.message;
      agent.taskManager.complete(agent._taskId, { error: { message: userMessage, rawMessage: error.message, type: failure.type } });
      emit(AgentEventTypes.ERROR, { message: userMessage, rawMessage: error.message, taskId: agent._taskId, traceId });
      if (agent._state !== 'failed' && agent._state !== 'cancelled') agent._transitionState('failed', { lastError: userMessage, message: userMessage });
      agent._writeTurnMessage('agent', `Error: ${userMessage}`, { kind: 'failed' }, options.turnId || '');
      agent.taskManager.update(agent._taskId, { status: 'failed', state: 'failed', error: userMessage, lastError: userMessage });
      void agent.taskManager.persist();
      agent.sessionManager.setSessionState?.({
        phase: 'error',
        lastIntent: intent,
        lastTaskId: agent._taskId,
        pending: null,
        taskStatus: 'failed',
        taskFailure: { message: userMessage, taskId: agent._taskId },
        retryAction: { type: 'retry', taskId: agent._taskId },
      });
      agent.sessionManager.clearCurrentTask?.();
      return { error: error.message, taskId: agent._taskId };
    } finally {
      agent._running = false;
      await agent._drainQueue();
    }
}
