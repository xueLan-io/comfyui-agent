import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { formatAgentError } from '../error-message.mjs';
import { useComfyUI } from './ComfyUIContext.jsx';
import { useSession } from './SessionContext.jsx';
import { buildPresetGenerationRequest, presetWorkflowName } from '../runtime/preset-generation.mjs';
import { normalizeProgressEvent } from '../runtime/progress.mjs';
import { normalizeGenerationResult } from '../runtime/generation-contract.mjs';

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

function eventErrorText(data) {
  if (!data) return '';
  if (typeof data.error === 'string') return data.error;
  if (data.error?.message) return data.error.message;
  return data.message || '';
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
  return JSON.stringify([
    image.assetId,
    image.path,
    image.url,
    image.type,
    image.projectId,
    image.sessionId,
    image.taskId,
    image.subfolder,
    image.filename || image.name,
    image.mediaType || image.kind,
  ].map(value => value ?? ''));
}

function messageKey(message = {}) {
  return message.messageId || message.id || (message.turnId ? `${message.turnId}:${message.role || ''}` : '');
}

function mergeConversation(current = [], incoming = []) {
  const merged = new Map();
  for (const message of current) {
    const key = messageKey(message);
    merged.set(key || `current:${merged.size}`, message);
  }
  for (const message of incoming) {
    const key = messageKey(message);
    if (key) merged.set(key, { ...merged.get(key), ...message });
    else merged.set(`incoming:${merged.size}`, message);
  }
  return [...merged.values()];
}

