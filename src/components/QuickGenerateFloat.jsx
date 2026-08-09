import { useEffect, useMemo, useRef, useState } from 'react';
import { useAgent } from '../contexts/AgentContext.jsx';
import { useComfyUI } from '../contexts/ComfyUIContext.jsx';
import ImageAsset from './ImageAsset.jsx';
import AssetPreviewModal from './AssetPreviewModal.jsx';
import Icon from './Icon.jsx';
import FloatingPresetView from './FloatingPresetView.jsx';
import { presetDefaultControls, presetWorkflowName } from '../runtime/preset-generation.mjs';
import H3VideoPanel from './H3VideoPanel.jsx';
import { isMiniMaxH3Workflow } from './h3-video-controls.mjs';
import { useI18n } from '../i18n/I18nContext.jsx';

const INITIAL_PROMPT = '';
const INITIAL_NEGATIVE = '';
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
  const { t } = useI18n();
  const parts = normalizePrompt(value).split(',').map(item => item.trim()).filter(Boolean);
  if (!parts.length) return <span className="quick-prompt-empty">{t('floatNoPromptParts')}</span>;
  return <div className="quick-prompt-chips">{parts.map((part, index) => <span className="quick-prompt-chip" key={`${part}-${index}`}><span>{part}</span><button type="button" onClick={() => onRemove(index)} aria-label={t('floatRemovePart', { part })}><Icon name="close" size={10} /></button></span>)}</div>;
}

