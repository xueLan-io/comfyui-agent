import { useCallback, useEffect, useRef, useState } from 'react';
import { ComfyUIProvider, useComfyUI } from './contexts/ComfyUIContext.jsx';
import { AgentProvider, useAgent } from './contexts/AgentContext.jsx';
import { SessionProvider } from './contexts/SessionContext.jsx';
import Header from './components/Header.jsx';
import ChatPanel from './components/ChatPanel.jsx';
import WorkspacePanel from './components/WorkspacePanel.jsx';
import SettingsPanel from './components/SettingsPanel.jsx';
import TraceView from './components/TraceView.jsx';
import ImagePreviewModal from './components/AssetPreviewModal.jsx';
import NodeControlsModal from './components/NodeControlsPanel.jsx';
import ProjectSidebar from './components/ProjectNavigator.jsx';
import PromptPreviewModal from './components/PromptPreviewModal.jsx';
import PolicyConfirmModal from './components/PolicyConfirmModal.jsx';
import AssetLibraryPage from './components/AssetLibraryPage.jsx';
import PromptLibraryPage from './components/PromptLibraryPage.jsx';
import PresetLibraryPage from './components/PresetLibraryPage.jsx';
import BatchWorkspacePage from './components/BatchWorkspacePage.jsx';
import ComfyUISetup from './components/ComfyUISetup.jsx';
import Icon from './components/Icon.jsx';
import QuickGenerateFloat from './components/QuickGenerateFloat.jsx';
import ErrorFeedbackModal from './components/ErrorFeedbackModal.jsx';
import { I18nProvider, useI18n } from './i18n/I18nContext.jsx';

