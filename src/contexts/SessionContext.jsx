import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

const SessionContext = createContext(null);

export function useSession() {
  return useContext(SessionContext);
}

export function SessionProvider({ children }) {
  const [state, setState] = useState({ projects: [], activeProjectId: '', activeSessionId: '', messages: [], project: null });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const apply = useCallback(next => {
    if (next) setState(next);
    return next;
  }, []);

  useEffect(() => {
    window.electronAPI.projectsList()
      .then(next => {
        if (!next) throw new Error('项目数据尚未准备好');
        apply(next);
      })
      .catch(error => setLoadError(error.message || '项目数据加载失败'))
      .finally(() => setLoading(false));
  }, [apply]);

  const activate = useCallback((projectId, sessionId) => window.electronAPI.sessionActivate(projectId, sessionId).then(apply), [apply]);
  const createProject = useCallback(input => window.electronAPI.projectCreate(input).then(apply), [apply]);
  const renameProject = useCallback((projectId, name) => window.electronAPI.projectRename(projectId, name).then(apply), [apply]);
  const deleteProject = useCallback(projectId => window.electronAPI.projectDelete(projectId).then(apply), [apply]);
  const createSession = useCallback((title, projectId) => window.electronAPI.sessionCreate(title, projectId).then(apply), [apply]);
  const deleteSession = useCallback((sessionId, projectId) => window.electronAPI.sessionDelete(sessionId, projectId).then(apply), [apply]);
  const renameSession = useCallback((sessionId, title, projectId) => window.electronAPI.sessionRename(sessionId, title, projectId).then(apply), [apply]);

  const value = useMemo(() => ({
    ...state,
    loading,
    loadError,
    activate,
    createProject,
    renameProject,
    deleteProject,
    createSession,
    deleteSession,
    renameSession,
    applyState: apply,
  }), [state, loading, activate, createProject, renameProject, deleteProject, createSession, deleteSession, renameSession, apply]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
