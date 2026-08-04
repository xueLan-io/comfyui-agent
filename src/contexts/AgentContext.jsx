import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { formatAgentError } from '../error-message.mjs';
import { useComfyUI } from './ComfyUIContext.jsx';
import { useSession } from './SessionContext.jsx';

const TOOL_LABELS = {
  comfyui: 'ComfyUI',
  prompt_enhance: '提示词优化',
  filesystem: '文件系统',
  web: 'Web research',
  evaluator: '结果评估',
  planning: '任务规划',
};

const AgentContext = createContext(null);

export function useAgent() {
  return useContext(AgentContext);
}

function timeStr() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function toolLabel(tool) {
  return TOOL_LABELS[tool] || tool || '';
}

function buildGraphSteps(events) {
  const steps = new Map();

  events.forEach((event, index) => {
    if (!event.status || (!event.tool && event.stage !== 'planning')) return;
    const key = event.stepId || event.tool || event.stage || `event-${index}`;
    const previous = steps.get(key);
    steps.set(key, {
      ...previous,
      ...event,
      _key: key,
      _order: previous?._order ?? index,
    });
  });

  return [...steps.values()].sort((a, b) => a._order - b._order);
}

function mergeAssets(current, next) {
  const merged = new Map((current || []).map(image => [
    assetKey(image),
    image,
  ]));
  (next || []).forEach(image => merged.set(
    assetKey(image),
    image,
  ));
  return [...merged.values()];
}

function assetKey(image = {}) {
  return `${image.type || ''}:${image.projectId || ''}:${image.subfolder || ''}:${image.filename || ''}`;
}

function messageAttachments(items = []) {
  return items
    .filter(item => item?.name || item?.path)
    .map(item => ({
      name: item.name || item.path.split(/[\\/]/).pop(),
      kind: item.kind || 'image',
      ...(item.previewUrl ? { previewUrl: item.previewUrl } : {}),
    }));
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);

