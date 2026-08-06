import { useEffect, useMemo, useRef, useState } from 'react';
import { useAgent } from '../contexts/AgentContext.jsx';
import { useComfyUI } from '../contexts/ComfyUIContext.jsx';
import { useSession } from '../contexts/SessionContext.jsx';
import ImageAsset from './ImageAsset.jsx';
import AssetPreviewModal from './AssetPreviewModal.jsx';
import Icon from './Icon.jsx';
import FloatingPresetView from './FloatingPresetView.jsx';
import { presetDefaultControls, presetWorkflowName } from '../runtime/preset-generation.mjs';

const INITIAL_PROMPT = '';
const INITIAL_NEGATIVE = '';
const TASK_STORAGE_PREFIX = 'comfy-agent.quick-generate-task.';
const QUICK_PREPARE_TIMEOUT_MS = 120000;
const QUICK_RESULT_DISPLAY_MS = 8000;

function normalizePrompt(value = '') {
  return String(value).replaceAll('，', ',');
}

function appendPrompt(current, value) {
  const candidate = normalizePrompt(value).trim();
  if (!candidate) return normalizePrompt(current);
  const existing = normalizePrompt(current).split(',').map(part => part.trim()).filter(Boolean);
  const existingKeys = new Set(existing.map(part => part.toLowerCase()));
  const next = candidate.split(',').map(part => part.trim()).filter(part => part && !existingKeys.has(part.toLowerCase()));
  return [...existing, ...next].join(', ');
}

function replacePrompt(value) {
  return normalizePrompt(value).trim();
}

function taskStorageKey(projectId, sessionId) {
  return `${TASK_STORAGE_PREFIX}${projectId || 'default'}.${sessionId || 'default'}`;
}

