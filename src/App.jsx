import { useEffect, useRef, useState } from 'react';
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
import ComfyUISetup from './components/ComfyUISetup.jsx';
import Icon from './components/Icon.jsx';

function AppLayout() {
  const { showNodeControls, setShowNodeControls, workflowManifest, generationControls, setGenerationControls, comfyState } = useComfyUI();
  const { showSettings, setShowSettings, showTrace, setShowTrace, trace, preview, setPreview, promptPreview, confirmPromptPreview, cancelPromptPreview, runLibraryGeneration, recoveryTasks, refreshRecoveryTasks, retryRecoveryTask, archiveRecoveryTask, archiveAllRecoveryTasks, policyConfirm, confirmPolicyOverride, cancelPolicyOverride } = useAgent();
  const [activeView, setActiveView] = useState('chat');
  const [promptLibraryMounted, setPromptLibraryMounted] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  const [recoveryAction, setRecoveryAction] = useState('');
  const [recoveryError, setRecoveryError] = useState('');
  const [expandedRecoveryTask, setExpandedRecoveryTask] = useState('');
  const setupDismissedRef = useRef(false);

  useEffect(() => {
    if (comfyState.status === 'error' && !comfyState.portableRoot && !setupDismissedRef.current) {
      setShowSetup(true);
    }
  }, [comfyState]);

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

  function handleViewChange(view) {
    if (view === 'prompt-library') {
      openPromptLibrary();
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
      setRecoveryError(error.message || '恢复任务操作失败');
    } finally {
      setRecoveryAction('');
    }
  }

  return (
    <div className="app">
      <div className={`app-main-view${activeView === 'prompt-library' ? ' view-hidden' : ''}`}>
        <Header onOpenSetup={openSetup} />
        <main className="body">
          <ProjectSidebar activeView={activeView} onViewChange={handleViewChange} />
          {activeView === 'assets' ? <AssetLibraryPage onBack={() => setActiveView('chat')} /> : <ChatPanel />}
          {activeView === 'chat' && <WorkspacePanel onOpenPromptLibrary={openPromptLibrary} />}
        </main>
      </div>
      {promptLibraryMounted && (
        <PromptLibraryPage
          hidden={activeView !== 'prompt-library'}
          onBack={() => setActiveView('chat')}
          onGenerate={(text, negative) => { setActiveView('chat'); return runLibraryGeneration(text, negative); }}
        />
      )}

      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
      {showSetup && <ComfyUISetup onClose={closeSetup} />}
      {showTrace && <TraceView trace={trace} onClose={() => setShowTrace(false)} />}
      {recoveryTasks.length > 0 && (
        <section className="recovery-panel" aria-label="可恢复任务">
           <div className="recovery-panel-heading"><strong>需要恢复的任务</strong><span>{recoveryTasks.length} 项</span><div className="recovery-panel-actions"><button className="btn btn-icon" onClick={() => void runRecoveryAction('refresh', refreshRecoveryTasks)} disabled={Boolean(recoveryAction)} title="刷新恢复任务"><Icon name="refresh" size={13} /></button><button className="btn" onClick={() => { if (window.confirm(`归档全部 ${recoveryTasks.length} 项恢复任务？`)) void runRecoveryAction('archive-all', archiveAllRecoveryTasks); }} disabled={Boolean(recoveryAction)}>{recoveryAction === 'archive-all' ? '归档中...' : '全部归档'}</button></div></div>
           {recoveryError && <div className="recovery-feedback error"><Icon name="circleAlert" size={13} />{recoveryError}</div>}
          {recoveryTasks.map(task => (
            <div className="recovery-item" key={task.id}>
               <button className="recovery-item-heading recovery-item-toggle" onClick={() => setExpandedRecoveryTask(value => value === task.id ? '' : task.id)} aria-expanded={expandedRecoveryTask === task.id}>
                <code>{task.taskId || task.id}</code>
                <span>{task.state || task.status}</span>
                 <Icon name={expandedRecoveryTask === task.id ? 'chevronUp' : 'chevronDown'} size={13} />
               </button>
              <div className="recovery-item-details">
                <span>请求：{task.request || task.message || '未记录'}</span>
                {expandedRecoveryTask === task.id && <><span>创建：{task.createdAt ? new Date(task.createdAt).toLocaleString() : '未知'}</span><span>更新：{task.updatedAt ? new Date(task.updatedAt).toLocaleString() : '未知'}</span><span>requestId：{task.requestId || '未知'}</span><span>traceId：{task.traceId || '未知'}</span><span>promptId：{task.promptId || task.attempts?.find(attempt => attempt.promptId)?.promptId || '未知'}</span><span>尝试次数：{task.attempts?.length || 0}</span></>}
                {(task.error || task.lastError) && <span>错误：{task.error?.message || task.error || task.lastError}</span>}
              </div>
              <div className="recovery-item-actions">
                <button className="btn" onClick={() => void runRecoveryAction(task.id, () => retryRecoveryTask(task.id))} disabled={Boolean(recoveryAction)}>{recoveryAction === task.id ? '处理中...' : '继续观察'}</button>
                <button className="btn btn-danger" onClick={() => void runRecoveryAction(`archive:${task.id}`, () => archiveRecoveryTask(task.id))} disabled={Boolean(recoveryAction)}>{recoveryAction === `archive:${task.id}` ? '归档中...' : '归档'}</button>
              </div>
            </div>
          ))}
        </section>
      )}
      {preview && <ImagePreviewModal preview={preview} onClose={() => setPreview(null)} />}
      {promptPreview && <PromptPreviewModal preview={promptPreview} onConfirm={confirmPromptPreview} onCancel={cancelPromptPreview} />}
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

export default function App() {
  return (
    <ComfyUIProvider>
      <SessionProvider>
        <AgentProvider>
          <AppLayout />
        </AgentProvider>
      </SessionProvider>
    </ComfyUIProvider>
  );
}
