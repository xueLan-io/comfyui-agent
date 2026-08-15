// Core conversational turn flow, extracted from Agent. Agent instance callbacks are
// deliberately used for overridable behavior (archive, memory, degradation, etc.).
// P0-5 slice 9: chat() now delegates context/message/request assembly and the
// reply lifecycle to chat-request.mjs; this file keeps only the orchestration.
import { emit, AgentEventTypes, initTurn, nextTraceId } from '../events/agent-events.mjs';
import { normalizeResearchSettings } from '../research/settings.mjs';
import { wantsWebResearch } from './chat-intents.mjs';
import { assembleChatContext, assembleChatMessages, buildChatRequest, completeChatReply, handleChatFailure, researchReply, chatResearchContext } from './chat-request.mjs';

export { chatResearchContext };

export async function chat(agent, userMessage, options = {}) {
  if (options.turnId) initTurn(options.turnId);
  const queued = agent._enqueue(() => agent.chat(userMessage, options));
  if (queued) return queued;
  if (agent._state === 'awaiting_confirmation') throw new Error('有待确认的生成预览，请先确认或取消当前预览。');
  agent._running = true; agent._taskId = `chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`; agent._traceId = nextTraceId();
  const taskId = agent._taskId, traceId = agent._traceId, turnId = options.turnId || '', intent = options.intent || 'chat';
  agent.taskManager.create({ id: taskId, kind: 'chat', message: userMessage, traceId, intent, projectId: agent.sessionManager.activeProjectId, sessionId: agent.sessionManager.activeSessionId, turnId }); void agent.taskManager.persist();
  if (agent._state !== 'classifying') agent._transitionState('classifying', { message: 'Classifying request...' });
  agent.sessionManager.setSessionState?.({ turnId, phase: 'running', lastIntent: intent, lastTaskId: taskId, pending: null, pendingIntent: null, pendingRequest: '', supplementalInput: '' });
  if (!options.skipUserMessage) agent._writeTurnMessage('user', userMessage, {}, turnId);
  emit(AgentEventTypes.MESSAGE, { role: 'user', content: userMessage, taskId, traceId }); emit(AgentEventTypes.STATUS, { status: 'running', message: '正在回复...', taskId, traceId });
  if (options.workflowManifest) agent._lastManifest = options.workflowManifest;
  const needsResearch = agent.llm?.isConfigured ? options.execution?.needsResearch === true : wantsWebResearch(userMessage, options.intent);
  const local = !agent.llm?.isConfigured && !needsResearch ? agent._localResponse(userMessage) : null;
  const streamMessageId = turnId ? `${turnId}:agent` : `${taskId}:response`;
  const finish = completeChatReply(agent, { taskId, traceId, turnId, intent, streamMessageId });
  if (local) {
    agent._transitionState('planning', { message: 'Preparing reply...' });
    const result = await finish(local);
    agent._running = false;
    await agent._drainQueue();
    return result;
  }
  try {
    agent._transitionState('planning', { message: 'Planning response...' }); agent.taskManager.update(taskId, { status: 'planning' }); void agent.taskManager.persist();
    let response, metadata = null, retryAttempt = 0;
    if (!agent.llm.isConfigured && needsResearch) {
      const settings = normalizeResearchSettings(agent.project.get('researchSettings') || {});
      response = researchReply(settings.allowNetwork ? await agent._chatResearch(userMessage, settings) : { sources: [], message: 'Online research is disabled in settings.' });
    } else if (!agent.llm.isConfigured) {
      response = '当前没有连接语言模型。你仍可以直接运行本地工作流；如果想进行自然对话，请先在模型设置中连接 Ollama 或 OpenAI 兼容服务。';
    } else {
      const context = await assembleChatContext(agent, { userMessage, options, needsResearch });
      const assembled = await assembleChatMessages(agent, { images: context.images, memory: context.memory, wf: context.wf, project: context.project, runtime: context.runtime, research: context.research, taskId, traceId });
      const buildRequest = buildChatRequest(agent, { profile: assembled.profile, archivedMessage: assembled.archivedMessage, compiled: assembled.compiled, archive: assembled.archive, system: assembled.system, reserved: assembled.reserved, research: context.research, options, streamMessageId, taskId, traceId, turnId });
      emit(AgentEventTypes.PLAN, { stage: 'thinking', partial: '正在思考…', taskId, traceId, turnId });
      const request = await agent._chatWithDegradation({ buildRequest, isLocal: assembled.profile.mode === 'local', taskId, traceId, streamMessageId });
      metadata = request.result; retryAttempt = request.retryAttempt;
      if (metadata?.usage) emit(AgentEventTypes.CONTEXT_USAGE, { ...request.telemetry, archiveCount: assembled.archive.segments.length, inputTokens: metadata.usage.inputTokens, outputTokens: metadata.usage.outputTokens, totalTokens: metadata.usage.totalTokens, source: 'provider', retryAttempt, taskId, traceId });
      response = metadata.content?.trim() || '模型没有返回文本。';
    }
    return finish(response, metadata, retryAttempt);
  } catch (error) {
    return handleChatFailure(agent, { taskId, traceId, turnId, intent, error });
  } finally {
    agent._running = false;
    await agent._drainQueue();
  }
}
