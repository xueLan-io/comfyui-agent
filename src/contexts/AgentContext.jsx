import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { formatAgentError } from '../error-message.mjs';
import { useComfyUI } from './ComfyUIContext.jsx';
import { useSession } from './SessionContext.jsx';
import { buildPresetGenerationRequest, presetWorkflowName } from '../runtime/preset-generation.mjs';
import { normalizeProgressEvent } from '../runtime/progress.mjs';
import { normalizeGenerationResult } from '../runtime/generation-contract.mjs';
import { IDLE as PHASE_IDLE, PREPARING as PHASE_PREPARING, PREVIEW as PHASE_PREVIEW, RUNNING as PHASE_RUNNING, STOPPING as PHASE_STOPPING, COMPLETED as PHASE_COMPLETED, ERROR as PHASE_ERROR, CANCELLED as PHASE_CANCELLED, canTransition, isActive as isPhaseActive, isTerminal as isPhaseTerminal, restorePhase as pureRestorePhase } from '../runtime/generation-state-machine.mjs';
import { buildRuntimeView, normalizeRuntimeStatus } from '../runtime/runtime-status.mjs';
import { playCompletionSound, playFailureSound } from '../utils/sounds.mjs';

const TOOL_LABELS = {
  comfyui: 'ComfyUI',
  prompt_enhance: '提示词优化',
  filesystem: '文件系统',
  web: 'Web research',
  evaluator: '结果评估',
  planning: '任务规划',
};

const AgentContext = createContext(null);

function normalizeUiStatus(status = '') {
  return normalizeRuntimeStatus(status);
}

function isTaskActive(status, generationPhase = PHASE_IDLE) {
  return buildRuntimeView({ rawStatus: status, generationPhase }).busy || isPhaseActive(generationPhase);
}

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

function nonEmptyObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0);
}

