import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useSession } from './SessionContext.jsx';

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

export function ComfyUIProvider({ children, floating = false }) {
  const { project } = useSession();
  const [comfyState, setComfyState] = useState({ status: 'checking', message: '正在检测 ComfyUI...' });
  const [workflowDir, setWorkflowDir] = useState('');
  const [workflowFiles, setWorkflowFiles] = useState([]);
  const [selectedFile, setSelectedFile] = useState('');
  const [workflowManifest, setWorkflowManifest] = useState(null);
  const [inspectingWorkflow, setInspectingWorkflow] = useState(false);
  const [generationControls, setGenerationControlsState] = useState(() => project?.generationControls || { settings: {}, nodeOverrides: {}, outputNodeIds: null });
  const [showNodeControls, setShowNodeControls] = useState(false);
  const inspectedWorkflowRef = useRef('');
  const inspectVersionRef = useRef(0);
  const [favoriteWorkflows, setFavoriteWorkflows] = useState(() => {
    try { return JSON.parse(window.localStorage.getItem('comfyui-agent.favorite-workflows') || '[]'); } catch { return []; }
  });
  const [recentWorkflows, setRecentWorkflows] = useState(() => {
    try { return JSON.parse(window.localStorage.getItem('comfyui-agent.recent-workflows') || '[]'); } catch { return []; }
  });

  const connected = comfyState.status === 'ready';

  const setGenerationControls = useCallback(next => {
    setGenerationControlsState(previous => {
      const value = typeof next === 'function' ? next(previous) : next;
      void window.electronAPI.projectUpdateState({ generationControls: value }).catch(() => {});
      return value;
    });
  }, []);

  useEffect(() => {
    if (project?.generationControls) setGenerationControlsState(project.generationControls);
  }, [project?.generationControls]);

  useEffect(() => {
    window.localStorage.setItem('comfyui-agent.favorite-workflows', JSON.stringify(favoriteWorkflows));
  }, [favoriteWorkflows]);

  useEffect(() => {
    window.localStorage.setItem('comfyui-agent.recent-workflows', JSON.stringify(recentWorkflows));
  }, [recentWorkflows]);

  const selectWorkflow = useCallback(name => {
    setSelectedFile(name);
    if (name) setRecentWorkflows(previous => [name, ...previous.filter(item => item !== name)].slice(0, 8));
  }, []);

  const toggleFavoriteWorkflow = useCallback(name => {
    if (!name) return;
    setFavoriteWorkflows(previous => previous.includes(name) ? previous.filter(item => item !== name) : [...previous, name]);
  }, []);

  useEffect(() => {
    window.electronAPI.listWorkflows().then(result => {
      if (!result) return;
      setWorkflowDir(result.displayDir || result.dir);
      setWorkflowFiles(result.files);
      setSelectedFile(previous => {
        if (previous && result.files.includes(previous)) return previous;
        if (project?.workflow && result.files.includes(project.workflow)) return project.workflow;
        return defaultWorkflow(result.files);
      });
    }).catch(() => {});
  }, [project?.workflow]);

  useEffect(() => {
    const workflow = project?.workflow || '';
    if (!workflow || !workflowFiles.includes(workflow)) return;
    setSelectedFile(previous => previous === workflow ? previous : workflow);
  }, [project?.workflow, workflowFiles]);


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
    if (!connected) inspectedWorkflowRef.current = '';
  }, [connected]);

  useEffect(() => {
    let active = true;
    const inspectVersion = ++inspectVersionRef.current;
    if (!connected || !selectedFile) return () => { active = false; };

    const inspectKey = `${workflowDir}\u0000${selectedFile}`;
    if (inspectedWorkflowRef.current === inspectKey) return () => { active = false; };
    inspectedWorkflowRef.current = inspectKey;
    setInspectingWorkflow(true);

    if (workflowFiles.length > 0 && !workflowFiles.includes(selectedFile)) {
      setWorkflowManifest({ workflowName: selectedFile, missing: true, error: '工作流不存在' });
      setInspectingWorkflow(false);
      return () => { active = false; };
    }

    window.electronAPI.agentInspectWorkflow(selectedFile)
      .then(manifest => {
        if (active && inspectVersion === inspectVersionRef.current) {
          setWorkflowManifest(manifest || { workflowName: selectedFile, error: '工作流检查失败' });
          setInspectingWorkflow(false);
        }
      })
      .catch(error => {
        if (active && inspectVersion === inspectVersionRef.current) {
          setWorkflowManifest({ workflowName: selectedFile, error: error.message || '工作流检查失败' });
          setInspectingWorkflow(false);
        }
      });
    return () => { active = false; };
  }, [connected, selectedFile, workflowDir]);

  useEffect(() => {
    if (selectedFile) void window.electronAPI.projectUpdateState({ workflow: selectedFile }).catch(() => {});
  }, [floating, selectedFile]);

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

  const importWorkflows = useCallback(async (paths) => {
    const result = await window.electronAPI.importWorkflows(paths);
    if (!result) return { results: [], files: [] };
    setWorkflowDir(result.displayDir || result.dir);
    setWorkflowFiles(result.files);
    if (result.imported && result.imported.length > 0) setSelectedFile(result.imported[0]);
    return result;
  }, []);

  const applyWorkflowList = useCallback((result) => {
    if (!result) return null;
    setWorkflowDir(result.displayDir || result.dir);
    setWorkflowFiles(result.files);
    return result;
  }, []);

  const deleteWorkflow = useCallback(async (name) => {
    const result = await window.electronAPI.workflowDelete(name);
    applyWorkflowList(result);
    setSelectedFile(previous => previous === name ? defaultWorkflow(result.files) : previous);
    return result;
  }, [applyWorkflowList]);

  const renameWorkflow = useCallback(async (name, nextName) => {
    const result = await window.electronAPI.workflowRename(name, nextName);
    applyWorkflowList(result);
    setSelectedFile(previous => previous === name ? nextName : previous);
    return result;
  }, [applyWorkflowList]);

  const value = {
    comfyState,
    connected,
    workflowDir,
    workflowFiles,
    selectedFile,
    setSelectedFile,
    selectWorkflow,
    favoriteWorkflows,
    recentWorkflows,
    toggleFavoriteWorkflow,
    workflowManifest,
    inspectingWorkflow,
    generationControls,
    setGenerationControls,
    showNodeControls,
    setShowNodeControls,
    handleShowWorkflowDir,
    handleStartComfyUI,
    refreshWorkflows,
    importWorkflows,
    deleteWorkflow,
    renameWorkflow,
  };

  return <ComfyUIContext.Provider value={value}>{children}</ComfyUIContext.Provider>;
}
