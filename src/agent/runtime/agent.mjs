import { Planner } from './planner.mjs';
import { Executor } from './executor.mjs';
import { Evaluator } from './evaluator.mjs';
import { LLMProvider } from '../llm/provider.mjs';
import { JSONFileStore } from '../memory/store.mjs';
import { SessionManager } from './session-manager.mjs';
import { TaskManager, canTransition } from './task-manager.mjs';
import { RetryPolicy } from '../optimizer/retry-policy.mjs';
import { estimateTokens } from '../optimizer/prompt-guard.mjs';
import { ComfyUITool } from '../tools/comfyui/index.mjs';
import { RuntimeTools } from '../tools/comfyui/runtime.mjs';
import { WorkflowReadTools } from '../tools/comfyui/workflow-read.mjs';
import { ComfyUIRuntimeParametersTool } from '../tools/comfyui/runtime-parameters.mjs';
import { WorkflowInspectTool } from '../tools/comfyui/workflow-inspect.mjs';
import { InspectImageTool } from '../tools/comfyui/image-inspect.mjs';
import { WorkflowPatchTool } from '../tools/comfyui/workflow-patch.mjs';
import { WorkflowMutationTools } from '../tools/comfyui/workflow-mutation-tools.mjs';
import { PromptEnhanceTool } from '../tools/prompt/enhance.mjs';
import { PromptLibraryTool } from '../tools/prompt-library/index.mjs';
import { FilesystemTool } from '../tools/filesystem/index.mjs';
import { FilesystemMutateTool } from '../tools/filesystem/mutate.mjs';
import { SystemTool } from '../tools/system/index.mjs';
import { WebTool } from '../tools/web/index.mjs';
import { WorkflowAdapter } from '../tools/comfyui/workflow-adapter.mjs';
import { registerAdapters } from '../tools/comfyui/adapters/index.mjs';
import { emit, AgentEventTypes, initSession, nextTraceId } from '../events/agent-events.mjs';
import { confirmationForPlan } from '../schemas/confirmation-schema.mjs';
import { IntentRouter, isExplicitNewGeneration, questionFor } from './intent-router.mjs';
import { assessPromptReadiness } from '../tools/prompt/readiness.mjs';
import { normalizePersonality } from './chat-prompt.mjs';
import { createSandboxPolicy, resolveSandboxFile } from '../security/sandbox.mjs';
import { existsSync, readdirSync } from 'fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { wantsWebResearch } from './chat-intents.mjs';
import { createAgentToolRegistry } from './agent-tools.mjs';
import { contextArchiveOf, archivePrompt, compactConversationSegment, prepareConversationArchive, prefetchContextArchive, compactConversation, memoryContext, archiveMessage } from './context-archive.mjs';
import { resultSummary, recordGenerationArtifact, recordArtifact, replanPlan, executeWithRetry, retryDecision, retryParameters, rotateRetryParameters, recordStepAttempt, recompilePrompt, collectPromptIssues, collectArtifacts } from './execution-ops.mjs';
import { researchCharacter, buildSearchQuery, chatResearch } from './research-ops.mjs';
import { useSession as sessionUse, createProject as createProjectOp, createSession as createSessionOp, suggestSessionTitle as suggestSessionTitleOp, deleteProject as deleteProjectOp, deleteSession as deleteSessionOp } from './session-ops.mjs';
import { chatWithDegradation, localResponse } from './chat-ops.mjs';
import { chat as chatFlow, chatResearchContext } from './chat-flow.mjs';
import { prepareFileMutation as prepareFileMutationOp, prepareWorkflowMutation as prepareWorkflowMutationOp, runPrepared as runPreparedOp, prepareGeneration as prepareGenerationOp, isCancellationError, aiFailure } from './prepare-ops.mjs';
import { handleTurn as handleTurnFlow } from './turn-flow.mjs';
import { run as runFlow } from './run-flow.mjs';

registerAdapters();


function requestedWorkflowMode(request, intent, media = {}, execution = {}) {
  if (execution.kind && execution.kind !== 'none' && execution.kind !== 'file_edit') return execution.kind;
  if (/(?:upscale|super.?resolution|\u653e\u5927|\u9ad8\u6e05)/i.test(request)) return 'upscale';
  if (media.masks?.length > 0) return 'inpaint';
  if (media.images?.length > 0) return 'img2img';
  if (intent !== 'edit') return 'txt2img';
  if (/(?:inpaint|mask|\u5c40\u90e8\u91cd\u7ed8|\u8499\u7248|\u906e\u7f69)/i.test(request)) return 'inpaint';
  return 'img2img';
}