function AppLayout({ floating = false }) {
  const { showNodeControls, setShowNodeControls, workflowManifest, generationControls, setGenerationControls, comfyState } = useComfyUI();
  const { showSettings, setShowSettings, showTrace, setShowTrace, trace, preview, setPreview, promptPreview, confirmPromptPreview, cancelPromptPreview, runLibraryGeneration, recoveryTasks, refreshRecoveryTasks, retryRecoveryTask, archiveRecoveryTask, archiveAllRecoveryTasks, policyConfirm, confirmPolicyOverride, cancelPolicyOverride, errorFeedback, setErrorFeedback, feedbackOpen, setFeedbackOpen } = useAgent();
  const { t } = useI18n();
  const [activeView, setActiveView] = useState('chat');
  const [promptLibraryMounted, setPromptLibraryMounted] = useState(false);
  const [presetLibraryMounted, setPresetLibraryMounted] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  const [recoveryAction, setRecoveryAction] = useState('');
  const pendingLibraryGenerationRef = useRef(null);
  const [recoveryError, setRecoveryError] = useState('');
  const [expandedRecoveryTask, setExpandedRecoveryTask] = useState('');
  const [recoveryPanelOpen, setRecoveryPanelOpen] = useState(false);
  const [appVersion, setAppVersion] = useState('');
  const setupDismissedRef = useRef(false);

  useEffect(() => {
    void window.electronAPI.appVersion?.().then(setAppVersion).catch(() => {});
  }, []);

  useEffect(() => {
    if (comfyState.status === 'error' && !comfyState.portableRoot && !setupDismissedRef.current) {
      setShowSetup(true);
    }
  }, [comfyState]);

  useEffect(() => {
    const handlePresetSaved = event => {
      setPresetLibraryMounted(true);
      setActiveView('presets');
      window.setTimeout(() => window.dispatchEvent(new CustomEvent('comfy-agent:preset-highlight', { detail: event.detail })), 0);
    };
    window.addEventListener('comfy-agent:preset-saved', handlePresetSaved);
    return () => window.removeEventListener('comfy-agent:preset-saved', handlePresetSaved);
  }, []);

  const consumeLibraryGeneration = useCallback(request => {
    if (!request) return;
    pendingLibraryGenerationRef.current = null;
    void runLibraryGeneration(request.text, request.negative, request.options)
      .then(request.resolve, request.reject);
  }, [runLibraryGeneration]);

  const handleChatReady = useCallback(() => {
    consumeLibraryGeneration(pendingLibraryGenerationRef.current);
  }, [consumeLibraryGeneration]);

  useEffect(() => {
    if (activeView === 'chat') consumeLibraryGeneration(pendingLibraryGenerationRef.current);
  }, [activeView, consumeLibraryGeneration]);

  function queueLibraryGeneration(text, negative, options = {}) {
    return new Promise((resolve, reject) => {
      const request = { text, negative, options, resolve, reject };
      pendingLibraryGenerationRef.current = request;
      // Generation is owned by AgentContext, not by the chat view. Keep the
      // workbench visible while the direct request prepares and executes.
      consumeLibraryGeneration(request);
    });
  }

  function openSetup() {
    setShowSetup(true);
  }

  function closeSetup() {
    setupDismissedRef.current = true;
    setShowSetup(false);
  }

  function openPromptLibrary() {
    setPromptLibraryMounted(true);
    setActiveView('prompt-library');
  }

  function openPresetLibrary() {
    setPresetLibraryMounted(true);
    setActiveView('presets');
  }

  function handleViewChange(view) {
    if (view === 'prompt-library') {
      openPromptLibrary();
      return;
    }
    if (view === 'presets') {
      openPresetLibrary();
      return;
    }
    setActiveView(view);
  }

  async function runRecoveryAction(action, callback) {
    if (recoveryAction) return;
    setRecoveryAction(action);
    setRecoveryError('');
    try {
      await callback();
    } catch (error) {
      setRecoveryError(error.message || t('operationFailed'));
    } finally {
      setRecoveryAction('');
    }
  }

  if (floating) {
    return <QuickGenerateFloat visible onClose={() => window.electronAPI.floatingHide?.()} />;
  }

  return (
    <div className="app">
      <div className={`app-main-view${activeView === 'prompt-library' || activeView === 'presets' ? ' view-hidden' : ''}`}>
        <Header onOpenSetup={openSetup} />
        <main className="body">
          <ProjectSidebar activeView={activeView} onViewChange={handleViewChange} onOpenQuickGenerate={() => window.electronAPI.floatingShow?.()} />
          {activeView === 'batch' ? <BatchWorkspacePage onBack={() => setActiveView('chat')} /> : activeView === 'assets' ? <AssetLibraryPage onBack={() => setActiveView('chat')} /> : <ChatPanel active={activeView === 'chat'} onReady={handleChatReady} />}
          {activeView === 'chat' && <WorkspacePanel onOpenPromptLibrary={openPromptLibrary} />}
        </main>
      </div>
      {promptLibraryMounted && (
        <PromptLibraryPage
          hidden={activeView !== 'prompt-library'}
          onBack={() => setActiveView('chat')}
          onGenerate={(text, negative) => queueLibraryGeneration(text, negative, { immediate: true })}
        />
      )}

      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
      {feedbackOpen && errorFeedback && <ErrorFeedbackModal error={errorFeedback} version={appVersion} onClose={() => setFeedbackOpen(false)} />}
      {showSetup && <ComfyUISetup onClose={closeSetup} />}
      {showTrace && <TraceView trace={trace} onClose={() => setShowTrace(false)} />}
      {recoveryTasks.length > 0 && (
         <section className={`recovery-panel${recoveryPanelOpen ? ' open' : ' collapsed'}`} aria-label={t('recoveryTasks')}>
            <div className="recovery-panel-heading"><button className="recovery-panel-toggle" onClick={() => setRecoveryPanelOpen(value => !value)} aria-expanded={recoveryPanelOpen}><Icon name={recoveryPanelOpen ? 'chevronDown' : 'chevronUp'} size={13} /><strong>{t('recoveryNeeded')}</strong><span>{recoveryTasks.length} {t('items')}</span></button>{recoveryPanelOpen && <div className="recovery-panel-actions"><button className="btn btn-icon" onClick={() => void runRecoveryAction('refresh', refreshRecoveryTasks)} disabled={Boolean(recoveryAction)} title={t('refreshRecovery')}><Icon name="refresh" size={13} /></button><button className="btn" onClick={() => { if (window.confirm(t('archiveAllConfirm', { count: recoveryTasks.length }))) void runRecoveryAction('archive-all', archiveAllRecoveryTasks); }} disabled={Boolean(recoveryAction)}>{recoveryAction === 'archive-all' ? t('archiving') : t('archiveAll')}</button></div>}</div>
           {recoveryPanelOpen && <div className="recovery-panel-list">
             {recoveryError && <div className="recovery-feedback error"><Icon name="circleAlert" size={13} />{recoveryError}</div>}
          {recoveryTasks.map(task => (
            <div className="recovery-item" key={task.id}>
               <button className="recovery-item-heading recovery-item-toggle" onClick={() => setExpandedRecoveryTask(value => value === task.id ? '' : task.id)} aria-expanded={expandedRecoveryTask === task.id}>
                <code>{task.taskId || task.id}</code>
                <span>{task.state || task.status}</span>
                 <Icon name={expandedRecoveryTask === task.id ? 'chevronUp' : 'chevronDown'} size={13} />
               </button>
              <div className="recovery-item-details">
                 <span>{t('request')}：{task.request || task.message || t('notRecorded')}</span>
                 {expandedRecoveryTask === task.id && <><span>{t('created')}：{task.createdAt ? new Date(task.createdAt).toLocaleString() : t('unknown')}</span><span>{t('updated')}：{task.updatedAt ? new Date(task.updatedAt).toLocaleString() : t('unknown')}</span><span>requestId：{task.requestId || t('unknown')}</span><span>traceId：{task.traceId || t('unknown')}</span><span>promptId：{task.promptId || task.attempts?.find(attempt => attempt.promptId)?.promptId || t('unknown')}</span><span>{t('attempts')}：{task.attempts?.length || 0}</span></>}
                 {(task.error || task.lastError) && <span>{t('error')}：{task.error?.message || task.error || task.lastError}</span>}
              </div>
              <div className="recovery-item-actions">
                 <button className="btn" onClick={() => void runRecoveryAction(task.id, () => retryRecoveryTask(task.id))} disabled={Boolean(recoveryAction)}>{recoveryAction === task.id ? t('processing') : t('continueWatching')}</button>
                 <button className="btn btn-danger" onClick={() => void runRecoveryAction(`archive:${task.id}`, () => archiveRecoveryTask(task.id))} disabled={Boolean(recoveryAction)}>{recoveryAction === `archive:${task.id}` ? t('archiving') : t('archive')}</button>
              </div>
            </div>
           ))}
           </div>}
         </section>
      )}
       {presetLibraryMounted && <PresetLibraryPage hidden={activeView !== 'presets'} onBack={() => setActiveView('chat')} onReuse={(preset, immediate, overrides = {}) => queueLibraryGeneration(preset.positive, preset.negative, { immediate, preset, overrides })} />}
      {preview && <ImagePreviewModal preview={preview} onClose={() => setPreview(null)} />}
      {promptPreview && !promptPreview.quickGenerate && <PromptPreviewModal preview={promptPreview} onConfirm={confirmPromptPreview} onCancel={cancelPromptPreview} />}
      {policyConfirm && <PolicyConfirmModal pending={policyConfirm} onConfirm={confirmPolicyOverride} onCancel={cancelPolicyOverride} />}
      {showNodeControls && workflowManifest && (
        <NodeControlsModal
          manifest={workflowManifest}
          controls={generationControls}
          onChange={setGenerationControls}
          onClose={() => setShowNodeControls(false)}
        />
      )}
    </div>
  );
}

export default function App({ floating = false }) {
  return (
    <I18nProvider><SessionProvider><ComfyUIProvider floating={floating}><AgentProvider><AppLayout floating={floating} /></AgentProvider></ComfyUIProvider></SessionProvider></I18nProvider>
  );
}