function resultMedia(result = {}) {
  const images = Array.isArray(result.images) ? result.images : [];
  const videos = Array.isArray(result.videos) ? result.videos : [];
  const supplied = Array.isArray(result.media) ? result.media : [];
  const all = [...images, ...videos, ...supplied];
  return normalizeGenerationResult({ ...result, media: all }).media || [];
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
  const sessionKeyRef = useRef('');

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
  const [generationTurn, setGenerationTurn] = useState(null);
  const [autoConfirmPreviewId, setAutoConfirmPreviewId] = useState('');
  const [generationSource, setGenerationSource] = useState('');
  const [preview, setPreview] = useState(null);
  const [promptPreview, setPromptPreview] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [editingMessageIndex, setEditingMessageIndex] = useState(-1);
  const [policyConfirm, setPolicyConfirm] = useState(null);
  const [contextUsage, setContextUsage] = useState(null);
  const [errorFeedback, setErrorFeedback] = useState(null);
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  const addActivityEvent = useCallback(event => {
    setActivityEvents(previous => [...previous, { ...event, time: event.time || timeStr() }]);
  }, []);

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
  const activeDirectTaskIdRef = useRef('');
  const activeDirectRequestIdRef = useRef('');
  const activeImageRequestIdRef = useRef('');
  const blockedTaskIdsRef = useRef(new Set());
  const blockedTurnIdsRef = useRef(new Set());
  const invalidPreviewIdsRef = useRef(new Set());
  const confirmedPreviewIdsRef = useRef(new Set());
  const activeTurnIdRef = useRef('');
  const hydratedSessionKeyRef = useRef('');
  const syncedSessionSnapshotRef = useRef('');
  const submissionLockRef = useRef(false);
  const generationTokenRef = useRef(0);
  const registeredDirectRequestsRef = useRef(new Set());
  const sessionInfoRef = useRef({ sessionId: '', projectId: '', title: '', messageCount: 0 });
  sessionInfoRef.current = {
    sessionId: session.activeSessionId,
    projectId: session.activeProjectId,
    title: session.projects.find(project => project.id === session.activeProjectId)?.sessions?.find(item => item.id === session.activeSessionId)?.title || '',
    messageCount: session.messages?.length || 0,
  };
  sessionKeyRef.current = `${session.activeProjectId}:${session.activeSessionId}`;
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
    const projectId = session.activeProjectId;
    const sessionKey = `${projectId}:${session.activeSessionId}`;
    if (!projectId || !window.electronAPI.projectAssets) return [];
    const projectAssets = await window.electronAPI.projectAssets(projectId);
    if (sessionKeyRef.current !== sessionKey) return [];
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
    const sessionKey = `${session.activeProjectId}:${session.activeSessionId}`;
    if (!window.electronAPI.agentListTasks) return [];
    const tasks = await window.electronAPI.agentListTasks();
    if (sessionKeyRef.current !== sessionKey) return [];
    const recoverable = (tasks || []).filter(task =>
      task.projectId === session.activeProjectId
      && task.sessionId === session.activeSessionId
      && ['submit_unknown', 'observe_timeout', 'archive_failed', 'observing'].includes(task.state || task.status));
    setRecoveryTasks(recoverable);
    return recoverable;
  }, [session.activeProjectId, session.activeSessionId]);

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
    const sessionKey = `${session.activeProjectId}:${session.activeSessionId}`;
    const switchedSession = hydratedSessionKeyRef.current !== sessionKey;
    // Persisted session updates can arrive after a direct generation has started.
    // Do not hydrate the old snapshot over the live task in that window.
      if (!switchedSession) {
        const snapshotKey = [
          // Result/media fields can change without changing message count or id.
          // Use the persisted payload so a completion is rendered immediately.
          JSON.stringify(session.messages || []),
          session.sessionState?.lastTaskId || '',
          session.sessionState?.taskStatus || session.sessionState?.state || '',
          session.sessionState?.updatedAt || '',
          session.sessionState?.preparedPreview?.previewId || '',
          session.sessionState?.lastResult?.taskId || '',
          JSON.stringify(session.project?.assets || []),
      ].join('|');
      if (syncedSessionSnapshotRef.current === snapshotKey) return undefined;
      syncedSessionSnapshotRef.current = snapshotKey;
      setMessages(previous => mergeConversation(previous, session.messages || []));
      if (Array.isArray(session.project?.assets)) setAssets(previous => mergeAssets(previous, session.project.assets));
      const persistedPreview = session.sessionState?.preparedPreview;
      if (persistedPreview?.previewId && !promptPreview
        && !invalidPreviewIdsRef.current.has(persistedPreview.previewId)
        && !confirmedPreviewIdsRef.current.has(persistedPreview.previewId)) {
        setPromptPreview(persistedPreview);
        setGenerationPending(true);
        setStatus('preview');
      }
      void refreshAssets({ replace: true }).catch(() => {});
      void refreshRecoveryTasks().catch(() => {});
      return undefined;
    }
    hydratedSessionKeyRef.current = sessionKey;
    syncedSessionSnapshotRef.current = '';
    const storedState = session.sessionState || {};
    const source = storedState.lastGenerationSource || '';
    activeTurnIdRef.current = storedState.turnId || '';
    setMessages(session.messages || []);
    // Historical media is rendered by its owning message, not as the live
    // output for the newly hydrated turn.
    setImages([]);
    setVideos([]);
    setMedia([]);
    setAssets(session.project?.assets || []);
    setLastGenerationRequest(storedState.lastPrompt || '');
    setLastGenerationNegative(storedState.lastCompiledPrompt?.negative || '');
    generationSourceRef.current = source || 'ai';
    setGenerationSource(source);
    setPromptMode(session.project?.promptMode || 'raw');
    if (session.project?.workflow) setSelectedFile(session.project.workflow);
    setActivityEvents([]);
    const taskActive = ['queued', 'executing', 'running', 'archiving', 'observing'].includes(storedState.taskStatus || storedState.state);
    setStatus(storedState.preparedPreview ? 'preview' : taskActive ? (storedState.state || storedState.taskStatus || 'running') : 'idle');
    setStatusMsg('');
    setGenerationPending(Boolean(storedState.preparedPreview || taskActive));
    // A direct quick-generation preview is live state. Do not overwrite it with
    // the previous session snapshot while its prepare/run IPC is in flight.
    if (!generationPending && !submissionLockRef.current) {
      const restoredPreview = storedState.preparedPreview;
      setPromptPreview(restoredPreview?.previewId
        && !invalidPreviewIdsRef.current.has(restoredPreview.previewId)
        && !confirmedPreviewIdsRef.current.has(restoredPreview.previewId)
        ? restoredPreview : null);
    }
    setPreview(null);
    setTrace(null);
    setGenerationProgress(null);
    const restoredResult = storedState.lastResult?.media?.length ? storedState.lastResult : null;
    const restoredMedia = restoredResult ? resultMedia(restoredResult) : [];
    setGenerationResult(restoredResult ? { ...restoredResult, media: restoredMedia } : null);
    setGenerationTurn(restoredResult ? { turnId: storedState.turnId || restoredResult.turnId || '', taskId: storedState.lastTaskId || restoredResult.taskId || '', requestId: storedState.requestId || restoredResult.requestId || '', status: 'completed', positive: restoredResult.positive || restoredResult.compiledPrompt?.positive || storedState.lastPrompt || '', negative: restoredResult.negative || restoredResult.compiledPrompt?.negative || '', media: restoredMedia } : null);
    setThinking('');
    setAttachments([]);
    setEditingMessageIndex(-1);
    pendingGenerationIndexRef.current = -1;
    pendingGenerationTurnIdRef.current = '';
    activeTaskIdRef.current = '';
    void refreshAssets({ replace: true }).catch(() => {});
    void refreshRecoveryTasks().catch(() => {});
    return undefined;
  }, [session.activeProjectId, session.activeSessionId, session.messages, session.project, session.sessionState, setSelectedFile, refreshAssets, refreshRecoveryTasks, generationPending, generationResult, promptPreview]);

  useEffect(() => {
    const sessionKey = `${session.activeProjectId}:${session.activeSessionId}`;
    if (!session.activeProjectId || !session.activeSessionId || !window.electronAPI.agentListRequestStatus) return undefined;
    let disposed = false;
    void window.electronAPI.agentListRequestStatus({
      projectId: session.activeProjectId,
      sessionId: session.activeSessionId,
      activeOnly: true,
    }).then(entries => {
      if (disposed || sessionKeyRef.current !== sessionKey || !Array.isArray(entries)) return;
      const entry = entries.find(item => item.source === 'direct') || entries[0];
      for (const item of entries) registeredDirectRequestsRef.current.add(item.requestId);
      if (!entry || entry.source !== 'direct') return;
      if (entry.taskId) activeDirectTaskIdRef.current = entry.taskId;
      activeDirectRequestIdRef.current = entry.requestId;
      if (entry.state === 'stopping') {
        setGenerationPending(true);
        setGenerationProgress(null);
        setStatus('stopping');
        setStatusMsg('后台任务正在收尾，请稍候');
        return;
      }
      if (['created', 'queued', 'preparing', 'prepared', 'executing', 'observing'].includes(entry.state)) {
        setGenerationPending(true);
        setStatus(entry.state === 'preparing' ? 'preparing' : entry.state === 'prepared' ? 'preview' : 'running');
        setStatusMsg('正在恢复任务状态...');
        return;
      }
      if (['timed_out', 'archive_failed'].includes(entry.state)) {
        setGenerationPending(false);
        setGenerationProgress(null);
        setStatus('error');
        setStatusMsg(entry.error?.message || '任务需要恢复处理');
      }
    }).catch(() => {});
    return () => { disposed = true; };
  }, [session.activeProjectId, session.activeSessionId, session.sessionState?.revision]);

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
      if (data.turnId && blockedTurnIdsRef.current.has(data.turnId)) return false;
      if (data.turnId && activeTurnIdRef.current && data.turnId !== activeTurnIdRef.current) return false;
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
      if (data.status === 'error' || data.status === 'failed' || data.uiStatus === 'error') {
        setErrorFeedback(previous => previous || { error: data.message || '任务执行失败', status: data.status, taskId: data.taskId, traceId: data.traceId });
        addActivityEvent({ ...data, type: 'error', description: data.message || '任务执行失败', status: 'error', error: eventErrorText(data) });
      }
      if (['preparing', 'queued', 'executing', 'running', 'archiving'].includes(data.status || data.uiStatus)) {
        clearThinking();
      }
      const terminal = ['completed', 'failed', 'error', 'cancelled', 'abandoned'].includes(data.status) || data.uiStatus === 'error';
      if (terminal) {
        clearQueuedProgress();
        setGenerationPending(false);
        if (data.status === 'completed') setGenerationProgress(previous => normalizeProgressEvent({ ...previous, stage: 'completed', percent: 100, overallPercent: 100, message: data.message || '生成完成' }, previous));
        else setGenerationProgress(null);
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
      const eventTaskId = data.taskId || data.requestId || '';
      if (data.turnId && blockedTurnIdsRef.current.has(data.turnId)) return false;
      if (data.turnId && activeTurnIdRef.current && data.turnId !== activeTurnIdRef.current) return false;
      if (eventTaskId && blockedTaskIdsRef.current.has(eventTaskId)) return false;
      if (['running', 'completed', 'cancelled'].includes(data.status) && !data.taskId) return false;
      if (data.status === 'failed' && !data.taskId && data.phase !== 'preparing') return false;
       // Events are delivered across renderer remounts and session switches.
       // Ownership is verified above, so do not discard a valid event merely
       // because this renderer did not originate the request.
       if (data.requestId) registeredDirectRequestsRef.current.add(data.requestId);
       if (!data.requestId && !activeDirectRequestIdRef.current) return false;
      if (activeDirectRequestIdRef.current && data.requestId && data.requestId !== activeDirectRequestIdRef.current) return false;
       if (data.taskId && !activeDirectTaskIdRef.current && !activeDirectRequestIdRef.current) return false;
      if (data.taskId && activeDirectTaskIdRef.current && data.taskId !== activeDirectTaskIdRef.current) {
        if (data.requestId === activeDirectRequestIdRef.current) activeDirectTaskIdRef.current = data.taskId;
        else return false;
      }
      return true;
    };

    unsubs.push(window.electronAPI.onDirectStatus(data => {
      if (!isCurrentDirectEvent(data)) return;
      if (data.status === 'prepared' && data.preview?.previewId) {
        if (invalidPreviewIdsRef.current.has(data.preview.previewId) || confirmedPreviewIdsRef.current.has(data.preview.previewId)) return;
        setPromptPreview({ ...data.preview, quickGenerate: data.preview.quickGenerate !== false });
        setGenerationPending(true);
        setStatus('preview');
      }
      setStatus(data.uiStatus || data.status);
      setStatusMsg(data.message || '');
      if (data.status === 'error' || data.status === 'failed' || data.uiStatus === 'error') {
        setErrorFeedback(previous => previous || { error: data.message || '任务执行失败', status: data.status, taskId: data.taskId, traceId: data.traceId });
        addActivityEvent({ ...data, type: 'error', description: data.message || '任务执行失败', status: 'error', error: eventErrorText(data) });
      }
      if (data.status === 'running' && data.timeEstimate) {
        clearThinking();
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
        const taskId = data.taskId || data.requestId || '';
        const messageId = data.messageId || (data.requestId ? `direct:${data.requestId}:completed` : taskId ? `direct:${taskId}:completed` : '');
        setGenerationResult({ ...result, media: resultItems });
        setGenerationTurn(previous => previous ? {
          ...previous,
          taskId: data.taskId || previous.taskId,
          requestId: data.requestId || previous.requestId,
          status: 'completed',
          media: resultItems,
          positive: data.positive || data.prompt || previous.positive,
          negative: data.negative || previous.negative,
          parameters: data.parameters || result.parameters || result.settings || previous.settings || {},
        } : previous);
        setImages(previous => mergeAssets(previous, result.images || []));
        setVideos(previous => mergeAssets(previous, result.videos || []));
        setMedia(previous => mergeAssets(previous, resultItems));
        void refreshAssets({ replace: true }).catch(() => {});
        setMessages(previous => {
          if (messageId && previous.some(message => message.messageId === messageId)) return previous;
          if (taskId && previous.some(message => message.directTaskId === taskId)) return previous;
           return [...previous, {
            role: 'agent',
            content: `Generated ${resultItems.length} media item(s).`,
            images: result.images || [],
            videos: result.videos || [],
            media: resultItems,
              messageId,
              directTaskId: taskId,
               requestId: data.requestId || '',
               turnId: data.turnId || '',
               prompt: data.positive || data.prompt || '',
               negative: data.negative || '',
               workflowName: data.workflowName || result.workflowName || '',
               parameters: data.parameters || result.parameters || result.settings || {},
               nodeOverrides: data.nodeOverrides || result.nodeOverrides || {},
               generationSource: 'direct',
               time: timeStr(),
           }];
        });
      }
      if (['completed', 'failed', 'cancelled'].includes(data.status)) {
        clearQueuedProgress();
        setGenerationPending(false);
        if (data.status === 'completed') setGenerationProgress(previous => normalizeProgressEvent({ ...previous, stage: 'completed', percent: 100, overallPercent: 100, message: data.message || '生成完成' }, previous));
        else setGenerationProgress(null);
      }
      if (data.status === 'stopping') {
        activeDirectRequestIdRef.current = data.requestId || activeDirectRequestIdRef.current;
        activeDirectTaskIdRef.current = data.taskId || activeDirectTaskIdRef.current;
        clearQueuedProgress();
        setGenerationPending(true);
        setGenerationProgress(null);
        setStatus('stopping');
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
        status: data.error && data.researchStatus ? 'warning' : (data.error ? 'error' : 'completed'),
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
      setErrorFeedback({
        error: data.message || data.error || '请求失败',
        status: data.status || 'error',
        taskId: data.taskId,
        traceId: data.traceId,
      });
      addActivityEvent({
        ...data,
        type: 'error',
        description: data.message,
        status: 'error',
        error: eventErrorText(data),
      });
      setGenerationPending(false);
      setGenerationProgress(null);
      clearQueuedProgress();
      terminateStreamingTask(data.taskId, 'error');
      setStatus('error');
      setStatusMsg(formatAgentError(data));
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
      activeDirectTaskIdRef.current = '';
      activeDirectRequestIdRef.current = '';
      if (thinkingFrameRef.current) window.cancelAnimationFrame(thinkingFrameRef.current);
      thinkingFrameRef.current = 0;
      thinkingUpdateRef.current = null;
    };
  }, [session.activeProjectId, session.activeSessionId, terminateStreamingTask, addActivityEvent, refreshAssets]);

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
    // Cancellation is terminal for this turn, but must preserve the user's
    // original request and conversation context.
    setMessages(previous => previous.map(message => (
      message.turnId === turnId
        ? { ...message, pendingGeneration: false, turnStatus: 'cancelled' }
        : message
    )));
  }, []);

  const runGeneration = useCallback(async (text, controlsOverride) => {
    if ((!text && attachments.length === 0) || status === 'running' || submissionLockRef.current) return;
    submissionLockRef.current = true;
    const generationToken = ++generationTokenRef.current;
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
    activeTaskIdRef.current = taskActive ? storedState.lastTaskId || '' : '';
    if (taskActive && storedState.lastTaskId) {
      setGenerationTurn(previous => previous || {
        turnId: storedState.turnId || '',
        taskId: storedState.lastTaskId,
        requestId: storedState.requestId || '',
        status: storedState.taskStatus || storedState.state || 'running',
        positive: storedState.lastPrompt || '',
        negative: storedState.lastCompiledPrompt?.negative || '',
        media: [],
      });
    }
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
    activeTurnIdRef.current = turnId;
    setGenerationTurn({ turnId, taskId: '', requestId: '', status: 'preparing', positive: text || IMAGE_ONLY_REQUEST, negative: '', workflow: selectedFile, settings: controls.settings || {}, media: [] });
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
      if (generationToken !== generationTokenRef.current) return { status: 'stale' };
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
      setGenerationTurn(previous => previous ? {
        ...previous,
        taskId: result?.taskId || previous.taskId,
        requestId: result?.requestId || previous.requestId,
        status: 'preview',
        positive: result?.positive || previous.positive,
        negative: result?.negative || previous.negative,
        workflow: result?.workflowName || previous.workflow,
      } : previous);
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
        if (generationToken !== generationTokenRef.current) return { status: 'stale' };
        const userMessage = formatAgentError(error);
        await discardGenerationTurn();
        setGenerationPending(false);
        setStatus('error');
        setStatusMsg(userMessage);
        setMessages(previous => [...previous, { role: 'agent', content: userMessage, time: timeStr(), turnId }]);
    } finally {
      submissionLockRef.current = false;
    }
  }, [status, selectedFile, workflowManifest, generationControls, attachments, beginAgentTask, discardGenerationTurn]);

  const runDirectGeneration = useCallback(async (text, overrides = {}) => {
    if (!text && attachments.length === 0) return { status: 'empty_prompt', message: '请输入提示词或添加参考图' };
    if (['running', 'preview', 'preparing', 'stopping'].includes(status) || submissionLockRef.current) {
      const message = status === 'stopping' ? '上一任务正在收尾，请等待取消完成后再试' : '已有生成任务正在进行或等待确认';
      setStatusMsg(message);
      return { status: 'busy', message };
    }
    submissionLockRef.current = true;
    const generationToken = ++generationTokenRef.current;
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
    activeDirectTaskIdRef.current = '';
    activeDirectRequestIdRef.current = '';
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
    activeTurnIdRef.current = turnId;
    setGenerationTurn({ turnId, taskId: '', requestId: turnId, status: 'preparing', positive: text || IMAGE_ONLY_REQUEST, negative: overrides.negative || '', workflow: overrides.workflowName || selectedFile, settings: controls.settings || {}, media: [] });
    registeredDirectRequestsRef.current.add(turnId);
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
       if (generationToken !== generationTokenRef.current) return { status: 'stale' };
        const nextPreview = { ...result, quickGenerate: overrides.quickGenerate === true || overrides.autoConfirm === true };
        setGenerationTurn(previous => previous ? {
          ...previous,
          taskId: result?.taskId || previous.taskId,
          requestId: result?.requestId || previous.requestId,
          status: 'preview',
          positive: result?.positive || previous.positive,
          negative: result?.negative || previous.negative,
        } : previous);
       setPromptPreview(nextPreview);
       if (overrides.autoConfirm === true) setAutoConfirmPreviewId(result.previewId || '');
       const finalWorkflowName = result?.workflow?.name || result?.workflowName || overrides.workflowName || selectedFile;
       if (finalWorkflowName && finalWorkflowName !== selectedFile) setSelectedFile(finalWorkflowName);
       setStatus('preview');
       setStatusMsg('已完成生成准备，请确认后执行');
       return { ...result, status: 'accepted', workflowName: finalWorkflowName };
    } catch (error) {
      if (generationToken !== generationTokenRef.current) return { status: 'stale' };
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

  const sendQuickGeneration = useCallback((text, { negative = '', workflowName = '', controls = null } = {}) => (
    runDirectGeneration(text, {
      negative,
      workflowName: workflowName || selectedFile,
      origin: 'quick_generate',
      autoConfirm: true,
      ...(controls ? { controls } : {}),
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
    const request = buildPresetGenerationRequest(options.preset, { workflowName: selectedFile, controls: options.controls || generationControls, overrides: options.overrides });
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
    if (promptPreview?.action === 'generation_suggestion') {
      const suggestion = promptPreview;
      if (edits.action !== 'prepare_generation') return;
      setPromptPreview(null);
      setGenerationPending(true);
      setStatus('running');
      setStatusMsg('正在整理提示词...');
      try {
        const result = await window.electronAPI.agentHandleTurn({
          text: suggestion.request,
          modeHint: 'generate',
          workflowName: selectedFile,
          workflowManifest,
          projectId: session.activeProjectId,
          sessionId: session.activeSessionId,
          turnId: suggestion.turnId || newTurnId(),
          skipUserMessage: true,
        });
        const payload = result?.result && typeof result.result === 'object'
          ? { ...result, ...result.result, result: result.result }
          : result;
        if (payload?.action === 'prepare' && payload.preview) {
          setPromptPreview(payload.preview);
          setStatus('preview');
          setStatusMsg(payload.decision?.reason || '请确认生成预览');
          return;
        }
        setGenerationPending(false);
        setStatus('idle');
        setStatusMsg(payload?.response || payload?.decision?.question || '未能准备生成请求');
      } catch (error) {
        setGenerationPending(false);
        setStatus('error');
        setStatusMsg(formatAgentError(error));
      }
      return;
    }
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
    if (confirmedPreviewIdsRef.current.has(previewId) || invalidPreviewIdsRef.current.has(previewId)) return;
    confirmedPreviewIdsRef.current.add(previewId);
    activeTurnIdRef.current = preview.turnId || preview.executionContext?.turnId || activeTurnIdRef.current;
    activeTaskIdRef.current = '';
    activeDirectTaskIdRef.current = promptPreview.taskId || '';
    activeDirectRequestIdRef.current = promptPreview.requestId || '';
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
           projectId: session.activeProjectId,
           sessionId: session.activeSessionId,
           turnId: preview.turnId || preview.executionContext?.turnId || activeTurnIdRef.current,
           requestId: preview.requestId || '',
           previewId,
          recordConfirmation: false,
        });
      const executionResult = result?.result || result;
      if (executionResult?.error) throw new Error(executionResult.error);
      const resultItems = resultMedia(executionResult);
    if (resultItems.length) {
        setGenerationResult({ ...executionResult, media: resultItems });
        setGenerationTurn(previous => previous ? {
          ...previous,
          taskId: executionResult.taskId || previous.taskId,
          requestId: executionResult.requestId || previous.requestId,
          status: 'completed',
          media: resultItems,
          positive: edits.positive || preview.positive || previous.positive,
          negative: edits.negative || preview.negative || previous.negative,
        } : previous);
        if (preview.presetId && window.electronAPI.globalPresetMarkUsed) void window.electronAPI.globalPresetMarkUsed(preview.presetId, true).catch(() => {});
        setImages(executionResult.images || []);
        setVideos(executionResult.videos || []);
        setMedia(resultItems);
        setGenerationTurn(previous => previous ? { ...previous, status: 'completed', media: resultItems } : previous);
        setGenerationPending(false);
        setAssets(previous => mergeAssets(previous, resultItems));
        setMessages(previous => {
          if (preview.source === 'direct') {
            const directTaskId = preview.taskId || preview.requestId || '';
            const messageId = preview.requestId ? `direct:${preview.requestId}:completed` : directTaskId ? `direct:${directTaskId}:completed` : '';
            if (messageId && previous.some(message => message.messageId === messageId)) return previous;
            if (directTaskId && previous.some(message => message.directTaskId === directTaskId)) return previous;
            return [...previous, {
              role: 'agent',
              content: `Generated ${resultItems.length} media item(s).`,
              images: executionResult.images || [],
              videos: executionResult.videos || [],
              media: resultItems,
              prompt: edits.positive || preview.positive || '',
              negative: edits.negative || preview.negative || '',
              turnId: preview.turnId || '',
              messageId,
              directTaskId,
              time: timeStr(),
            }];
          }
          const index = previous.findLastIndex(message => message.role === 'agent');
          if (index < 0) return previous;
          return previous.map((message, messageIndex) => (
            messageIndex === index
               ? { ...message, images: mergeAssets(message.images || [], executionResult.images || []), videos: mergeAssets(message.videos || [], executionResult.videos || []), media: mergeAssets(message.media || [], resultItems), prompt: edits.positive || preview.positive || message.prompt || '', negative: edits.negative || preview.negative || message.negative || '', workflowName: preview.workflowName || message.workflowName || '', parameters: preview.parameters || executionResult.parameters || executionResult.settings || message.parameters || {}, nodeOverrides: preview.nodeOverrides || executionResult.nodeOverrides || message.nodeOverrides || {}, generationSource: 'direct' }
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
    generationTokenRef.current += 1;
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
    // agent:turn wraps chat responses and generation previews in `result`.
    // Normalize that transport envelope before updating the UI.
    const payload = result?.result && typeof result.result === 'object'
      ? { ...result, ...result.result, result: result.result }
      : result;
    if (payload?.action === 'generate' && payload.preview) {
      setPromptPreview(payload.preview);
      setGenerationPending(true);
      setStatus('preview');
      setStatusMsg(payload.decision?.reason || '请确认生成预览');
      return;
    }
    if (payload?.action === 'clarify') {
      setGenerationPending(false);
      setStatus('idle');
       setStatusMsg(payload.response || payload.decision?.question || '请补充必要信息');
       return;
    }
    if (payload?.action === 'queued') {
      setGenerationPending(false);
      setStatus('idle');
       setStatusMsg('\u751f\u6210\u8bf7\u6c42\u5df2\u6392\u961f\uff08\u7b2c ' + (payload.position || '?') + ' \u9879\uff09');
       return;
    }
    if (payload?.action === 'prepare') {
       setPromptPreview(payload.preview);
       if (payload.preview?.workflowName && payload.preview.workflowName !== selectedFile) setSelectedFile(payload.preview.workflowName);
       setStatus('preview');
       setStatusMsg(payload.decision?.reason || '请确认生成预览');
       return;
    }
    if (payload?.action === 'policy_block') {
      setGenerationPending(false);
      setStatus('idle');
      setStatusMsg('');
      addActivityEvent({
        type: 'policy',
        status: 'rejected',
        description: '云端安全审核驳回',
        message: payload.message || '内容未通过云端安全审核',
        reason: payload.policyDecision?.reason || '',
        categories: payload.policyDecision?.categories || [],
        sentToCloud: false,
        taskId: payload.taskId || '',
        traceId: payload.traceId || '',
      });
      setPolicyConfirm({
        text: requestText,
        modeHint,
        media: null,
         turnId: payload.turnId || '',
         message: payload.message || '内容被云端审查拦截',
         categories: payload.policyDecision?.categories || [],
         reason: payload.policyDecision?.reason || '',
         requiresLocal: payload.policyDecision?.requiresLocal === true,
         localUnavailable: payload.policyDecision?.localUnavailable === true,
      });
      return;
    }
    if (payload?.action === 'suggest') {
      setGenerationPending(false);
      setPromptPreview({
        action: 'generation_suggestion',
        request: requestText,
        turnId: payload.turnId || '',
      });
      setStatus('idle');
      setStatusMsg(payload.response || '检测到图片生成请求');
      return;
    }
    setGenerationPending(false);
    setStatus('idle');
     setStatusMsg(payload.response || '已完成');
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
  }, [selectedFile, setSelectedFile, session, addActivityEvent]);

  const submitTurn = useCallback(async (text, modeHint = 'answer') => {
    if (!text && attachments.length === 0) return;
    if (status === 'running' || status === 'stopping' || submissionLockRef.current) {
      setStatusMsg(status === 'stopping' ? '上一任务正在收尾，请稍候' : '请求正在处理中，请勿重复发送');
      return { status: 'busy' };
    }
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
      addActivityEvent({ type: 'error', status: 'error', description: userMessage, error: error?.message || userMessage, code: error?.code || '', taskId: activeTaskIdRef.current, traceId: error?.traceId || '' });
      setMessages(previous => [...previous, { role: 'agent', content: userMessage, time: timeStr() }]);
    } finally {
      submissionLockRef.current = false;
    }
  }, [status, selectedFile, workflowManifest, attachments, session.activeSessionId, beginAgentTask, applyTurnResult, addActivityEvent]);

  const confirmPolicyOverride = useCallback(async () => {
    const pending = policyConfirm;
    if (!pending || submissionLockRef.current) return;
    submissionLockRef.current = true;
    addActivityEvent({
      type: 'policy',
      status: 'overridden',
      description: '已确认手动发送',
      message: '用户确认后继续发送到云端',
      sentToCloud: true,
      taskId: pending.taskId || '',
      traceId: pending.traceId || '',
    });
    if (pending.kind === 'openai-image') {
      setPolicyConfirm(null);
      setGenerationPending(true);
      setStatus('running');
      setStatusMsg('已确认手动发送，正在调用云端生图...');
      try {
         const generationToken = ++generationTokenRef.current;
         const result = await window.electronAPI.imageGenerate(pending.text, {
          projectId: session.activeProjectId,
          sessionId: session.activeSessionId,
          images: pending.images || [],
          requestId: pending.turnId,
          allowPolicyOverride: true,
          ...(pending.imageOptions || {}),
        });
         if (generationToken !== generationTokenRef.current) return;
         activeImageRequestIdRef.current = pending.turnId;
        activeTaskIdRef.current = result.taskId || '';
        const normalizedResult = normalizeGenerationResult(result);
        setImages(normalizedResult.images || []);
        setVideos(normalizedResult.videos || []);
        setMedia(normalizedResult.media || []);
        setGenerationResult(normalizedResult);
        await refreshAssets({ replace: true });
        setMessages(previous => [...previous, { role: 'agent', content: 'OpenAI Image 生成完成。', images: normalizedResult.images || [], media: normalizedResult.media || [], time: timeStr(), turnId: pending.turnId }]);
        setLastGenerationRequest(pending.text);
        setGenerationSource('openai-image');
        setStatus('idle');
        setStatusMsg('生成完成');
      } catch (error) {
        setStatus('error');
        const userMessage = formatAgentError(error);
        setStatusMsg(userMessage);
        addActivityEvent({ type: 'error', status: 'error', description: userMessage, error: error?.message || userMessage, code: error?.code || '', taskId: activeTaskIdRef.current, traceId: error?.traceId || '' });
         setMessages(previous => [...previous, { role: 'agent', content: userMessage, time: timeStr(), turnId: pending.turnId }]);
      } finally {
        setGenerationPending(false);
        submissionLockRef.current = false;
      }
      return;
    }
    setPolicyConfirm(null);
    setGenerationPending(true);
    setThinking('');
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
      addActivityEvent({ type: 'error', status: 'error', description: userMessage, error: error?.message || userMessage, code: error?.code || '', taskId: activeTaskIdRef.current, traceId: error?.traceId || '' });
      setMessages(previous => [...previous, { role: 'agent', content: userMessage, time: timeStr() }]);
    } finally {
      submissionLockRef.current = false;
    }
  }, [policyConfirm, selectedFile, workflowManifest, session.activeSessionId, beginAgentTask, applyTurnResult, addActivityEvent]);

  const cancelPolicyOverride = useCallback(() => {
    addActivityEvent({
      type: 'policy',
      status: 'cancelled',
      description: '已取消发送',
      message: '内容未发送到云端',
      sentToCloud: false,
      taskId: policyConfirm?.taskId || '',
      traceId: policyConfirm?.traceId || '',
    });
    setPolicyConfirm(null);
    setGenerationPending(false);
    setStatus('idle');
    setStatusMsg('已取消发送（内容被云端审查拦截）。');
    setMessages(previous => [...previous, { role: 'agent', content: '已取消发送：内容被云端审查拦截，未发送到云端。', time: timeStr() }]);
  }, [policyConfirm, addActivityEvent]);

  const handleSend = useCallback(async (action = 'answer', imageOptions = {}, textOverride = null) => {
    const text = textOverride === null ? input.trim() : String(textOverride || '').trim();
    if (!text && attachments.length === 0) return;
    if (status === 'running' || status === 'stopping' || submissionLockRef.current) {
      setStatusMsg(status === 'stopping' ? '上一任务正在收尾，请稍候' : '请求正在处理中，请勿重复发送');
      return { status: 'busy' };
    }
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
         const generationToken = ++generationTokenRef.current;
         const result = await window.electronAPI.imageGenerate(text, {
          projectId: session.activeProjectId,
          sessionId: session.activeSessionId,
          images: attachments,
          requestId: turnId,
          ...imageOptions,
        });
          if (generationToken !== generationTokenRef.current) return;
          const normalizedResult = normalizeGenerationResult(result);
         setImages(normalizedResult.images || []);
         setVideos(normalizedResult.videos || []);
         setMedia(normalizedResult.media || []);
         setGenerationResult(normalizedResult);
         activeTaskIdRef.current = result.taskId || '';
         await refreshAssets({ replace: true });
         setMessages(previous => [...previous, { role: 'agent', content: 'OpenAI Image 生成完成。', images: normalizedResult.images || [], media: normalizedResult.media || [], time: timeStr(), turnId }]);
        setLastGenerationRequest(text);
        setGenerationSource('openai-image');
        setStatus('idle');
        setStatusMsg('生成完成');
      } catch (error) {
         if (error?.code === 'CLOUD_POLICY_BLOCKED') {
           setGenerationPending(false);
           setStatus('idle');
           addActivityEvent({
             type: 'policy',
             status: 'rejected',
             description: '云端安全审核驳回',
             message: error.message || '内容未通过云端安全审核',
             reason: error.policyDecision?.reason || '',
             categories: error.policyDecision?.categories || [],
             sentToCloud: false,
             taskId: error.taskId || turnId,
             traceId: error.traceId || '',
           });
           setPolicyConfirm({
            kind: 'openai-image',
            text,
            images: attachments,
            imageOptions,
            turnId,
            message: error.message || '内容被云端审查拦截',
            categories: error.policyDecision?.categories || [],
            reason: error.policyDecision?.reason || '',
            requiresLocal: error.policyDecision?.requiresLocal === true,
            localUnavailable: error.policyDecision?.localUnavailable === true,
          });
          return;
        }
        setStatus('error');
        const userMessage = formatAgentError(error);
        setStatusMsg(userMessage);
        addActivityEvent({ type: 'error', status: 'error', description: userMessage, error: error?.message || userMessage, code: error?.code || '', taskId: activeTaskIdRef.current, traceId: error?.traceId || '' });
      } finally {
        setGenerationPending(false);
        submissionLockRef.current = false;
      }
      return;
    }
    if (action === 'answer') setAttachments([]);
    return submitTurn(text, action === 'generate' ? 'generate' : 'answer');
  }, [input, status, attachments, runDirectGeneration, submitTurn, session.activeProjectId, session.activeSessionId, refreshAssets, addActivityEvent]);

  const handleRegenerate = useCallback((record = null, feedbackType = 'regenerate') => {
    if (typeof record === 'string') {
      feedbackType = record;
      record = null;
    }
    const source = record?.generationSource || generationSourceRef.current;
    const request = (record?.prompt || lastGenerationRequest).trim();
    const negative = record?.negative ?? lastGenerationNegative;
    const controls = {
      ...generationControls,
      settings: { ...(record?.parameters || generationControls.settings || {}) },
      nodeOverrides: record?.nodeOverrides || generationControls.nodeOverrides || {},
      outputNodeIds: record?.outputNodeIds || generationControls.outputNodeIds || null,
    };
    // Regenerate means a new sample. Reusing an existing seed produces the same image.
    controls.settings = { ...(controls.settings || {}), seed: Math.floor(Math.random() * 0xFFFFFFFF) };
    if (source === 'direct') {
      runDirectGeneration(request, { controls, negative, workflowName: record?.workflowName || selectedFile });
      return;
    }
    if (source === 'openai-image') {
      void handleSend('openai-image', { ...controls, count: 1 }, request);
      return;
    }
    void window.electronAPI.agentFeedback(feedbackType);
    runGeneration(request, controls);
  }, [lastGenerationRequest, lastGenerationNegative, runGeneration, runDirectGeneration, generationControls, handleSend, selectedFile]);

  const recordFeedback = useCallback(async (type, details = {}) => {
    if (type === 'regenerate' || type === 'new_seed') {
       if (lastGenerationRequest && status !== 'running') handleRegenerate(null, type);
      return { handled: true };
    }
    if (type === 'edit_prompt' && lastGenerationRequest) setInput(lastGenerationRequest);
    if (type === 'adjust_parameters') setShowSettings(true);
    return window.electronAPI.agentFeedback(type, details);
  }, [lastGenerationRequest, status, handleRegenerate]);

  const handleCancel = useCallback(async () => {
    generationTokenRef.current += 1;
    const taskId = activeTaskIdRef.current;
    const currentPreview = promptPreview;
    if (currentPreview?.previewId) invalidPreviewIdsRef.current.add(currentPreview.previewId);
    if (activeTurnIdRef.current) blockedTurnIdsRef.current.add(activeTurnIdRef.current);
    activeTaskIdRef.current = '';
    if (activeDirectRequestIdRef.current) blockedTaskIdsRef.current.add(activeDirectRequestIdRef.current);
    activeDirectRequestIdRef.current = '';
    activeDirectTaskIdRef.current = '';
    activeTurnIdRef.current = '';
    terminateStreamingTask(taskId, 'cancelled');
    setGenerationProgress(null);
    setPromptPreview(null);
    setAutoConfirmPreviewId('');
    setGenerationTurn(previous => previous ? { ...previous, status: 'cancelled' } : previous);
    if (generationSourceRef.current === 'direct' || generationSourceRef.current === 'ai') {
      await discardGenerationTurn();
    }
    let cancelMessage = '已取消';
    let cancellation = null;
    try {
      if (generationSourceRef.current === 'direct') {
        if (currentPreview?.previewId) await window.electronAPI.directDiscardPreview(currentPreview.previewId).catch(() => {});
        cancellation = await window.electronAPI.directCancel();
      } else if (generationSourceRef.current === 'openai-image') {
        await window.electronAPI.imageCancel(activeImageRequestIdRef.current);
      } else {
        await window.electronAPI.agentCancel(taskId);
      }
    } catch (error) {
      cancelMessage = `取消请求失败：${formatAgentError(error)}`;
    }
    const stopping = generationSourceRef.current === 'direct' && cancellation?.cancelled && !cancellation?.settled;
    setGenerationPending(stopping);
    setStatus(stopping ? 'stopping' : 'idle');
    setStatusMsg(stopping ? '取消请求已发送，正在等待后台任务收尾' : cancelMessage);
  }, [promptPreview, terminateStreamingTask, discardGenerationTurn]);

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
      invalidPreviewIdsRef.current.add(promptPreview.previewId);
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
    setGenerationTurn(null);
    setPromptPreview(null);
    setPreview(null);
    setAttachments([]);
    setTrace(null);
    setActivityEvents([]);
    setErrorFeedback(null);
    setFeedbackOpen(false);
    setContextUsage(null);
    setPolicyConfirm(null);
    setAutoConfirmPreviewId('');
    setEditingMessageIndex(-1);
    pendingGenerationIndexRef.current = -1;
    pendingGenerationTurnIdRef.current = '';
    activeTaskIdRef.current = '';
    activeTurnIdRef.current = '';
    blockedTurnIdsRef.current.clear();
    invalidPreviewIdsRef.current.clear();
    confirmedPreviewIdsRef.current.clear();
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
    executionRecords: session.sessionState?.executionRecords || {},
    errorFeedback,
    setErrorFeedback,
    feedbackOpen,
    setFeedbackOpen,
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
    generationTurn,
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