export class Agent {
  constructor(options = {}) {
    this.llmConfig = options.llmConfig || { provider: 'openai-compatible', model: 'gpt-4o' };
    this.researchConfig = options.researchConfig || {};
    this.promptConfig = {
      personality: normalizePersonality(options.promptConfig?.personality),
      language: options.promptConfig?.language === 'en-US' ? 'en-US' : 'zh-CN',
    };
    this.sandbox = options.sandbox || createSandboxPolicy({ allowNetwork: this.researchConfig.allowNetwork !== false });
    this.workflowDir = options.workflowDir || '';
    this.comfyRoot = options.comfyRoot || '';
    this.userDataPath = options.userDataPath || '';
    this._promptMode = options.promptMode || 'raw';
    this._plannerOptions = { ...(options.plannerOptions || {}) };
    this._retryPolicyOptions = { ...(options.retryPolicyOptions || {}) };
    this._toolRegistry = options.toolRegistry || null;
    this.projectId = options.projectId || '';
    this.sessionId = options.sessionId || '';
    // Optional cross-session memory (LongTermMemory). When absent the agent
    // behaves exactly as before: no recall injection, no session capture.
    this.memory = options.memory || null;

    this.llm = new LLMProvider(this.llmConfig);
    this.llm.setPolicyStateHandler(({ state }) => {
      const messages = {
        reviewing: '正在审查内容（将发送到云端模型）',
        cloud_allowed: '内容审查通过，发送到云端模型',
        local_fallback: '内容需在本地模型处理，已切换本地模型',
        blocked: '内容包含禁止项，已停止发送',
        user_override: '已通过手动确认，发送到云端模型',
        idle: '',
      };
       // Intent classification runs before a task exists. Never let that
       // pre-processing policy check inherit the completed task's identity.
       const preProcessing = this._policyPreprocessing === true;
       emit(AgentEventTypes.PROGRESS, {
         scope: 'llm-policy',
         stage: state,
         policyState: state,
         message: messages[state] || state,
         percent: state === 'reviewing' ? 8 : state === 'cloud_allowed' || state === 'local_fallback' || state === 'user_override' ? 12 : state === 'blocked' ? 100 : undefined,
         taskId: preProcessing ? '' : this._taskId,
         traceId: preProcessing ? '' : this._traceId,
         projectId: this.projectId,
         sessionId: this.sessionId,
       });
    });
    this.tools = this._getTools();
    this.planner = new Planner(this.llm, { ...this._plannerOptions, tools: this.tools });
    this.intentRouter = new IntentRouter(this.llm, {
      imageDataUrl: image => ComfyUITool.client.imageDataUrl(image),
      authorizePath: path => this._authorizeVisionPath(path),
    });
    this.executor = new Executor(this.tools, this.llm, this.sandbox);
    this.evaluator = new Evaluator(this.llm, { imageDataUrl: (image) => ComfyUITool.client.imageDataUrl(image) });
    this.retryPolicy = new RetryPolicy(undefined, this._retryPolicyOptions);

    this._running = false;
    this._taskId = '';
    this._artifacts = [];
    this._lastManifest = null;
    this._archivePrefetchSignal = null;
    this._prefetchTimer = null;
    this._activePromptIds = new Set();
    this._preparedRuns = new Map();
    this._state = 'idle';
    this._traceId = '';
    this._currentStep = '';
    this._currentAttempt = 0;
    this._currentPromptId = '';
    this._currentAttemptId = '';
    this._requestId = '';
    this._lastError = '';
    this._needsConfirmation = false;
    this._replanCount = 0;
    this._maxReplans = options.maxReplans ?? 2;
    this._pendingQueue = [];
    this._cancelRequested = false;
    this._promptCompileController = null;
    this._policyPreprocessing = false;

    const storageDir = this.userDataPath ? join(this.userDataPath, 'agent-data') : '';
    this.taskManager = new TaskManager(storageDir ? new JSONFileStore(storageDir, 'tasks.json') : null);
    this.sessionManager = new SessionManager(storageDir, {
      defaultProjectDir: this.userDataPath ? join(this.userDataPath, 'projects') : '',
    });

    initSession();
  }

  async init() {
    if (this.memory?.init) await this.memory.init();
    await this.sessionManager.init();
    initSession(this.sessionManager.activeProjectId, this.sessionManager.activeSessionId);
    if (!this.project.get('promptMode')) this.project.set('promptMode', this._promptMode);
    await this.taskManager.load();
    this._recoverAbandonedTasks();
    const sessionState = this.sessionManager.getSessionState?.();
    if (sessionState?.state === 'awaiting_confirmation' && sessionState.preparedPreview) {
      this._reconstructPreparedRun(sessionState.preparedPreview);
      this._state = 'awaiting_confirmation';
      this._needsConfirmation = true;
    } else {
      this._state = 'idle';
      this._needsConfirmation = false;
    }
    this._cleanupStalePreparedRuns();
  }

  _recoverAbandonedTasks() {
    const recoverable = this.taskManager.recoverInterrupted();
    const sessionState = this.sessionManager.getSessionState?.();
    const runningPhases = ['classifying', 'clarifying', 'planning', 'executing', 'observing', 'retrying', 'replanning', 'queued'];
    if (sessionState && runningPhases.includes(sessionState.state) && recoverable.length === 0) {
      this.sessionManager.setSessionState?.({ state: 'idle', phase: 'idle', pending: null, pendingIntent: null, pendingRequest: '', preparedPreview: null, taskStatus: 'idle' });
    }
  }