function firstNonEmptyObject(...values) {
  return values.find(nonEmptyObject) || {};
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
  const playTerminalSound = useCallback(status => {
    if (status === 'cancelled' || status === 'abandoned') return;
    if (!window.electronAPI?.uiPreferences) return;
    void window.electronAPI.uiPreferences().then(prefs => {
      const style = prefs.soundStyle || 'none';
      if (!prefs.soundOnComplete || style === 'none') return;
      const volume = prefs.soundVolume != null ? Math.min(100, Math.max(0, Number(prefs.soundVolume))) / 100 : 1;
      if (status === 'completed') playCompletionSound(style, volume);
      else playFailureSound(style, volume);
    }).catch(() => {});
  }, []);

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [activityEvents, setActivityEvents] = useState([]);
  const [status, setStatus] = useState('idle');
  const [rawStatus, setRawStatus] = useState('idle');
  const [statusMsg, setStatusMsg] = useState('');
  const [images, setImages] = useState([]);
  const [videos, setVideos] = useState([]);
  const [media, setMedia] = useState([]);
  const [generationPhase, setGenerationPhase] = useState(PHASE_IDLE);
  const generationPhaseRef = useRef(PHASE_IDLE);
  const [assets, setAssets] = useState([]);
  const [thinking, setThinking] = useState('');
  const [lastGenerationRequest, setLastGenerationRequest] = useState('');
  const [lastGenerationNegative, setLastGenerationNegative] = useState('');
  const [promptMode, setPromptMode] = useState('raw');
  const [trace, setTrace] = useState(null);
  const [showTrace, setShowTrace] = useState(false);
  const [recoveryTasks, setRecoveryTasks] = useState([]);
  const [generationProgress, setGenerationProgress] = useState(null);
  const [generationRecords, setGenerationRecords] = useState({});
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
    const turnId = event.turnId || activeTurnIdRef.current || '';
    const normalized = { ...event, ...(turnId ? { turnId } : {}), time: event.time || timeStr() };
    setActivityEvents(previous => [...previous, normalized]);
    if (turnId && window.electronAPI?.sessionAppendExecutionEvent) {
      void window.electronAPI.sessionAppendExecutionEvent(normalized).catch(() => {});
    }
  }, []);

  const transitionGeneration = useCallback((nextPhase, patch = {}) => {
    const previous = generationPhaseRef.current;
    if (!canTransition(previous, nextPhase)) {
      console.warn(`[AgentContext] Invalid transition: ${previous} → ${nextPhase}`);
      return false;
    }
    generationPhaseRef.current = nextPhase;
    setGenerationPhase(nextPhase);
    Object.entries(patch).forEach(([key, value]) => {
      if (key === 'statusMsg') setStatusMsg(value);
      else if (key === 'status') setStatus(value);
      else if (key === 'rawStatus') setRawStatus(value);
      else if (key === 'error') setErrorFeedback(value);
      else if (key === 'generationResult') setGenerationResult(value);
      else if (key === 'images') setImages(value);
      else if (key === 'videos') setVideos(value);
      else if (key === 'media') setMedia(value);
      else if (key === 'promptPreview') setPromptPreview(value);
      else if (key === 'generationProgress') setGenerationProgress(value);
    });
    if (patch.rawStatus === undefined && patch.status !== undefined) setRawStatus(patch.status);
    return true;
  }, []);

  const restorePhase = useCallback((targetPhase, patch = {}) => {
    const result = pureRestorePhase(targetPhase, patch);
    if (result.applied) {
      generationPhaseRef.current = targetPhase;
      setGenerationPhase(targetPhase);
      Object.entries(patch).forEach(([key, value]) => {
        if (key === 'statusMsg') setStatusMsg(value);
        else if (key === 'status') setStatus(value);
        else if (key === 'rawStatus') setRawStatus(value);
        else if (key === 'error') setErrorFeedback(value);
        else if (key === 'generationResult') setGenerationResult(value);
        else if (key === 'images') setImages(value);
        else if (key === 'videos') setVideos(value);
        else if (key === 'media') setMedia(value);
        else if (key === 'promptPreview') setPromptPreview(value);
        else if (key === 'generationProgress') setGenerationProgress(value);
      });
      if (patch.rawStatus === undefined && patch.status !== undefined) setRawStatus(patch.status);
    }
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
  const generationRecordsRef = useRef({});
  const recordedPlanEventsRef = useRef(new Set());
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
  generationRecordsRef.current = generationRecords;
  const runtimeView = useMemo(() => buildRuntimeView({
    status,
    rawStatus,
    generationPhase,
    message: statusMsg,
    progress: generationProgress,
    source: generationSource,
    requestId: generationTurn?.requestId || '',
    turnId: generationTurn?.turnId || activeTurnIdRef.current,
    taskId: generationTurn?.taskId || activeTaskIdRef.current,
  }), [status, rawStatus, generationPhase, statusMsg, generationProgress, generationSource, generationTurn]);

  const upsertRecord = useCallback((requestId, patch, { persist = true } = {}) => {
    if (!requestId) return;
    const record = {
      requestId,
      projectId: session.activeProjectId,
      sessionId: session.activeSessionId,
      ...patch,
      updatedAt: Date.now(),
    };
    setGenerationRecords(previous => ({
      ...previous,
      [requestId]: { ...previous[requestId], ...record, createdAt: previous[requestId]?.createdAt || record.createdAt || Date.now() },
    }));
    if (persist && window.electronAPI.sessionUpsertGenerationRecord) {
      void window.electronAPI.sessionUpsertGenerationRecord(record).catch(() => {});
    }
  }, [session.activeProjectId, session.activeSessionId]);

  // A record created for a preparing/queued turn must be closed out when the
  // generation chain fails locally (plan failure, prepare throw, execution
  // throw). Without this the placeholder card stays at "准备渲染 0%" forever.
  const failRecord = useCallback((requestId, message, code = '') => {
    if (!requestId || !generationRecordsRef.current[requestId]) return;
    upsertRecord(requestId, {
      status: 'failed',
      progressPercent: null,
      progressNodePercent: null,
      progressStage: 'failed',
      progressMessage: message || '任务执行失败',
      error: { message: message || '任务执行失败', code: code || '' },
    });
  }, [upsertRecord]);

  // Closing an accepted preview only closes non-terminal records. A record that
  // already reached failed/error keeps its error message instead of being
  // overwritten with a cancellation.
  const cancelRecord = useCallback((requestId, message = '已取消') => {
    if (!requestId) return;
    const record = generationRecordsRef.current[requestId];
    if (!record || ['completed', 'failed', 'error', 'cancelled', 'abandoned'].includes(record.status)) return;
    upsertRecord(requestId, {
      status: 'cancelled',
      progressStage: 'cancelled',
      progressMessage: message,
      error: null,
    });
  }, [upsertRecord]);

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
          JSON.stringify(session.sessionState?.generationRecords || {}),
      ].join('|');
      if (syncedSessionSnapshotRef.current === snapshotKey) return undefined;
      syncedSessionSnapshotRef.current = snapshotKey;
      setMessages(previous => mergeConversation(previous, session.messages || []));
      if (session.sessionState?.generationRecords) setGenerationRecords(previous => ({ ...previous, ...session.sessionState.generationRecords }));
      if (Array.isArray(session.project?.assets)) setAssets(previous => mergeAssets(previous, session.project.assets));
      const persistedPreview = session.sessionState?.preparedPreview;
      if (persistedPreview?.previewId && !promptPreview
        && !invalidPreviewIdsRef.current.has(persistedPreview.previewId)
        && !confirmedPreviewIdsRef.current.has(persistedPreview.previewId)) {
        setPromptPreview(persistedPreview);
        transitionGeneration(PHASE_PREVIEW, { status: 'preview' });
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
    const storedRecords = { ...(storedState.generationRecords || {}) };
    if (Object.keys(storedRecords).length === 0) {
      for (const message of session.messages || []) {
        const mediaItems = message.media || [...(message.images || []), ...(message.videos || [])];
        if (!message.turnId || !mediaItems.length) continue;
        storedRecords[message.requestId || message.turnId] = {
          requestId: message.requestId || message.turnId,
          turnId: message.turnId,
          taskId: message.taskId || message.directTaskId || '',
          projectId: session.activeProjectId,
          sessionId: session.activeSessionId,
          source: message.generationSource || storedState.lastGenerationSource || 'agent',
          status: 'completed', createdAt: message.createdAt || Date.now(), updatedAt: Date.now(),
          prompt: message.prompt || message.positive || '', negative: message.negative || '', workflowName: message.workflowName || '',
          parameters: message.parameters || message.settings || {}, nodeOverrides: message.nodeOverrides || {}, outputNodeIds: message.outputNodeIds || null,
          media: mediaItems, durationMs: message.duration_ms || 0, completedAt: message.completedAt || Date.now(), progressPercent: 100, progressNodePercent: 100, progressMessage: '生成完成', progressStage: 'completed', error: null,
        };
      }
      if (storedState.lastResult?.media?.length) {
        const requestId = storedState.requestId || storedState.lastResult.requestId || storedState.lastResult.taskId;
        if (requestId) storedRecords[requestId] = { ...storedState.lastResult, requestId, turnId: storedState.turnId || storedState.lastResult.turnId || '', taskId: storedState.lastTaskId || storedState.lastResult.taskId || '', projectId: session.activeProjectId, sessionId: session.activeSessionId, source: storedState.lastGenerationSource || storedState.lastResult.source || 'agent', status: 'completed', createdAt: Date.now(), updatedAt: Date.now(), prompt: storedState.lastResult.positive || storedState.lastPrompt || '', negative: storedState.lastResult.negative || '', parameters: storedState.lastResult.parameters || storedState.lastResult.settings || {}, media: resultMedia(storedState.lastResult), completedAt: Date.now(), progressPercent: 100, progressStage: 'completed', error: null };
      }
    }
    // 应用重启后没有任务会再推进这些记录：长时间停在 preparing/generating
    // 的占位卡片是中断遗留，标记失败而不是让占位动画永远挂着。
    const hydrationNow = Date.now();
    for (const record of Object.values(storedRecords)) {
      if (record && !['completed', 'failed', 'error', 'cancelled', 'abandoned'].includes(record.status)
        && hydrationNow - (record.updatedAt || record.createdAt || 0) > 10 * 60 * 1000) {
        record.status = 'failed';
        record.progressStage = 'failed';
        record.progressMessage = '任务已中断，请重新生成';
        record.error = { message: '任务已中断，请重新生成', code: 'interrupted' };
        record.updatedAt = hydrationNow;
      }
    }
    setGenerationRecords(storedRecords);
    if (Object.keys(storedRecords).length && Object.keys(storedState.generationRecords || {}).length === 0) Object.values(storedRecords).forEach(record => upsertRecord(record.requestId, record));
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
    // `taskStatus` may be the persisted idle default while `state` still
    // describes a live task. Prefer the active state so recovery never hides it.
    const storedTaskState = storedState.state && storedState.state !== 'idle'
      ? storedState.state
      : storedState.taskStatus || storedState.state || '';
    const taskActive = ['classifying', 'planning', 'queued', 'executing', 'running', 'archiving', 'observing', 'retrying', 'replanning'].includes(storedTaskState);
    setStatus(storedState.preparedPreview ? 'preview' : taskActive ? normalizeUiStatus(storedTaskState) : 'idle');
    setRawStatus(storedState.preparedPreview ? 'prepared' : taskActive ? storedTaskState : 'idle');
    setStatusMsg('');
    const initialPhase = storedState.preparedPreview ? PHASE_PREVIEW
      : taskActive ? PHASE_RUNNING
      : PHASE_IDLE;
    restorePhase(initialPhase, { status: storedState.preparedPreview ? 'preview' : taskActive ? normalizeUiStatus(storedTaskState) : 'idle', rawStatus: storedState.preparedPreview ? 'prepared' : taskActive ? storedTaskState : 'idle', statusMsg: '' });
    // A direct quick-generation preview is live state. Do not overwrite it with
    // the previous session snapshot while its prepare/run IPC is in flight.
    if (generationPhase === PHASE_IDLE && !submissionLockRef.current) {
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
  }, [session.activeProjectId, session.activeSessionId, session.messages, session.project, session.sessionState, setSelectedFile, refreshAssets, refreshRecoveryTasks, generationPhase, generationResult, promptPreview]);

  useEffect(() => {
    const sessionKey = `${session.activeProjectId}:${session.activeSessionId}`;
    if (!session.activeProjectId || !session.activeSessionId || !window.electronAPI.agentListRequestStatus) return undefined;
    let disposed = false;
    void window.electronAPI.agentListRequestStatus({
      projectId: session.activeProjectId,
      sessionId: session.activeSessionId,
      activeOnly: true,
    }).then(async entries => {
      if (disposed || sessionKeyRef.current !== sessionKey || !Array.isArray(entries)) return;
      const entry = entries.find(item => item.source === 'direct') || entries[0];
      for (const item of entries) registeredDirectRequestsRef.current.add(item.requestId);
      if (!entry) return;
      // Agent-backed Creative-mode work shares the same persisted request
      // ledger as direct work. Restore either source after a renderer reload.
      if (entry.source !== 'direct') {
        activeTurnIdRef.current = entry.turnId || entry.requestId || '';
        if (entry.taskId) activeTaskIdRef.current = entry.taskId;
        setGenerationSource('agent');
      } else {
        if (entry.taskId) activeDirectTaskIdRef.current = entry.taskId;
        activeDirectRequestIdRef.current = entry.requestId;
      }
      if (entry.state === 'stopping') {
        restorePhase(PHASE_STOPPING, { status: 'stopping', rawStatus: entry.state, statusMsg: '后台任务正在收尾，请稍候' });
        return;
      }
      if (['created', 'queued', 'preparing', 'prepared', 'executing', 'observing'].includes(entry.state)) {
        const phase = entry.state === 'preparing' ? PHASE_PREPARING : entry.state === 'prepared' ? PHASE_PREVIEW : PHASE_RUNNING;
        const statusMsg = '正在恢复任务状态...';
        if (window.electronAPI.agentStatus) {
          try {
            const realStatus = await window.electronAPI.agentStatus();
            if (disposed || sessionKeyRef.current !== sessionKey) return;
            if (!realStatus?.running) return;
          } catch { }
        }
        restorePhase(phase, { status: normalizeUiStatus(entry.state), rawStatus: entry.state, statusMsg });
        return;
      }
      if (['timed_out', 'archive_failed'].includes(entry.state)) {
        restorePhase(PHASE_ERROR, { status: 'error', rawStatus: entry.state, statusMsg: entry.error?.message || '任务需要恢复处理', generationProgress: null });
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
      const key = [data.source, data.requestId, data.turnId, data.taskId, data.stage, data.nodeId || data.node, data.percent, data.overallPercent, data.nodePercent, data.message].join('|');
      if (key === lastProgressKey) return;
      lastProgressKey = key;
      const normalized = normalizeProgressEvent(data, generationProgress);
      setGenerationProgress(previous => normalizeProgressEvent(data, previous));
      const requestId = data.requestId || data.turnId || activeDirectRequestIdRef.current || activeTurnIdRef.current;
      if (!generationRecordsRef.current[requestId]) return;
      upsertRecord(requestId, {
        turnId: data.turnId || activeTurnIdRef.current || '', taskId: data.taskId || '', source: data.source || generationSourceRef.current || 'agent',
        status: data.stage === 'queued' ? 'queued' : 'generating', progressPercent: normalized.overallPercent ?? normalized.percent,
        progressNodePercent: normalized.nodePercent, progressMessage: normalized.message, progressStage: normalized.stage || data.stage || 'generating',
      });
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

    const isCurrentAgentEvent = (data, { canClaimTask = false } = {}) => {
      if (!isCurrentSessionEvent(data)) return false;
      if (data.turnId && blockedTurnIdsRef.current.has(data.turnId)) return false;
      if (data.turnId && activeTurnIdRef.current && data.turnId !== activeTurnIdRef.current) return false;
      if (data.taskId && blockedTaskIdsRef.current.has(data.taskId)) return false;
      if (data.taskId && !activeTaskIdRef.current) {
        // Progress and terminal events cannot establish ownership. Otherwise a
        // delayed event from the previous turn can hide the current task.
        if (!canClaimTask || (activeTurnIdRef.current && data.turnId !== activeTurnIdRef.current)) return false;
        activeTaskIdRef.current = data.taskId;
      }
      return !data.taskId || !activeTaskIdRef.current || data.taskId === activeTaskIdRef.current;
    };

    const applyStreamingMessage = (previous, data) => {
      const elapsed = sendStartRef.current > 0 ? Date.now() - sendStartRef.current : 0;
      const messageIndex = previous.findIndex(message => message.streamingMessageId === data.messageId || message.messageId === data.messageId);
      if (messageIndex < 0) {
        const messageData = data.done
          ? data
          : { ...data, content: data.delta || data.content || '', streamingMessageId: data.messageId, streamAttempt: data.attempt || 0, streamSequence: data.sequence ?? -1 };
         return [...previous, {
          ...messageData,
          time: timeStr(),
          duration_ms: data.done ? elapsed : 0,
        }];
      }

      return previous.map((message, index) => {
        if (index !== messageIndex) return message;
        if (!data.done) {
          const incomingAttempt = data.attempt || 0;
          const incomingSequence = data.sequence ?? -1;
          if (incomingAttempt < (message.streamAttempt || 0)) return message;
          if (!data.reset && incomingAttempt === (message.streamAttempt || 0) && incomingSequence <= (message.streamSequence ?? -1)) return message;
          const content = data.reset
            ? (data.delta || data.content || '')
            : data.delta != null
              ? `${incomingAttempt === (message.streamAttempt || 0) ? message.content || '' : ''}${data.delta}`
              : data.content || message.content || '';
          return { ...message, ...data, content, streamAttempt: incomingAttempt, streamSequence: incomingSequence };
        }
        const { streamingMessageId, ...completedMessage } = message;
        return { ...completedMessage, ...data, streaming: false, time: timeStr(), duration_ms: elapsed };
      });
    };

    const flushStreamingMessages = () => {
      streamingFrameRef.current = 0;
      const updates = [...streamingUpdatesRef.current.values()];
      streamingUpdatesRef.current.clear();
      if (updates.length > 0) setMessages(previous => updates.reduce(applyStreamingMessage, previous));
    };

    const queueStreamingMessage = data => {
      const pending = streamingUpdatesRef.current.get(data.messageId);
      if (pending && !data.done && !data.reset && data.delta != null && pending.delta != null && pending.attempt === data.attempt) {
        streamingUpdatesRef.current.set(data.messageId, { ...data, delta: `${pending.delta}${data.delta}`, sequence: data.sequence });
      } else if (pending?.reset && !data.done && data.delta != null && pending.attempt === data.attempt) {
        streamingUpdatesRef.current.set(data.messageId, { ...data, delta: `${pending.delta || ''}${data.delta}`, reset: true });
      } else {
        streamingUpdatesRef.current.set(data.messageId, data);
      }
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
      const terminal = ['completed', 'failed', 'error', 'cancelled', 'abandoned'].includes(data.status) || data.uiStatus === 'error';
      if (!isCurrentAgentEvent(data, { canClaimTask: !terminal })) return;
      setRawStatus(data.status || data.uiStatus || 'idle');
      setStatus(normalizeUiStatus(data.uiStatus || data.status));
      setStatusMsg(data.message || '');
      if (data.status === 'error' || data.status === 'failed' || data.uiStatus === 'error') {
        setErrorFeedback(previous => previous || { error: data.message || '任务执行失败', status: data.status, taskId: data.taskId, traceId: data.traceId });
        addActivityEvent({ ...data, type: 'error', description: data.message || '任务执行失败', status: 'error', error: eventErrorText(data) });
      }
      if (['preparing', 'queued', 'executing', 'running', 'archiving'].includes(data.status || data.uiStatus)) {
        clearThinking();
      }
      if (terminal) {
        clearQueuedProgress();
        const terminalPhase = data.status === 'completed' ? PHASE_COMPLETED : data.status === 'cancelled' ? PHASE_CANCELLED : PHASE_ERROR;
        transitionGeneration(terminalPhase, {
          status: normalizeUiStatus(data.uiStatus || data.status),
          rawStatus: data.status || data.uiStatus,
          statusMsg: data.message || '',
          generationProgress: data.status === 'completed' ? normalizeProgressEvent({ stage: 'completed', percent: 100, overallPercent: 100, message: data.message || '生成完成' }) : null,
        });
        if (data.status !== 'cancelled') playTerminalSound(data.status);
        terminateStreamingTask(data.taskId, data.status === 'completed' ? 'completed' : data.status);
        const requestId = data.requestId || data.turnId || activeTurnIdRef.current;
        // 终态事件只更新已存在的生成记录。聊天回复的完成/失败事件没有对应
        // 记录，凭空创建会让每条聊天消息后面都挂一张占位卡片或失败框。
        if (requestId && generationRecordsRef.current[requestId]) upsertRecord(requestId, { turnId: data.turnId || activeTurnIdRef.current || '', taskId: data.taskId || '', status: data.status === 'completed' ? 'completed' : data.status === 'cancelled' ? 'cancelled' : 'failed', progressPercent: data.status === 'completed' ? 100 : null, progressStage: data.status, progressMessage: data.message || '', error: data.status === 'completed' ? null : { message: data.message || '任务执行失败', code: data.code || '' }, ...(data.status === 'completed' ? { completedAt: Date.now() } : {}) });
      }
      if (data.taskId && terminal) {
        void window.electronAPI.agentGetTrace(data.taskId).then(savedTrace => {
          if (savedTrace && isCurrentSessionEvent(data) && activeTaskIdRef.current === data.taskId) setTrace(savedTrace);
        }).catch(() => {});
      }
    }));

    unsubs.push(window.electronAPI.onAgentProgress(data => {
      if (!isCurrentAgentEvent(data, { canClaimTask: data.scope === 'timing' })) return;
      if (data.scope === 'timing') {
        addActivityEvent({ ...data, type: 'agent:progress' });
        return;
      }
      if (data.scope === 'llm-policy') {
        if (data.message) setStatusMsg(data.message);
        return;
      }
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
       if (!activeDirectRequestIdRef.current && !activeDirectTaskIdRef.current) return false;
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
      setRawStatus(data.status || data.uiStatus || 'idle');
      if (data.status === 'prepared' && data.preview?.previewId) {
        if (invalidPreviewIdsRef.current.has(data.preview.previewId) || confirmedPreviewIdsRef.current.has(data.preview.previewId)) return;
        setPromptPreview({ ...data.preview, quickGenerate: data.preview.quickGenerate !== false });
        transitionGeneration(PHASE_PREVIEW, { status: 'preview' });
      }
      setStatus(normalizeUiStatus(data.uiStatus || data.status));
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
        const recordRequestId = data.requestId || data.turnId || '';
        const existingRecord = generationRecordsRef.current[recordRequestId] || {};
        const positive = data.positive || data.prompt || result.positive || result.compiledPrompt?.positive || existingRecord.prompt || '';
        const negative = data.negative || result.negative || result.compiledPrompt?.negative || existingRecord.negative || '';
        const workflowName = data.workflowName || result.workflowName || result.workflow?.name || existingRecord.workflowName || '';
        const parameters = firstNonEmptyObject(data.parameters, result.parameters, result.settings, existingRecord.parameters);
        const taskId = data.taskId || data.requestId || '';
        const messageId = data.messageId || (data.requestId ? `direct:${data.requestId}:completed` : taskId ? `direct:${taskId}:completed` : '');
        setGenerationResult({ ...result, media: resultItems });
        setGenerationTurn(previous => previous ? {
          ...previous,
          taskId: data.taskId || previous.taskId,
          requestId: data.requestId || previous.requestId,
          status: 'completed',
          media: resultItems,
          positive: positive || previous.positive,
          negative: negative || previous.negative,
          parameters: nonEmptyObject(parameters) ? parameters : previous.settings || {},
        } : previous);
        setImages(previous => mergeAssets(previous, result.images || []));
        setVideos(previous => mergeAssets(previous, result.videos || []));
        setMedia(previous => mergeAssets(previous, resultItems));
        upsertRecord(recordRequestId, { turnId: data.turnId || '', taskId, source: 'direct', status: 'completed', prompt: positive, negative, workflowName, parameters, nodeOverrides: data.nodeOverrides || result.nodeOverrides || {}, outputNodeIds: data.outputNodeIds || result.outputNodeIds || null, media: resultItems, durationMs: result.durationMs || result.duration_ms || 0, completedAt: Date.now(), progressPercent: 100, progressNodePercent: 100, progressMessage: data.message || '生成完成', progressStage: 'completed', error: null });
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
               prompt: positive,
               negative,
               workflowName,
               parameters,
               nodeOverrides: data.nodeOverrides || result.nodeOverrides || {},
               generationSource: 'direct',
               time: timeStr(),
           }];
        });
      }
      if (['completed', 'failed', 'cancelled', 'archive_failed', 'abandoned'].includes(data.status)) {
        clearQueuedProgress();
        const terminalPhase = data.status === 'completed' ? PHASE_COMPLETED : data.status === 'cancelled' ? PHASE_CANCELLED : PHASE_ERROR;
        transitionGeneration(terminalPhase, {
          status: normalizeUiStatus(data.status),
          rawStatus: data.status,
          statusMsg: data.message || '',
          generationProgress: data.status === 'completed' ? normalizeProgressEvent({ stage: 'completed', percent: 100, overallPercent: 100, message: data.message || '生成完成' }) : null,
        });
        if (data.status !== 'cancelled') playTerminalSound(data.status);
        activeDirectRequestIdRef.current = '';
        activeDirectTaskIdRef.current = '';
        if (data.status !== 'completed') upsertRecord(data.requestId || data.turnId, { turnId: data.turnId || '', taskId: data.taskId || '', source: 'direct', status: data.status === 'cancelled' ? 'cancelled' : 'failed', progressStage: data.status, progressMessage: data.message || '', error: { message: data.message || '任务执行失败', code: data.code || '' } });
      }
      if (data.status === 'stopping') {
        activeDirectRequestIdRef.current = data.requestId || activeDirectRequestIdRef.current;
        activeDirectTaskIdRef.current = data.taskId || activeDirectTaskIdRef.current;
        clearQueuedProgress();
        transitionGeneration(PHASE_STOPPING, { status: 'stopping', rawStatus: data.status, generationProgress: null });
      }
    }));

    unsubs.push(window.electronAPI.onDirectProgress(data => {
      if (!isCurrentDirectEvent(data)) return;
      queueProgress(data);
    }));

    unsubs.push(window.electronAPI.onAgentStep(data => {
      // Planner/executor events already carry ctx.eventMeta.turnId. They must be
      // allowed to claim this turn even when no reasoning stream preceded them.
      if (!isCurrentAgentEvent(data, { canClaimTask: true })) return;
      addActivityEvent(data);
    }));

    unsubs.push(window.electronAPI.onAgentToolCall(data => {
      if (!isCurrentAgentEvent(data, { canClaimTask: true })) return;
      addActivityEvent({
        ...data,
        description: `正在调用 ${toolLabel(data.tool)}...`,
        status: 'running',
      });
    }));

    unsubs.push(window.electronAPI.onAgentToolResult(data => {
      if (!isCurrentAgentEvent(data, { canClaimTask: true })) return;
      addActivityEvent({
        ...data,
        description: `${toolLabel(data.tool)} 已完成`,
        status: data.error && data.researchStatus ? 'warning' : (data.error ? 'error' : 'completed'),
      });
    }));

    unsubs.push(window.electronAPI.onAgentMessage(data => {
      if (!isCurrentAgentEvent(data, { canClaimTask: true })) return;
      if (data.role === 'user') return;
      if (data.streaming && !data.done) {
        clearQueuedProgress();
        setGenerationProgress(null);
        transitionGeneration(PHASE_RUNNING, { status: 'running', statusMsg: '正在回复...' });
      }
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
      transitionGeneration(PHASE_ERROR, { status: 'error', statusMsg: formatAgentError(data), generationProgress: null });
      clearQueuedProgress();
      terminateStreamingTask(data.taskId, 'error');
      const requestId = data.requestId || data.turnId || activeTurnIdRef.current;
      // 错误事件只更新已存在的生成记录。聊天回复的失败没有对应记录，
      // 凭空创建会在每条聊天消息后面挂一张失败卡片。
      if (requestId && generationRecordsRef.current[requestId]) upsertRecord(requestId, {
        turnId: data.turnId || activeTurnIdRef.current || '',
        taskId: data.taskId || '',
        source: generationSourceRef.current || 'agent',
        status: 'failed',
        progressPercent: null,
        progressNodePercent: null,
        progressStage: 'failed',
        progressMessage: formatAgentError(data),
        error: { message: data.message || data.error || '任务执行失败', code: data.code || '' },
      });
    }));

    unsubs.push(window.electronAPI.onAgentPlan(data => {
      // Every planner event carries ctx.eventMeta.turnId. A fallback planner has
      // no reasoning event, so its planning event must claim the active task.
      if (!isCurrentAgentEvent(data, { canClaimTask: true })) return;
      if (data.stage === 'thinking') {
        queueThinking(data.partial || '');
        return;
      }
      if (data.stage === 'complete' || data.stage === 'error') {
        clearThinking();
      }
      const steps = Array.isArray(data.steps) ? data.steps : data.plan?.steps;
      if (Array.isArray(steps) && steps.length > 0) {
        const planKey = `${data.taskId || activeTaskIdRef.current}:${data.traceId || ''}:${data.replan ? 'replan' : 'plan'}:${steps.map(step => step.id).join(',')}`;
        if (recordedPlanEventsRef.current.has(planKey)) return;
        recordedPlanEventsRef.current.add(planKey);
        setActivityEvents(previous => [...previous, {
          ...data,
          stage: 'planning',
          description: `已创建执行计划，共 ${steps.length} 步`,
          status: 'planning',
          time: timeStr(),
        }]);
        setTrace({ steps, taskId: data.taskId });
      }
      if (data.plan) setTrace(previous => ({ ...previous, steps: data.plan.steps }));
    }));

    unsubs.push(window.electronAPI.onAgentTask(data => {
      if (!isCurrentAgentEvent(data, { canClaimTask: true })) return;
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
  }, [session.activeProjectId, session.activeSessionId, terminateStreamingTask, addActivityEvent, refreshAssets, playTerminalSound]);

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
    if ((!text && attachments.length === 0) || isTaskActive(status, generationPhase) || submissionLockRef.current) return;
    submissionLockRef.current = true;
    const generationToken = ++generationTokenRef.current;
    if (!selectedFile) {
      transitionGeneration(PHASE_ERROR, { status: 'error', statusMsg: '请先选择一个工作流' });
      submissionLockRef.current = false;
      return;
    }

    const controls = controlsOverride || generationControls;
    generationSourceRef.current = 'ai';
    setGenerationSource('ai');
    setLastGenerationRequest(text || IMAGE_ONLY_REQUEST);
    setLastGenerationNegative('');
    setAutoConfirmPreviewId('');
    setPromptPreview(null);
    setPreview(null);
    setActivityEvents([]);
    setGenerationResult(null);
    transitionGeneration(PHASE_RUNNING, { status: 'running', statusMsg: '正在准备工作流...', generationProgress: null });
    setImages([]);
    setVideos([]);
    setMedia([]);
    setThinking('');
    beginAgentTask();
    sendStartRef.current = Date.now();
    const turnId = newTurnId();
    const requestId = turnId;
    activeTurnIdRef.current = turnId;
    pendingGenerationTurnIdRef.current = turnId;
    const attached = messageAttachments(attachments);
    setMessages(previous => {
      pendingGenerationIndexRef.current = previous.length;
      return [...previous, { role: 'user', content: text || '图片', time: timeStr(), turnId, attachments: attached, pendingGeneration: true }];
    });

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
          requestId,
      });
      if (generationToken !== generationTokenRef.current) return { status: 'stale' };
      if (result?.action === 'clarify') {
        const pendingIndex = pendingGenerationIndexRef.current;
        setMessages(previous => previous.map((message, index) => (
          index === pendingIndex ? { ...message, pendingGeneration: false } : message
        )));
        pendingGenerationIndexRef.current = -1;
        pendingGenerationTurnIdRef.current = '';
        transitionGeneration(PHASE_IDLE, { status: 'idle', statusMsg: result.response || '请补充生成信息' });
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
        transitionGeneration(PHASE_PREVIEW, { status: 'preview', promptPreview: result, statusMsg: result.error || 'AI 生成未完成' });
        return;
      }
      if (result?.workflowName && result.workflowName !== selectedFile) {
        setSelectedFile(result.workflowName);
      }
      transitionGeneration(PHASE_PREVIEW, { status: 'preview', promptPreview: result, statusMsg: '请确认提示词和注入目标' });
      } catch (error) {
        if (generationToken !== generationTokenRef.current) return { status: 'stale' };
        const userMessage = formatAgentError(error);
        await discardGenerationTurn();
        transitionGeneration(PHASE_ERROR, { status: 'error', statusMsg: userMessage });
        setMessages(previous => [...previous, { role: 'agent', content: userMessage, time: timeStr(), turnId }]);
    } finally {
      submissionLockRef.current = false;
    }
  }, [status, selectedFile, workflowManifest, generationControls, attachments, beginAgentTask, discardGenerationTurn, session.activeProjectId, session.activeSessionId, upsertRecord, failRecord]);

  const runDirectGeneration = useCallback(async (text, overrides = {}) => {
    if (!text && attachments.length === 0) return { status: 'empty_prompt', message: '请输入提示词或添加参考图' };
    if (isTaskActive(status, generationPhase) || submissionLockRef.current) {
      const message = status === 'stopping' ? '上一任务正在收尾，请等待取消完成后再试' : '已有生成任务正在进行或等待确认';
      setStatusMsg(message);
      return { status: 'busy', message };
    }
    submissionLockRef.current = true;
    const generationToken = ++generationTokenRef.current;
    if (!selectedFile) {
      transitionGeneration(PHASE_ERROR, { status: 'error', statusMsg: '请先选择一个工作流' });
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
    setGenerationResult(null);
    transitionGeneration(overrides.quickGenerate === true ? PHASE_PREPARING : PHASE_RUNNING, {
      status: overrides.quickGenerate === true ? 'preparing' : 'running',
      statusMsg: '正在准备直接生成...',
      generationProgress: null,
    });
    setImages([]);
    setVideos([]);
    setMedia([]);
    setThinking('');
    beginAgentTask();
    sendStartRef.current = Date.now();
    const turnId = newTurnId();
    activeTurnIdRef.current = turnId;
    activeDirectRequestIdRef.current = '';
    registeredDirectRequestsRef.current.add(turnId);
    pendingGenerationTurnIdRef.current = turnId;
    const attached = messageAttachments(attachments);
    setMessages(previous => {
      pendingGenerationIndexRef.current = previous.length;
      return [...previous, { role: 'user', content: text || '图片', time: timeStr(), turnId, attachments: attached, pendingGeneration: true }];
    });
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
       transitionGeneration(PHASE_PREVIEW, { status: 'preview', statusMsg: '已完成生成准备，请确认后执行' });
       return { ...result, status: 'accepted', workflowName: finalWorkflowName };
    } catch (error) {
      if (generationToken !== generationTokenRef.current) return { status: 'stale' };
      const userMessage = formatAgentError(error);
      await discardGenerationTurn();
      transitionGeneration(PHASE_ERROR, { status: 'error', statusMsg: userMessage });
      return { status: 'failed', message: userMessage };
    } finally {
      submissionLockRef.current = false;
    }
  }, [status, generationPhase, selectedFile, generationControls, attachments, beginAgentTask, discardGenerationTurn, session.activeProjectId, session.activeSessionId, upsertRecord, failRecord]);

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
    // A preset without an identifier cannot be validated against the store.
    // Fall back to a plain direct generation with the supplied prompt instead
    // of surfacing a misleading "预设不存在" dependency failure.
    if (!options.preset?.id) return runDirectGeneration(text, {
      negative,
      origin: 'prompt_library',
      autoConfirm: options.immediate === true,
    });
    if (window.electronAPI.globalPresetCheckDependencies) {
      const dependencyReport = await window.electronAPI.globalPresetCheckDependencies(options.preset.id);
      if (!dependencyReport?.valid) {
        const firstIssue = dependencyReport?.issues?.find(issue => issue.severity === 'error');
        const message = firstIssue?.message || '预设依赖不完整，暂时无法生成';
        setRawStatus('error');
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
      transitionGeneration(PHASE_RUNNING, { status: 'running', statusMsg: '正在整理提示词...' });
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
          transitionGeneration(PHASE_PREVIEW, { status: 'preview', promptPreview: payload.preview, statusMsg: payload.decision?.reason || '请确认生成预览' });
          return;
        }
        transitionGeneration(PHASE_IDLE, { status: 'idle', statusMsg: payload?.response || payload?.decision?.question || '未能准备生成请求' });
      } catch (error) {
        transitionGeneration(PHASE_ERROR, { status: 'error', statusMsg: formatAgentError(error) });
      }
      return;
    }
    if (promptPreview?.action === 'ai_failed') {
      const request = promptPreview.originalRequest;
      await discardGenerationTurn();
      setPromptPreview(null);
      transitionGeneration(PHASE_IDLE, { status: 'idle', statusMsg: '' });
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
    setGenerationResult(null);
    setImages([]);
    setVideos([]);
    setMedia([]);
    setThinking('');
    transitionGeneration(PHASE_RUNNING, { status: 'running', statusMsg: '正在执行已确认的提示词...' });
    sendStartRef.current = Date.now();
    beginAgentTask();
    const recordRequestId = preview.requestId || preview.executionContext?.turnId || activeTurnIdRef.current;
    const recordTurnId = preview.turnId || preview.executionContext?.turnId || activeTurnIdRef.current;
    setGenerationTurn({ turnId: recordTurnId, taskId: preview.taskId || '', requestId: recordRequestId, status: 'preparing', positive: edits.positive || preview.positive || '', negative: edits.negative || preview.negative || '', workflow: preview.workflowName || selectedFile, settings: edits.parameters || preview.parameters || preview.settings || {}, media: [] });
    upsertRecord(recordRequestId, { turnId: recordTurnId, taskId: preview.taskId || '', source: preview.source === 'direct' ? 'direct' : 'agent', status: 'preparing', createdAt: Date.now(), prompt: edits.positive || preview.positive || '', negative: edits.negative || preview.negative || '', workflowName: preview.workflowName || selectedFile, parameters: edits.parameters || preview.parameters || preview.settings || {}, nodeOverrides: edits.nodeOverrides || preview.nodeOverrides || {}, outputNodeIds: preview.outputNodeIds || preview.executionContext?.outputNodeIds || null, media: [], durationMs: 0, progressPercent: null, progressNodePercent: null, progressMessage: '正在执行已确认的提示词...', progressStage: 'preparing', error: null });
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
          confirmation: {
            accepted: true,
            digest: preview.requestDigest,
            requestId: preview.requestId,
            previewId,
          },
          previewEdits: edits,
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
        transitionGeneration(PHASE_COMPLETED, { status: 'completed' });
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
      failRecord(preview.requestId || preview.executionContext?.turnId || activeTurnIdRef.current, userMessage, error?.code || '');
      transitionGeneration(PHASE_ERROR, { status: 'error', statusMsg: userMessage });
    }
  }, [promptPreview, status, selectedFile, workflowManifest, session.activeSessionId, runDirectGeneration, runGeneration, beginAgentTask, discardGenerationTurn, generationControls, failRecord, upsertRecord]);

  useEffect(() => {
    if (!autoConfirmPreviewId || !promptPreview?.previewId || autoConfirmPreviewId !== promptPreview.previewId) return;
    setAutoConfirmPreviewId('');
    void confirmPromptPreview();
  }, [autoConfirmPreviewId, promptPreview, confirmPromptPreview]);

  const addAttachmentItems = useCallback(async (items) => {
    if (!items?.length) return;
    const withPreviews = await Promise.all(items.map(async item => {
      if (item.kind !== 'image' || !window.electronAPI.mediaImageData) return item;
      const previewUrl = await window.electronAPI.mediaImageData(item).catch(() => '');
      return previewUrl ? { ...item, previewUrl } : item;
    }));
    setAttachments(current => {
      const paths = new Set(current.map(item => item.path));
      return [...current, ...withPreviews.filter(item => !paths.has(item.path))];
    });
  }, []);

  const handleAttachMedia = useCallback(async () => {
    const selected = await window.electronAPI.selectMediaFiles();
    if (!selected?.length) return;
    await addAttachmentItems(selected);
  }, [addAttachmentItems]);

  const handlePasteImage = useCallback(async (event) => {
    const files = event?.clipboardData?.files;
    if (!files || files.length === 0) return false;
    const imageFile = [...files].find(file => String(file.type || '').startsWith('image/'));
    if (!imageFile) return false;
    try {
      const buffer = await imageFile.arrayBuffer();
      const item = await window.electronAPI.clipboardSaveImage(buffer, imageFile.name || 'pasted-image.png');
      await addAttachmentItems([item]);
      return true;
    } catch (error) {
      console.error('[paste-image]', error?.message || error);
      return false;
    }
  }, [addAttachmentItems]);

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
    cancelRecord(promptPreview?.requestId || promptPreview?.executionContext?.turnId || activeTurnIdRef.current);
    setPromptPreview(null);
    setMessages(previous => previous.filter(message => !message.previewNotice));
    transitionGeneration(PHASE_IDLE, { status: 'idle', statusMsg: '' });
  }, [promptPreview, discardGenerationTurn, cancelRecord]);

  const handleEditMessage = useCallback(async (index) => {
    if (status === 'running' || !messages[index] || messages[index].role !== 'user') return;
    const message = messages[index];
    const rewind = await window.electronAPI.agentRewindConversation(index);
    if (!rewind?.rewound) return;
    const previousTaskId = activeTaskIdRef.current;
    const previousTurnId = activeTurnIdRef.current;
    if (previousTurnId) blockedTurnIdsRef.current.add(previousTurnId);
    terminateStreamingTask(previousTaskId, 'cancelled');
    activeTaskIdRef.current = '';
    activeTurnIdRef.current = '';
    setMessages(previous => previous.slice(0, index));
    setInput(message.content);
    setEditingMessageIndex(index);
    inputRef.current?.focus();
  }, [messages, status, terminateStreamingTask]);

  const cancelEdit = useCallback(() => {
    setInput('');
    setEditingMessageIndex(-1);
  }, []);

  const applyTurnResult = useCallback(async (result, requestText, modeHint = 'creative', expectedTurnId = '') => {
    // agent:turn wraps chat responses and generation previews in `result`.
    // Normalize that transport envelope before updating the UI.
    const payload = result?.result && typeof result.result === 'object'
      ? { ...result, ...result.result, result: result.result }
      : result;
    // IPC replies can arrive after cancellation or after a newer turn started.
    // Events are already turn-filtered; apply the same boundary to RPC results.
    if (expectedTurnId && activeTurnIdRef.current !== expectedTurnId) return { status: 'stale' };
    if (payload?.turnId && expectedTurnId && payload.turnId !== expectedTurnId) return { status: 'stale' };
    if (payload?.action === 'generate' && payload.preview) {
      const preview = payload.preview;
      if (preview?.action === 'ai_failed') {
        const errorMessage = preview.error || preview.message || '生成准备失败';
        transitionGeneration(PHASE_PREVIEW, { status: 'preview', promptPreview: preview, statusMsg: errorMessage });
        return;
      }
      setPromptPreview(payload.preview);
      transitionGeneration(PHASE_PREVIEW, { status: 'preview', statusMsg: payload.decision?.reason || '请确认生成预览' });
      return;
    }
    if (payload?.action === 'clarify') {
      transitionGeneration(PHASE_IDLE, { status: 'idle', statusMsg: payload.response || payload.decision?.question || '请补充必要信息' });
       return;
    }
    if (payload?.action === 'queued') {
      transitionGeneration(PHASE_IDLE, { status: 'idle', statusMsg: '生成请求已排队（第 ' + (payload.position || '?') + ' 项）' });
       return;
    }
    if (payload?.action === 'prepare') {
       const preview = payload.preview;
       if (preview?.action === 'ai_failed') {
         const errorMessage = preview.error || preview.message || '生成准备失败';
         transitionGeneration(PHASE_PREVIEW, { status: 'preview', promptPreview: preview, statusMsg: errorMessage });
         return;
       }
       setPromptPreview(payload.preview);
       if (payload.preview?.workflowName && payload.preview.workflowName !== selectedFile) setSelectedFile(payload.preview.workflowName);
       transitionGeneration(PHASE_PREVIEW, { status: 'preview', statusMsg: payload.decision?.reason || '请确认生成预览' });
       return;
    }
    if (payload?.action === 'policy_block') {
      transitionGeneration(PHASE_IDLE, { status: 'idle', statusMsg: '' });
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
    if (payload?.action === 'ai_failed') {
      const errorMessage = payload.error || payload.message || '生成准备失败';
      transitionGeneration(PHASE_ERROR, { status: 'error', statusMsg: errorMessage });
      return;
    }
    if (payload?.action === 'suggest') {
      setPromptPreview({
        action: 'generation_suggestion',
        request: requestText,
        turnId: payload.turnId || '',
      });
      transitionGeneration(PHASE_IDLE, { status: 'idle', statusMsg: payload.response || '检测到图片生成请求' });
      return;
    }
    if (payload?.action === 'execute' && payload.result) {
      const executionResult = payload.result;
      const mediaItems = resultMedia(executionResult);
      if (mediaItems.length) upsertRecord(executionResult.requestId || expectedTurnId, {
        turnId: executionResult.turnId || expectedTurnId, taskId: executionResult.taskId || '', source: executionResult.source || 'agent', status: 'completed', createdAt: Date.now(),
        prompt: executionResult.compiledPrompt?.positive || executionResult.positive || requestText, negative: executionResult.compiledPrompt?.negative || executionResult.negative || '', workflowName: executionResult.workflowName || '', parameters: executionResult.parameters || executionResult.settings || {}, nodeOverrides: executionResult.nodeOverrides || {}, outputNodeIds: executionResult.outputNodeIds || null,
        media: mediaItems, durationMs: executionResult.durationMs || executionResult.duration_ms || 0, completedAt: Date.now(), progressPercent: 100, progressNodePercent: 100, progressMessage: '生成完成', progressStage: 'completed', error: null,
      });
    }
    const turnId = payload?.turnId || activeTurnIdRef.current;
    const response = typeof payload?.response === 'string' ? payload.response.trim() : '';
    if (response) {
      const messageId = turnId ? `${turnId}:agent` : '';
      setMessages(previous => {
        if (previous.some(message => (
          (messageId && (message.messageId === messageId || message.streamingMessageId === messageId))
          || (message.turnId === turnId && message.role === 'agent' && message.content === response)
        ))) return previous;
        return [...previous, {
          role: 'agent',
          content: response,
          messageId,
          turnId,
          time: timeStr(),
          duration_ms: sendStartRef.current > 0 ? Date.now() - sendStartRef.current : 0,
        }];
      });
    }
    transitionGeneration(PHASE_IDLE, { status: 'idle', statusMsg: response || '已完成' });
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
  }, [selectedFile, setSelectedFile, session, addActivityEvent, upsertRecord]);

  const submitTurn = useCallback(async (text, modeHint = 'creative', options = {}) => {
    if (!text && attachments.length === 0) return;
    if (isTaskActive(status, generationPhase) || submissionLockRef.current) {
      setStatusMsg(status === 'stopping' ? '上一任务正在收尾，请稍候' : '请求正在处理中，请勿重复发送');
      return { status: 'busy' };
    }
    submissionLockRef.current = true;
    const generationToken = ++generationTokenRef.current;
    const requestText = text || IMAGE_ONLY_REQUEST;
    generationSourceRef.current = 'chat';
    setGenerationSource('agent');
    setLastGenerationRequest(requestText);
    transitionGeneration(PHASE_PREPARING, { status: 'preparing', statusMsg: '正在判断请求并准备下一步...', generationProgress: null });
    setThinking('');
    setActivityEvents([]);
    beginAgentTask();
    sendStartRef.current = Date.now();
    const turnId = newTurnId();
    activeTurnIdRef.current = turnId;
    activeDirectRequestIdRef.current = turnId;
    const attached = messageAttachments(attachments);
    setMessages(previous => [...previous, { role: 'user', content: text || '图片', time: timeStr(), turnId, attachments: attached }]);
    try {
      const media = requestMedia(requestText, attachments);
      const result = await window.electronAPI.agentHandleTurn({
        text: requestText,
        modeHint,
        media,
        workflowName: selectedFile,
        workflowManifest,
        skillId: options.skillId || '',
        projectId: session.activeProjectId,
           sessionId: session.activeSessionId,
           turnId,
           requestId: turnId,
      });
      if (generationToken !== generationTokenRef.current || activeTurnIdRef.current !== turnId) return { status: 'stale' };
      return applyTurnResult(result, requestText, modeHint, turnId);
    } catch (error) {
      if (generationToken !== generationTokenRef.current || activeTurnIdRef.current !== turnId) return { status: 'stale' };
      const userMessage = formatAgentError(error);
      transitionGeneration(PHASE_ERROR, { status: 'error', statusMsg: userMessage });
      addActivityEvent({ type: 'error', status: 'error', description: userMessage, error: error?.message || userMessage, code: error?.code || '', taskId: activeTaskIdRef.current, traceId: error?.traceId || '' });
      setMessages(previous => [...previous, { role: 'agent', content: userMessage, time: timeStr() }]);
    } finally {
      submissionLockRef.current = false;
    }
  }, [status, generationPhase, selectedFile, workflowManifest, attachments, session.activeProjectId, session.activeSessionId, beginAgentTask, applyTurnResult, addActivityEvent]);

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
      transitionGeneration(PHASE_RUNNING, { status: 'running', statusMsg: '已确认手动发送，正在调用云端生图...' });
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
        transitionGeneration(PHASE_IDLE, { status: 'idle', statusMsg: '生成完成' });
      } catch (error) {
        const userMessage = formatAgentError(error);
        transitionGeneration(PHASE_ERROR, { status: 'error', statusMsg: userMessage });
        addActivityEvent({ type: 'error', status: 'error', description: userMessage, error: error?.message || userMessage, code: error?.code || '', taskId: activeTaskIdRef.current, traceId: error?.traceId || '' });
         setMessages(previous => [...previous, { role: 'agent', content: userMessage, time: timeStr(), turnId: pending.turnId }]);
      } finally {
        submissionLockRef.current = false;
      }
      return;
    }
    setPolicyConfirm(null);
    transitionGeneration(PHASE_RUNNING, { status: 'running', statusMsg: '已确认手动发送，正在重试...' });
    setThinking('');
    beginAgentTask();
    sendStartRef.current = Date.now();
    try {
      const result = await window.electronAPI.agentHandleTurn({
        text: pending.text,
        modeHint: pending.modeHint || 'creative',
        media: pending.media || null,
        workflowName: selectedFile,
        workflowManifest,
        sessionId: session.activeSessionId,
        turnId: pending.turnId || '',
        allowPolicyOverride: true,
      });
      if (pending.turnId && activeTurnIdRef.current !== pending.turnId) return { status: 'stale' };
      return applyTurnResult(result, pending.text, pending.modeHint || 'creative', pending.turnId || '');
    } catch (error) {
      const userMessage = formatAgentError(error);
      transitionGeneration(PHASE_ERROR, { status: 'error', statusMsg: userMessage });
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
    transitionGeneration(PHASE_IDLE, { status: 'idle', statusMsg: '已取消发送（内容被云端审查拦截）。' });
    setMessages(previous => [...previous, { role: 'agent', content: '已取消发送：内容被云端审查拦截，未发送到云端。', time: timeStr() }]);
  }, [policyConfirm, addActivityEvent]);

  const handleSend = useCallback(async (action = 'creative', imageOptions = {}, textOverride = null, options = {}) => {
    const text = textOverride === null ? input.trim() : String(textOverride || '').trim();
    if (!text && attachments.length === 0) return;
    if (isTaskActive(status, generationPhase) || submissionLockRef.current) {
      setStatusMsg(status === 'stopping' ? '上一任务正在收尾，请稍候' : '请求正在处理中，请勿重复发送');
      return { status: 'busy' };
    }
    setInput('');

    setEditingMessageIndex(-1);
    if (action === 'direct') return runDirectGeneration(text);
    if (action === 'openai-image') {
      submissionLockRef.current = true;
      generationSourceRef.current = 'openai-image';
      transitionGeneration(PHASE_RUNNING, { status: 'running', statusMsg: '正在调用 OpenAI Image 生成图片...' });
      const turnId = newTurnId();
      activeImageRequestIdRef.current = turnId;
      upsertRecord(turnId, { turnId, taskId: '', source: 'openai-image', status: 'preparing', createdAt: Date.now(), prompt: text, negative: '', workflowName: 'OpenAI Image', parameters: imageOptions, nodeOverrides: {}, outputNodeIds: null, media: [], durationMs: 0, progressPercent: null, progressNodePercent: null, progressMessage: '正在调用 OpenAI Image 生成图片...', progressStage: 'preparing', error: null });
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
          upsertRecord(turnId, { turnId, taskId: result.taskId || '', source: 'openai-image', status: 'completed', prompt: result.revisedPrompt || text, negative: '', workflowName: 'OpenAI Image', parameters: imageOptions, media: normalizedResult.media || [], durationMs: result.durationMs || 0, completedAt: Date.now(), progressPercent: 100, progressNodePercent: 100, progressMessage: '生成完成', progressStage: 'completed', error: null });
         activeTaskIdRef.current = result.taskId || '';
         await refreshAssets({ replace: true });
         setMessages(previous => [...previous, { role: 'agent', content: 'OpenAI Image 生成完成。', images: normalizedResult.images || [], media: normalizedResult.media || [], time: timeStr(), turnId }]);
        setLastGenerationRequest(text);
        setGenerationSource('openai-image');
        transitionGeneration(PHASE_IDLE, { status: 'idle', statusMsg: '生成完成' });
      } catch (error) {
         if (error?.code === 'CLOUD_POLICY_BLOCKED') {
           transitionGeneration(PHASE_IDLE, { status: 'idle' });
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
        const userMessage = formatAgentError(error);
        transitionGeneration(PHASE_ERROR, { status: 'error', statusMsg: userMessage });
        addActivityEvent({ type: 'error', status: 'error', description: userMessage, error: error?.message || userMessage, code: error?.code || '', taskId: activeTaskIdRef.current, traceId: error?.traceId || '' });
        upsertRecord(turnId, { turnId, source: 'openai-image', status: 'failed', progressMessage: userMessage, progressStage: 'failed', error: { message: userMessage, code: error?.code || '' } });
      } finally {
        submissionLockRef.current = false;
      }
      return;
    }
    return submitTurn(text, 'creative', options);
  }, [input, status, generationPhase, attachments, runDirectGeneration, submitTurn, session.activeProjectId, session.activeSessionId, refreshAssets, addActivityEvent, upsertRecord]);

  const handleRegenerate = useCallback((record = null, feedbackType = 'regenerate') => {
    if (typeof record === 'string') {
      feedbackType = record;
      record = null;
    }
    const source = record?.source || record?.generationSource || generationSourceRef.current;
    const request = (record?.prompt !== undefined ? record.prompt : lastGenerationRequest).trim();
    const negative = record?.negative !== undefined ? record.negative : lastGenerationNegative;
    const controls = {
      ...generationControls,
      settings: { ...(record?.parameters !== undefined ? record.parameters : generationControls.settings || {}) },
      nodeOverrides: record?.nodeOverrides !== undefined ? record.nodeOverrides : generationControls.nodeOverrides || {},
      outputNodeIds: record?.outputNodeIds !== undefined ? record.outputNodeIds : generationControls.outputNodeIds || null,
    };
    // Regenerate means a new sample. Reusing an existing seed produces the same image.
    controls.settings = { ...(controls.settings || {}), seed: Math.floor(Math.random() * 0xFFFFFFFF) };
    if (source === 'direct') {
      runDirectGeneration(request, { controls, negative, workflowName: record?.workflowName !== undefined ? record.workflowName : selectedFile });
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
    const cancelledRequestId = activeImageRequestIdRef.current || activeDirectRequestIdRef.current || activeTurnIdRef.current;
    const currentPreview = promptPreview;
    if (currentPreview?.previewId) invalidPreviewIdsRef.current.add(currentPreview.previewId);
    if (activeTurnIdRef.current) blockedTurnIdsRef.current.add(activeTurnIdRef.current);
    activeTaskIdRef.current = '';
    if (generationSourceRef.current !== 'direct' && activeDirectRequestIdRef.current) {
      blockedTaskIdsRef.current.add(activeDirectRequestIdRef.current);
      activeDirectRequestIdRef.current = '';
      activeDirectTaskIdRef.current = '';
    }
    activeTurnIdRef.current = '';
    terminateStreamingTask(taskId, 'cancelled');
    setGenerationProgress(null);
    setPromptPreview(null);
    setAutoConfirmPreviewId('');
    setGenerationTurn(previous => previous ? { ...previous, status: 'cancelled' } : previous);
    if (cancelledRequestId) upsertRecord(cancelledRequestId, { status: 'cancelled', progressStage: 'cancelled', progressMessage: '已取消', error: null });
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
    transitionGeneration(stopping ? PHASE_STOPPING : PHASE_IDLE, {
      status: stopping ? 'stopping' : 'idle',
      statusMsg: stopping ? '取消请求已发送，正在等待后台任务收尾' : cancelMessage,
    });
    if (stopping) {
      const cancelTimeoutRef = { current: null };
      cancelTimeoutRef.current = setTimeout(() => {
        transitionGeneration(PHASE_IDLE, { status: 'idle', statusMsg: '取消超时，已强制终止' });
        cancelTimeoutRef.current = null;
      }, 30000);
    }
  }, [promptPreview, terminateStreamingTask, discardGenerationTurn, upsertRecord]);

  const handleKeyDown = useCallback((event, action = 'answer') => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleSend(action);
    }
  }, [handleSend]);

  const clearConversation = useCallback(async () => {
    if (isTaskActive(status, generationPhase)) return;
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
    setGenerationResult(null);
    setGenerationRecords({});
    setGenerationTurn(null);
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
    transitionGeneration(PHASE_IDLE, { status: 'idle', statusMsg: '' });
  }, [status, generationPhase, promptPreview, terminateStreamingTask]);

  const compactConversation = useCallback(async () => {
    if (isTaskActive(status, generationPhase)) throw new Error('请先停止当前任务');
    const result = await window.electronAPI.agentCompactConversation();
    setContextUsage(current => ({ ...current, archiveCount: result.archived || 0 }));
    return result;
  }, [status, generationPhase]);

  const createNewSession = useCallback(async () => {
    if (isTaskActive(status, generationPhase)) throw new Error('请先停止当前任务');
    return session.createSession('新会话', session.activeProjectId);
  }, [session, status, generationPhase]);

  const getRuntimeStatus = useCallback(() => window.electronAPI.agentStatus(), []);

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
    handlePasteImage,
    removeAttachment,
    activityEvents,
    executionRecords: session.sessionState?.executionRecords || {},
    errorFeedback,
    setErrorFeedback,
    feedbackOpen,
    setFeedbackOpen,
    status,
    rawStatus,
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
    generationRecords,
    upsertRecord,
    setGenerationProgress,
    generationResult,
    generationPhase,
    runtimeView,
    generationPending: runtimeView.busy,
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
    compactConversation,
    createNewSession,
    getRuntimeStatus,
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
