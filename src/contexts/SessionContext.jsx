import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

const SessionContext = createContext(null);

function messageKey(message = {}) {
  return message.messageId || message.id || (message.turnId ? `${message.turnId}:${message.role || ''}` : '');
}

function mergeMessages(current = [], incoming = []) {
  const merged = new Map();
  for (const message of current) {
    const key = messageKey(message);
    if (key) merged.set(key, message);
    else merged.set(`index:${merged.size}`, message);
  }
  for (const message of incoming) {
    const key = messageKey(message);
    if (key) merged.set(key, { ...merged.get(key), ...message });
    else merged.set(`incoming:${merged.size}`, message);
  }
  return [...merged.values()].sort((a, b) => (a.timestamp || a.ts || 0) - (b.timestamp || b.ts || 0));
}

function mergeState(current, next) {
  if (!current || current.activeProjectId !== next?.activeProjectId || current.activeSessionId !== next?.activeSessionId) return next;
  return {
    ...current,
    ...next,
    messages: mergeMessages(current.messages, next.messages),
    project: current.project && next.project
      ? { ...current.project, ...next.project, assets: next.project.assets || current.project.assets || [] }
      : next.project || current.project,
    sessionState: { ...(current.sessionState || {}), ...(next.sessionState || {}) },
  };
}

export function useSession() {
  return useContext(SessionContext);
}

export function SessionProvider({ children }) {
  const [state, setState] = useState({ projects: [], activeProjectId: '', activeSessionId: '', messages: [], project: null, sessionState: {} });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const activationVersionRef = useRef(0);
  const activationTargetRef = useRef(null);

  const apply = useCallback(next => {
    if (next) setState(previous => mergeState(previous, next));
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

  useEffect(() => {
    if (!window.electronAPI.onProjectState) return undefined;
    return window.electronAPI.onProjectState(next => {
      const target = activationTargetRef.current;
      if (target && (next?.activeProjectId !== target.projectId || next?.activeSessionId !== target.sessionId)) return;
      apply(next);
    });
  }, [apply]);

  const activate = useCallback((projectId, sessionId) => {
    const version = ++activationVersionRef.current;
    activationTargetRef.current = { projectId, sessionId };
    return window.electronAPI.sessionActivate(projectId, sessionId).then(next => {
      if (version !== activationVersionRef.current) return null;
      activationTargetRef.current = null;
      return apply(next);
    }).catch(error => {
      if (version === activationVersionRef.current) activationTargetRef.current = null;
      throw error;
    });
  }, [apply]);
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