  _reconstructPreparedRun(previewData) {
    if (!previewData || !previewData.previewId) return;
    const previewId = previewData.previewId;
    if (this._preparedRuns.has(previewId)) return;
    this._preparedRuns.set(previewId, {
      userMessage: previewData.interpretedPrompt || '',
      effectiveRequest: previewData.positive || '',
      intent: previewData.intent || null,
      plan: previewData.plan || null,
      compiledPrompt: {
        positive: previewData.positive || '',
        negative: previewData.negative || '',
        tags: previewData.tags || [],
        narrative: previewData.narrative || '',
        constraints: previewData.constraints || {},
      },
      workflowManifest: null,
      options: previewData.options || {},
      workflowName: previewData.workflowName || '',
      confirmation: previewData.confirmation || null,
      compileInput: null,
      requestId: previewData.requestId || '',
      requestDigest: previewData.requestDigest || '',
      status: previewData.status || 'prepared',
      createdAt: Date.now(),
    });
  }

  _cleanupStalePreparedRuns() {
    const now = Date.now();
    const maxAge = 10 * 60 * 1000;
    for (const [previewId, run] of this._preparedRuns.entries()) {
      if (run.createdAt && (now - run.createdAt) > maxAge) {
        this._preparedRuns.delete(previewId);
      }
    }
  }

  async recoverTasks() {
    const tasks = this.taskManager.tasks.filter(task => task.state === 'observing' && (task.promptId || task.attempts?.some(attempt => attempt.promptId)));
    const results = [];
    for (const task of tasks) {
      const promptId = task.promptId || task.attempts.find(attempt => attempt.promptId)?.promptId;
      try {
        this.taskManager.update(task.id, { recovery: { ...(task.recovery || {}), state: 'observing', attempts: (task.recovery?.attempts || 0) + 1, lastCheckedAt: Date.now() } });
        const status = await ComfyUITool.monitor(promptId);
        if (status.status === 'unknown') {
          this.taskManager.update(task.id, { status: 'observe_timeout', state: 'observe_timeout', recovery: { ...(task.recovery || {}), state: 'user_confirmation_required', lastCheckedAt: Date.now() }, lastError: `ComfyUI prompt ${promptId} is no longer observable` });
        }
        results.push({ taskId: task.id, promptId, ...status });
      } catch (error) {
        results.push({ taskId: task.id, promptId, status: 'unavailable', error: error.message });
      }
    }
    if (tasks.length > 0) await this.taskManager.persist();
    return results;
  }

