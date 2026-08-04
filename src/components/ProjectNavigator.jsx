import { useEffect, useRef, useState } from 'react';
import { useAgent } from '../contexts/AgentContext.jsx';
import { useSession } from '../contexts/SessionContext.jsx';
import Icon from './Icon.jsx';

function projectMark(project, index) {
  return (project?.name || `P${index + 1}`).trim().slice(0, 1).toUpperCase();
}

export default function ProjectNavigator({ activeView = 'chat', onViewChange }) {
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
    session.activate(projectId, sessionId).catch(operationError => setError(operationError.message || '切换项目失败'));
  }

  function activateSession(projectId, sessionId) {
    setProjectMenuOpen(false);
    setProjectMenuPosition(null);
    session.activate(projectId, sessionId).catch(operationError => setError(operationError.message || '切换会话失败'));
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
      await session.createSession('新会话', projectId);
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
      if (dialog.type === 'rename-project') await session.renameProject(dialog.projectId, value);
      if (dialog.type === 'rename-session') await session.renameSession(dialog.sessionId, value, dialog.projectId);
      if (dialog.type === 'delete-project') await session.deleteProject(dialog.projectId);
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
    'rename-session': '重命名会话',
    'delete-project': '删除项目',
  }[dialog?.type];
  const dialogPrompt = dialog?.type === 'rename-session' ? '会话名称' : '项目名称';
  const dialogDefault = { 'create-project': '新项目' }[dialog?.type];

  if (session.loading) return <aside className="project-sidebar"><div className="sidebar-loading">正在加载项目...</div></aside>;
  if (session.loadError) return (
    <aside className="project-sidebar">
      <div className="sidebar-error"><strong>项目栏不可用</strong><span>{session.loadError}</span></div>
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
                <strong>工作台</strong>
              </div>
              <button className="btn btn-icon sidebar-collapse" onClick={() => setCollapsed(true)} title="收起侧栏"><Icon name="panelLeft" /></button>
            </>
          ) : (
            <button className="btn btn-icon sidebar-collapse" onClick={() => setCollapsed(false)} title="展开侧栏"><Icon name="panelLeft" /></button>
          )}
        </div>

        {!collapsed && <>
          <nav className="workspace-nav" aria-label="工作区视图">
            <button className={`workspace-nav-item${activeView === 'chat' ? ' active' : ''}`} onClick={() => { setProjectMenuOpen(false); onViewChange?.('chat'); }}>
              <span className="workspace-nav-icon"><Icon name="message" /></span>
              <span>对话工作台</span>
            </button>
            <button className={`workspace-nav-item${activeView === 'assets' ? ' active' : ''}`} onClick={() => { setProjectMenuOpen(false); onViewChange?.('assets'); }}>
              <span className="workspace-nav-icon"><Icon name="images" /></span>
              <span>资产库</span>
            </button>
            <button className={`workspace-nav-item${activeView === 'prompt-library' ? ' active' : ''}`} onClick={() => { setProjectMenuOpen(false); onViewChange?.('prompt-library'); }}>
              <span className="workspace-nav-icon"><Icon name="library" /></span>
              <span>提示词工作台</span>
            </button>
          </nav>

          <div className="sidebar-content">
            <div className="sidebar-context-label">当前项目</div>
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
                  <strong>{activeProject?.name || '未选择项目'}</strong>
                  <small>{activeProject ? `${activeProject.sessions?.length || 0} 个会话` : '选择一个项目开始'}</small>
                </span>
                <Icon name="chevronDown" size={15} />
              </button>

              {projectMenuOpen && <div className="sidebar-project-menu" style={projectMenuPosition || undefined} role="listbox" aria-label="项目列表">
                <div className="sidebar-menu-header">
                  <span>项目</span>
                  <button className="tree-action" onClick={() => openDialog('create-project', '新项目')} title="新建项目"><Icon name="plus" size={14} /></button>
                </div>
                <div className="sidebar-project-options" style={projectMenuPosition ? { maxHeight: Math.max(120, projectMenuPosition.maxHeight - 35) } : undefined}>
                  {session.projects.map((project, projectIndex) => {
                    const active = project.id === session.activeProjectId;
                    return (
                      <div className={`sidebar-project-option${active ? ' active' : ''}`} key={project.id}>
                        <button className="sidebar-project-option-select" onClick={() => activateProject(project.id, project.sessions?.[0]?.id)} role="option" aria-selected={active}>
                          <span className={`project-mark project-mark-${projectIndex % 4}`}>{projectMark(project, projectIndex)}</span>
                          <span>
                            <strong>{project.name}</strong>
                            <small>{project.sessions?.length || 0} 个会话</small>
                          </span>
                          {active && <Icon name="check" size={14} />}
                        </button>
                        <div className="sidebar-project-option-actions">
                          <button className="tree-action" onClick={() => handleCreateSession(project.id)} title={`在${project.name}中新建会话`}><Icon name="plus" size={13} /></button>
                          <button className="tree-action" onClick={() => openDialog('rename-project', project.name, project.id)} title="重命名项目"><Icon name="more" size={13} /></button>
                          {session.projects.length > 1 && <button className="tree-action danger-icon" onClick={() => openDialog('delete-project', '', project.id)} title="删除项目"><Icon name="trash" size={13} /></button>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>}
            </div>

            <div className="sidebar-section-heading">
              <div>
                <span>会话</span>
                <small>{activeProject ? '当前项目中的对话' : '先选择一个项目'}</small>
              </div>
              <button className="btn btn-icon" onClick={() => handleCreateSession()} title="新建会话" disabled={!activeProject}><Icon name="plus" size={15} /></button>
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
                      <button className="tree-action" onClick={() => openDialog('rename-session', item.title, activeProject.id, item.id)} title="重命名会话"><Icon name="more" size={13} /></button>
                      {activeProject.sessions.length > 1 && <button className="tree-action danger-icon" onClick={() => session.deleteSession(item.id, activeProject.id).catch(operationError => setError(operationError.message || '删除会话失败'))} title="删除会话"><Icon name="trash" size={13} /></button>}
                    </div>
                  </div>
                );
              })}
              {!activeProject && <div className="sidebar-empty-state"><Icon name="folder" size={17} /><span>还没有选择项目</span></div>}
              {activeProject?.sessions?.length === 0 && <div className="sidebar-empty-state"><Icon name="message" size={17} /><span>新建一个会话开始工作</span></div>}
            </div>
          </div>
        </>}

        {!collapsed && <div className="project-sidebar-footer">
          {error && <div className="sidebar-inline-error" role="alert">{error}</div>}
          <button className="sidebar-settings" onClick={() => setShowSettings(true)}><Icon name="settings" size={15} /> 设置</button>
        </div>}
      </aside>

      {dialog && <div className="modal-overlay sidebar-dialog-overlay" onClick={closeDialog}>
        <form className="sidebar-dialog" onSubmit={submitDialog} onClick={event => event.stopPropagation()}>
          <div className="modal-header"><h2>{dialogTitle}</h2><button type="button" className="btn btn-icon" onClick={closeDialog} title="关闭"><Icon name="close" /></button></div>
          {dialog.type === 'delete-project' ? <p className="sidebar-dialog-message">确定删除“{dialogProject?.name}”吗？项目文件不会被删除。</p> : (
            <label className="sidebar-dialog-field"><span>{dialogPrompt}</span><input autoFocus value={dialog.value ?? dialogDefault ?? ''} onChange={event => setDialog(current => ({ ...current, value: event.target.value }))} onFocus={event => event.target.select()} /></label>
          )}
          {error && <div className="sidebar-dialog-error" role="alert">{error}</div>}
          <div className="settings-footer"><span className="settings-footer-spacer" /><button type="button" className="btn" onClick={closeDialog} disabled={busy}>取消</button><button type="submit" className={`btn ${dialog.type === 'delete-project' ? 'btn-danger' : 'btn-primary'}`} disabled={busy}>{busy ? '处理中...' : dialog.type === 'delete-project' ? '删除项目' : '确定'}</button></div>
        </form>
      </div>}
    </>
  );
}