function readTask(projectId, sessionId) {
  try {
    const value = JSON.parse(window.localStorage.getItem(taskStorageKey(projectId, sessionId)) || 'null');
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function ProgressRing({ progress, status, indeterminate = false }) {
  const radius = 27;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (Math.max(0, Math.min(100, progress)) / 100) * circumference;
  return (
    <svg className={`quick-generate-ring quick-generate-ring-${status}${indeterminate ? ' indeterminate' : ''}`} viewBox="0 0 64 64" aria-hidden="true">
      <circle className="quick-generate-ring-track" cx="32" cy="32" r={radius} />
      <circle className="quick-generate-ring-value" cx="32" cy="32" r={radius} strokeDasharray={circumference} strokeDashoffset={offset} />
    </svg>
  );
}

function PromptChips({ value, onRemove }) {
  const parts = normalizePrompt(value).split(',').map(item => item.trim()).filter(Boolean);
  if (!parts.length) return <span className="quick-prompt-empty">还没有提示词片段</span>;
  return <div className="quick-prompt-chips">{parts.map((part, index) => <span className="quick-prompt-chip" key={`${part}-${index}`}><span>{part}</span><button type="button" onClick={() => onRemove(index)} aria-label={`删除${part}`}><Icon name="close" size={10} /></button></span>)}</div>;
}

export default function QuickGenerateFloat({ onClose, visible = true }) {
  const { generationProgress, generationPending, generationResult, status: agentStatus, statusMsg, preview, sendQuickGeneration, runLibraryGeneration, handleCancel, cancelPromptPreview, setPreview, monitorRecoveryTask } = useAgent();
  const { selectedFile, selectWorkflow, workflowFiles, workflowManifest, setGenerationControls } = useComfyUI();
  const { activeProjectId, activeSessionId, sessionState } = useSession();
  const [collapsed, setCollapsed] = useState(false);
  const [tab, setTab] = useState('positive');
  const [positive, setPositive] = useState(INITIAL_PROMPT);
  const [negative, setNegative] = useState(INITIAL_NEGATIVE);
  const [status, setStatus] = useState('idle');
  const [task, setTask] = useState(null);
  const [resultOnly, setResultOnly] = useState(false);
  const requestedRef = useRef(false);
  const recoveryTaskRef = useRef(false);
  const dragRef = useRef(null);
  const tabRef = useRef(tab);
  const prepareTimeoutRef = useRef(null);
  const resultTimerRef = useRef(null);
  const resultDeadlineRef = useRef(null);
  const resultRemainingRef = useRef(0);
  const resultWasCollapsedRef = useRef(false);
  const generationBaselineRef = useRef(null);
  const [resultCountdown, setResultCountdown] = useState(0);
  const [view, setView] = useState('quick');
  const [activePreset, setActivePreset] = useState(null);
  const [dragReceiving, setDragReceiving] = useState(false);
  const incomingDragRef = useRef(null);
  const isBusy = ['preparing', 'confirming', 'running'].includes(status);
  tabRef.current = tab;

  function stopResultCountdown() {
    if (resultTimerRef.current) window.clearInterval(resultTimerRef.current);
    resultTimerRef.current = null;
    resultDeadlineRef.current = null;
    resultRemainingRef.current = 0;
    setResultCountdown(0);
  }

  function updateResultCountdown() {
    const remaining = Math.max(0, (resultDeadlineRef.current || Date.now()) - Date.now());
    resultRemainingRef.current = remaining;
    setResultCountdown(Math.ceil(remaining / 1000));
    return remaining;
  }

  function pauseResultCountdown() {
    if (!resultTimerRef.current) return;
    updateResultCountdown();
    window.clearInterval(resultTimerRef.current);
    resultTimerRef.current = null;
    resultDeadlineRef.current = null;
  }

  function resumeResultCountdown() {
    if (resultTimerRef.current || !resultOnly) return;
    if (!resultRemainingRef.current) {
      setResultOnly(false);
      setTab('positive');
      if (resultWasCollapsedRef.current) {
        setCollapsed(true);
        resizeFloatingWindow(true);
      }
      return;
    }
    resultDeadlineRef.current = Date.now() + resultRemainingRef.current;
    resultTimerRef.current = window.setInterval(() => {
      if (updateResultCountdown() > 0) return;
      window.clearInterval(resultTimerRef.current);
      resultTimerRef.current = null;
      resultRemainingRef.current = 0;
      setResultOnly(false);
      setTab('positive');
      if (resultWasCollapsedRef.current) {
        setCollapsed(true);
        resizeFloatingWindow(true);
      }
    }, 250);
  }

  function resizeFloatingWindow(collapsed) {
    void window.electronAPI.floatingResize?.(collapsed);
  }

  useEffect(() => {
    const restored = readTask(activeProjectId, activeSessionId);
    if (!restored) {
      setTask(null);
      setStatus('idle');
      requestedRef.current = false;
      recoveryTaskRef.current = false;
       setPositive(normalizePrompt(sessionState?.lastPrompt || INITIAL_PROMPT));
       setNegative(normalizePrompt(INITIAL_NEGATIVE));
      return;
    }
     setPositive(normalizePrompt(restored.positive || INITIAL_PROMPT));
     setNegative(normalizePrompt(restored.negative || INITIAL_NEGATIVE));
    setTask(restored);
    requestedRef.current = true;
    if (restored.phase === 'running' && restored.taskId) {
      recoveryTaskRef.current = true;
      setStatus('running');
      void monitorRecoveryTask(restored.taskId).then(result => {
        if (result?.status === 'completed' && result.result) {
          const media = result.result.media || [...(result.result.images || []), ...(result.result.videos || [])];
          setTask(current => ({ ...current, phase: 'complete', result: media, promptId: result.promptId || current.promptId }));
          setStatus('complete');
        } else if (['queued', 'running'].includes(result?.status)) {
          setTask(current => ({ ...current, phase: 'running', promptId: result.promptId || current.promptId, progress: result.progress || current.progress }));
          setStatus('running');
        } else {
          setTask(current => ({ ...current, phase: 'failed', error: result?.message || '远端任务状态未知，请重试。' }));
          setStatus('failed');
        }
      }).catch(error => {
        setTask(current => ({ ...current, phase: 'failed', error: error.message || '恢复任务失败，请重试。' }));
        setStatus('failed');
      });
    } else if (['preparing', 'confirming', 'running'].includes(restored.phase)) {
      setTask({ ...restored, phase: 'failed', error: '应用重新加载，之前的任务没有后端任务标识，请重试。' });
      setStatus('failed');
    } else {
      // Completed tasks are history, not a command to reopen the result screen.
      // Start the controller on its prompt editor so reopening the float does not
      // trap the user in the previous generation.
      if (restored.phase === 'complete') {
        setTask(current => ({ ...current, phase: 'idle', result: [] }));
        setStatus('idle');
      } else {
        setStatus(restored.phase === 'failed' ? 'failed' : 'idle');
      }
    }
  }, [activeProjectId, activeSessionId, monitorRecoveryTask, sessionState?.lastPrompt]);

  useEffect(() => {
    if (!window.electronAPI.onFloatingDrag) return undefined;
    const unsubscribe = window.electronAPI.onFloatingDrag(event => {
       if (event?.phase === 'start') {
          cancelOrbDrag();
         incomingDragRef.current = event.payload || null;
         setDragReceiving(false);
        return;
      }
      if (event?.phase === 'move') {
        setDragReceiving(Boolean(event.hit));
        return;
      }
       if (event?.phase === 'cancel') {
         incomingDragRef.current = null;
         setDragReceiving(false);
         cancelOrbDrag();
         return;
       }
       if (event?.phase !== 'end') return;
      const payload = incomingDragRef.current;
      incomingDragRef.current = null;
      setDragReceiving(false);
      if (!event.hit || !payload) return;
       cancelOrbDrag();
       applyDraggedCard(payload);
    });
    return () => {
      unsubscribe?.();
      incomingDragRef.current = null;
      setDragReceiving(false);
    };
  }, [isBusy, selectWorkflow, setGenerationControls, workflowFiles]);

  useEffect(() => {
    if (!activeProjectId && !activeSessionId) return;
    try {
      if (task) window.localStorage.setItem(taskStorageKey(activeProjectId, activeSessionId), JSON.stringify({ ...task, updatedAt: Date.now() }));
      else window.localStorage.removeItem(taskStorageKey(activeProjectId, activeSessionId));
    } catch {}
  }, [activeProjectId, activeSessionId, task]);

  useEffect(() => {
    if (!requestedRef.current) return;
    if (generationPending && task?.phase !== 'preparing') {
      setStatus('running');
      setTask(current => current ? { ...current, phase: 'running' } : current);
    } else if (!generationPending && generationResult && generationResult !== generationBaselineRef.current && (agentStatus === 'complete' || agentStatus === 'completed') && ['preparing', 'confirming', 'running'].includes(task?.phase)) {
      const result = generationResult?.media || task?.result || [];
      setTask(current => ({ ...current, phase: 'complete', result }));
      setStatus('complete');
    } else if (!generationPending && generationResult && generationResult !== generationBaselineRef.current && generationResult.media?.length && task?.phase === 'running') {
      setTask(current => ({ ...current, phase: 'complete', result: generationResult.media }));
      setStatus('complete');
    } else if (['error', 'failed', 'cancelled'].includes(agentStatus) && ['preparing', 'confirming', 'running'].includes(task?.phase)) {
      setTask(current => ({ ...current, phase: agentStatus === 'cancelled' ? 'cancelled' : 'failed', error: statusMsg || '工作流执行失败' }));
      setStatus(agentStatus === 'cancelled' ? 'idle' : 'failed');
    }
  }, [agentStatus, generationPending, generationResult, statusMsg, task?.phase]);

  useEffect(() => {
    if (status !== 'running' || !generationProgress || task?.phase !== 'running') return;
    setTask(current => {
      if (!current || (current.progress?.percent === generationProgress.percent && current.progress?.message === generationProgress.message)) return current;
      return { ...current, progress: { percent: generationProgress.percent, indeterminate: generationProgress.indeterminate, message: generationProgress.message, node: generationProgress.node } };
    });
  }, [generationProgress, status, task?.phase]);

  useEffect(() => {
    if (!recoveryTaskRef.current || status !== 'running' || !task?.taskId || !monitorRecoveryTask) return undefined;
    let active = true;
    const check = async () => {
      try {
        const result = await monitorRecoveryTask(task.taskId);
        if (!active) return;
        if (result?.status === 'completed' && result.result) {
          const media = result.result.media || [...(result.result.images || []), ...(result.result.videos || [])];
          setTask(current => ({ ...current, phase: 'complete', result: media, promptId: result.promptId || current.promptId }));
          setStatus('complete');
        } else if (['unknown', 'unavailable', 'submit_unknown', 'archive_failed'].includes(result?.status)) {
          setTask(current => ({ ...current, phase: 'failed', error: result?.message || '远端任务状态未知，请重试。' }));
          setStatus('failed');
        }
        if (result?.progress) {
          setTask(current => ({ ...current, progress: result.progress }));
        }
      } catch (error) {
        if (!active) return;
        setTask(current => ({ ...current, phase: 'failed', error: error.message || '恢复任务失败，请重试。' }));
        setStatus('failed');
      }
    };
    const timer = window.setInterval(() => { void check(); }, 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [monitorRecoveryTask, status, task?.taskId]);

  useEffect(() => {
    if (status !== 'complete') return undefined;
    resultWasCollapsedRef.current = collapsed;
    setCollapsed(false);
    resizeFloatingWindow(false);
    setResultOnly(true);
     resultRemainingRef.current = QUICK_RESULT_DISPLAY_MS;
     resultDeadlineRef.current = Date.now() + QUICK_RESULT_DISPLAY_MS;
     setResultCountdown(Math.ceil(QUICK_RESULT_DISPLAY_MS / 1000));
    if (resultTimerRef.current) window.clearInterval(resultTimerRef.current);
     resultTimerRef.current = window.setInterval(() => {
       const remaining = updateResultCountdown();
       if (remaining > 0) return;
      window.clearInterval(resultTimerRef.current);
       resultTimerRef.current = null;
       resultRemainingRef.current = 0;
       resultDeadlineRef.current = null;
      setResultOnly(false);
      setTab('positive');
      if (resultWasCollapsedRef.current) {
        setCollapsed(true);
        resizeFloatingWindow(true);
      }
    }, 250);
     return () => {
       if (resultTimerRef.current) window.clearInterval(resultTimerRef.current);
       resultTimerRef.current = null;
       resultDeadlineRef.current = null;
     };
   }, [status]);

  useEffect(() => {
    if (preview) pauseResultCountdown();
    else resumeResultCountdown();
  }, [preview, resultOnly]);

   useEffect(() => () => {
     if (prepareTimeoutRef.current) window.clearTimeout(prepareTimeoutRef.current);
     cancelOrbDrag();
   }, []);

  const currentValue = tab === 'positive' ? positive : negative;
  const setCurrentValue = tab === 'positive' ? setPositive : setNegative;
   const promptParts = useMemo(() => normalizePrompt(currentValue).split(',').map(item => item.trim()).filter(Boolean), [currentValue]);
  const statusLabel = { idle: 'READY', preparing: 'PREPARING', confirming: 'READY TO RUN', running: 'GENERATING', complete: 'COMPLETE', failed: 'FAILED' }[status];
  const progressEvent = generationProgress || task?.progress || null;
  const progress = Number.isFinite(progressEvent?.overallPercent) ? progressEvent.overallPercent : Number(progressEvent?.percent || 0);
  const indeterminate = progressEvent?.indeterminate === true;
  const statusDescription = { idle: '准备开始生成', preparing: '正在准备生成', confirming: '请确认生成参数', running: progressEvent?.percentScope === 'node' ? `当前节点：${progressEvent.message || progressEvent.node || '执行中'}` : progressEvent?.message || `正在生成 · ${progress}%`, complete: '生成完成 · 预览结果', failed: task?.error || statusMsg || '工作流执行失败' }[status];
  const recentImages = (task?.result || []).slice(0, 4);
  const workflowName = task?.workflowName || workflowManifest?.workflowName || selectedFile || '未选择工作流';
  const modelType = workflowManifest?.modelType || workflowManifest?.promptProfile?.family || 'generic';
  const workflowReady = Boolean(selectedFile && workflowFiles.includes(selectedFile));

  function handlePromptKeyDown(event) {
    if (!(event.ctrlKey || event.metaKey) || event.key !== 'Enter' || isBusy || !positive.trim()) return;
    event.preventDefault();
    startGeneration();
  }

  function removePart(index) {
     setCurrentValue(promptParts.filter((_, itemIndex) => itemIndex !== index).join(', '));
  }

  function startGeneration(preset = activePreset, positiveOverride = '', negativeOverride = '') {
    const generationPositive = positiveOverride || positive;
    const generationNegative = negativeOverride || negative;
    if (!generationPositive.trim() || !workflowReady || isBusy) return;
    generationBaselineRef.current = generationResult;
    setResultOnly(false);
    collapse();
    requestedRef.current = true;
    recoveryTaskRef.current = false;
    const request = { phase: 'preparing', positive: generationPositive.trim(), negative: generationNegative.trim(), workflowName, startedAt: Date.now(), result: [], projectId: activeProjectId, sessionId: activeSessionId, presetId: preset?.id || '' };
    setTask(request);
    setStatus('preparing');
    if (prepareTimeoutRef.current) window.clearTimeout(prepareTimeoutRef.current);
    prepareTimeoutRef.current = window.setTimeout(() => {
      setTask(current => current?.phase === 'preparing' ? { ...current, phase: 'failed', error: '工作流检查超时，请重试。' } : current);
      setStatus(current => current === 'preparing' ? 'failed' : current);
    }, QUICK_PREPARE_TIMEOUT_MS);
    const generationPreset = preset ? { ...preset, positive: generationPositive.trim(), negative: generationNegative.trim() } : null;
    const generation = generationPreset
      ? runLibraryGeneration(generationPositive.trim(), generationNegative.trim(), { immediate: true, preset: generationPreset })
      : sendQuickGeneration(generationPositive.trim(), { negative: generationNegative.trim(), workflowName: selectedFile });
    void generation.then(result => {
      if (prepareTimeoutRef.current) window.clearTimeout(prepareTimeoutRef.current);
      if (!result || result.status !== 'accepted') {
        setTask(current => ({ ...current, phase: 'failed', error: result?.message || '工作流检查失败，请重试。' }));
        setStatus('failed');
        return;
      }
      setTask(current => current ? { ...current, phase: 'running', taskId: result.taskId, workflowName: result.workflowName || current.workflowName } : current);
    }).catch(error => {
      if (prepareTimeoutRef.current) window.clearTimeout(prepareTimeoutRef.current);
      setTask(current => ({ ...current, phase: 'failed', error: error.message || '工作流检查失败，请重试。' }));
      setStatus('failed');
    });
  }

  function openPresetLibrary() {
    stopResultCountdown();
    setResultOnly(false);
    setCollapsed(false);
    resizeFloatingWindow(false);
    setView('presets');
  }

  function selectPreset(preset, immediate = false) {
    setActivePreset(preset);
     setPositive(normalizePrompt(preset.positive || INITIAL_PROMPT));
     setNegative(normalizePrompt(preset.negative || INITIAL_NEGATIVE));
    setGenerationControls(presetDefaultControls(preset));
    const presetWorkflow = presetWorkflowName(preset);
    if (presetWorkflow && workflowFiles.includes(presetWorkflow)) selectWorkflow(presetWorkflow);
    setTab('positive');
    setView('quick');
    if (immediate) window.setTimeout(() => startGeneration(preset, preset.positive || INITIAL_PROMPT, preset.negative || INITIAL_NEGATIVE), 0);
  }

  function applyDraggedCard(payload) {
    if (isBusy) return;
    stopResultCountdown();
    setResultOnly(false);
    setCollapsed(false);
    resizeFloatingWindow(false);
    setView('quick');
    const target = payload.kind === 'prompt-card'
      ? tabRef.current
      : 'positive';
    if (payload.kind === 'prompt-card') {
      if (payload.mode === 'replace' && payload.replaceBoth) {
        setPositive(replacePrompt(payload.positive));
        setNegative(replacePrompt(payload.negative));
      } else if (payload.mode === 'replace') {
        if (target === 'negative') setNegative(replacePrompt(payload.content || payload.positive || payload.negative));
        else setPositive(replacePrompt(payload.positive));
      } else if (target === 'negative') {
        setNegative(current => appendPrompt(current, payload.content || payload.negative || payload.positive));
      } else {
        setPositive(current => appendPrompt(current, payload.positive));
      }
    } else {
      setPositive(normalizePrompt(payload.positive || INITIAL_PROMPT));
      setNegative(normalizePrompt(payload.negative || INITIAL_NEGATIVE));
    }
    setStatus('idle');
    setTask(null);
    requestedRef.current = false;
    recoveryTaskRef.current = false;
    if (payload.kind === 'preset-card') {
      const preset = {
        ...payload,
        id: payload.presetId || payload.id || '',
        title: payload.title || '拖入预设',
        parameters: payload.parameters || {},
        nodeOverrides: payload.nodeOverrides || {},
        outputNodeIds: payload.outputNodeIds || null,
      };
      setActivePreset(preset);
      setGenerationControls(presetDefaultControls(preset));
      const presetWorkflow = presetWorkflowName(preset);
      if (presetWorkflow && workflowFiles.includes(presetWorkflow)) selectWorkflow(presetWorkflow);
    } else {
      setActivePreset(null);
    }
    setTab(payload.kind === 'preset-card' ? 'positive' : target);
  }

  function resetPreset(preset) {
    if (!window.confirm(`恢复“${preset.title}”的默认状态？当前修改会被清除。`)) return;
     setPositive(normalizePrompt(preset.positive || INITIAL_PROMPT));
     setNegative(normalizePrompt(preset.negative || INITIAL_NEGATIVE));
    setGenerationControls(presetDefaultControls(preset));
    const presetWorkflow = presetWorkflowName(preset);
    if (presetWorkflow && workflowFiles.includes(presetWorkflow)) selectWorkflow(presetWorkflow);
    setActivePreset(preset);
    setTab('positive');
    setStatus('idle');
    setTask(null);
    requestedRef.current = false;
  }

  function resetGeneration() {
    stopResultCountdown();
    if (prepareTimeoutRef.current) window.clearTimeout(prepareTimeoutRef.current);
    prepareTimeoutRef.current = null;
    if (['preparing', 'confirming', 'running'].includes(status)) void handleCancel();
    else if (cancelPromptPreview) void cancelPromptPreview();
    recoveryTaskRef.current = false;
    setResultOnly(false);
    setTab('positive');
     setPositive(normalizePrompt(INITIAL_PROMPT));
     setNegative(normalizePrompt(INITIAL_NEGATIVE));
    setActivePreset(null);
    setGenerationControls({ settings: {}, nodeOverrides: {}, outputNodeIds: null });
    setStatus('idle');
    setTask(null);
    requestedRef.current = false;
  }

  function collapse() {
    setCollapsed(true);
    resizeFloatingWindow(true);
  }

  function expand() {
    setCollapsed(false);
    resizeFloatingWindow(false);
  }

  function retryGeneration() {
    stopResultCountdown();
    setResultOnly(false);
    startGeneration();
  }

  function editPrompt() {
    stopResultCountdown();
    setResultOnly(false);
    setTab('positive');
  }
  function handleOrbPointerDown(event) {
    if (event.button !== 0) return;
    const token = `orb-${Date.now()}-${event.pointerId}`;
    dragRef.current = { pointerId: event.pointerId, element: event.currentTarget, x: event.clientX, y: event.clientY, moved: false, frame: 0, queuedX: event.clientX, queuedY: event.clientY, token };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
    void window.electronAPI.floatingMoveStart?.(event.clientX, event.clientY, token);
  }

  function cancelOrbDrag() {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.frame) window.cancelAnimationFrame(drag.frame);
    drag.element?.releasePointerCapture?.(drag.pointerId);
    dragRef.current = null;
    void window.electronAPI.floatingMoveEnd?.(drag.token);
  }

  function handleOrbPointerMove(event) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - drag.x;
    const deltaY = event.clientY - drag.y;
    if (Math.abs(deltaX) > 2 || Math.abs(deltaY) > 2) drag.moved = true;
    if (!drag.moved) return;
    drag.x = event.clientX;
    drag.y = event.clientY;
    drag.queuedX = event.clientX;
    drag.queuedY = event.clientY;
    event.preventDefault();
    if (!drag.frame) {
      drag.frame = window.requestAnimationFrame(() => {
        drag.frame = 0;
         void window.electronAPI.floatingMoveAt?.(drag.queuedX, drag.queuedY, drag.token);
      });
    }
  }

  function handleOrbPointerUp(event) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (drag.frame) window.cancelAnimationFrame(drag.frame);
    if (drag.moved) void window.electronAPI.floatingMoveAt?.(event.clientX, event.clientY, drag.token);
    void window.electronAPI.floatingMoveEnd?.(drag.token);
    if (!drag.moved) expand();
  }

  return (
    <>
      <section className={`quick-generate-float${collapsed ? ' collapsed' : ''}${dragReceiving ? ' drag-receiving' : ''}${visible || task ? '' : ' quick-generate-hidden'}`} aria-label="快速生成控制器">
       {dragReceiving && <div className="floating-drag-receive-layer" aria-live="polite"><div className="floating-drag-receive-orb"><Icon name="download" size={22} /><strong>松开以载入卡片</strong><span>内容会载入快速生成</span></div></div>}
      {view === 'presets' ? <FloatingPresetView onBack={() => setView('quick')} onAdjust={preset => selectPreset(preset)} onGenerate={preset => selectPreset(preset, true)} onReset={resetPreset} /> : collapsed ? (
        <button className="quick-generate-orb" type="button" onPointerDown={handleOrbPointerDown} onPointerMove={handleOrbPointerMove} onPointerUp={handleOrbPointerUp} onPointerCancel={handleOrbPointerUp} title="展开快速生成">
          <ProgressRing progress={progress} status={status} indeterminate={indeterminate} />
          <span className="quick-generate-orb-content">{status === 'running' ? (indeterminate ? '...' : `${progress}%`) : <Icon name={status === 'complete' ? 'check' : status === 'failed' ? 'circleAlert' : 'spark'} size={20} />}</span>
        </button>
      ) : (
        <div className={`quick-generate-panel${resultOnly ? ' result-only' : ''}`}>
             <header className="quick-generate-header" onDoubleClick={collapse}>
            <div><span className="section-kicker">{resultOnly ? 'RESULT' : 'QUICK GENERATE'}</span><strong>{resultOnly ? '生成完成' : '快速生成'}</strong></div>
            <div className="quick-generate-header-actions">
               <button type="button" className="quick-generate-main" onClick={openPresetLibrary} title="打开预设卡"><Icon name="spark" size={13} /><span>预设卡</span></button>
               <button type="button" className="quick-generate-main" onClick={() => window.electronAPI.floatingShowMain?.()} title="打开主应用"><Icon name="panelRight" size={13} /><span>主应用</span></button>
              <button type="button" className="quick-generate-collapse" onClick={collapse} title="收起为悬浮球"><Icon name="minimize" size={14} /></button>
              <button type="button" className="quick-generate-close" onClick={() => onClose?.()} title="隐藏悬浮窗"><Icon name="close" size={15} /></button>
            </div>
          </header>

          {!resultOnly && <div className={`quick-generate-status quick-generate-status-${status}`}>
            <span className="quick-generate-status-dot" />
            <div><strong>{statusLabel}</strong><span>{statusDescription}</span></div>
            {status === 'running' && <span className="quick-generate-status-percent">{progress}%</span>}
          </div>}
          {!resultOnly && ['preparing', 'running'].includes(status) && <div className="quick-generate-progress"><span className={indeterminate || status === 'preparing' ? 'indeterminate' : ''} style={indeterminate || status === 'preparing' ? undefined : { width: `${progress}%` }} /></div>}

          {resultOnly && <div className="quick-generate-featured-result">
             {recentImages[0] ? <ImageAsset image={recentImages[0]} onOpen={preview => setPreview({ ...preview, images: recentImages, index: 0 })} /> : <div className="quick-generate-result-empty"><Icon name="images" size={18} /><span>生成结果已完成</span></div>}
             <span className="quick-generate-result-caption">点击结果查看大图 · {resultCountdown}s 后返回提示词</span>
             <span className="quick-generate-result-countdown" style={{ width: `${Math.max(0, Math.min(100, (resultCountdown / (QUICK_RESULT_DISPLAY_MS / 1000)) * 100))}%` }} />
          </div>}

           {resultOnly && <div className="quick-generate-result-actions">
              <button type="button" className="btn" onClick={editPrompt}><Icon name="edit" size={13} />编辑提示词</button>
              <button type="button" className="btn btn-primary" onClick={retryGeneration}><Icon name="refresh" size={13} />再次生成</button>
              <button type="button" className="btn quick-generate-reset" onClick={resetGeneration}><Icon name="trash" size={13} />清空并恢复默认</button>
           </div>}

          {!resultOnly && <div className="quick-prompt-card">
            <div className="quick-prompt-card-heading"><div><span className="section-kicker">PROMPT CARD</span><strong>提示词</strong></div><span>{promptParts.length} 个片段</span></div>
            <div className="quick-prompt-tabs" role="tablist" aria-label="提示词类型">
               <button type="button" className={tab === 'positive' ? 'active' : ''} onClick={() => setTab('positive')} role="tab" aria-selected={tab === 'positive'}><Icon name="plus" size={12} />我想要<span>{normalizePrompt(positive).split(',').filter(item => item.trim()).length}</span></button>
               <button type="button" className={tab === 'negative' ? 'active negative' : ''} onClick={() => setTab('negative')} role="tab" aria-selected={tab === 'negative'}><Icon name="minus" size={12} />我不想要<span>{normalizePrompt(negative).split(',').filter(item => item.trim()).length}</span></button>
            </div>
            <div className="quick-prompt-card-body">
              <PromptChips value={currentValue} onRemove={removePart} />
               <textarea value={currentValue} onChange={event => setCurrentValue(normalizePrompt(event.target.value))} onKeyDown={handlePromptKeyDown} placeholder={tab === 'positive' ? '描述主体、动作、场景和风格...' : '例如：blurry, bad anatomy'} disabled={isBusy} aria-label={tab === 'positive' ? '正向提示词' : '负向提示词'} />
              <span className="quick-prompt-hint">内容会原样用于生成</span>
            </div>
          </div>}

          {!resultOnly && status === 'complete' && <div className="quick-generate-results" aria-label="最近生成结果">
            <div className="quick-generate-results-heading"><span>RESULT</span><small>{recentImages.length ? `${recentImages.length} 个结果` : '生成结果'}</small></div>
             {recentImages.length ? <div className="quick-generate-results-strip">{recentImages.map((image, index) => <ImageAsset key={`${image.filename}-${image.createdAt}`} image={image} compact onOpen={preview => setPreview({ ...preview, images: recentImages, index })} />)}</div> : <div className="quick-generate-result-empty"><Icon name="images" size={15} /><span>结果会显示在这里</span></div>}
          </div>}
          {!resultOnly && <div className="quick-generate-meta">
            <label className="quick-generate-workflow-label" htmlFor="quick-workflow-select"><Icon name="workflow" size={13} /><span>工作流</span></label>
            <select id="quick-workflow-select" className="quick-generate-workflow-select" value={selectedFile} onChange={event => selectWorkflow(event.target.value)} disabled={isBusy || workflowFiles.length === 0} aria-label="选择工作流">
              <option value="">选择工作流</option>
              {workflowFiles.map(file => <option key={file} value={file}>{file}</option>)}
            </select>
            <span title={modelType}>{modelType}</span>
          </div>}
           {!resultOnly && <div className="quick-generate-action-row">
             <button type="button" className={`quick-generate-action${status === 'running' ? ' cancel' : status === 'failed' ? ' retry' : ''}`} onClick={status === 'running' ? resetGeneration : status === 'failed' ? retryGeneration : startGeneration} disabled={!positive.trim() || !workflowReady || isBusy}>
               <Icon name={status === 'running' ? 'stop' : status === 'complete' ? 'refresh' : status === 'failed' ? 'refresh' : 'spark'} size={19} />
               <span>{status === 'running' ? '取消生成' : status === 'complete' ? '再次生成' : status === 'failed' ? '重试生成' : '生成'}</span>
               <small>{status === 'running' || status === 'failed' ? statusDescription : '使用当前工作流'}</small>
             </button>
             {!isBusy && <button type="button" className="btn quick-generate-reset" onClick={resetGeneration} title="清空当前结果并恢复默认提示词"><Icon name="trash" size={13} />清空</button>}
           </div>}
        </div>
      )}
      </section>
      {preview && <AssetPreviewModal preview={preview} onClose={() => setPreview(null)} />}
    </>
  );
}