  _newTurnId() {
    return `turn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  _writeTurnMessage(role, content, metadata = {}, turnId = '') {
    const messageId = metadata.messageId || (turnId ? `${turnId}:${role}` : '');
    if (messageId && typeof this.conversation.updateById === 'function'
      && this.conversation.updateById(messageId, content, { ...metadata, messageId, turnId })) {
      return messageId;
    }
    this.conversation.add(role, content, { ...metadata, ...(messageId ? { messageId, turnId } : {}) });
    return messageId;
  }

  async handleTurn(input = {}) {
    return handleTurnFlow(this, input);
  }

  _transitionState(next, details = {}) {
    if (!this._state) this._state = 'idle';
    if (!canTransition(this._state, next)) {
      throw new Error(`Invalid task state transition: ${this._state} -> ${next}`);
    }
    this._state = next;
    if (details.traceId) this._traceId = details.traceId;
    if (details.currentStep !== undefined) this._currentStep = details.currentStep;
    if (details.currentAttempt !== undefined) this._currentAttempt = details.currentAttempt;
    if (details.promptId !== undefined) this._currentPromptId = details.promptId || '';
    if (details.lastError !== undefined) this._lastError = details.lastError || '';
    if (details.needsConfirmation !== undefined) this._needsConfirmation = Boolean(details.needsConfirmation);
    const uiStatus = {
      idle: 'idle',
      classifying: 'running',
      clarifying: 'waiting',
      planning: 'running',
      awaiting_confirmation: 'preview',
      executing: 'running',
      observing: 'running',
      retrying: 'running',
      replanning: 'running',
      completed: 'completed',
      failed: 'error',
      cancelled: 'cancelled',
    }[next] || next;
    const record = {
      status: next,
      state: next,
      traceId: this._traceId,
      currentStep: this._currentStep,
      currentAttempt: this._currentAttempt,
      promptId: this._currentPromptId,
      lastError: this._lastError,
      needsConfirmation: this._needsConfirmation,
    };
    if (this._taskId && this.taskManager?.update) {
      if (this.taskManager.transition) {
        this.taskManager.transition(this._taskId, next, record);
      } else {
        this.taskManager.update(this._taskId, record);
      }
      void this.taskManager.persist?.();
    }
    this.sessionManager?.setSessionState?.({
      state: next,
      traceId: this._traceId,
      lastTaskId: this._taskId,
      currentStep: this._currentStep,
      currentAttempt: this._currentAttempt,
      promptId: this._currentPromptId,
      lastError: this._lastError,
      needsConfirmation: this._needsConfirmation,
    });
    emit(AgentEventTypes.STATUS, {
      status: next,
      state: next,
      uiStatus,
      message: details.message || '',
      taskId: this._taskId,
      traceId: this._traceId,
      requestId: this._requestId,
      currentStep: this._currentStep,
      currentAttempt: this._currentAttempt,
      promptId: this._currentPromptId,
      lastError: this._lastError,
      needsConfirmation: this._needsConfirmation,
    });
    const stateProgress = {
      classifying: null,
      planning: null,
      awaiting_confirmation: null,
      executing: 20,
      observing: 90,
      retrying: 50,
      replanning: 45,
      completed: 100,
    };
    if (Object.hasOwn(stateProgress, next)) {
      emit(AgentEventTypes.PROGRESS, {
        scope: 'agent',
        stage: next,
        percent: stateProgress[next],
        message: details.message || next,
        taskId: this._taskId,
        traceId: this._traceId,
        requestId: this._requestId,
      });
    }
  }

  get conversation() {
    return this.sessionManager.conversation;
  }

  get project() {
    return this.sessionManager.project;
  }

  _conversationForLLM(recentCount) {
    if (typeof this.conversation.getCompressedLLMMessages === 'function') {
      return this.conversation.getCompressedLLMMessages({ recentCount });
    }
    return (this.conversation.getLLMMessages?.() || []).slice(-recentCount);
  }

  get promptMode() {
    return this.project.get('promptMode') || this._promptMode;
  }

  _thinkingStream() {
    let text = '';
    return delta => {
      text += delta;
      emit(AgentEventTypes.PLAN, { stage: 'thinking', partial: text });
    };
  }

  async _researchCharacter(request, inputSettings = {}) {
    return researchCharacter(this, request, inputSettings);
  }

  // 口语消息 → 搜索关键词。cn.bing 对中文口语长句解析很差（"帮我查一下"只剩"帮"），
  // 优先用 LLM 提炼，失败时用规则剥离口语前缀兜底
  async _buildSearchQuery(message) {
    return buildSearchQuery(this, message);
  }

  async _chatResearch(message, settings) {
    return chatResearch(this, message, settings);
  }

  _getTools() {
    if (this._toolRegistry?.byName) {
      return this._toolRegistry.byName;
    }
    this.toolRegistry = createAgentToolRegistry();
    return this.toolRegistry.byName;
  }

  reconfigureLLM(config) {
    if (this._runtimeBusy()) {
      throw new Error('Agent is busy; LLM reconfiguration is not allowed while a task is running');
    }
    this.llmConfig = Array.isArray(config?.providers) ? config : { ...this.llmConfig, ...config };
    this.llm.reconfigure(this.llmConfig);
    this.planner = new Planner(this.llm, { ...this._plannerOptions, tools: this.tools });
    this.intentRouter = new IntentRouter(this.llm, {
      imageDataUrl: image => ComfyUITool.client.imageDataUrl(image),
      authorizePath: path => this._authorizeVisionPath(path),
    });
    this.evaluator = new Evaluator(this.llm, { imageDataUrl: (image) => ComfyUITool.client.imageDataUrl(image) });
    this.executor = new Executor(this.tools, this.llm, this.sandbox);
  }

  reconfigureResearch(config) {
    this.researchConfig = { ...(config || {}) };
    this.sandbox.setNetworkEnabled(this.researchConfig.allowNetwork !== false);
  }

  reconfigurePrompt(config = {}) {
    this.promptConfig = {
      personality: normalizePersonality(config.personality),
      language: config.language === 'en-US' ? 'en-US' : 'zh-CN',
    };
    return this.promptConfig;
  }

  _effectivePersonality() {
    const projectPersonality = normalizePersonality(this.project.get('customSystemPrompt'));
    if (projectPersonality.enabled && projectPersonality.text) return projectPersonality;
    return this.promptConfig.personality;
  }

  setWorkflowDir(dir) {
    this.workflowDir = dir;
    const saved = this.project.get('workflow');
    // 仅当已选工作流文件在新目录中不存在时才清空；
    // 否则 list-workflows 等目录未变的调用会误删用户选择，导致 Agent 不知道当前工作流
    if (saved && dir && existsSync(join(dir, saved))) return;
    this.project.set('workflow', '');
  }

  setPromptMode(mode) {
    this._promptMode = mode;
    this.project.set('promptMode', mode);
  }

  _runtimeBusy() {
    return this._running || this._state === 'awaiting_confirmation' || this._pendingQueue.length > 0;
  }

  _assertSessionSwitchAllowed() {
    if (this._runtimeBusy()) {
      throw new Error('当前会话仍有任务或待确认预览，请先取消后再切换会话');
    }
  }

  _resetRuntimeState() {
    this._running = false;
    this._taskId = '';
    this._artifacts = [];
    this._lastManifest = null;
    this._activePromptIds.clear();
    this._state = 'idle';
    this._traceId = '';
    this._currentStep = '';
    this._currentAttempt = 0;
    this._currentPromptId = '';
    this._currentAttemptId = '';
    this._requestId = '';
    this._lastError = '';
    this._needsConfirmation = false;
    this._replanCount = 0;
    this._pendingQueue = [];
  }

  async useSession(projectId, sessionId) {
    return sessionUse(this, projectId, sessionId);
  }

  async createProject(input) {
    return createProjectOp(this, input);
  }

  async createSession(title, projectId, { activate = true } = {}) {
    return createSessionOp(this, title, projectId, { activate });
  }

  async suggestSessionTitle(message) {
    return suggestSessionTitleOp(this, message);
  }

  async deleteProject(projectId) {
    return deleteProjectOp(this, projectId);
  }

  async deleteSession(sessionId, projectId = this.sessionManager.activeProjectId) {
    return deleteSessionOp(this, sessionId, projectId);
  }

  _listWorkflows() {
    if (!this.workflowDir || !existsSync(this.workflowDir)) return [];
    const files = new Set();
    const collect = (dir, prefix = '') => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const relativeName = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) collect(join(dir, entry.name), relativeName);
        else if (entry.name.toLowerCase().endsWith('.json') && !entry.name.toLowerCase().includes('backup')) files.add(relativeName);
      }
    };
    collect(this.workflowDir);
    return [...files].sort((a, b) => a.localeCompare(b));
  }

  async _selectWorkflowForRequest(request, intent, options, currentWorkflow, workflowManifest) {
    if (!this.workflowDir) {
      return { workflowName: currentWorkflow, workflowManifest };
    }

    const mode = requestedWorkflowMode(request, intent, options.media || {}, options.execution || {});
    if (workflowManifest?.capabilities?.modes?.includes(mode)) {
      return { workflowName: currentWorkflow, workflowManifest };
    }
    if (options.workflowName && !workflowManifest) {
      return { workflowName: currentWorkflow, workflowManifest };
    }

    const candidates = await ComfyUITool.discover(this.workflowDir);
    const match = candidates.find(item => item.capabilities?.modes?.includes(mode));
    if (match) return { workflowName: match.name, workflowManifest: null };
    if (mode === 'txt2img') return { workflowName: currentWorkflow, workflowManifest };

    const currentModes = (workflowManifest?.capabilities?.modes || []);
    const availableModes = [...new Set(candidates.flatMap(item => item.capabilities?.modes || []))];
    const error = new Error(`当前请求需要「${mode}」模式（如 图生图/局部重绘/放大 等），但没有任何工作流支持它。`
      + `当前工作流「${currentWorkflow || '未选择'}」支持：${currentModes.join('、') || '无'}；`
      + `可用模式：${availableModes.join('、') || '无'}。请选择支持该模式的工作流，或在设置中新增对应工作流。`);
    error.failureType = 'workflow_mode_unavailable';
    error.retryable = false;
    throw error;
  }

  _enqueue(thunk) {
    if (!this._running) return null;
    this._pendingQueue.push(thunk);
    return { queued: true, position: this._pendingQueue.length };
  }

  async _drainQueue() {
    if (this._state === 'awaiting_confirmation') return;
    if (!this._pendingQueue || this._pendingQueue.length === 0) return;
    while (!this._running && !this._cancelRequested && this._pendingQueue.length > 0) {
      const next = this._pendingQueue.shift();
      await next();
    }
  }

  _lastImagesAsMedia() {
    const projectDir = this.sessionManager.getActiveProject?.()?.dir;
    if (!projectDir) return [];
    return (this.project.get('lastImages') || [])
      .filter(image => image?.type === 'project' && image.filename)
      .map(image => ({
        ...image,
        name: image.filename,
        path: join(projectDir, image.subfolder || '', image.filename),
      }))
      .filter(image => existsSync(image.path));
  }

  _intentContext(options = {}) {
    return {
      conversation: this.conversation.getMessages?.({ limit: 8 }) || this._conversationForLLM(8),
      sessionMemory: this.sessionManager.getSessionMemory?.() || this.sessionManager.getSessionState()?.sessionMemory || {},
      sessionState: this.sessionManager.getSessionState(),
      lastPrompt: this.project.get('lastPrompt') || '',
      lastImages: this._lastImagesAsMedia(),
      attachedMedia: options.media || null,
      modeHint: options.modeHint || '',
      sourceTurnId: options.sourceTurnId || '',
      eventMeta: { taskId: this._taskId, traceId: this._traceId, turnId: options.turnId || '', projectId: this.projectId, sessionId: this.sessionId },
    };
  }

  async routeIntent(userMessage, options = {}) {
    const decision = await this.intentRouter.route(userMessage, this._intentContext(options));
    const request = decision.request || userMessage;
    if (decision.action === 'prepare') {
      const readiness = assessPromptReadiness({
        request,
        intent: decision.intent,
        media: options.media,
        lastImages: this._lastImagesAsMedia(),
        lastPrompt: this.project.get('lastPrompt') || '',
      });
      if (readiness.readiness === 'clarify') {
        const blockedByMissingMedia = readiness.missing.some(missing => missing === 'reference_media' || missing === 'previous_generation');
        // LLM 已结合完整语境判明语义（调整方向/主体/新值）时，正则 readiness
        // 只补充上下文事实类缺失（参考图/上一张图），不否决 LLM 的语义判断。
        const readinessMissing = decision.source === 'llm'
          ? readiness.missing.filter(missing => missing === 'reference_media' || missing === 'previous_generation')
          : readiness.missing;
        if (!readinessMissing.length) {
          return { ...decision, request, readiness: { ...readiness, readiness: 'ready', missing: [], question: '' } };
        }
        // A configured intent model has already resolved the request context.
        // Only let the keyword fallback override a local/offline classification.
        if (decision.source !== 'llm' && blockedByMissingMedia && isExplicitNewGeneration(request)) {
          const generateReadiness = assessPromptReadiness({
            request,
            intent: 'generate',
            media: options.media,
            lastImages: this._lastImagesAsMedia(),
            lastPrompt: this.project.get('lastPrompt') || '',
          });
          const generateDecision = {
            ...decision,
            intent: 'generate',
            action: 'prepare',
            target: 'new',
            reason: 'explicit new generation request overrides refinement classification',
            request,
            readiness: generateReadiness,
          };
          if (generateReadiness.readiness === 'clarify') {
            return {
              ...generateDecision,
              action: 'clarify',
              missing: generateReadiness.missing,
              question: generateReadiness.question || questionFor('generate', generateReadiness.missing, request),
            };
          }
          return generateDecision;
        }
        return {
          ...decision,
          action: 'clarify',
          request,
          missing: [...new Set([...(decision.missing || []), ...readinessMissing])],
          question: decision.question || readiness.question || questionFor(decision.intent, readinessMissing, request),
          readiness: { ...readiness, missing: readinessMissing },
        };
      }
      return { ...decision, request, readiness };
    }
    if (decision.action === 'clarify' && !decision.question) {
      return { ...decision, question: questionFor(decision.intent, decision.missing, userMessage) };
    }
    return decision;
  }

  clarify(userMessage, decision = {}) {
    const response = decision.question || questionFor(decision.intent, decision.missing, userMessage);
    const existingTask = this._taskId ? this.taskManager?.get(this._taskId) : null;
    const canReuseTask = this._state === 'classifying' && existingTask && ['queued', 'classifying'].includes(existingTask.state || existingTask.status);
    const taskId = canReuseTask ? this._taskId : `clarify_${Date.now()}`;
    const traceId = this._traceId || nextTraceId();
    this._taskId = taskId;
    this._traceId = traceId;
    if (!this.taskManager.get(taskId)) {
      this.taskManager.create({ id: taskId, kind: 'clarify', message: userMessage, traceId, intent: decision.intent || 'generate', projectId: this.sessionManager.activeProjectId, sessionId: this.sessionManager.activeSessionId });
    }
    if (this._state !== 'classifying') this._transitionState('classifying', { message: 'Classifying request...' });
    if (this._state === 'classifying') this._transitionState('clarifying', { message: response });
    if (!decision.skipUserMessage) {
      this._writeTurnMessage('user', userMessage, {
        intent: decision.intent || 'chat',
        action: 'clarify',
      }, decision.sourceTurnId || '');
    }
    this._writeTurnMessage('agent', response, { kind: 'clarification' }, decision.sourceTurnId || '');
    this.sessionManager.setSessionState({
      state: 'clarifying',
      phase: 'awaiting_clarification',
      lastIntent: decision.intent || '',
      lastTaskId: taskId,
      pending: {
        request: decision.request || userMessage,
        intent: decision.intent || 'generate',
        missing: decision.missing || [],
        question: response,
      },
      pendingIntent: { ...decision, sourceTurnId: decision.sourceTurnId || '' },
      pendingRequest: decision.request || userMessage,
      pendingQuestion: response,
      supplementalInput: '',
    });
    this.taskManager.update(taskId, { status: 'clarifying', state: 'clarifying' });
    void this.taskManager.persist();
    emit(AgentEventTypes.MESSAGE, { role: 'agent', content: response, taskId, traceId });
    emit(AgentEventTypes.STATUS, { status: 'clarifying', uiStatus: 'waiting', state: 'clarifying', message: response, taskId, traceId });
    return { response, taskId, missing: decision.missing || [] };
  }

  async prepareGeneration(userMessage, options = {}) {
    return prepareGenerationOp(this, userMessage, options);
  }
  async prepareFileMutation(userMessage, options = {}) {
    return prepareFileMutationOp(this, userMessage, options);
  }

  async prepareWorkflowMutation(input, options = {}) {
    return prepareWorkflowMutationOp(this, input, options);
  }

  async runPrepared(previewId, edits = {}) {
    return runPreparedOp(this, previewId, edits);
  }

  _contextArchive() {
    return contextArchiveOf(this);
  }

  _archivePrompt(messages = []) {
    return archivePrompt(this, messages);
  }

  async _compactConversationSegment(messages, mode = 'cloud', signal) {
    return compactConversationSegment(this, messages, mode, signal);
  }

  async _prepareConversationArchive({ recentCount, mode, inputBudget, currentMessages, signal }) {
    return prepareConversationArchive(this, { recentCount, mode, inputBudget, currentMessages, signal });
  }

  // 回复完成后空闲期预压缩会话：把下一次回答前的一次完整 LLM 压缩调用
  // 提前到用户阅读回复的间隙执行。新消息到达时由 handleTurn 取消，不抢锁。
  async _prefetchContextArchive() {
    return prefetchContextArchive(this);
  }

  async compactConversation({ recentCount = 8, mode = 'cloud' } = {}) {
    return compactConversation(this, { recentCount, mode });
  }

  // Recall cross-session memory for system-prompt injection. Returns '' when
  // no memory is configured, the project has nothing stored, or recall fails.
  async _memoryContext(query = '') {
    return memoryContext(this, query);
  }

  _archiveMessage(archive) {
    return archiveMessage(this, archive);
  }

  async _chatWithDegradation({ buildRequest, isLocal, taskId, traceId, streamMessageId = '' }) {
    return chatWithDegradation(this, { buildRequest, isLocal, taskId, traceId, streamMessageId });
  }

  discardPrepared(previewId) {
    const discarded = this._preparedRuns.delete(previewId);
    const persisted = this.sessionManager.getSessionState?.().preparedPreview?.previewId === previewId;
    if (discarded || persisted) {
      if (this._taskId && this._state === 'awaiting_confirmation') {
        this.taskManager.complete(this._taskId, { result: { cancelled: true, reason: 'confirmation_declined' } });
        this._transitionState('cancelled', { message: 'Confirmation declined', needsConfirmation: false });
        this._transitionState('idle', { message: 'Ready for next turn', needsConfirmation: false });
      } else {
        this._state = 'idle';
        this._needsConfirmation = false;
      }
      void this.taskManager.persist();
      this.sessionManager.setSessionState?.({
        state: 'idle',
        phase: 'idle',
        pending: null,
        pendingIntent: null,
        pendingRequest: '',
        preparedPreview: null,
        taskStatus: 'cancelled',
      });
    }
    return { discarded: discarded || persisted };
  }

  async run(userMessage, options = {}) {
    return runFlow(this, userMessage, options);
  }
  _resultSummary(result) {
    return resultSummary(this, result);
  }

  _recordGenerationArtifact(result, compiledPrompt = {}, metadata = {}) {
    return recordGenerationArtifact(this, result, compiledPrompt, metadata);
  }

  recordArtifact(result, metadata = {}) {
    return recordArtifact(this, result, metadata);
  }

  async _replanPlan(plan, stepIndex, step, output, ctx, completedSteps) {
    return replanPlan(this, plan, stepIndex, step, output, ctx, completedSteps);
  }

  async _executeWithRetry(step, ctx) {
    return executeWithRetry(this, step, ctx);
  }

  async _retryDecision(step, ctx, output, attempt = 1) {
    return retryDecision(this, step, ctx, output, attempt);
  }

  _retryParameters(step, ctx) {
    return retryParameters(this, step, ctx);
  }

  _rotateRetryParameters(ctx, decision) {
    return rotateRetryParameters(ctx, decision);
  }

  _recordStepAttempt(step, output, attempt, ctx) {
    return recordStepAttempt(this, step, output, attempt, ctx);
  }

  _filesystemRoots() {
    const roots = [];
    const add = (name, path) => {
      if (!path || roots.some(root => root.path === path)) return;
      roots.push({ name, path });
    };

    add('workflow', this.workflowDir);
    add('project', this.sessionManager.getActiveProject?.()?.dir);
    for (const name of ['input', 'output', 'temp']) {
      if (this.comfyRoot) add(name, join(this.comfyRoot, name));
    }
    return roots;
  }

  // Approves a path found in chat text for auto-attach as a vision image.
  // Only paths inside the sandbox roots (workflow/project/input/output/temp)
  // are accepted; everything else is dropped so arbitrary local files are
  // never read and forwarded to the LLM provider implicitly.
  _authorizeVisionPath(path) {
    if (!path || typeof path !== 'string') return false;
    try {
      resolveSandboxFile({
        workflowDir: this.workflowDir,
        allowedRoots: this._filesystemRoots(),
        comfyRoot: this.comfyRoot,
      }, path);
      return true;
    } catch {
      return false;
    }
  }

  async _recompilePrompt(ctx, decision) {
    return recompilePrompt(this, ctx, decision);
  }

  _collectPromptIssues(result) {
    return collectPromptIssues(this, result);
  }

  _collectArtifacts(result, step) {
    return collectArtifacts(this, result, step);
  }

  async runWithWorkflow(userMessage, workflowName, options = {}) {
    this.project.set('workflow', workflowName);
    return this.run(userMessage, options);
  }

  async prepareWithWorkflow(userMessage, workflowName, options = {}) {
    return this.prepareGeneration(userMessage, { ...options, workflowName });
  }

  _localResponse(text) {
    return localResponse(this, text);
  }

  async chat(userMessage, options = {}) {
    return chatFlow(this, userMessage, options);
  }

  async detectWorkflow(workflowName) {
    return WorkflowAdapter.resolve(workflowName, this.workflowDir);
  }

  getArtifacts(options = {}) {
    const { type, limit } = options;
    let result = this._artifacts;
    if (type) result = result.filter(a => a.type === type);
    if (limit) result = result.slice(-limit);
    return result;
  }

  _buildResponse(result, userGoal) {
    if (!result) return '任务完成，没有可显示的输出。';
     if (result.videos && result.videos.length > 0) {
       return `已完成 — 生成了 ${result.videos.length} 个视频，请查看下方输出面板。`;
     }
     if (result.media && result.media.length > 0) {
       return `已完成 — 生成了 ${result.media.length} 个媒体结果，请查看下方输出面板。`;
     }
     if (result.images && result.images.length > 0) {
      return `已完成 — 生成了 ${result.images.length} 张图片，请查看下方输出面板。`;
    }
    return '任务执行成功。';
  }

  async cancel(taskId = '') {
    if (taskId && this._taskId !== taskId) {
      return { cancelled: false, reason: 'task_not_current' };
    }
    this._cancelRequested = true;
    this._pendingQueue = [];
    const cancelledTaskId = this._taskId;
    this._promptCompileController?.abort('cancelled');
    this.llm?.cancel();
    if (this.executor) this.executor.cancel();
    const promptIds = [...this._activePromptIds];
    this._activePromptIds.clear();
    try {
      if (promptIds.length > 0) {
        for (const promptId of promptIds) await ComfyUITool.cancel(promptId);
      } else if (this._running) {
        await ComfyUITool.cancel();
      }
    } catch {}
    // 取消竞态：等待 ComfyUI 中断返回期间执行可能已完成（取消到达太晚），
    // 此时不能再把已完成的任务覆写成取消状态，否则已生成成果会被吞掉。
    const alreadyCompleted = cancelledTaskId ? this.taskManager.get(cancelledTaskId)?.status === 'completed' : false;
    if (!alreadyCompleted) {
      if (cancelledTaskId) {
        this.taskManager.complete(cancelledTaskId, { result: { cancelled: true } });
        if (this._state !== 'cancelled' && canTransition(this._state, 'cancelled')) this._transitionState('cancelled', { message: 'Cancelled', needsConfirmation: false });
        this.taskManager.update(cancelledTaskId, { status: 'cancelled', state: 'cancelled' });
        void this.taskManager.persist();
      }
      this.sessionManager.setSessionState?.({
        phase: 'cancelled',
        lastTaskId: cancelledTaskId,
        pending: null,
        pendingIntent: null,
        pendingRequest: '',
        preparedPreview: null,
        taskStatus: 'cancelled',
      });
      this.sessionManager.clearCurrentTask?.();
    }
    this._running = false;
    return { cancelled: true, taskId: cancelledTaskId };
  }

  async abandon() {
    this.llm?.cancel();
    if (this.executor) this.executor.cancel();
    this._pendingQueue = [];
    if (this._taskId) {
      this.taskManager.markAbandoned({ taskId: this._taskId });
    }
    this.sessionManager.setSessionState?.({
      state: 'idle',
      phase: 'idle',
      lastTaskId: this._taskId,
      pending: null,
      pendingIntent: null,
      pendingRequest: '',
      preparedPreview: null,
      taskStatus: 'idle',
    });
    this.sessionManager.clearCurrentTask?.();
    this._running = false;
    return { abandoned: true, taskId: this._taskId };
  }

  async listQueue() {
    const q = await ComfyUITool.client.queue();
    return {
      running: q.queue_running?.length || 0,
      pending: q.queue_pending?.length || 0,
      runningPromptIds: (q.queue_running || []).map(item => item?.[1]).filter(Boolean),
      pendingPromptIds: (q.queue_pending || []).map(item => item?.[1]).filter(Boolean),
    };
  }

  async cancelPrompt(promptId) {
    return ComfyUITool.cancel(promptId);
  }

  async clearQueue() {
    const q = await ComfyUITool.client.queue();
    const pendingPromptIds = (q.queue_pending || []).map(item => item?.[1]).filter(Boolean);
    await ComfyUITool.client.queueDelete(pendingPromptIds);
    await ComfyUITool.client.interrupt();
    return { cleared: pendingPromptIds.length };
  }

  clearConversation() {
    this.conversation.clear();
    if (this._state !== 'idle' && canTransition(this._state, 'idle')) this._transitionState('idle', { message: '', needsConfirmation: false });
    this.sessionManager.setSessionState?.({ phase: 'idle', lastIntent: '', pending: null, executionRecords: {}, contextArchive: { version: 1, segments: [], archivedMessageIds: [] } });
    return { cleared: true, length: this.conversation.length };
  }

  recordConversationMessage(role, content, metadata = {}) {
    const safeAttachments = Array.isArray(metadata.attachments)
      ? metadata.attachments
        .map(item => ({ name: item?.name || item?.path?.split(/[\\/]/).pop() || '', kind: item?.kind || 'image' }))
        .filter(item => item.name)
      : undefined;
    return this._writeTurnMessage(role, content, {
      ...metadata,
      ...(safeAttachments ? { attachments: safeAttachments } : {}),
    }, metadata.turnId || '');
  }

  removeConversationTurn(turnId) {
    return { removed: this.conversation.removeByTurnId(turnId) };
  }

  rewindConversation(index) {
    return this.conversation.rewind(index);
  }

  listTasks(limit = 50) {
    return this.taskManager.list(limit);
  }

  getTrace(taskId) {
    return this.taskManager.getTrace(taskId);
  }

  recordFeedback(type, details = {}) {
    const allowed = new Set(['satisfied', 'regenerate', 'edit_prompt', 'new_seed', 'adjust_parameters']);
    if (!allowed.has(type)) throw new Error(`Unsupported feedback type: ${type}`);
    const projectId = this.sessionManager.activeProjectId;
    const sessionId = this.sessionManager.activeSessionId;
    const task = this._taskId ? this.taskManager.get(this._taskId) : null;
    const currentTask = task?.kind === 'run' && task.projectId === projectId && task.sessionId === sessionId ? task : null;
    const taskId = currentTask?.id
      || this.taskManager.list(200).find(item => item.kind === 'run' && item.projectId === projectId && item.sessionId === sessionId)?.id;
    if (!taskId) return { recorded: false, reason: 'No generation task' };
    const feedback = this.taskManager.addFeedback(taskId, type, details);
    if (!feedback) return { recorded: false, reason: 'Task not found' };
    void this.taskManager.persist();
    emit(AgentEventTypes.FEEDBACK, { taskId, traceId: this.taskManager.get(taskId)?.traceId || this._traceId, feedback });
    return { recorded: true, taskId, feedback };
  }

  get isRunning() {
    return this._running;
  }

  get taskId() {
    return this._taskId;
  }

  get state() {
    return this._state;
  }
}

export { wantsWebResearch, chatResearchContext };
