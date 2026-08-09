import { useState } from 'react';
import { useAgent } from '../contexts/AgentContext.jsx';
import { useSession } from '../contexts/SessionContext.jsx';
import Icon from './Icon.jsx';
import { useI18n } from '../i18n/I18nContext.jsx';

export default function ProjectSidebar() {
  const { t } = useI18n();
  const session = useSession();
  const { setShowSettings } = useAgent();
  const [collapsed, setCollapsed] = useState(false);
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const activeProject = session.projects.find(project => project.id === session.activeProjectId);

  function openDialog(type, value = '') {
    setError('');
    setDialog({ type, value });
  }

  function closeDialog() {
    if (!busy) setDialog(null);
  }

  async function handleCreateSession() {
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      await session.createSession(t('psNewSession'), session.activeProjectId);
    } catch (operationError) {
      setError(operationError.message || t('psCreateFailed'));
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
      if (dialog.type === 'rename-project') await session.renameProject(activeProject.id, value);
      if (dialog.type === 'delete-project') await session.deleteProject(activeProject.id);
      setDialog(null);
    } catch (operationError) {
      setError(operationError.message || t('psOpFailed'));
    } finally {
      setBusy(false);
    }
  }

  const dialogTitle = {
    'create-project': t('psDialogCreate'),
    'rename-project': t('psDialogRename'),
    'delete-project': t('psDialogDelete'),
  }[dialog?.type];

  const dialogPrompt = {
    'create-project': t('psInputLabel'),
    'rename-project': t('psInputLabel'),
  }[dialog?.type];

  const dialogDefault = {
    'create-project': t('psInputPlaceholder'),
  }[dialog?.type];

  if (session.loading) return <aside className="project-sidebar"><div className="sidebar-loading">{t('psLoading')}</div></aside>;

  if (session.loadError) return (
    <aside className="project-sidebar">
      <div className="sidebar-error">
        <strong>{t('psUnavailableTitle')}</strong>
        <span>{session.loadError}</span>
      </div>
    </aside>
  );

  return (
    <>
      <aside className={`project-sidebar${collapsed ? ' collapsed' : ''}`}>
        <div className="project-sidebar-header">
          {!collapsed && <div className="project-switcher">
            <select
              value={session.activeProjectId}
              onChange={event => {
                const project = session.projects.find(item => item.id === event.target.value);
                if (project) session.activate(project.id, project.sessions[0]?.id).catch(operationError => setError(operationError.message || t('psSwitchFailed')));
              }}
              aria-label={t('psCurrentProject')}
            >
              {session.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
            <button className="btn btn-icon" onClick={() => openDialog('create-project', t('psInputPlaceholder'))} title={t('psDialogCreate')}><Icon name="plus" /></button>
            {activeProject && <button className="btn btn-icon" onClick={() => openDialog('rename-project', activeProject.name)} title={t('psDialogRename')}>···</button>}
            {session.projects.length > 1 && activeProject && <button className="btn btn-icon danger-icon" onClick={() => openDialog('delete-project')} title={t('psDialogDelete')}><Icon name="trash" size={14} /></button>}
          </div>}
          {collapsed && <button className="btn btn-icon sidebar-collapse" onClick={() => setCollapsed(false)} title={t('psExpandSidebar')}>»</button>}
        </div>
        {!collapsed && <>
          <div className="session-heading"><span>{t('psSessions')}</span><button className="btn btn-icon" onClick={handleCreateSession} title={t('psNewSessionTitle')}><Icon name="plus" /></button></div>
          <div className="session-list">
            {activeProject?.sessions.map(item => (
              <div key={item.id} className={`session-item${item.id === session.activeSessionId ? ' active' : ''}`}>
                <button onClick={() => session.activate(activeProject.id, item.id).catch(operationError => setError(operationError.message || t('psSwitchSessionFailed')))}>{item.title}</button>
                {activeProject.sessions.length > 1 && <button className="session-delete" onClick={() => session.deleteSession(item.id, activeProject.id).catch(operationError => setError(operationError.message || t('psDeleteSessionFailed')))} title={t('psDeleteSession')}><Icon name="trash" size={13} /></button>}
              </div>
            ))}
          </div>
          {error && <div className="sidebar-inline-error" role="alert">{error}</div>}
          <div className="project-sidebar-footer">
            <button className="sidebar-settings" onClick={() => setShowSettings(true)}><Icon name="settings" size={15} /> {t('psSettings')}</button>
            <button className="btn btn-icon sidebar-collapse" onClick={() => setCollapsed(true)} title={t('psCollapseSidebar')}>«</button>
          </div>
        </>}
      </aside>

      {dialog && <div className="modal-overlay sidebar-dialog-overlay" onClick={closeDialog}>
        <form className="sidebar-dialog" onSubmit={submitDialog} onClick={event => event.stopPropagation()}>
          <div className="modal-header">
            <h2>{dialogTitle}</h2>
            <button type="button" className="btn btn-icon" onClick={closeDialog} title={t('close')}><Icon name="close" /></button>
          </div>
          {dialog.type === 'delete-project' ? (
            <p className="sidebar-dialog-message">{t('psConfirmDeleteProject', { name: activeProject?.name })}</p>
          ) : (
            <label className="sidebar-dialog-field">
              <span>{dialogPrompt}</span>
              <input
                autoFocus
                value={dialog.value ?? dialogDefault ?? ''}
                onChange={event => setDialog(current => ({ ...current, value: event.target.value }))}
                onFocus={event => event.target.select()}
              />
            </label>
          )}
          {error && <div className="sidebar-dialog-error" role="alert">{error}</div>}
          <div className="settings-footer">
            <span className="settings-footer-spacer" />
            <button type="button" className="btn" onClick={closeDialog} disabled={busy}>{t('cancel')}</button>
            <button type="submit" className={`btn ${dialog.type === 'delete-project' ? 'btn-danger' : 'btn-primary'}`} disabled={busy}>
              {busy ? t('psProcessing') : dialog.type === 'delete-project' ? t('psDialogDelete') : t('psConfirm')}
            </button>
          </div>
        </form>
      </div>}
    </>
  );
}
