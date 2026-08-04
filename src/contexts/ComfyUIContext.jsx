import { createContext, useCallback, useContext, useEffect, useState } from 'react';

const ComfyUIContext = createContext(null);

function defaultWorkflow(files = []) {
  return files.slice().sort((a, b) => {
    const score = file => {
      let value = 0;
      if (/txt2img\.json$/i.test(file)) value += 50;
      if (/optimized|\u4f18\u5316\u7248/i.test(file)) value += 20;
      if (/backup|\u6d4b\u8bd5|\u65e7\u7248/i.test(file)) value -= 20;
      return value;
    };
    return score(b) - score(a) || a.localeCompare(b);
  })[0] || '';
}

export function useComfyUI() {
  return useContext(ComfyUIContext);
}

export function ComfyUIProvider({ children }) {
  const [comfyState, setComfyState] = useState({ status: 'checking', message: '正在检测 ComfyUI...' });
  const [workflowDir, setWorkflowDir] = useState('');
  const [workflowFiles, setWorkflowFiles] = useState([]);
  const [selectedFile, setSelectedFile] = useState('');
  const [workflowManifest, setWorkflowManifest] = useState(null);
  const [generationControls, setGenerationControls] = useState({ settings: {}, nodeOverrides: {}, outputNodeIds: null });
  const [showNodeControls, setShowNodeControls] = useState(false);

  const connected = comfyState.status === 'ready';

  useEffect(() => {
    window.electronAPI.listWorkflows().then(result => {
      if (!result) return;
      setWorkflowDir(result.displayDir || result.dir);
      setWorkflowFiles(result.files);
      setSelectedFile(previous => previous || defaultWorkflow(result.files));
    });
  }, []);

  useEffect(() => {
    let active = true;
    let timer;

    const refreshComfyState = async () => {
      try {
        const nextState = await window.electronAPI.comfyUIStatus();
        if (active) setComfyState(nextState);
      } catch {
        // Keep the last known state while the Electron main process is restarting.
      } finally {
        if (active) timer = setTimeout(refreshComfyState, 2000);
      }
    };

    void refreshComfyState();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    return window.electronAPI.onComfyUIStatus(setComfyState);
  }, []);

  useEffect(() => {
    let active = true;
    setWorkflowManifest(null);
    setGenerationControls({ settings: {}, nodeOverrides: {}, outputNodeIds: null });
    if (!connected || !selectedFile) return () => { active = false; };

    window.electronAPI.agentInspectWorkflow(selectedFile)
      .then(manifest => {
        if (active) setWorkflowManifest(manifest);
      })
      .catch(() => {});
    return () => { active = false; };
  }, [connected, selectedFile, workflowDir]);

  useEffect(() => {
    if (selectedFile) void window.electronAPI.projectUpdateState({ workflow: selectedFile });
  }, [selectedFile]);

  const handleShowWorkflowDir = useCallback(async () => {
    await window.electronAPI.showWorkflowDir(selectedFile);
  }, [selectedFile]);

  const handleStartComfyUI = useCallback(async () => {
    setComfyState(previous => ({ ...previous, status: 'starting', message: '正在启动本地 ComfyUI...' }));
    const nextState = await window.electronAPI.comfyUIStart();
    setComfyState(nextState);
  }, []);

  const refreshWorkflows = useCallback(async () => {
    const result = await window.electronAPI.listWorkflows();
    if (!result) return;
    setWorkflowDir(result.displayDir || result.dir);
    setWorkflowFiles(result.files);
    setSelectedFile(previous => previous || defaultWorkflow(result.files));
  }, []);

  const value = {
    comfyState,
    connected,
    workflowDir,
    workflowFiles,
    selectedFile,
    setSelectedFile,
    workflowManifest,
    generationControls,
    setGenerationControls,
    showNodeControls,
    setShowNodeControls,
    handleShowWorkflowDir,
    handleStartComfyUI,
    refreshWorkflows,
  };

  return <ComfyUIContext.Provider value={value}>{children}</ComfyUIContext.Provider>;
}
