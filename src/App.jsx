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
import AssetLibraryPage from './components/AssetLibraryPage.jsx';
import PromptLibraryPage from './components/PromptLibraryPage.jsx';
import ComfyUISetup from './components/ComfyUISetup.jsx';

function AppLayout() {
  const { showNodeControls, setShowNodeControls, workflowManifest, generationControls, setGenerationControls, comfyState } = useComfyUI();
  const { showSettings, setShowSettings, showTrace, setShowTrace, trace, preview, setPreview, promptPreview, confirmPromptPreview, cancelPromptPreview, runLibraryGeneration, recoveryTasks, retryRecoveryTask } = useAgent();
  const [activeView, setActiveView] = useState('chat');
  const [promptLibraryMounted, setPromptLibraryMounted] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
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
          <strong>需要恢复的任务</strong>
          {recoveryTasks.map(task => (
            <div className="recovery-item" key={task.id}>
              <code>{task.taskId || task.id}</code>
              <span>{task.state || task.status}</span>
              <button className="btn" onClick={() => retryRecoveryTask(task.id)}>继续观察 / 归档</button>
            </div>
          ))}
        </section>
      )}
      {preview && <ImagePreviewModal preview={preview} onClose={() => setPreview(null)} />}
      {promptPreview && <PromptPreviewModal preview={promptPreview} onConfirm={confirmPromptPreview} onCancel={cancelPromptPreview} />}
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
