import { useState } from 'react';
import { useAgent } from '../contexts/AgentContext.jsx';
import { useSession } from '../contexts/SessionContext.jsx';
import Icon from './Icon.jsx';

export default function ProjectSidebar() {
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
      await session.createSession('新会话', session.activeProjectId);
    } catch (operationError) {
      setError(operationError.message || '新建会话失败');
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
      setError(operationError.message || '操作失败，请重试');
    } finally {
      setBusy(false);
    }
  }

  const dialogTitle = {
    'create-project': '新建项目',
    'rename-project': '重命名项目',
    'delete-project': '删除项目',
  }[dialog?.type];

  const dialogPrompt = {
    'create-project': '项目名称',
    'rename-project': '项目名称',
  }[dialog?.type];

  const dialogDefault = {
    'create-project': '新项目',
  }[dialog?.type];

  if (session.loading) return <aside className="project-sidebar"><div className="sidebar-loading">正在加载项目...</div></aside>;

  if (session.loadError) return (
    <aside className="project-sidebar">
      <div className="sidebar-error">
        <strong>项目栏不可用</strong>
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
                if (project) session.activate(project.id, project.sessions[0]?.id).catch(operationError => setError(operationError.message || '切换项目失败'));
              }}
              aria-label="当前项目"
            >
              {session.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
            <button className="btn btn-icon" onClick={() => openDialog('create-project', '新项目')} title="新建项目"><Icon name="plus" /></button>
            {activeProject && <button className="btn btn-icon" onClick={() => openDialog('rename-project', activeProject.name)} title="重命名项目">···</button>}
            {session.projects.length > 1 && activeProject && <button className="btn btn-icon danger-icon" onClick={() => openDialog('delete-project')} title="删除项目"><Icon name="trash" size={14} /></button>}
          </div>}
          {collapsed && <button className="btn btn-icon sidebar-collapse" onClick={() => setCollapsed(false)} title="展开项目栏">»</button>}
        </div>
        {!collapsed && <>
          <div className="session-heading"><span>会话</span><button className="btn btn-icon" onClick={handleCreateSession} title="新建会话"><Icon name="plus" /></button></div>
          <div className="session-list">
            {activeProject?.sessions.map(item => (
              <div key={item.id} className={`session-item${item.id === session.activeSessionId ? ' active' : ''}`}>
                <button onClick={() => session.activate(activeProject.id, item.id).catch(operationError => setError(operationError.message || '切换会话失败'))}>{item.title}</button>
                {activeProject.sessions.length > 1 && <button className="session-delete" onClick={() => session.deleteSession(item.id, activeProject.id).catch(operationError => setError(operationError.message || '删除会话失败'))} title="删除会话"><Icon name="trash" size={13} /></button>}
              </div>
            ))}
          </div>
          {error && <div className="sidebar-inline-error" role="alert">{error}</div>}
          <div className="project-sidebar-footer">
            <button className="sidebar-settings" onClick={() => setShowSettings(true)}><Icon name="settings" size={15} /> 设置</button>
            <button className="btn btn-icon sidebar-collapse" onClick={() => setCollapsed(true)} title="折叠项目栏">«</button>
          </div>
        </>}
      </aside>

      {dialog && <div className="modal-overlay sidebar-dialog-overlay" onClick={closeDialog}>
        <form className="sidebar-dialog" onSubmit={submitDialog} onClick={event => event.stopPropagation()}>
          <div className="modal-header">
            <h2>{dialogTitle}</h2>
            <button type="button" className="btn btn-icon" onClick={closeDialog} title="关闭"><Icon name="close" /></button>
          </div>
          {dialog.type === 'delete-project' ? (
            <p className="sidebar-dialog-message">确定删除“{activeProject?.name}”？项目文件不会被删除。</p>
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
            <button type="button" className="btn" onClick={closeDialog} disabled={busy}>取消</button>
            <button type="submit" className={`btn ${dialog.type === 'delete-project' ? 'btn-danger' : 'btn-primary'}`} disabled={busy}>
              {busy ? '处理中...' : dialog.type === 'delete-project' ? '删除项目' : '确定'}
            </button>
          </div>
        </form>
      </div>}
    </>
  );
}