function collectRequestImages(text, media) {
  const images = [...media.images];
  const paths = new Set(images.map(item => item?.path).filter(Boolean));
  const pathPattern = /(?:"([A-Za-z]:\\[^"\r\n]+|\/[^"\r\n]+)"|'([A-Za-z]:\\[^'\r\n]+|\/[^'\r\n]+)'|((?:[A-Za-z]:\\|\/)[^\s"']+))/g;
  for (const match of String(text || '').matchAll(pathPattern)) {
    const path = match[1] || match[2] || match[3];
    const extension = `.${path.split('.').pop().toLowerCase()}`;
    if (!IMAGE_EXTENSIONS.has(extension) || paths.has(path)) continue;
    paths.add(path);
    images.push({ path, name: path.split(/[\\/]/).pop(), kind: 'image' });
  }
  return images;
}

function requestMedia(text, attachments) {
  const media = {
    images: attachments.filter(item => item.kind === 'image'),
    videos: attachments.filter(item => item.kind === 'video'),
  };
  return {
    ...media,
    images: collectRequestImages(text, media),
  };
}

const IMAGE_ONLY_REQUEST = '请结合这张图片继续处理我的请求。';

function newTurnId() {
  return `turn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function AgentProvider({ children }) {
  const { selectedFile, setSelectedFile, workflowManifest, generationControls } = useComfyUI();
  const session = useSession();

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [activityEvents, setActivityEvents] = useState([]);
  const [status, setStatus] = useState('idle');
  const [statusMsg, setStatusMsg] = useState('');
  const [images, setImages] = useState([]);
  const [generationPending, setGenerationPending] = useState(false);
  const [assets, setAssets] = useState([]);
  const [thinking, setThinking] = useState('');
  const [lastGenerationRequest, setLastGenerationRequest] = useState('');
  const [lastGenerationNegative, setLastGenerationNegative] = useState('');
  const [promptMode, setPromptMode] = useState('raw');
  const [trace, setTrace] = useState(null);
  const [showTrace, setShowTrace] = useState(false);
  const [recoveryTasks, setRecoveryTasks] = useState([]);
  const [generationProgress, setGenerationProgress] = useState(null);
  const [generationSource, setGenerationSource] = useState('');
  const [preview, setPreview] = useState(null);
  const [promptPreview, setPromptPreview] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [editingMessageIndex, setEditingMessageIndex] = useState(-1);

  const msgEndRef = useRef(null);
  const conversationRef = useRef(null);
  const thinkingTextRef = useRef(null);
  const inputRef = useRef(null);
  const sendStartRef = useRef(0);
  const pendingGenerationIndexRef = useRef(-1);
  const pendingGenerationTurnIdRef = useRef('');
  const generationSourceRef = useRef('ai');
  const streamingUpdatesRef = useRef(new Map());
  const streamingFrameRef = useRef(0);
  const activeTaskIdRef = useRef('');
  const blockedTaskIdsRef = useRef(new Set());
  const sessionInfoRef = useRef({ sessionId: '', projectId: '', title: '', messageCount: 0 });
  sessionInfoRef.current = {
    sessionId: session.activeSessionId,
    projectId: session.activeProjectId,
    title: session.projects.find(project => project.id === session.activeProjectId)?.sessions?.find(item => item.id === session.activeSessionId)?.title || '',
    messageCount: session.messages?.length || 0,
  };
  const thinkingUpdateRef = useRef(null);
  const thinkingFrameRef = useRef(0);
  const followConversationRef = useRef(true);
  const graphSteps = useMemo(() => buildGraphSteps(activityEvents), [activityEvents]);

  const beginAgentTask = useCallback(() => {
    activeTaskIdRef.current = '';
  }, []);

  const terminateStreamingTask = useCallback((taskId = '', streamState = 'cancelled') => {
    const targetTaskId = taskId || activeTaskIdRef.current;
    if (targetTaskId && streamState !== 'completed') blockedTaskIdsRef.current.add(targetTaskId);

    if (streamingFrameRef.current) window.cancelAnimationFrame(streamingFrameRef.current);
    streamingFrameRef.current = 0;
    for (const [messageId, data] of streamingUpdatesRef.current) {
      if (!targetTaskId || data.taskId === targetTaskId) streamingUpdatesRef.current.delete(messageId);
    }

    setMessages(previous => previous.map(message => {
      const belongsToTask = targetTaskId
        ? message.taskId === targetTaskId
        : message.streaming || message.streamingMessageId;
      if (!belongsToTask || (!message.streaming && !message.streamingMessageId)) return message;
      const { streamingMessageId, ...completedMessage } = message;
      return {
        ...completedMessage,
        streaming: false,
        ...(streamState !== 'completed' ? { streamState } : {}),
      };
    }));
    setThinking('');
  }, []);

  const refreshAssets = useCallback(async ({ replace = true } = {}) => {
    if (!session.activeProjectId || !window.electronAPI.projectAssets) return [];
    const projectAssets = await window.electronAPI.projectAssets(session.activeProjectId);
    if (Array.isArray(projectAssets)) {
      if (replace) {
        setAssets(projectAssets);
      } else {
        setAssets(previous => mergeAssets(previous, projectAssets));
      }
      return projectAssets;
    }
    return [];
  }, [session.activeProjectId, session.activeSessionId]);

  const refreshRecoveryTasks = useCallback(async () => {
    if (!window.electronAPI.agentListTasks) return [];
    const tasks = await window.electronAPI.agentListTasks();
    const recoverable = (tasks || []).filter(task => ['submit_unknown', 'observe_timeout', 'archive_failed', 'observing'].includes(task.state || task.status));
    setRecoveryTasks(recoverable);
    return recoverable;
  }, []);

  const retryRecoveryTask = useCallback(async taskId => {
    const result = await window.electronAPI.agentRetryRecovery(taskId);
    await refreshRecoveryTasks();
    if (result?.result?.images?.length) {
      setImages(previous => mergeAssets(previous, result.result.images));
      setStatusMsg('恢复任务已归档');
    }
    return result;
  }, [refreshRecoveryTasks]);

  const removeAsset = useCallback((image) => {
    const key = assetKey(image);
    setAssets(previous => previous.filter(item => assetKey(item) !== key));
    setImages(previous => previous.filter(item => assetKey(item) !== key));
  }, []);

  const deleteAsset = useCallback(async (image) => {
    if (!window.electronAPI.projectDeleteAsset) return false;
    const next = await window.electronAPI.projectDeleteAsset(image);
    if (Array.isArray(next)) {
      setAssets(next);
      setImages(previous => previous.filter(item => assetKey(item) !== assetKey(image)));
    } else removeAsset(image);
    return true;
  }, [removeAsset, session.activeSessionId]);

  useEffect(() => {
    if (!session.activeSessionId) return;
    const storedState = session.sessionState || {};
    const storedImages = Array.isArray(storedState.lastImages) ? storedState.lastImages : [];
    const source = storedState.lastGenerationSource || '';
    setMessages(session.messages || []);
    setImages(storedImages);
    setAssets(session.project?.assets || []);
    setLastGenerationRequest(storedState.lastPrompt || '');
    setLastGenerationNegative(storedState.lastCompiledPrompt?.negative || '');
    generationSourceRef.current = source || 'ai';
    setGenerationSource(source);
    setPromptMode(session.project?.promptMode || 'raw');
    setSelectedFile(session.project?.workflow || '');
    setActivityEvents([]);
    setStatus(storedState.preparedPreview ? 'preview' : 'idle');
    setStatusMsg('');
    setGenerationPending(false);
    setPromptPreview(storedState.preparedPreview || null);
    setPreview(null);
    setTrace(null);
    setGenerationProgress(null);
    setThinking('');
    setAttachments([]);
    setEditingMessageIndex(-1);
    pendingGenerationIndexRef.current = -1;
    pendingGenerationTurnIdRef.current = '';
    activeTaskIdRef.current = '';
    void refreshAssets({ replace: true }).catch(() => {});
    void refreshRecoveryTasks().catch(() => {});
    return undefined;
  }, [session.activeProjectId, session.activeSessionId, session.messages, session.project, setSelectedFile, refreshAssets, refreshRecoveryTasks]);

  useEffect(() => {
    let lastSync = 0;
    const syncAssets = () => {
      if (document.visibilityState === 'hidden') return;
      const now = Date.now();
      if (now - lastSync < 1000) return;
      lastSync = now;
      void refreshAssets({ replace: true }).catch(() => {});
    };

    window.addEventListener('focus', syncAssets);
    document.addEventListener('visibilitychange', syncAssets);
    return () => {
      window.removeEventListener('focus', syncAssets);
      document.removeEventListener('visibilitychange', syncAssets);
    };
  }, [refreshAssets]);

  useEffect(() => {
    const unsubs = [];
    const isCurrentSessionEvent = data => data.projectId === session.activeProjectId
      && data.sessionId === session.activeSessionId;

    const isCurrentAgentEvent = data => {
      if (!isCurrentSessionEvent(data)) return false;
      if (data.taskId && blockedTaskIdsRef.current.has(data.taskId)) return false;
      if (data.taskId && !activeTaskIdRef.current) activeTaskIdRef.current = data.taskId;
      return !data.taskId || !activeTaskIdRef.current || data.taskId === activeTaskIdRef.current;
    };

    const applyStreamingMessage = (previous, data) => {
      const elapsed = sendStartRef.current > 0 ? Date.now() - sendStartRef.current : 0;
      const messageIndex = previous.findIndex(message => message.streamingMessageId === data.messageId || message.messageId === data.messageId);
      if (messageIndex < 0) {
        const messageData = data.done ? data : { ...data, streamingMessageId: data.messageId };
        return [...previous, {
          ...messageData,
          time: timeStr(),
          duration_ms: data.done ? elapsed : 0,
        }];
      }

      return previous.map((message, index) => {
        if (index !== messageIndex) return message;
        if (!data.done) return { ...message, ...data };
        const { streamingMessageId, ...completedMessage } = message;
        return { ...completedMessage, ...data, time: timeStr(), duration_ms: elapsed };
      });
    };

    const flushStreamingMessages = () => {
      streamingFrameRef.current = 0;
      const updates = [...streamingUpdatesRef.current.values()];
      streamingUpdatesRef.current.clear();
      if (updates.length > 0) setMessages(previous => updates.reduce(applyStreamingMessage, previous));
    };

    const queueStreamingMessage = data => {
      streamingUpdatesRef.current.set(data.messageId, data);
      if (data.done) {
        if (streamingFrameRef.current) window.cancelAnimationFrame(streamingFrameRef.current);
        flushStreamingMessages();
      } else if (!streamingFrameRef.current) {
        streamingFrameRef.current = window.requestAnimationFrame(flushStreamingMessages);
      }
    };

    const flushThinking = () => {
      thinkingFrameRef.current = 0;
      if (thinkingUpdateRef.current === null) return;
      const partial = thinkingUpdateRef.current;
      thinkingUpdateRef.current = null;
      setThinking(partial);
    };

    const queueThinking = partial => {
      thinkingUpdateRef.current = partial;
      if (!thinkingFrameRef.current) thinkingFrameRef.current = window.requestAnimationFrame(flushThinking);
    };

    const clearThinking = () => {
      if (thinkingFrameRef.current) window.cancelAnimationFrame(thinkingFrameRef.current);
      thinkingFrameRef.current = 0;
      thinkingUpdateRef.current = null;
      setThinking('');
    };

    unsubs.push(window.electronAPI.onAgentStatus(data => {
      if (!isCurrentAgentEvent(data)) return;
      setStatus(data.uiStatus || data.status);
      setStatusMsg(data.message || '');
      const terminal = ['completed', 'failed', 'error', 'cancelled', 'abandoned'].includes(data.status) || data.uiStatus === 'error';
      if (data.status === 'error' || data.status === 'failed' || data.status === 'cancelled') setGenerationProgress(null);
      if (terminal) {
        setGenerationPending(false);
        terminateStreamingTask(data.taskId, data.status === 'completed' ? 'completed' : data.status);
      }
      if (data.taskId && terminal) {
        void window.electronAPI.agentGetTrace(data.taskId).then(savedTrace => {
          if (savedTrace && isCurrentSessionEvent(data) && activeTaskIdRef.current === data.taskId) setTrace(savedTrace);
        }).catch(() => {});
      }
    }));

    unsubs.push(window.electronAPI.onAgentProgress(data => {
      if (!isCurrentAgentEvent(data)) return;
      setGenerationProgress(data);
      if (data.message) setStatusMsg(data.message);
    }));

    const isCurrentDirectEvent = data => {
      if ((data.projectId || data.sessionId) && !isCurrentSessionEvent(data)) return false;
      if (data.taskId && blockedTaskIdsRef.current.has(data.taskId)) return false;
      if (data.taskId && !activeTaskIdRef.current) activeTaskIdRef.current = data.taskId;
      return !data.taskId || !activeTaskIdRef.current || data.taskId === activeTaskIdRef.current;
    };

    unsubs.push(window.electronAPI.onDirectStatus(data => {
      if (!isCurrentDirectEvent(data)) return;
      setStatus(data.uiStatus || data.status);
      setStatusMsg(data.message || '');
      if (['completed', 'failed', 'cancelled'].includes(data.status)) {
        setGenerationPending(false);
      }
    }));

    unsubs.push(window.electronAPI.onDirectProgress(data => {
      if (!isCurrentDirectEvent(data)) return;
      setGenerationProgress(data);
      if (data.message) setStatusMsg(data.message);
    }));

    unsubs.push(window.electronAPI.onAgentStep(data => {
      if (!isCurrentAgentEvent(data)) return;
      setActivityEvents(previous => [...previous, { ...data, time: timeStr() }]);
    }));

    unsubs.push(window.electronAPI.onAgentToolCall(data => {
      if (!isCurrentAgentEvent(data)) return;
      setActivityEvents(previous => [...previous, {
        ...data,
        description: `正在调用 ${toolLabel(data.tool)}...`,
        status: 'running',
        time: timeStr(),
      }]);
    }));

    unsubs.push(window.electronAPI.onAgentToolResult(data => {
      if (!isCurrentAgentEvent(data)) return;
      setActivityEvents(previous => [...previous, {
        ...data,
        description: `${toolLabel(data.tool)} 已完成`,
        status: data.error ? 'error' : 'completed',
        time: timeStr(),
      }]);
    }));

    unsubs.push(window.electronAPI.onAgentMessage(data => {
      if (!isCurrentAgentEvent(data)) return;
      if (data.role === 'user') return;
      const elapsed = sendStartRef.current > 0 ? Date.now() - sendStartRef.current : 0;
      if (!data.streaming && !data.messageId) {
        setMessages(previous => [...previous, { ...data, time: timeStr(), duration_ms: elapsed }]);
        return;
      }
      queueStreamingMessage(data);
    }));

    unsubs.push(window.electronAPI.onAgentError(data => {
      if (!isCurrentAgentEvent(data)) return;
      setActivityEvents(previous => [...previous, {
        ...data,
        description: data.message,
        status: 'error',
        time: timeStr(),
      }]);
    }));

    unsubs.push(window.electronAPI.onAgentPlan(data => {
      if (!isCurrentAgentEvent(data)) return;
      if (data.stage === 'thinking') {
        queueThinking(data.partial || '');
        return;
      }
      if (data.stage === 'complete' || data.stage === 'error') {
        clearThinking();
      }
      if (data.steps) {
        setActivityEvents(previous => [...previous, {
          ...data,
          stage: 'planning',
          description: `已创建执行计划，共 ${data.steps.length} 步`,
          status: 'planning',
          time: timeStr(),
        }]);
        setTrace({ steps: data.steps, taskId: data.taskId });
      }
      if (data.plan) setTrace(previous => ({ ...previous, steps: data.plan.steps }));
    }));

    unsubs.push(window.electronAPI.onAgentTask(data => {
      if (!isCurrentAgentEvent(data)) return;
      setTrace(previous => ({ ...previous, taskId: data.taskId, stepCount: data.stepCount }));
    }));

    unsubs.push(window.electronAPI.onAgentTrace(data => {
      if (!isCurrentAgentEvent(data)) return;
      setTrace(previous => ({ ...previous, ...data }));
    }));

    return () => {
      unsubs.forEach(unsubscribe => unsubscribe());
      if (streamingFrameRef.current) window.cancelAnimationFrame(streamingFrameRef.current);
      streamingFrameRef.current = 0;
      streamingUpdatesRef.current.clear();
      activeTaskIdRef.current = '';
      if (thinkingFrameRef.current) window.cancelAnimationFrame(thinkingFrameRef.current);
      thinkingFrameRef.current = 0;
      thinkingUpdateRef.current = null;
    };
  }, [session.activeProjectId, session.activeSessionId, terminateStreamingTask]);

  useEffect(() => {
    if (followConversationRef.current) {
      msgEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
    }
  }, [messages, status, activityEvents, thinking]);

  useEffect(() => {
    const element = thinkingTextRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [thinking]);

  const handleConversationScroll = useCallback(event => {
    const element = event.currentTarget;
    followConversationRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 96;
  }, []);

  useEffect(() => {
    window.electronAPI.agentSetPromptMode(promptMode);
  }, [promptMode]);

  const discardGenerationTurn = useCallback(async () => {
    const turnId = pendingGenerationTurnIdRef.current;
    pendingGenerationTurnIdRef.current = '';
    pendingGenerationIndexRef.current = -1;
    if (!turnId) return;
    await window.electronAPI.agentRemoveConversationTurn?.(turnId)?.catch(() => {});
    setMessages(previous => previous.filter(message => message.turnId !== turnId));
  }, []);

  const runGeneration = useCallback(async (text, controlsOverride) => {
    if ((!text && attachments.length === 0) || status === 'running') return;
    if (!selectedFile) {
      setStatus('error');
      setStatusMsg('请先选择一个工作流');
      return;
    }

    const controls = controlsOverride || generationControls;
    generationSourceRef.current = 'ai';
    setGenerationSource('ai');
    setLastGenerationRequest(text || IMAGE_ONLY_REQUEST);
    setLastGenerationNegative('');
    setActivityEvents([]);
    setGenerationProgress(null);
    setGenerationPending(true);
    setImages([]);
    setThinking('');
    beginAgentTask();
    sendStartRef.current = Date.now();
    const turnId = newTurnId();
    pendingGenerationTurnIdRef.current = turnId;
    const attached = messageAttachments(attachments);
    setMessages(previous => {
      pendingGenerationIndexRef.current = previous.length;
      return [...previous, { role: 'user', content: text || '图片', time: timeStr(), turnId, attachments: attached, pendingGeneration: true }];
    });
    setStatus('running');
    setStatusMsg('正在准备工作流...');

    try {
      const media = requestMedia(text, attachments);
      const result = await window.electronAPI.agentGenerate(text, selectedFile, undefined, {
        ...controls,
        workflowManifest,
        media,
        turnId,
      });
      if (result?.action === 'clarify') {
        const pendingIndex = pendingGenerationIndexRef.current;
        setMessages(previous => previous.map((message, index) => (
          index === pendingIndex ? { ...message, pendingGeneration: false } : message
        )));
        pendingGenerationIndexRef.current = -1;
        pendingGenerationTurnIdRef.current = '';
        setGenerationPending(false);
        setStatus('idle');
        setStatusMsg(result.response || '请补充生成信息');
        return;
      }
      if (result?.action === 'ai_failed') {
        await discardGenerationTurn();
        setPromptPreview(result);
        setStatus('preview');
        setStatusMsg(result.error || 'AI 生成未完成');
        return;
      }
      if (result?.workflowName && result.workflowName !== selectedFile) {
        setSelectedFile(result.workflowName);
      }
      setPromptPreview(result);
      setStatus('preview');
      setStatusMsg('请确认提示词和注入目标');
    } catch (error) {
      const userMessage = formatAgentError(error);
      await discardGenerationTurn();
      setGenerationPending(false);
      setStatus('error');
      setStatusMsg(userMessage);
    }
  }, [status, selectedFile, workflowManifest, generationControls, attachments, beginAgentTask, discardGenerationTurn]);

  const runDirectGeneration = useCallback(async (text, overrides = {}) => {
    if ((!text && attachments.length === 0) || status === 'running') return;
    if (!selectedFile) {
      setStatus('error');
      setStatusMsg('请先选择一个工作流');
      return;
    }

    const controls = overrides.controls || generationControls;
    const media = requestMedia(text, attachments);
    generationSourceRef.current = 'direct';
    setGenerationSource('direct');
    setLastGenerationRequest(text || IMAGE_ONLY_REQUEST);
    setActivityEvents([]);
    setGenerationProgress(null);
    setGenerationPending(true);
    setImages([]);
    setThinking('');
    beginAgentTask();
    sendStartRef.current = Date.now();
    const turnId = newTurnId();
    pendingGenerationTurnIdRef.current = turnId;
    const attached = messageAttachments(attachments);
    setMessages(previous => {
      pendingGenerationIndexRef.current = previous.length;
      return [...previous, { role: 'user', content: text || '图片', time: timeStr(), turnId, attachments: attached, pendingGeneration: true }];
    });
    setStatus('running');
    setStatusMsg('正在准备直接生成...');

    try {
      const result = await window.electronAPI.directPrepare({
        source: 'direct',
        projectId: session.activeProjectId,
        sessionId: session.activeSessionId,
        workflowName: selectedFile,
        positive: text || IMAGE_ONLY_REQUEST,
        negative: overrides.negative || '',
        settings: controls.settings || {},
        nodeOverrides: controls.nodeOverrides || {},
        outputNodeIds: controls.outputNodeIds || null,
        media,
        turnId,
        origin: overrides.origin || 'prompt_library',
        executionPolicy: { retry: true, evaluate: true, mutatePrompt: false },
      });
      setPromptPreview(result);
      setStatus('preview');
      setStatusMsg('请检查原文提示词和工作流检查结果');
    } catch (error) {
      const userMessage = formatAgentError(error);
      await discardGenerationTurn();
      setGenerationPending(false);
      setStatus('error');
      setStatusMsg(userMessage);
    }
  }, [status, selectedFile, generationControls, attachments, beginAgentTask, discardGenerationTurn, session.activeProjectId, session.activeSessionId]);

  const runLibraryGeneration = useCallback(async (text, negative = '') => {
    return runDirectGeneration(text, { negative, origin: 'prompt_library' });
  }, [runDirectGeneration]);

  const confirmPromptPreview = useCallback(async (edits = {}) => {
    if (promptPreview?.action === 'ai_failed') {
      const request = promptPreview.originalRequest;
      await discardGenerationTurn();
      setPromptPreview(null);
      setGenerationPending(false);
      setStatus('idle');
      setStatusMsg('');
      if (edits.action === 'direct_original') return runDirectGeneration(request, { origin: 'ai_failure_fallback' });
      return runGeneration(request);
    }
    if (!promptPreview?.previewId || status === 'running') return;
    const previewId = promptPreview.previewId;
    const preview = promptPreview;
    setPromptPreview(null);
    setMessages(previous => previous.filter(message => !message.previewNotice));
    setGenerationPending(true);
    setImages([]);
    setThinking('');
    setStatus('running');
    setStatusMsg('正在执行已确认的提示词...');
    sendStartRef.current = Date.now();
    beginAgentTask();
    try {
      const result = promptPreview.source === 'direct'
        ? await window.electronAPI.directRunPrepared(previewId, edits)
        : await window.electronAPI.agentHandleTurn({
          text: '确认执行',
          modeHint: 'generate',
          confirmation: edits,
          workflowName: selectedFile,
          workflowManifest,
          sessionId: session.activeSessionId,
          recordConfirmation: false,
        });
      const executionResult = result?.result || result;
      if (executionResult?.error) throw new Error(executionResult.error);
      if (executionResult?.images) {
        setImages(executionResult.images);
        setGenerationPending(false);
        setAssets(previous => mergeAssets(previous, executionResult.images));
        setMessages(previous => {
          if (preview.source === 'direct') {
            return [...previous, {
              role: 'agent',
              content: `Generated ${executionResult.images.length} image(s).`,
              images: executionResult.images,
              prompt: edits.positive || preview.positive || '',
              negative: edits.negative || preview.negative || '',
              turnId: preview.turnId || '',
              time: timeStr(),
            }];
          }
          const index = previous.findLastIndex(message => message.role === 'agent');
          if (index < 0) return previous;
          return previous.map((message, messageIndex) => (
            messageIndex === index
              ? { ...message, images: mergeAssets(message.images || [], executionResult.images) }
              : message
          ));
        });
      }
      pendingGenerationTurnIdRef.current = '';
      pendingGenerationIndexRef.current = -1;
      setAttachments([]);
    } catch (error) {
      const userMessage = formatAgentError(error);
      await discardGenerationTurn();
      setGenerationPending(false);
      setStatus('error');
      setStatusMsg(userMessage);
    }
  }, [promptPreview, status, selectedFile, workflowManifest, session.activeSessionId, runDirectGeneration, runGeneration, beginAgentTask, discardGenerationTurn]);

  const handleAttachMedia = useCallback(async () => {
    const selected = await window.electronAPI.selectMediaFiles();
    if (!selected?.length) return;
    const withPreviews = await Promise.all(selected.map(async item => {
      if (item.kind !== 'image' || !window.electronAPI.mediaImageData) return item;
      const previewUrl = await window.electronAPI.mediaImageData(item).catch(() => '');
      return previewUrl ? { ...item, previewUrl } : item;
    }));
    setAttachments(current => {
      const paths = new Set(current.map(item => item.path));
      return [...current, ...withPreviews.filter(item => !paths.has(item.path))];
    });
  }, []);

  const removeAttachment = useCallback((path) => {
    setAttachments(current => current.filter(item => item.path !== path));
  }, []);

  const cancelPromptPreview = useCallback(async () => {
    if (promptPreview?.previewId) {
      try {
        if (promptPreview.source === 'direct') {
          await window.electronAPI.directDiscardPreview(promptPreview.previewId);
        } else {
          await window.electronAPI.agentDiscardPreview(promptPreview.previewId);
        }
      } catch {}
    }
    await discardGenerationTurn();
    setPromptPreview(null);
    setMessages(previous => previous.filter(message => !message.previewNotice));
    setGenerationPending(false);
    setStatus('idle');
    setStatusMsg('');
  }, [promptPreview, discardGenerationTurn]);

  const handleEditMessage = useCallback(async (index) => {
    if (status === 'running' || !messages[index] || messages[index].role !== 'user') return;
    const message = messages[index];
    await window.electronAPI.agentRewindConversation(index);
    setMessages(previous => previous.slice(0, index));
    setInput(message.content);
    setEditingMessageIndex(index);
    inputRef.current?.focus();
  }, [messages, status]);

  const cancelEdit = useCallback(() => {
    setInput('');
    setEditingMessageIndex(-1);
  }, []);

  const submitTurn = useCallback(async (text, modeHint = 'answer') => {
    if ((!text && attachments.length === 0) || status === 'running') return;
    const requestText = text || IMAGE_ONLY_REQUEST;
    generationSourceRef.current = 'chat';
    setGenerationSource('agent');
    setLastGenerationRequest(requestText);
    setGenerationPending(true);
    setThinking('');
    setActivityEvents([]);
    setGenerationProgress(null);
    beginAgentTask();
    sendStartRef.current = Date.now();
    const turnId = newTurnId();
    const attached = messageAttachments(attachments);
    setMessages(previous => [...previous, { role: 'user', content: text || '图片', time: timeStr(), turnId, attachments: attached }]);
    setStatus('running');
    setStatusMsg('正在判断请求并准备下一步...');
    try {
      const media = requestMedia(requestText, attachments);
      const result = await window.electronAPI.agentHandleTurn({
        text: requestText,
        modeHint,
        media,
        workflowName: selectedFile,
        workflowManifest,
        sessionId: session.activeSessionId,
        turnId,
      });
      if (result?.action === 'clarify') {
        setGenerationPending(false);
        setStatus('idle');
        setStatusMsg(result.response || result.result?.response || result.decision?.question || '请补充必要信息');
        return;
      }
      if (result?.action === 'queued') {
        setGenerationPending(false);
        setStatus('idle');
        setStatusMsg('\u751f\u6210\u8bf7\u6c42\u5df2\u6392\u961f\uff08\u7b2c ' + (result.position || '?') + ' \u9879\uff09');
        return;
      }
      if (result?.action === 'prepare') {
        setPromptPreview(result.preview);
        if (result.preview?.workflowName && result.preview.workflowName !== selectedFile) setSelectedFile(result.preview.workflowName);
        setStatus('preview');
        setStatusMsg(result.decision?.reason || '请确认生成预览');
        return;
      }
      setGenerationPending(false);
      setStatus('idle');
      setStatusMsg(result.response || '已完成');
      if (sessionInfoRef.current.messageCount === 0 && sessionInfoRef.current.title === '新会话') {
        const renameTarget = sessionInfoRef.current.sessionId;
        const renameProjectId = sessionInfoRef.current.projectId;
        void window.electronAPI.agentTitleForMessage(text)
          .then(({ title }) => {
            if (!title || !renameTarget || !renameProjectId) return undefined;
            sessionInfoRef.current = { ...sessionInfoRef.current, title, messageCount: 1 };
            return session.renameSession(renameTarget, title, renameProjectId).catch(() => {});
          })
          .catch(() => {});
      }
    } catch (error) {
      const userMessage = formatAgentError(error);
      setGenerationPending(false);
      setStatus('error');
      setStatusMsg(userMessage);
      setMessages(previous => [...previous, { role: 'agent', content: userMessage, time: timeStr() }]);
    }
  }, [status, selectedFile, workflowManifest, attachments, session.activeSessionId, setSelectedFile, beginAgentTask]);

  const handleSend = useCallback(async (action = 'answer') => {
    const text = input.trim();
    if ((!text && attachments.length === 0) || status === 'running') return;
    setInput('');

    setEditingMessageIndex(-1);
    if (action === 'direct') return runDirectGeneration(text);
    if (action === 'answer') setAttachments([]);
    return submitTurn(text, action === 'generate' ? 'generate' : 'answer');
  }, [input, status, attachments, runDirectGeneration, submitTurn]);

  const handleRegenerate = useCallback((feedbackType = 'regenerate') => {
    const controls = { ...generationControls };
    if (controls.settings?.seed == null) {
      controls.settings = { ...(controls.settings || {}), seed: Math.floor(Math.random() * 0xFFFFFFFF) };
    }
    if (generationSourceRef.current === 'direct') {
      runDirectGeneration(lastGenerationRequest.trim(), { controls, negative: lastGenerationNegative });
      return;
    }
    void window.electronAPI.agentFeedback(feedbackType);
    runGeneration(lastGenerationRequest.trim(), controls);
  }, [lastGenerationRequest, lastGenerationNegative, runGeneration, runDirectGeneration, generationControls]);

  const recordFeedback = useCallback(async (type, details = {}) => {
    if (type === 'regenerate' || type === 'new_seed') {
      if (lastGenerationRequest && status !== 'running') handleRegenerate(type);
      return { handled: true };
    }
    if (type === 'edit_prompt' && lastGenerationRequest) setInput(lastGenerationRequest);
    if (type === 'adjust_parameters') setShowSettings(true);
    return window.electronAPI.agentFeedback(type, details);
  }, [lastGenerationRequest, status, handleRegenerate]);

  const handleCancel = useCallback(async () => {
    terminateStreamingTask(activeTaskIdRef.current, 'cancelled');
    if (generationSourceRef.current === 'direct' || generationSourceRef.current === 'ai') {
      await discardGenerationTurn();
    }
    if (generationSourceRef.current === 'direct') await window.electronAPI.directCancel();
    else await window.electronAPI.agentCancel(activeTaskIdRef.current);
    setGenerationPending(false);
    setStatus('idle');
    setStatusMsg('已取消');
  }, [terminateStreamingTask, discardGenerationTurn]);

  const handleKeyDown = useCallback((event, action = 'answer') => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleSend(action);
    }
  }, [handleSend]);

  const clearConversation = useCallback(() => {
    if (status === 'running') return;
    terminateStreamingTask(activeTaskIdRef.current, 'cancelled');
    void window.electronAPI.agentClearConversation();
    setMessages([]);
    setImages([]);
    setGenerationSource('');
    setLastGenerationNegative('');
    setGenerationPending(false);
    setThinking('');
    setStatus('idle');
    setStatusMsg('');
  }, [status, terminateStreamingTask]);

  const value = {
    messages,
    setMessages,
    input,
    setInput,
    runGeneration,
    runLibraryGeneration,
    attachments,
    handleAttachMedia,
    removeAttachment,
    activityEvents,
    status,
    setStatus,
    statusMsg,
    setStatusMsg,
    images,
    setImages,
    assets,
    refreshAssets,
    removeAsset,
    deleteAsset,
    thinking,
    lastGenerationRequest,
    generationSource,
    promptMode,
    setPromptMode,
    trace,
    setTrace,
    showTrace,
    setShowTrace,
    generationProgress,
    setGenerationProgress,
    generationPending,
    preview,
    setPreview,
    promptPreview,
    confirmPromptPreview,
    cancelPromptPreview,
    showSettings,
    setShowSettings,
    graphSteps,
    msgEndRef,
    conversationRef,
    thinkingTextRef,
    handleConversationScroll,
    inputRef,
    handleSend,
    handleRegenerate,
    recordFeedback,
    editingMessageIndex,
    handleEditMessage,
    cancelEdit,
    handleCancel,
    handleKeyDown,
    clearConversation,
    recoveryTasks,
    refreshRecoveryTasks,
    retryRecoveryTask,
  };

  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>;
}

export { buildGraphSteps };
