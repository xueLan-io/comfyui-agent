// Unified user-turn orchestration extracted from Agent.
// Calls remain on the Agent instance so overrides and lifecycle behavior persist.
import { initTurn } from '../events/agent-events.mjs';
import { isConfirmTurn, messageAttachments } from './chat-intents.mjs';
import { emitTiming, timingOutcome } from './prepare-ops.mjs';

export async function handleTurn(agent, input = {}) {
    // 新消息到达立即取消后台压缩预取（含未触发的定时器），避免占用本地模型的串行锁
    if (agent._prefetchTimer) {
      clearTimeout(agent._prefetchTimer);
      agent._prefetchTimer = null;
    }
    agent._archivePrefetchSignal?.abort('superseded');
    const typedText = typeof input.text === 'string' ? input.text.trim() : '';
    const hasMedia = Boolean(input.media?.images?.length || input.media?.videos?.length);
    if (!typedText && !hasMedia) return { turnId: agent._newTurnId(), action: 'reply', response: '' };
    const text = typedText || '请结合这张图片继续处理我的请求。';
    const turnId = input.turnId || agent._newTurnId();
    initTurn(turnId);
    if (input.projectId) agent.projectId = input.projectId;
    if (input.sessionId) agent.sessionId = input.sessionId;
    const initialProjectId = agent.projectId;
    const initialSessionId = agent.sessionId;
    const turnStart = Date.now();
    const timingMeta = {
      ...(agent.projectId ? { projectId: agent.projectId } : {}),
      ...(agent.sessionId ? { sessionId: agent.sessionId } : {}),
      turnId,
      taskId: '',
      traceId: '',
    };
    emitTiming('turn_start', {
      ...timingMeta,
      timingPhase: 'turn',
      message: `开始处理：${text.slice(0, 40)}${text.length > 40 ? '…' : ''}`,
    });
    let turnOutcome = 'completed';

    try {
      // Creative is the unified conversational entry point. Retain `generate`
      // for older confirmation callers that explicitly require that bias.
      const modeHint = input.modeHint === 'generate' ? 'generate' : 'creative';
      const activeProject = agent.sessionManager.getActiveProject?.();
      if (input.sessionId && activeProject?.sessions?.some(session => session.id === input.sessionId)
        && input.sessionId !== agent.sessionManager.activeSessionId) {
        await agent.useSession(agent.sessionManager.activeProjectId, input.sessionId);
      }
      if (agent.projectId || initialProjectId) timingMeta.projectId = agent.projectId || initialProjectId;
      if (agent.sessionId || initialSessionId) timingMeta.sessionId = agent.sessionId || initialSessionId;
      const options = {
        workflowName: input.workflowName || '',
        workflowManifest: input.workflowManifest || null,
        media: input.media || null,
        sourceTurnId: turnId,
        allowPolicyOverride: input.allowPolicyOverride === true,
        executionPolicy: input.executionPolicy || undefined,
        skillId: input.skillId || '',
      };

      const sessionState = agent.sessionManager.getSessionState?.() || {};
      const awaitingConfirmation = agent._state === 'awaiting_confirmation'
        || sessionState.state === 'awaiting_confirmation'
        || sessionState.phase === 'awaiting_preview';
      if (awaitingConfirmation && isConfirmTurn(text)) {
        if (input.recordConfirmation !== false) {
          agent._writeTurnMessage('user', text, { turnId, modeHint, attachments: messageAttachments(input.media) }, turnId);
        }
        const previewId = sessionState.preparedPreview?.previewId;
        if (!previewId || !agent._preparedRuns.has(previewId)) {
          return {
            turnId,
            action: 'clarify',
            response: '上次的生成预览已恢复，但执行计划已失效。请重新提交生成请求。',
            decision: { intent: 'generate', action: 'clarify', target: 'new', missing: ['prepared_plan'] },
          };
        }
        const result = await agent.runPrepared(previewId, { ...(input.confirmation || {}), ...(input.previewEdits || {}), turnId });
        return { turnId, action: 'execute', decision: { intent: 'generate', action: 'execute', requiresConfirmation: false, sourceTurnId: turnId }, result };
      }

      if (!input.skipUserMessage) agent._writeTurnMessage('user', text, { turnId, modeHint, attachments: messageAttachments(input.media) }, turnId);
      const hadPending = Boolean(agent.sessionManager.getSessionState?.().pending);
      if (hadPending) {
        agent.sessionManager.setSessionState?.({ supplementalInput: text });
      }
      agent._policyPreprocessing = true;
      let decision;
      const intentStart = Date.now();
      let intentOutcome = 'completed';
      emitTiming('intent_start', {
        ...timingMeta,
        timingPhase: 'intent',
        message: '意图分类中',
      });
      try {
        decision = await agent.routeIntent(text, { ...options, modeHint, turnId });
      } catch (error) {
        intentOutcome = timingOutcome(error);
        throw error;
      } finally {
        agent._policyPreprocessing = false;
        emitTiming('intent_end', {
          ...timingMeta,
          timingPhase: 'intent',
          duration_ms: Date.now() - intentStart,
          outcome: intentOutcome,
          message: '意图分类结束',
        });
      }
      decision.sourceTurnId = turnId;

      if (decision.intent === 'cancel') {
        await agent.cancel();
        turnOutcome = 'cancelled';
        const response = '已取消当前任务。';
        agent._writeTurnMessage('agent', response, { kind: 'cancelled' }, turnId);
        return { turnId, action: 'reply', decision, response };
      }
      if (decision.action === 'clarify') {
        const result = agent.clarify(text, { ...decision, sourceTurnId: turnId, skipUserMessage: true });
        return { turnId, action: 'clarify', decision, result, response: result.response };
      }
      if (decision.intent === 'file_edit' || options.fileMutation === true) {
        const preview = await agent.prepareFileMutation(text, { ...options, turnId, effectiveRequest: text });
        return {
          turnId,
          action: 'prepare',
          decision: { ...decision, intent: 'file_edit', action: 'prepare', requiresConfirmation: true, sourceTurnId: turnId },
          preview,
        };
      }
      if (decision.action === 'suggest') {
        const response = '检测到图片生成请求。是否按当前工作流准备生成？';
        agent._writeTurnMessage('agent', response, { kind: 'generation_suggestion' }, turnId);
        return { turnId, action: 'suggest', decision, response };
      }
      if (decision.action === 'reply') {
        agent.sessionManager.setSessionState?.({
          turnId,
          pending: null,
          pendingIntent: null,
          pendingRequest: '',
          supplementalInput: '',
        });
        const result = await agent.chat(text, { ...options, intent: decision.intent, execution: decision.execution, turnId, skipUserMessage: true });
        return { turnId, action: 'reply', decision, result, response: result.response };
      }

      agent.sessionManager.setSessionState?.({
        turnId,
        pendingIntent: decision,
        pendingRequest: decision.request || text,
        supplementalInput: '',
      });
      const preview = await agent.prepareGeneration(text, {
        ...options,
        intent: decision.intent,
        execution: decision.execution,
        effectiveRequest: decision.request || text,
        readiness: decision.readiness || null,
        turnId,
        modeHint,
      });
      if (preview?.action === 'clarify') {
        return { turnId, action: 'clarify', decision: { ...decision, ...preview }, result: preview, response: preview.response };
      }
      if (preview?.cancelled) {
        turnOutcome = 'cancelled';
        return { turnId, action: 'cancelled', taskId: preview.taskId || agent._taskId, result: preview };
      }
      if (preview?.queued) {
        return { turnId, action: 'queued', position: preview.position, taskId: agent._taskId };
      }
      return {
        turnId,
        action: 'prepare',
        decision: { ...decision, action: 'prepare', requiresConfirmation: true, sourceTurnId: turnId },
        preview,
      };
    } catch (error) {
      turnOutcome = timingOutcome(error);
      throw error;
    } finally {
      emitTiming('turn_end', {
        ...timingMeta,
        ...(agent.projectId || timingMeta.projectId ? { projectId: agent.projectId || timingMeta.projectId } : {}),
        ...(agent.sessionId || timingMeta.sessionId ? { sessionId: agent.sessionId || timingMeta.sessionId } : {}),
        timingPhase: 'turn',
        duration_ms: Date.now() - turnStart,
        outcome: turnOutcome,
        message: '请求处理结束',
      });
    }
  }