export default function QuickGenerateFloat({ onClose, visible = true }) {
  const { t } = useI18n();
  const { generationProgress, generationPending, generationResult, status: agentStatus, statusMsg, preview, sendQuickGeneration, runLibraryGeneration, handleCancel, setPreview } = useAgent();
  const { selectedFile, selectWorkflow, workflowFiles, workflowManifest, setGenerationControls } = useComfyUI();
  const [collapsed, setCollapsed] = useState(false);
  const [tab, setTab] = useState('positive');
  const [positive, setPositive] = useState(INITIAL_PROMPT);
  const [negative, setNegative] = useState(INITIAL_NEGATIVE);
  const [resultOnly, setResultOnly] = useState(false);
  const dragRef = useRef(null);
  const tabRef = useRef(tab);
  const resultTimerRef = useRef(null);
  const resultDeadlineRef = useRef(null);
  const resultRemainingRef = useRef(0);
  const resultWasCollapsedRef = useRef(false);
  const [resultCountdown, setResultCountdown] = useState(0);
  const [view, setView] = useState('quick');
  const [generationPage, setGenerationPage] = useState('image');
  const [activePreset, setActivePreset] = useState(null);
  const [dragReceiving, setDragReceiving] = useState(false);
  const [h3Readiness, setH3Readiness] = useState(null);
  const incomingDragRef = useRef(null);
  const status = agentStatus === 'completed' ? 'complete' : agentStatus === 'error' || agentStatus === 'failed' ? 'failed' : agentStatus === 'preview' ? 'confirming' : agentStatus || 'idle';
  const isBusy = generationPending || ['preparing', 'confirming', 'running'].includes(status);
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

    useEffect(() => () => cancelOrbDrag(), []);

  const currentValue = tab === 'positive' ? positive : negative;
  const setCurrentValue = tab === 'positive' ? setPositive : setNegative;
   const promptParts = useMemo(() => normalizePrompt(currentValue).split(',').map(item => item.trim()).filter(Boolean), [currentValue]);
  const statusLabel = { idle: 'READY', preparing: 'PREPARING', confirming: 'READY TO RUN', running: 'GENERATING', complete: 'COMPLETE', failed: 'FAILED' }[status];
   const progressEvent = generationProgress || null;
  const progress = Number.isFinite(progressEvent?.overallPercent) ? progressEvent.overallPercent : Number(progressEvent?.percent || 0);
  const indeterminate = progressEvent?.indeterminate === true;
   const statusDescription = { idle: t('floatStatusIdle'), preparing: t('floatStatusPreparing'), confirming: t('floatStatusConfirming'), running: progressEvent?.percentScope === 'node' ? t('floatCurrentNode', { node: progressEvent.message || progressEvent.node || t('floatStatusRunning') }) : progressEvent?.message || t('floatGenerating', { progress }), complete: t('floatStatusComplete'), failed: statusMsg || t('floatStatusFailed') }[status];
   const recentImages = (generationResult?.media || []).slice(0, 4);
   const workflowName = workflowManifest?.workflowName || selectedFile || t('floatNoWorkflowSelected');
  const modelType = workflowManifest?.modelType || workflowManifest?.promptProfile?.family || 'generic';
   // The backend performs the authoritative workflow existence/preflight check.
   // Do not block the button on a stale floating-window file list.
   const workflowReady = Boolean(selectedFile);
   const h3Selected = isMiniMaxH3Workflow(workflowManifest) || /minimax|mini.?max|h3/i.test(`${selectedFile} ${workflowManifest?.workflowName || ''}`);
   const videoPage = generationPage === 'video';
   const generationReady = workflowReady && (!videoPage || (h3Selected && h3Readiness?.ready === true));

  function selectGenerationPage(page) {
    setGenerationPage(page);
  }

  useEffect(() => {
    setGenerationPage(isMiniMaxH3Workflow(workflowManifest) ? 'video' : 'image');
  }, [workflowManifest]);

  function handlePromptKeyDown(event) {
    if (!(event.ctrlKey || event.metaKey) || event.key !== 'Enter' || isBusy || !positive.trim()) return;
    event.preventDefault();
    startGeneration();
  }

  function removePart(index) {
     setCurrentValue(promptParts.filter((_, itemIndex) => itemIndex !== index).join(', '));
  }

  function startGeneration(preset = activePreset, positiveOverride = '', negativeOverride = '', forceNewSeed = false) {
    const generationPositive = positiveOverride || positive;
    const generationNegative = negativeOverride || negative;
    const upscaleOnly = workflowManifest?.modes?.includes?.('upscale') || /upscale|放大|超分/i.test(`${selectedFile} ${workflowManifest?.workflowName || ''}`);
    if ((!upscaleOnly && !generationPositive.trim()) || !generationReady || isBusy) return;
    setResultOnly(false);
    collapse();
    // 再次生成必须换 seed，否则复用工作流默认种子会得到相同图片。
    const seedControls = forceNewSeed
      ? { ...generationControls, settings: { ...(generationControls.settings || {}), seed: Math.floor(Math.random() * 0xFFFFFFFF) } }
      : null;
    const generationPreset = preset ? { ...preset, positive: generationPositive.trim(), negative: generationNegative.trim() } : null;
    void (generationPreset
      ? runLibraryGeneration(generationPositive.trim(), generationNegative.trim(), { immediate: true, preset: generationPreset, controls: seedControls })
      : sendQuickGeneration(generationPositive.trim(), { negative: generationNegative.trim(), workflowName: selectedFile, controls: seedControls }))
      .catch(() => {});
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
    if (!window.confirm(t('floatConfirmResetPreset', { title: preset.title }))) return;
     setPositive(normalizePrompt(preset.positive || INITIAL_PROMPT));
     setNegative(normalizePrompt(preset.negative || INITIAL_NEGATIVE));
    setGenerationControls(presetDefaultControls(preset));
    const presetWorkflow = presetWorkflowName(preset);
    if (presetWorkflow && workflowFiles.includes(presetWorkflow)) selectWorkflow(presetWorkflow);
    setActivePreset(preset);
    setTab('positive');
  }

  function resetGeneration() {
    stopResultCountdown();
     if (isBusy) void handleCancel().catch(() => {});
    setResultOnly(false);
    setTab('positive');
     setPositive(normalizePrompt(INITIAL_PROMPT));
     setNegative(normalizePrompt(INITIAL_NEGATIVE));
    setActivePreset(null);
    setGenerationControls({ settings: {}, nodeOverrides: {}, outputNodeIds: null });
  }

  function collapse() {
    setCollapsed(true);
    resizeFloatingWindow(true);
  }

  function expand() {
    setCollapsed(false);
    resizeFloatingWindow(false);
  }

  async function retryGeneration() {
    stopResultCountdown();
    setResultOnly(false);
    startGeneration(activePreset, '', '', true);
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
      <section className={`quick-generate-float${collapsed ? ' collapsed' : ''}${dragReceiving ? ' drag-receiving' : ''}${visible ? '' : ' quick-generate-hidden'}`} aria-label={t('floatController')}>
       {dragReceiving && <div className="floating-drag-receive-layer" aria-live="polite"><div className="floating-drag-receive-orb"><Icon name="download" size={22} /><strong>{t('floatReleaseToLoad')}</strong><span>{t('floatReleaseHint')}</span></div></div>}
      {view === 'presets' ? <FloatingPresetView onBack={() => setView('quick')} onAdjust={preset => selectPreset(preset)} onGenerate={preset => selectPreset(preset, true)} onReset={resetPreset} /> : collapsed ? (
        <button className="quick-generate-orb" type="button" onPointerDown={handleOrbPointerDown} onPointerMove={handleOrbPointerMove} onPointerUp={handleOrbPointerUp} onPointerCancel={handleOrbPointerUp} title={t('floatExpand')}>
          <ProgressRing progress={progress} status={status} indeterminate={indeterminate} />
          <span className="quick-generate-orb-content">{status === 'running' ? (indeterminate ? '...' : `${progress}%`) : <Icon name={status === 'complete' ? 'check' : status === 'failed' ? 'circleAlert' : 'spark'} size={20} />}</span>
        </button>
      ) : (
        <div className={`quick-generate-panel${resultOnly ? ' result-only' : ''}`}>
             <header className="quick-generate-header" onDoubleClick={collapse}>
            <div><span className="section-kicker">{resultOnly ? 'RESULT' : 'QUICK GENERATE'}</span><strong>{resultOnly ? t('floatResultTitle') : t('floatQuickGenerate')}</strong></div>
            <div className="quick-generate-header-actions">
               <button type="button" className="quick-generate-main" onClick={openPresetLibrary} title={t('floatOpenPresets')}><Icon name="spark" size={13} /><span>{t('floatPresetCards')}</span></button>
               <button type="button" className="quick-generate-main" onClick={() => window.electronAPI.floatingShowMain?.()} title={t('floatOpenMain')}><Icon name="panelRight" size={13} /><span>{t('floatMainApp')}</span></button>
              <button type="button" className="quick-generate-collapse" onClick={collapse} title={t('floatCollapseOrb')}><Icon name="minimize" size={14} /></button>
              <button type="button" className="quick-generate-close" onClick={() => onClose?.()} title={t('floatHideWindow')}><Icon name="close" size={15} /></button>
            </div>
          </header>

          {!resultOnly && <div className={`quick-generate-status quick-generate-status-${status}`}>
            <span className="quick-generate-status-dot" />
            <div><strong>{statusLabel}</strong><span>{statusDescription}</span></div>
            {status === 'running' && <span className="quick-generate-status-percent">{progress}%</span>}
           </div>}
           {!resultOnly && ['preparing', 'running'].includes(status) && <div className="quick-generate-progress"><span className={indeterminate || status === 'preparing' ? 'indeterminate' : ''} style={indeterminate || status === 'preparing' ? undefined : { width: `${progress}%` }} /></div>}

          {resultOnly && <div className="quick-generate-featured-result">
             {recentImages[0] ? <ImageAsset image={recentImages[0]} onOpen={preview => setPreview({ ...preview, images: recentImages, index: 0 })} /> : <div className="quick-generate-result-empty"><Icon name="images" size={18} /><span>{t('floatResultEmpty')}</span></div>}
             <span className="quick-generate-result-caption">{t('floatResultCaption', { n: resultCountdown })}</span>
             <span className="quick-generate-result-countdown" style={{ width: `${Math.max(0, Math.min(100, (resultCountdown / (QUICK_RESULT_DISPLAY_MS / 1000)) * 100))}%` }} />
           </div>}

           {resultOnly && <div className="quick-generate-result-actions">
              <button type="button" className="btn" onClick={editPrompt}><Icon name="edit" size={13} />{t('floatEditPrompt')}</button>
              <button type="button" className="btn btn-primary" onClick={retryGeneration}><Icon name="refresh" size={13} />{t('floatGenerateAgain')}</button>
              <button type="button" className="btn quick-generate-reset" onClick={resetGeneration}><Icon name="trash" size={13} />{t('floatClearReset')}</button>
           </div>}

           {!resultOnly && <div className="quick-generate-pages" role="tablist" aria-label={t('floatGenerationType')}>
             <button type="button" className={!videoPage ? 'active' : ''} onClick={() => selectGenerationPage('image')} role="tab" aria-selected={!videoPage}><Icon name="images" size={13} />{t('floatTextToImage')}</button>
             <button type="button" className={videoPage ? 'active video' : ''} onClick={() => selectGenerationPage('video')} role="tab" aria-selected={videoPage} title={t('floatChooseH3First')}><Icon name="play" size={13} />{t('floatVideoGeneration')}</button>
           </div>}

           {!resultOnly && <div className={`quick-generation-editor${videoPage ? ' video' : ''}`}>
             <div className="quick-prompt-card">
             <div className="quick-prompt-card-heading"><div><span className="section-kicker">PROMPT CARD</span><strong>{t('floatPromptCard')}</strong></div><span>{t('floatPromptParts', { n: promptParts.length })}</span></div>
            <div className="quick-prompt-tabs" role="tablist" aria-label={t('floatPromptType')}>
               <button type="button" className={tab === 'positive' ? 'active' : ''} onClick={() => setTab('positive')} role="tab" aria-selected={tab === 'positive'}><Icon name="plus" size={12} />{t('floatIWant')}<span>{normalizePrompt(positive).split(',').filter(item => item.trim()).length}</span></button>
               <button type="button" className={tab === 'negative' ? 'active negative' : ''} onClick={() => setTab('negative')} role="tab" aria-selected={tab === 'negative'}><Icon name="minus" size={12} />{t('floatIDontWant')}<span>{normalizePrompt(negative).split(',').filter(item => item.trim()).length}</span></button>
            </div>
            <div className="quick-prompt-card-body">
              <PromptChips value={currentValue} onRemove={removePart} />
               <textarea value={currentValue} onChange={event => setCurrentValue(normalizePrompt(event.target.value))} onKeyDown={handlePromptKeyDown} placeholder={tab === 'positive' ? t('floatPositivePlaceholder') : t('floatNegativePlaceholder')} disabled={isBusy} aria-label={tab === 'positive' ? t('floatPresetPositive') : t('floatPresetNegative')} />
              <span className="quick-prompt-hint">{t('floatVerbatimHint')}</span>
             </div>
             </div>
             {videoPage && <H3VideoPanel onApply={setGenerationControls} onReadinessChange={setH3Readiness} workflowSelected={h3Selected} />}
           </div>}

          {!resultOnly && status === 'complete' && <div className="quick-generate-results" aria-label={t('floatRecentResults')}>
            <div className="quick-generate-results-heading"><span>RESULT</span><small>{recentImages.length ? `${recentImages.length} ${t('floatRecentResults')}` : t('floatResultsHeading')}</small></div>
             {recentImages.length ? <div className="quick-generate-results-strip">{recentImages.map((image, index) => <ImageAsset key={`${image.filename}-${image.createdAt}`} image={image} compact onOpen={preview => setPreview({ ...preview, images: recentImages, index })} />)}</div> : <div className="quick-generate-result-empty"><Icon name="images" size={15} /><span>{t('floatResultsEmpty')}</span></div>}
          </div>}
            {!resultOnly && <div className="quick-generate-meta">
            <label className="quick-generate-workflow-label" htmlFor="quick-workflow-select"><Icon name="workflow" size={13} /><span>{t('floatWorkflow')}</span></label>
              <select id="quick-workflow-select" className="quick-generate-workflow-select" value={selectedFile} onChange={event => selectWorkflow(event.target.value)} disabled={isBusy || workflowFiles.length === 0} aria-label={t('floatChooseWorkflow')}>
              <option value="">{t('floatChooseWorkflow')}</option>
              {workflowFiles.map(file => <option key={file} value={file}>{file}</option>)}
            </select>
             <span title={modelType}>{modelType}</span>
           </div>}
            {!resultOnly && <div className="quick-generate-action-row">
              <button type="button" className={`quick-generate-action${status === 'running' ? ' cancel' : status === 'failed' ? ' retry' : ''}`} onClick={status === 'running' ? resetGeneration : status === 'failed' ? retryGeneration : startGeneration} disabled={status === 'running' ? false : !positive.trim() || !generationReady || isBusy}>
               <Icon name={status === 'running' ? 'stop' : status === 'complete' ? 'refresh' : status === 'failed' ? 'refresh' : 'spark'} size={19} />
               <span>{status === 'running' ? t('floatCancelGeneration') : status === 'complete' ? t('floatGenerateAgain') : status === 'failed' ? t('floatRetryGeneration') : t('floatGenerate')}</span>
                <small>{status === 'running' || status === 'failed' ? statusDescription : videoPage && !h3Selected ? t('floatChooseH3First') : videoPage && !h3Readiness?.ready ? h3Readiness?.message || t('floatCheckingH3') : t('floatUseCurrentWorkflow')}</small>
             </button>
             {!isBusy && <button type="button" className="btn quick-generate-reset" onClick={resetGeneration} title={t('floatClearReset')}><Icon name="trash" size={13} />{t('floatClear')}</button>}
           </div>}
        </div>
      )}
      </section>
      {preview && <AssetPreviewModal preview={preview} onClose={() => setPreview(null)} />}
    </>
  );
}
