import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { formatAgentError } from '../error-message.mjs';
import { useComfyUI } from './ComfyUIContext.jsx';
import { useSession } from './SessionContext.jsx';
import { buildPresetGenerationRequest, presetWorkflowName } from '../runtime/preset-generation.mjs';
import { normalizeProgressEvent } from '../runtime/progress.mjs';

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

function resultMedia(result = {}) {
  const images = Array.isArray(result.images) ? result.images : [];
  const videos = Array.isArray(result.videos) ? result.videos : [];
  return Array.isArray(result.media) && result.media.length > 0 ? result.media : [...images, ...videos];
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
  const [videos, setVideos] = useState([]);
  const [media, setMedia] = useState([]);
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
  const [generationResult, setGenerationResult] = useState(null);
  const [autoConfirmPreviewId, setAutoConfirmPreviewId] = useState('');
  const [generationSource, setGenerationSource] = useState('');
  const [preview, setPreview] = useState(null);
  const [promptPreview, setPromptPreview] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [editingMessageIndex, setEditingMessageIndex] = useState(-1);
  const [policyConfirm, setPolicyConfirm] = useState(null);
  const [contextUsage, setContextUsage] = useState(null);

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
  const activeImageRequestIdRef = useRef('');
  const blockedTaskIdsRef = useRef(new Set());
  const submissionLockRef = useRef(false);
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
    if (result?.result) {
      const items = resultMedia(result.result);
      if (!items.length) return result;
      setImages(previous => mergeAssets(previous, result.result.images || []));
      setVideos(previous => mergeAssets(previous, result.result.videos || []));
      setMedia(previous => mergeAssets(previous, items));
      setStatusMsg('恢复任务已归档');
    }
    return result;
  }, [refreshRecoveryTasks]);

  const monitorRecoveryTask = useCallback(async taskId => {
    if (!window.electronAPI.agentMonitorTask) return null;
    const result = await window.electronAPI.agentMonitorTask(taskId);
    await refreshRecoveryTasks();
    if (result?.result) {
      const items = resultMedia(result.result);
      if (items.length) {
        setImages(previous => mergeAssets(previous, result.result.images || []));
        setVideos(previous => mergeAssets(previous, result.result.videos || []));
        setMedia(previous => mergeAssets(previous, items));
        setGenerationResult({ ...result.result, media: items });
      }
    }
    return result;
  }, [refreshRecoveryTasks]);

  const archiveRecoveryTask = useCallback(async taskId => {
    const result = await window.electronAPI.agentArchiveTask(taskId);
    await refreshRecoveryTasks();
    return result;
  }, [refreshRecoveryTasks]);

  const archiveAllRecoveryTasks = useCallback(async () => {
    const current = recoveryTasks;
    if (!window.electronAPI.agentArchiveTask) return [];
    const results = await Promise.all(current.map(task => window.electronAPI.agentArchiveTask(task.id)));
    await refreshRecoveryTasks();
    return results;
  }, [recoveryTasks, refreshRecoveryTasks]);

  useEffect(() => {
    if (!recoveryTasks.length) return undefined;
    const timer = setInterval(() => { void refreshRecoveryTasks().catch(() => {}); }, 5000);
    return () => clearInterval(timer);
  }, [recoveryTasks.length, refreshRecoveryTasks]);

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
    // Persisted session updates can arrive after a direct generation has started.
    // Do not hydrate the old snapshot over the live task in that window.
    if (generationPending || submissionLockRef.current) return;
    const storedState = session.sessionState || {};
    const storedImages = Array.isArray(storedState.lastImages) ? storedState.lastImages : [];
    const source = storedState.lastGenerationSource || '';
    setMessages(session.messages || []);
    setImages(storedImages);
    setVideos(Array.isArray(storedState.lastVideos) ? storedState.lastVideos : []);
    setMedia(Array.isArray(storedState.lastMedia) ? storedState.lastMedia : storedImages);
    setAssets(session.project?.assets || []);
    setLastGenerationRequest(storedState.lastPrompt || '');
    setLastGenerationNegative(storedState.lastCompiledPrompt?.negative || '');
    generationSourceRef.current = source || 'ai';
    setGenerationSource(source);
    setPromptMode(session.project?.promptMode || 'raw');
    if (session.project?.workflow) setSelectedFile(session.project.workflow);
    setActivityEvents([]);
    setStatus(storedState.preparedPreview ? 'preview' : 'idle');
    setStatusMsg('');
    setGenerationPending(false);
    // A direct quick-generation preview is live state. Do not overwrite it with
    // the previous session snapshot while its prepare/run IPC is in flight.
    if (!generationPending && !submissionLockRef.current) {
      setPromptPreview(storedState.preparedPreview || null);
    }
    setPreview(null);
    setTrace(null);
    setGenerationProgress(null);
    setGenerationResult(null);
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
    let progressTimer = 0;
    let pendingProgress = null;
    let lastProgressKey = '';
    const clearQueuedProgress = () => {
      pendingProgress = null;
      if (progressTimer) window.clearTimeout(progressTimer);
      progressTimer = 0;
    };
    const flushProgress = () => {
      progressTimer = 0;
      const data = pendingProgress;
      pendingProgress = null;
      if (!data) return;
      const key = [data.stage, data.nodeId || data.node, data.percent, data.overallPercent, data.nodePercent, data.message].join('|');
      if (key === lastProgressKey) return;
      lastProgressKey = key;
      setGenerationProgress(previous => normalizeProgressEvent(data, previous));
      if (data.message) setStatusMsg(data.message);
    };
    const queueProgress = data => {
      pendingProgress = data;
      if (['completed', 'error', 'cancelled'].includes(data.stage)) {
        if (progressTimer) window.clearTimeout(progressTimer);
        flushProgress();
        return;
      }
      if (!progressTimer) progressTimer = window.setTimeout(flushProgress, 16);
    };
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
      if (terminal) {
        clearQueuedProgress();
        setGenerationPending(false);
        setGenerationProgress(null);
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
      queueProgress(data);
    }));

    const isCurrentDirectEvent = data => {
      if ((data.projectId || data.sessionId) && !isCurrentSessionEvent(data)) return false;
      if (!data.projectId || !data.sessionId) return false;
      if (data.taskId && blockedTaskIdsRef.current.has(data.taskId)) return false;
      if (['running', 'completed', 'cancelled'].includes(data.status) && !data.taskId) return false;
      if (data.status === 'failed' && !data.taskId && data.phase !== 'preparing') return false;
      if (data.taskId && !activeTaskIdRef.current) activeTaskIdRef.current = data.taskId;
      return !data.taskId || !activeTaskIdRef.current || data.taskId === activeTaskIdRef.current;
    };

    unsubs.push(window.electronAPI.onDirectStatus(data => {
      if (!isCurrentDirectEvent(data)) return;
      if (data.status === 'prepared' && data.preview?.previewId) {
        setPromptPreview({ ...data.preview, quickGenerate: data.preview.quickGenerate !== false });
        setGenerationPending(true);
        setStatus('preview');
      }
      setStatus(data.uiStatus || data.status);
      setStatusMsg(data.message || '');
      if (data.status === 'running' && data.timeEstimate) {
        setGenerationProgress(previous => normalizeProgressEvent({
          ...previous,
          timeEstimate: data.timeEstimate,
          startedAt: data.startedAt || Date.now(),
          message: data.message || previous?.message,
        }, previous));
      }
      if (data.status === 'completed' && data.result) {
        const result = data.result;
        const resultItems = resultMedia(result);
        setGenerationResult({ ...result, media: resultItems });
        setImages(result.images || []);
        setVideos(result.videos || []);
        setMedia(resultItems);
      }
      if (['completed', 'failed', 'cancelled'].includes(data.status)) {
        clearQueuedProgress();
        setGenerationPending(false);
        setGenerationProgress(null);
      }
    }));

    unsubs.push(window.electronAPI.onDirectProgress(data => {
      if (!isCurrentDirectEvent(data)) return;
      queueProgress(data);
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

    if (window.electronAPI.onAgentContextUsage) {
      unsubs.push(window.electronAPI.onAgentContextUsage(data => {
        if (!isCurrentAgentEvent(data)) return;
        setContextUsage(data);
      }));
    }

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
      if (progressTimer) window.clearTimeout(progressTimer);
      progressTimer = 0;
      pendingProgress = null;
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
    if ((!text && attachments.length === 0) || status === 'running' || submissionLockRef.current) return;
    submissionLockRef.current = true;
    if (!selectedFile) {
      setStatus('error');
      setStatusMsg('请先选择一个工作流');
      submissionLockRef.current = false;
      return;
    }

    const controls = controlsOverride || generationControls;
    generationSourceRef.current = 'ai';
    setGenerationSource('ai');
    setLastGenerationRequest(text || IMAGE_ONLY_REQUEST);
    setLastGenerationNegative('');
    activeTaskIdRef.current = '';
    setAutoConfirmPreviewId('');
    setPromptPreview(null);
    setPreview(null);
    setActivityEvents([]);
    setGenerationProgress(null);
    setGenerationResult(null);
    setGenerationPending(true);
    setImages([]);
    setVideos([]);
    setMedia([]);
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
        executionPolicy: { retry: false, evaluate: false, mutatePrompt: false },
        projectId: session.activeProjectId,
        sessionId: session.activeSessionId,
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
    } finally {
      submissionLockRef.current = false;
    }
  }, [status, selectedFile, workflowManifest, generationControls, attachments, beginAgentTask, discardGenerationTurn]);

  const runDirectGeneration = useCallback(async (text, overrides = {}) => {
    if (!text && attachments.length === 0) return { status: 'empty_prompt', message: '请输入提示词或添加参考图' };
    if (status === 'running' || submissionLockRef.current) return { status: 'busy', message: '已有生成任务正在进行' };
    submissionLockRef.current = true;
    if (!selectedFile) {
      setStatus('error');
      setStatusMsg('请先选择一个工作流');
      submissionLockRef.current = false;
      return { status: 'missing_workflow', message: '请先选择一个工作流' };
    }

    const controls = overrides.controls || generationControls;
    const media = overrides.media || requestMedia(text, attachments);
    generationSourceRef.current = 'direct';
    setGenerationSource('direct');
    setLastGenerationRequest(text || IMAGE_ONLY_REQUEST);
    if (typeof overrides.negative === 'string') setLastGenerationNegative(overrides.negative);
    activeTaskIdRef.current = '';
    setAutoConfirmPreviewId('');
    setPromptPreview(null);
    setPreview(null);
    setActivityEvents([]);
    setGenerationProgress(null);
    setGenerationResult(null);
    setGenerationPending(true);
    setImages([]);
    setVideos([]);
    setMedia([]);
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
    setStatus(overrides.quickGenerate === true ? 'preparing' : 'running');
    setStatusMsg('正在准备直接生成...');

    try {
      const result = await window.electronAPI.directPrepare({
        requestId: turnId,
        source: 'direct',
        projectId: session.activeProjectId,
        sessionId: session.activeSessionId,
        workflowName: overrides.workflowName || selectedFile,
        positive: text || IMAGE_ONLY_REQUEST,
        negative: overrides.negative || '',
        settings: controls.settings || {},
        nodeOverrides: controls.nodeOverrides || {},
        outputNodeIds: controls.outputNodeIds || null,
        media,
        turnId,
        origin: overrides.origin || 'prompt_library',
        presetId: overrides.presetId || '',
        presetOrigin: overrides.presetOrigin || '',
        executionPolicy: { retry: true, evaluate: true, mutatePrompt: false },
      });
       const nextPreview = { ...result, quickGenerate: overrides.quickGenerate === true || overrides.autoConfirm === true };
       setPromptPreview(nextPreview);
       if (overrides.autoConfirm === true) setAutoConfirmPreviewId(result.previewId || '');
       const finalWorkflowName = result?.workflow?.name || result?.workflowName || overrides.workflowName || selectedFile;
       if (finalWorkflowName && finalWorkflowName !== selectedFile) setSelectedFile(finalWorkflowName);
       setStatus('preview');
       setStatusMsg('已完成生成准备，请确认后执行');
       return { ...result, status: 'accepted', workflowName: finalWorkflowName };
    } catch (error) {
      const userMessage = formatAgentError(error);
      await discardGenerationTurn();
      setGenerationPending(false);
      setStatus('error');
      setStatusMsg(userMessage);
      return { status: 'failed', message: userMessage };
    } finally {
      submissionLockRef.current = false;
    }
  }, [status, selectedFile, generationControls, attachments, beginAgentTask, discardGenerationTurn, session.activeProjectId, session.activeSessionId]);

  const sendQuickGeneration = useCallback((text, { negative = '', workflowName = '' } = {}) => (
    runDirectGeneration(text, {
      negative,
      workflowName: workflowName || selectedFile,
      origin: 'quick_generate',
      autoConfirm: true,
    })
  ), [runDirectGeneration, selectedFile]);

  const runLibraryGeneration = useCallback(async (text, negative = '', options = {}) => {
    if (!options.preset) return runDirectGeneration(text, {
      negative,
      origin: 'prompt_library',
      autoConfirm: options.immediate === true,
    });
    if (window.electronAPI.globalPresetCheckDependencies) {
      const dependencyReport = await window.electronAPI.globalPresetCheckDependencies(options.preset.id);
      if (!dependencyReport?.valid) {
        const firstIssue = dependencyReport?.issues?.find(issue => issue.severity === 'error');
        const message = firstIssue?.message || '预设依赖不完整，暂时无法生成';
        setStatus('error');
        setStatusMsg(message);
        return { status: 'dependency_failed', message, dependencyReport };
      }
    }
    const request = buildPresetGenerationRequest(options.preset, { workflowName: selectedFile, controls: generationControls, overrides: options.overrides });
    let media = request.media;
    if (window.electronAPI.globalPresetResolveResources) {
      const resolved = await window.electronAPI.globalPresetResolveResources(options.preset);
      media = { images: resolved?.sourceImages || [], videos: [] };
    }
     let workflowName = presetWorkflowName(request, selectedFile);
     workflowName = workflowName && !workflowName.includes('/') && !workflowName.includes('\\') ? workflowName : selectedFile;
    if (window.electronAPI.globalPresetMatchWorkflow && workflowName) {
      const matched = await window.electronAPI.globalPresetMatchWorkflow(workflowName).catch(() => null);
      if (matched?.matched) workflowName = matched.workflowName;
    }
    return runDirectGeneration(request.positive || text, {
      negative: request.negative || negative,
      origin: request.origin,
      workflowName,
      controls: { settings: request.settings, nodeOverrides: request.nodeOverrides, outputNodeIds: request.outputNodeIds },
      media,
      presetId: request.presetId,
      presetOrigin: request.presetOrigin,
      autoConfirm: options.immediate === true,
    });
  }, [runDirectGeneration, selectedFile, generationControls]);

  const confirmPromptPreview = useCallback(async (edits = {}) => {
    if (promptPreview?.action === 'ai_failed') {
      const request = promptPreview.originalRequest;
      await discardGenerationTurn();
      setPromptPreview(null);
      setGenerationPending(false);
      setStatus('idle');
     setStatusMsg('');
    setContextUsage(null);
      if (edits.action === 'direct_original') return runDirectGeneration(request, { origin: 'ai_failure_fallback' });
      if (edits.action === 'force_cloud') return runGeneration(request, { ...generationControls, allowPolicyOverride: true });
      return runGeneration(request);
    }
    if (!promptPreview?.previewId) return;
    const previewId = promptPreview.previewId;
    const preview = promptPreview;
    activeTaskIdRef.current = '';
    setAutoConfirmPreviewId('');
    setPromptPreview(null);
    setMessages(previous => previous.filter(message => !message.previewNotice));
    setGenerationPending(true);
    setGenerationResult(null);
    setImages([]);
    setVideos([]);
    setMedia([]);
    setThinking('');
    setStatus('running');
    setStatusMsg('正在执行已确认的提示词...');
    sendStartRef.current = Date.now();
    beginAgentTask();
    try {
      const result = promptPreview.source === 'direct'
        ? await window.electronAPI.directRunPrepared(previewId, edits, {
          confirmation: {
            accepted: true,
            digest: preview.requestDigest,
            requestId: preview.requestId,
            previewId,
          },
        })
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
      const resultItems = resultMedia(executionResult);
      if (resultItems.length) {
        setGenerationResult({ ...executionResult, media: resultItems });
        if (preview.presetId && window.electronAPI.globalPresetMarkUsed) void window.electronAPI.globalPresetMarkUsed(preview.presetId, true).catch(() => {});
        setImages(executionResult.images || []);
        setVideos(executionResult.videos || []);
        setMedia(resultItems);
        setGenerationPending(false);
        setAssets(previous => mergeAssets(previous, resultItems));
        setMessages(previous => {
          if (preview.source === 'direct') {
            return [...previous, {
              role: 'agent',
              content: `Generated ${resultItems.length} media item(s).`,
              images: executionResult.images || [],
              videos: executionResult.videos || [],
              media: resultItems,
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
              ? { ...message, images: mergeAssets(message.images || [], executionResult.images || []), videos: mergeAssets(message.videos || [], executionResult.videos || []), media: mergeAssets(message.media || [], resultItems) }
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
  }, [promptPreview, status, selectedFile, workflowManifest, session.activeSessionId, runDirectGeneration, runGeneration, beginAgentTask, discardGenerationTurn, generationControls]);

  useEffect(() => {
    if (!autoConfirmPreviewId || !promptPreview?.previewId || autoConfirmPreviewId !== promptPreview.previewId) return;
    setAutoConfirmPreviewId('');
    void confirmPromptPreview();
  }, [autoConfirmPreviewId, promptPreview, confirmPromptPreview]);

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

  const applyTurnResult = useCallback(async (result, requestText, modeHint = 'answer') => {
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
    if (result?.action === 'policy_block') {
      setGenerationPending(false);
      setStatus('idle');
      setStatusMsg('');
      setPolicyConfirm({
        text: requestText,
        modeHint,
        media: null,
        turnId: result.turnId || '',
        message: result.message || '内容被云端审查拦截',
        categories: result.policyDecision?.categories || [],
        reason: result.policyDecision?.reason || '',
      });
      return;
    }
    setGenerationPending(false);
    setStatus('idle');
    setStatusMsg(result.response || '已完成');
    if (sessionInfoRef.current.messageCount === 0 && sessionInfoRef.current.title === '新会话') {
      const renameTarget = sessionInfoRef.current.sessionId;
      const renameProjectId = sessionInfoRef.current.projectId;
      void window.electronAPI.agentTitleForMessage(requestText)
        .then(({ title }) => {
          if (!title || !renameTarget || !renameProjectId) return undefined;
          sessionInfoRef.current = { ...sessionInfoRef.current, title, messageCount: 1 };
          return session.renameSession(renameTarget, title, renameProjectId).catch(() => {});
        })
        .catch(() => {});
    }
  }, [selectedFile, setSelectedFile, session]);

  const submitTurn = useCallback(async (text, modeHint = 'answer') => {
    if ((!text && attachments.length === 0) || status === 'running' || submissionLockRef.current) return;
    submissionLockRef.current = true;
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
        projectId: session.activeProjectId,
        sessionId: session.activeSessionId,
        turnId,
      });
      return applyTurnResult(result, requestText, modeHint);
    } catch (error) {
      const userMessage = formatAgentError(error);
      setGenerationPending(false);
      setStatus('error');
      setStatusMsg(userMessage);
      setMessages(previous => [...previous, { role: 'agent', content: userMessage, time: timeStr() }]);
    } finally {
      submissionLockRef.current = false;
    }
  }, [status, selectedFile, workflowManifest, attachments, session.activeSessionId, beginAgentTask, applyTurnResult]);

  const confirmPolicyOverride = useCallback(async () => {
    const pending = policyConfirm;
    if (!pending || submissionLockRef.current) return;
    submissionLockRef.current = true;
    if (pending.kind === 'openai-image') {
      setPolicyConfirm(null);
      setGenerationPending(true);
      setStatus('running');
      setStatusMsg('已确认手动发送，正在调用云端生图...');
      try {
        const result = await window.electronAPI.imageGenerate(pending.text, {
          projectId: session.activeProjectId,
          sessionId: session.activeSessionId,
          images: pending.images || [],
          requestId: pending.turnId,
          allowPolicyOverride: true,
          ...(pending.imageOptions || {}),
        });
        activeImageRequestIdRef.current = pending.turnId;
        activeTaskIdRef.current = result.taskId || '';
        setImages(result.images || []);
        await refreshAssets({ replace: true });
        setMessages(previous => [...previous, { role: 'agent', content: 'OpenAI Image 生成完成。', images: result.images || [], time: timeStr(), turnId: pending.turnId }]);
        setLastGenerationRequest(pending.text);
        setGenerationSource('openai-image');
        setStatus('idle');
        setStatusMsg('生成完成');
      } catch (error) {
        setStatus('error');
        setStatusMsg(formatAgentError(error));
      } finally {
        setGenerationPending(false);
        submissionLockRef.current = false;
      }
      return;
    }
    setPolicyConfirm(null);
    setGenerationPending(true);
    setThinking('');
    setActivityEvents([]);
    setGenerationProgress(null);
    beginAgentTask();
    sendStartRef.current = Date.now();
    setStatus('running');
    setStatusMsg('已确认手动发送，正在重试...');
    try {
      const result = await window.electronAPI.agentHandleTurn({
        text: pending.text,
        modeHint: pending.modeHint || 'answer',
        media: pending.media || null,
        workflowName: selectedFile,
        workflowManifest,
        sessionId: session.activeSessionId,
        turnId: pending.turnId || '',
        allowPolicyOverride: true,
      });
      return applyTurnResult(result, pending.text);
    } catch (error) {
      const userMessage = formatAgentError(error);
      setGenerationPending(false);
      setStatus('error');
      setStatusMsg(userMessage);
      setMessages(previous => [...previous, { role: 'agent', content: userMessage, time: timeStr() }]);
    } finally {
      submissionLockRef.current = false;
    }
  }, [policyConfirm, selectedFile, workflowManifest, session.activeSessionId, beginAgentTask, applyTurnResult]);

  const cancelPolicyOverride = useCallback(() => {
    setPolicyConfirm(null);
    setGenerationPending(false);
    setStatus('idle');
    setStatusMsg('已取消发送（内容被云端审查拦截）。');
    setMessages(previous => [...previous, { role: 'agent', content: '已取消发送：内容被云端审查拦截，未发送到云端。', time: timeStr() }]);
  }, []);

  const handleSend = useCallback(async (action = 'answer', imageOptions = {}, textOverride = null) => {
    const text = textOverride === null ? input.trim() : String(textOverride || '').trim();
    if ((!text && attachments.length === 0) || status === 'running' || submissionLockRef.current) return;
    setInput('');

    setEditingMessageIndex(-1);
    if (action === 'direct') return runDirectGeneration(text);
    if (action === 'openai-image') {
      submissionLockRef.current = true;
      generationSourceRef.current = 'openai-image';
      setStatus('running');
      setStatusMsg('正在调用 OpenAI Image 生成图片...');
      setGenerationPending(true);
      const turnId = newTurnId();
      activeImageRequestIdRef.current = turnId;
      setMessages(previous => [...previous, { role: 'user', content: text, time: timeStr(), turnId }]);
      try {
        const result = await window.electronAPI.imageGenerate(text, {
          projectId: session.activeProjectId,
          sessionId: session.activeSessionId,
          images: attachments,
          requestId: turnId,
          ...imageOptions,
        });
        setImages(result.images || []);
        activeTaskIdRef.current = result.taskId || '';
        await refreshAssets({ replace: true });
        setMessages(previous => [...previous, { role: 'agent', content: 'OpenAI Image 生成完成。', images: result.images || [], time: timeStr(), turnId }]);
        setLastGenerationRequest(text);
        setGenerationSource('openai-image');
        setStatus('idle');
        setStatusMsg('生成完成');
      } catch (error) {
        if (error?.code === 'CLOUD_POLICY_BLOCKED') {
          setGenerationPending(false);
          setStatus('idle');
          setPolicyConfirm({
            kind: 'openai-image',
            text,
            images: attachments,
            imageOptions,
            turnId,
            message: error.message || '内容被云端审查拦截',
            categories: error.policyDecision?.categories || [],
            reason: error.policyDecision?.reason || '',
          });
          return;
        }
        setStatus('error');
        setStatusMsg(formatAgentError(error));
      } finally {
        setGenerationPending(false);
        submissionLockRef.current = false;
      }
      return;
    }
    if (action === 'answer') setAttachments([]);
    return submitTurn(text, action === 'generate' ? 'generate' : 'answer');
  }, [input, status, attachments, runDirectGeneration, submitTurn, session.activeProjectId, session.activeSessionId, refreshAssets]);

  const handleRegenerate = useCallback((feedbackType = 'regenerate') => {
    const controls = { ...generationControls };
    // Regenerate means a new sample. Reusing an existing seed produces the same image.
    controls.settings = { ...(controls.settings || {}), seed: Math.floor(Math.random() * 0xFFFFFFFF) };
    if (generationSourceRef.current === 'direct') {
      runDirectGeneration(lastGenerationRequest.trim(), { controls, negative: lastGenerationNegative });
      return;
    }
    if (generationSourceRef.current === 'openai-image') {
      void handleSend('openai-image', { ...controls, count: 1 }, lastGenerationRequest.trim());
      return;
    }
    void window.electronAPI.agentFeedback(feedbackType);
    runGeneration(lastGenerationRequest.trim(), controls);
  }, [lastGenerationRequest, lastGenerationNegative, runGeneration, runDirectGeneration, generationControls, handleSend]);

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
    setGenerationProgress(null);
    if (generationSourceRef.current === 'direct' || generationSourceRef.current === 'ai') {
      await discardGenerationTurn();
    }
    if (generationSourceRef.current === 'direct') await window.electronAPI.directCancel();
    else if (generationSourceRef.current === 'openai-image') await window.electronAPI.imageCancel(activeImageRequestIdRef.current);
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

  const clearConversation = useCallback(async () => {
    if (status === 'running') return;
    terminateStreamingTask(activeTaskIdRef.current, 'cancelled');
    if (promptPreview?.previewId) {
      try {
        if (promptPreview.source === 'direct') await window.electronAPI.directDiscardPreview(promptPreview.previewId);
        else await window.electronAPI.agentDiscardPreview(promptPreview.previewId);
      } catch {}
    }
    void window.electronAPI.agentClearConversation();
    setMessages([]);
    setImages([]);
    setVideos([]);
    setMedia([]);
    setGenerationSource('');
    setLastGenerationRequest('');
    setLastGenerationNegative('');
    setGenerationPending(false);
    setGenerationProgress(null);
    setGenerationResult(null);
    setPromptPreview(null);
    setPreview(null);
    setAttachments([]);
    setTrace(null);
    setActivityEvents([]);
    setContextUsage(null);
    setPolicyConfirm(null);
    setAutoConfirmPreviewId('');
    setEditingMessageIndex(-1);
    pendingGenerationIndexRef.current = -1;
    pendingGenerationTurnIdRef.current = '';
    activeTaskIdRef.current = '';
    activeImageRequestIdRef.current = '';
    submissionLockRef.current = false;
    setThinking('');
    setStatus('idle');
    setStatusMsg('');
  }, [status, promptPreview, terminateStreamingTask]);

  const value = {
    messages,
    setMessages,
    input,
    setInput,
    runGeneration,
    runLibraryGeneration,
    sendQuickGeneration,
    attachments,
    handleAttachMedia,
    removeAttachment,
    activityEvents,
    status,
    setStatus,
    statusMsg,
    setStatusMsg,
    images,
    videos,
    media,
    setImages,
    assets,
    refreshAssets,
    removeAsset,
    deleteAsset,
    thinking,
    lastGenerationRequest,
    lastGenerationNegative,
    generationSource,
    promptMode,
    setPromptMode,
    trace,
    setTrace,
    showTrace,
    setShowTrace,
    generationProgress,
    setGenerationProgress,
    generationResult,
    generationPending,
    preview,
    setPreview,
    promptPreview,
    confirmPromptPreview,
    cancelPromptPreview,
    policyConfirm,
    contextUsage,
    confirmPolicyOverride,
    cancelPolicyOverride,
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
    monitorRecoveryTask,
    archiveRecoveryTask,
    archiveAllRecoveryTasks,
  };

  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>;
}

export { buildGraphSteps };
