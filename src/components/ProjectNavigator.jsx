import { useEffect, useRef, useState } from 'react';
import { useAgent } from '../contexts/AgentContext.jsx';
import { useSession } from '../contexts/SessionContext.jsx';
import Icon from './Icon.jsx';
import { useI18n } from '../i18n/I18nContext.jsx';

function projectMark(project, index) {
  return (project?.name || `P${index + 1}`).trim().slice(0, 1).toUpperCase();
}

export default function ProjectNavigator({ activeView = 'chat', onViewChange, onOpenQuickGenerate }) {
  const { t } = useI18n();
  const session = useSession();
  const { setShowSettings } = useAgent();
  const [collapsed, setCollapsed] = useState(false);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [projectMenuPosition, setProjectMenuPosition] = useState(null);
  const projectTriggerRef = useRef(null);
  const activeProject = session.projects.find(project => project.id === session.activeProjectId);
  const dialogProject = session.projects.find(project => project.id === dialog?.projectId) || activeProject;

  useEffect(() => {
    if (!projectMenuOpen) return undefined;
    const updateProjectMenuPosition = () => {
      const rect = projectTriggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      setProjectMenuPosition({
        top: rect.bottom + 6,
        left: rect.left,
        width: rect.width,
        maxHeight: Math.max(160, window.innerHeight - rect.bottom - 18),
      });
    };
    updateProjectMenuPosition();
    const scrollContainer = projectTriggerRef.current?.closest('.sidebar-content');
    scrollContainer?.addEventListener('scroll', updateProjectMenuPosition, { passive: true });
    window.addEventListener('resize', updateProjectMenuPosition);
    return () => {
      scrollContainer?.removeEventListener('scroll', updateProjectMenuPosition);
      window.removeEventListener('resize', updateProjectMenuPosition);
    };
  }, [projectMenuOpen]);

  function openDialog(type, value = '', projectId = session.activeProjectId, sessionId = session.activeSessionId) {
    setError('');
    setProjectMenuOpen(false);
    setProjectMenuPosition(null);
    setDialog({ type, value, projectId, sessionId });
  }

  function activateProject(projectId, sessionId) {
    setProjectMenuOpen(false);
    setProjectMenuPosition(null);
    session.activate(projectId, sessionId).catch(operationError => setError(operationError.message || t('operationFailed')));
  }

  function activateSession(projectId, sessionId) {
    setProjectMenuOpen(false);
    setProjectMenuPosition(null);
    session.activate(projectId, sessionId).catch(operationError => setError(operationError.message || t('operationFailed')));
  }

  function toggleProjectMenu() {
    const nextOpen = !projectMenuOpen;
    setProjectMenuOpen(nextOpen);
    if (!nextOpen) setProjectMenuPosition(null);
  }

  function closeDialog() {
    if (!busy) setDialog(null);
  }

  async function handleCreateSession(projectId = session.activeProjectId) {
    if (busy) return;
    setProjectMenuOpen(false);
    setProjectMenuPosition(null);
    setError('');
    setBusy(true);
    try {
      await session.createSession(t('newSession'), projectId);
    } catch (operationError) {
      setError(operationError.message || t('operationFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function submitDialog(event) {
    event.preventDefault();
    if (!dialog || busy) return;
    const value = dialog.value.trim();
    if (dialog.type !== 'delete-project' && !value) return;

    setBusy(true);
    setError('');
    try {
      if (dialog.type === 'create-project') await session.createProject({ name: value });
      if (dialog.type === 'rename-project') await session.renameProject(dialog.projectId, value);
      if (dialog.type === 'rename-session') await session.renameSession(dialog.sessionId, value, dialog.projectId);
      if (dialog.type === 'delete-project') await session.deleteProject(dialog.projectId);
      setDialog(null);
    } catch (operationError) {
      setError(operationError.message || t('operationFailed'));
    } finally {
      setBusy(false);
    }
  }

  const dialogTitle = {
    'create-project': t('createProject'),
    'rename-project': t('renameProject'),
    'rename-session': t('renameSession'),
    'delete-project': t('deleteProject'),
  }[dialog?.type];
  const dialogPrompt = dialog?.type === 'rename-session' ? t('sessionName') : t('projectName');
  const dialogDefault = { 'create-project': t('newProject') }[dialog?.type];

  if (session.loading) return <aside className="project-sidebar"><div className="sidebar-loading">{t('loadingProjects')}</div></aside>;
  if (session.loadError) return (
    <aside className="project-sidebar">
       <div className="sidebar-error"><strong>{t('projectUnavailable')}</strong><span>{session.loadError}</span></div>
    </aside>
  );

  return (
    <>
      <aside className={`project-sidebar${collapsed ? ' collapsed' : ''}`}>
        <div className="project-sidebar-header">
          {!collapsed ? (
            <>
              <div className="sidebar-title-block">
                <span className="sidebar-eyebrow">AGENT WORKSPACE</span>
                 <strong>{t('workspace')}</strong>
              </div>
               <button className="btn btn-icon sidebar-collapse" onClick={() => setCollapsed(true)} title={t('collapseSidebar')}><Icon name="panelLeft" /></button>
            </>
          ) : (
            <button className="btn btn-icon sidebar-collapse" onClick={() => setCollapsed(false)} title={t('expandSidebar')}><Icon name="panelLeft" /></button>
          )}
        </div>

        {!collapsed && <>
          <nav className="workspace-nav" aria-label={t('workspaceView')}>
            <button className={`workspace-nav-item${activeView === 'chat' ? ' active' : ''}`} onClick={() => { setProjectMenuOpen(false); onViewChange?.('chat'); }}>
              <span className="workspace-nav-icon"><Icon name="message" /></span>
               <span>{t('chatWorkspace')}</span>
            </button>
            <button className={`workspace-nav-item${activeView === 'assets' ? ' active' : ''}`} onClick={() => { setProjectMenuOpen(false); onViewChange?.('assets'); }}>
              <span className="workspace-nav-icon"><Icon name="images" /></span>
               <span>{t('assetLibrary')}</span>
            </button>
            <button className={`workspace-nav-item${activeView === 'presets' ? ' active' : ''}`} onClick={() => { setProjectMenuOpen(false); onViewChange?.('presets'); }}>
              <span className="workspace-nav-icon"><Icon name="spark" /></span>
               <span>{t('presetCards')}</span>
            </button>
            <button className={`workspace-nav-item${activeView === 'prompt-library' ? ' active' : ''}`} onClick={() => { setProjectMenuOpen(false); onViewChange?.('prompt-library'); }}>
              <span className="workspace-nav-icon"><Icon name="library" /></span>
               <span>{t('promptWorkspace')}</span>
            </button>
          </nav>

          <div className="sidebar-content">
             <div className="sidebar-context-label">{t('currentProject')}</div>
            <div className="sidebar-project-picker">
              <button
                className={`sidebar-project-trigger${projectMenuOpen ? ' open' : ''}`}
                ref={projectTriggerRef}
                onClick={toggleProjectMenu}
                aria-expanded={projectMenuOpen}
                aria-haspopup="listbox"
              >
                <span className={`project-mark project-mark-${Math.max(0, session.projects.indexOf(activeProject)) % 4}`}>{projectMark(activeProject, 0)}</span>
                <span className="sidebar-project-trigger-copy">
                    <strong>{activeProject ? (activeProject.isDefault ? t('defaultProject') : activeProject.name) : t('noProject')}</strong>
                   <small>{activeProject ? `${activeProject.sessions?.length || 0} ${t('sessions')}` : t('chooseProject')}</small>
                </span>
                <Icon name="chevronDown" size={15} />
              </button>

               {projectMenuOpen && <div className="sidebar-project-menu" style={projectMenuPosition || undefined} role="listbox" aria-label={t('projects')}>
                <div className="sidebar-menu-header">
                   <span>{t('project')}</span>
                   <button className="tree-action" onClick={() => openDialog('create-project', t('newProject'))} title={t('createProject')}><Icon name="plus" size={14} /></button>
                </div>
                <div className="sidebar-project-options" style={projectMenuPosition ? { maxHeight: Math.max(120, projectMenuPosition.maxHeight - 35) } : undefined}>
                  {session.projects.map((project, projectIndex) => {
                    const active = project.id === session.activeProjectId;
                    return (
                      <div className={`sidebar-project-option${active ? ' active' : ''}`} key={project.id}>
                        <button className="sidebar-project-option-select" onClick={() => activateProject(project.id, project.sessions?.[0]?.id)} role="option" aria-selected={active}>
                          <span className={`project-mark project-mark-${projectIndex % 4}`}>{projectMark(project, projectIndex)}</span>
                          <span>
                            <strong>{project.isDefault ? t('defaultProject') : project.name}</strong>
                           <small>{project.sessions?.length || 0} {t('sessions')}</small>
                          </span>
                          {active && <Icon name="check" size={14} />}
                        </button>
                        <div className="sidebar-project-option-actions">
                           <button className="tree-action" onClick={() => handleCreateSession(project.id)} title={`${t('newSession')} (${project.name})`}><Icon name="plus" size={13} /></button>
                           <button className="tree-action" onClick={() => openDialog('rename-project', project.name, project.id)} title={t('renameProject')}><Icon name="more" size={13} /></button>
                           {session.projects.length > 1 && <button className="tree-action danger-icon" onClick={() => openDialog('delete-project', '', project.id)} title={t('deleteProject')}><Icon name="trash" size={13} /></button>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>}
            </div>

            <div className="sidebar-section-heading">
               <div>
                 <span>{t('session')}</span>
                 <small>{activeProject ? t('currentProjectChats') : t('chooseProjectFirst')}</small>
              </div>
               <button className="btn btn-icon" onClick={() => handleCreateSession()} title={t('newSession')} disabled={!activeProject}><Icon name="plus" size={15} /></button>
            </div>

            <div className="sidebar-session-list">
              {activeProject?.sessions?.map(item => {
                const active = item.id === session.activeSessionId;
                return (
                  <div key={item.id} className={`sidebar-session-item${active ? ' active' : ''}`}>
                    <button className="sidebar-session-select" onClick={() => activateSession(activeProject.id, item.id)}>
                      <Icon name="message" size={14} />
                      <span>{item.title}</span>
                    </button>
                    <div className="sidebar-session-actions">
                       <button className="tree-action" onClick={() => openDialog('rename-session', item.title, activeProject.id, item.id)} title={t('renameSession')}><Icon name="more" size={13} /></button>
                       {activeProject.sessions.length > 1 && <button className="tree-action danger-icon" onClick={() => session.deleteSession(item.id, activeProject.id).catch(operationError => setError(operationError.message || t('deleteSessionFailed')))} title={t('delete')}><Icon name="trash" size={13} /></button>}
                    </div>
                  </div>
                );
              })}
               {!activeProject && <div className="sidebar-empty-state"><Icon name="folder" size={17} /><span>{t('noProjectSelected')}</span></div>}
               {activeProject?.sessions?.length === 0 && <div className="sidebar-empty-state"><Icon name="message" size={17} /><span>{t('startSession')}</span></div>}
            </div>
          </div>
        </>}

        {!collapsed && <div className="project-sidebar-footer">
          {error && <div className="sidebar-inline-error" role="alert">{error}</div>}
           <button className="sidebar-quick-generate" onClick={onOpenQuickGenerate}><Icon name="spark" size={15} /><span><strong>{t('quickGenerate')}</strong><small>{t('openFloatingController')}</small></span></button>
           <button className="sidebar-settings" onClick={() => setShowSettings(true)}><Icon name="settings" size={15} /> {t('settings')}</button>
        </div>}
      </aside>

      {dialog && <div className="modal-overlay sidebar-dialog-overlay" onClick={closeDialog}>
        <form className="sidebar-dialog" onSubmit={submitDialog} onClick={event => event.stopPropagation()}>
          <div className="modal-header"><h2>{dialogTitle}</h2><button type="button" className="btn btn-icon" onClick={closeDialog} title={t('close')}><Icon name="close" /></button></div>
          {dialog.type === 'delete-project' ? <p className="sidebar-dialog-message">{t('deleteProjectConfirm', { name: dialogProject?.name })}</p> : (
            <label className="sidebar-dialog-field"><span>{dialogPrompt}</span><input autoFocus value={dialog.value ?? dialogDefault ?? ''} onChange={event => setDialog(current => ({ ...current, value: event.target.value }))} onFocus={event => event.target.select()} /></label>
          )}
          {error && <div className="sidebar-dialog-error" role="alert">{error}</div>}
          <div className="settings-footer"><span className="settings-footer-spacer" /><button type="button" className="btn" onClick={closeDialog} disabled={busy}>{t('cancel')}</button><button type="submit" className={`btn ${dialog.type === 'delete-project' ? 'btn-danger' : 'btn-primary'}`} disabled={busy}>{busy ? t('handling') : dialog.type === 'delete-project' ? t('deleteProject') : t('confirm')}</button></div>
        </form>
      </div>}
    </>
  );
}
