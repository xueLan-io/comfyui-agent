import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useSession } from './SessionContext.jsx';
import { useI18n } from '../i18n/I18nContext.jsx';
import { normalizePlan, resolveSeedStrategy } from '../runtime/batch/seed-strategy.mjs';

const BatchQueueContext = createContext(null);

export function useBatchQueue() {
  return useContext(BatchQueueContext);
}

const ACTIVE_BATCH_STATUSES = new Set(['created', 'running', 'paused', 'interrupted']);

export function BatchQueueProvider({ children }) {
  const session = useSession();
  const { t } = useI18n();
  const projectId = session.activeProjectId || '';
  const sessionId = session.activeSessionId || '';
  const sessionKeyRef = useRef('');
  const [queueItems, setQueueItems] = useState([]);
  const [batches, setBatches] = useState([]);
  const [feedback, setFeedback] = useState(null);
  const feedbackTimerRef = useRef(0);

  const strategySummary = useCallback(strategy => {
    const mode = strategy?.mode || 'random';
    if (mode === 'fixed') return t('queueStrategyFixed');
    if (mode === 'list') return t('queueStrategyList', { count: (strategy.values || []).length });
    if (mode === 'step') return t('queueStrategyStep', { count: strategy.count || 4 });
    return t('queueStrategyRandom', { count: strategy.count || 4 });
  }, [t]);

  const showFeedback = useCallback((text, kind = 'info') => {
    setFeedback({ text, kind });
    window.clearTimeout(feedbackTimerRef.current);
    feedbackTimerRef.current = window.setTimeout(() => setFeedback(null), 3600);
  }, []);

  const loadBatches = useCallback(async () => {
    if (!projectId || !window.electronAPI?.batchList) return;
    try {
      const list = await window.electronAPI.batchList(projectId, 50);
      setBatches(Array.isArray(list) ? list : []);
    } catch {
      // keep last known list on transient failure
    }
  }, [projectId]);

  // Queue draft lives in the main process so the main and floating windows
  // share the same assembly area. Subscribe to change broadcasts + hydrate once.
  useEffect(() => {
    if (!window.electronAPI?.queueList) return undefined;
    void window.electronAPI.queueList().then(list => setQueueItems(Array.isArray(list) ? list : [])).catch(() => {});
    const unsubscribe = window.electronAPI.onQueueEvent?.(event => {
      if (event?.type === 'changed') setQueueItems(Array.isArray(event.items) ? event.items : []);
    });
    return () => unsubscribe?.();
  }, []);

  useEffect(() => {
    if (!projectId) { setBatches([]); return; }
    void loadBatches();
    const unsubscribe = window.electronAPI?.onBatchEvent?.(() => { void loadBatches(); });
    return () => unsubscribe?.();
  }, [projectId, sessionId, loadBatches]);

  // Reset the draft when the session changes (the draft is per active session).
  useEffect(() => {
    const key = `${projectId}:${sessionId}`;
    if (sessionKeyRef.current && sessionKeyRef.current !== key && window.electronAPI?.queueClear) {
      void window.electronAPI.queueClear().catch(() => {});
    }
    sessionKeyRef.current = key;
  }, [projectId, sessionId]);

  const addToQueue = useCallback(async (payload, options = {}) => {
    const plan = normalizePlan(payload || {});
    if (!plan.positive) {
      showFeedback(t('queueToastMissingPrompt'), 'error');
      return false;
    }
    const item = {
      plan,
      sourceKind: options.sourceKind || 'plan',
      sourceLabel: options.sourceLabel || '',
      hasReference: plan.media.images.length > 0 || plan.media.videos.length > 0,
      seedStrategy: options.seedStrategy || { mode: 'random', count: 4 },
    };
    try {
      const result = await window.electronAPI.queueAdd(item);
      const referenceNote = item.hasReference ? t('queueReferenceNote') : '';
      showFeedback(t('queueToastAdded', { position: result?.position ?? '—', strategy: strategySummary(item.seedStrategy), reference: referenceNote }), 'success');
      return true;
    } catch (error) {
      showFeedback(error?.message || t('operationFailed'), 'error');
      return false;
    }
  }, [showFeedback, strategySummary, t]);

  const removeQueueItem = useCallback(id => {
    void window.electronAPI.queueRemove(id).catch(() => {});
  }, []);

  const moveQueueItem = useCallback((id, direction) => {
    void window.electronAPI.queueMove(id, direction).catch(() => {});
  }, []);

  const updateQueueItem = useCallback((id, patch) => {
    void window.electronAPI.queueUpdate(id, patch).catch(() => {});
  }, []);

  const clearQueue = useCallback(() => {
    void window.electronAPI.queueClear().catch(() => {});
  }, []);

  const startQueue = useCallback(async () => {
    if (!projectId || !sessionId) { showFeedback(t('queueToastNoProject'), 'error'); return false; }
    if (!window.electronAPI?.queueStart) return false;
    try {
      const batch = await window.electronAPI.queueStart();
      showFeedback(t('queueToastStarted', { code: batch?.code || batch?.id || '', count: batch?.jobs?.length || '' }), 'success');
      await loadBatches();
      return true;
    } catch (error) {
      if (error?.code === 'QUEUE_EMPTY' || /queue empty/i.test(error?.message || '')) showFeedback(t('queueToastEmpty'), 'info');
      else if (error?.code === 'QUEUE_NO_JOBS' || /no runnable items/i.test(error?.message || '')) showFeedback(t('queueToastNoJobs'), 'info');
      else showFeedback(error?.message || t('operationFailed'), 'error');
      return false;
    }
  }, [projectId, sessionId, showFeedback, loadBatches, t]);

  const runBatchAction = useCallback(async (action, ...args) => {
    try {
      await window.electronAPI[action](...args);
      await loadBatches();
    } catch (error) {
      showFeedback(error?.message || t('operationFailed'), 'error');
    }
  }, [loadBatches, showFeedback, t]);

  const value = useMemo(() => {
    const sessionBatches = batches.filter(batch => !batch.sessionId || batch.sessionId === sessionId);
    const activeBatches = sessionBatches.filter(batch => ACTIVE_BATCH_STATUSES.has(batch.status));
    const activeJobCount = activeBatches.reduce((sum, batch) => sum + (batch.progress?.pending || 0) + (batch.progress?.running || 0), 0);
    const completedBatches = sessionBatches
      .filter(batch => batch.status === 'completed')
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const badge = queueItems.length + activeBatches.length;
    return {
      queueItems,
      batches: sessionBatches,
      activeBatches,
      completedBatches,
      activeJobCount,
      badge,
      feedback,
      seedPreview: resolveSeedStrategy,
      addToQueue,
      removeQueueItem,
      moveQueueItem,
      updateQueueItem,
      clearQueue,
      startQueue,
      pauseBatch: batchId => runBatchAction('batchPause', batchId),
      resumeBatch: batchId => runBatchAction('batchResume', batchId),
      cancelBatch: batchId => runBatchAction('batchCancel', batchId),
      retryJob: (batchId, jobId) => runBatchAction('batchRetryJob', batchId, jobId),
    };
  }, [batches, sessionId, queueItems, feedback, addToQueue, removeQueueItem, moveQueueItem, updateQueueItem, clearQueue, startQueue, runBatchAction]);

  useEffect(() => () => window.clearTimeout(feedbackTimerRef.current), []);

  return (
    <BatchQueueContext.Provider value={value}>
      {children}
      {feedback && <div className={`queue-toast queue-toast-${feedback.kind || 'info'}`} role="status" aria-live="polite">{feedback.text}</div>}
    </BatchQueueContext.Provider>
  );
}
