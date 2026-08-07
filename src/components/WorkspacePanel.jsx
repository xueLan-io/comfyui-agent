import { useEffect, useRef, useState } from 'react';
import { useComfyUI } from '../contexts/ComfyUIContext.jsx';
import { useAgent } from '../contexts/AgentContext.jsx';
import { countControlChanges } from './node-controls.mjs';
import Icon from './Icon.jsx';
import { useI18n } from '../i18n/I18nContext.jsx';

const VISIBLE_PROMPT_MODES = ['raw', 'anime', 'anime-character', 'anime-scene', 'anime-polish'];

function workflowGroups(files) {
  const rootItems = [];
  const groups = [];
  for (const file of files) {
    const sepIndex = file.indexOf('\\');
    if (sepIndex === -1) {
      rootItems.push(file);
      continue;
    }
    const groupName = file.slice(0, sepIndex);
    let group = groups.find(item => item.name === groupName);
    if (!group) {
      group = { name: groupName, items: [] };
      groups.push(group);
    }
    group.items.push(file);
  }
  groups.sort((a, b) => a.name.localeCompare(b.name));
  return { rootItems, groups };
}

function workflowDisplayName(file) {
  const sepIndex = file.lastIndexOf('\\');
  return sepIndex === -1 ? file : file.slice(sepIndex + 1);
}

export default function WorkspacePanel({ onOpenPromptLibrary }) {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [importFeedback, setImportFeedback] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [workflowQuery, setWorkflowQuery] = useState('');
  const workflowSearchRef = useRef(null);
  const importFeedbackTimer = useRef(null);
  const {
    selectedFile,
    selectWorkflow,
    workflowFiles,
    workflowDir,
    workflowManifest,
    generationControls,
    setShowNodeControls,
    handleShowWorkflowDir,
    importWorkflows,
    deleteWorkflow,
    renameWorkflow,
    favoriteWorkflows,
    recentWorkflows,
    toggleFavoriteWorkflow,
  } = useComfyUI();
  const {
    promptMode,
    setPromptMode,
    status,
    statusMsg,
  } = useAgent();
  const controlChangeCount = countControlChanges(generationControls);
  const promptProfile = workflowManifest?.promptProfile;
  const positiveTargetCount = promptProfile?.positiveTargets?.length || 0;
  const negativeTargetCount = promptProfile?.negativeTargets?.length || 0;
  const promptModeHelp = { raw: 'promptHelpRaw', anime: 'promptHelpAnime', 'anime-character': 'promptHelpCharacter', 'anime-scene': 'promptHelpScene', 'anime-polish': 'promptHelpPolish' }[promptMode] || 'promptHelpAnime';
  const modeText = { raw: ['rawMode', 'rawModeDesc'], anime: ['animeMode', 'animeModeDesc'], 'anime-character': ['characterMode', 'characterModeDesc'], 'anime-scene': ['sceneMode', 'sceneModeDesc'], 'anime-polish': ['polishMode', 'polishModeDesc'] };
  const statusText = { running: 'workflowRunning', completed: 'workflowCompleted', error: 'workflowFailed', cancelled: 'workflowCancelled' };

  useEffect(() => () => clearTimeout(importFeedbackTimer.current), []);

  useEffect(() => {
    const focusWorkflowSearch = event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        workflowSearchRef.current?.focus();
        workflowSearchRef.current?.select();
      }
    };
    window.addEventListener('keydown', focusWorkflowSearch);
    return () => window.removeEventListener('keydown', focusWorkflowSearch);
  }, []);

  useEffect(() => {
    const switchWorkflow = event => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const index = Number(event.key) - 1;
      const candidates = [...favoriteWorkflows, ...recentWorkflows.filter(file => !favoriteWorkflows.includes(file))].filter(file => workflowFiles.includes(file));
      if (index < 0 || index >= candidates.length) return;
      event.preventDefault();
      selectWorkflow(candidates[index]);
    };
    window.addEventListener('keydown', switchWorkflow);
    return () => window.removeEventListener('keydown', switchWorkflow);
  }, [favoriteWorkflows, recentWorkflows, selectWorkflow, workflowFiles]);

  const showImportFeedback = (type, text) => {
    setImportFeedback({ type, text });
    clearTimeout(importFeedbackTimer.current);
    importFeedbackTimer.current = setTimeout(() => setImportFeedback(null), 6000);
  };

  const applyImportResult = result => {
    if (!result) return;
    const failed = (result.results || []).filter(item => item.status !== 'imported');
    if (result.imported?.length > 0 && failed.length === 0) {
      showImportFeedback('ok', `已导入 ${result.imported.length} 个工作流`);
    } else if (result.imported?.length > 0) {
      showImportFeedback('warn', `导入 ${result.imported.length} 个，${failed.length} 个失败：${failed.map(item => `${workflowDisplayName(item.name)} ${item.error || ''}`).join('、')}`);
    } else if (failed.length > 0) {
      showImportFeedback('error', failed.map(item => `${workflowDisplayName(item.name)} ${item.error || ''}`).join('、'));
    }
  };

  const handleImportClick = async () => {
    try {
      const result = await window.electronAPI.selectWorkflowFiles();
      applyImportResult(result);
    } catch (error) {
      showImportFeedback('error', error.message || '导入失败');
    }
  };

  const handleDrop = async event => {
    setDragOver(false);
    const files = Array.from(event.dataTransfer?.files || []);
    if (files.length === 0) return;
    try {
      const paths = files.map(file => window.electronAPI.getPathForFile(file)).filter(Boolean);
      if (paths.length === 0) {
        showImportFeedback('error', '无法读取拖入的文件');
        return;
      }
      const result = await importWorkflows(paths);
      applyImportResult(result);
    } catch (error) {
      showImportFeedback('error', error.message || '导入失败');
    }
  };

  const handleDragOver = event => {
    const hasJson = Array.from(event.dataTransfer?.files || []).some(file => /\.json$/i.test(file.name));
    if (!hasJson) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setDragOver(true);
  };

  const startRename = () => {
    setRenameValue(selectedFile ? workflowDisplayName(selectedFile) : '');
    setRenameOpen(true);
    setMenuOpen(false);
    setConfirmDelete(false);
  };

  const handleRenameSubmit = async () => {
    const next = renameValue.trim();
    if (!next || !selectedFile) return;
    if (!/\.json$/i.test(next)) {
      showImportFeedback('error', '文件名必须以 .json 结尾');
      return;
    }
    if (/[\\/]/.test(next)) {
      showImportFeedback('error', '文件名不能包含路径分隔符');
      return;
    }
    try {
      await renameWorkflow(selectedFile, next);
      setRenameOpen(false);
      setMenuOpen(false);
      showImportFeedback('ok', `已重命名为 ${next}`);
    } catch (error) {
      showImportFeedback('error', error.message || '重命名失败');
    }
  };

  const handleDelete = async () => {
    if (!selectedFile) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    try {
      const name = selectedFile;
      await deleteWorkflow(name);
      setConfirmDelete(false);
      setMenuOpen(false);
      showImportFeedback('ok', `已删除 ${workflowDisplayName(name)}`);
    } catch (error) {
      showImportFeedback('error', error.message || '删除失败');
    }
  };

  const { rootItems, groups } = workflowGroups(workflowFiles);
  const normalizedWorkflowQuery = workflowQuery.trim().toLocaleLowerCase();
  const matchesWorkflow = file => !normalizedWorkflowQuery || file.toLocaleLowerCase().includes(normalizedWorkflowQuery);
  const filteredRootItems = rootItems.filter(file => matchesWorkflow(file) && !favoriteWorkflows.includes(file) && !recentWorkflows.includes(file));
  const filteredGroups = groups.map(group => ({ ...group, items: group.items.filter(file => matchesWorkflow(file) && !favoriteWorkflows.includes(file) && !recentWorkflows.includes(file)) })).filter(group => group.items.length > 0);
  const favoriteFiles = favoriteWorkflows.filter(file => workflowFiles.includes(file) && matchesWorkflow(file));
  const recentFiles = recentWorkflows.filter(file => workflowFiles.includes(file) && matchesWorkflow(file) && !favoriteFiles.includes(file));
  return (
    <section className={`panel-right workspace-sidebar${collapsed ? ' collapsed' : ''}${dragOver ? ' drag-over' : ''}`}
      onDragEnter={event => {
        if (Array.from(event.dataTransfer?.files || []).some(file => /\.json$/i.test(file.name))) setDragOver(true);
      }}
      onDragLeave={event => {
        if (event.currentTarget === event.target) setDragOver(false);
      }}
      onDragOver={handleDragOver}
      onDrop={handleDrop}>
       <div className="panel-right-header">
         <div><span className="sidebar-eyebrow">CONTROL ROOM</span><strong className="workspace-title">{t('workflow')}</strong></div>
        <div className="panel-right-controls">
           {statusText[status] && <span className={`tag tag-${status === 'error' ? 'err' : status === 'running' ? 'processing' : 'ok'}`}>{t(statusText[status])}</span>}
          <button className="btn btn-icon workspace-collapse" onClick={() => setCollapsed(value => !value)} title={collapsed ? t('expandSidebar') : t('collapseSidebar')}><Icon name={collapsed ? 'chevronLeft' : 'chevronRight'} /></button>
        </div>
      </div>

      {!collapsed && <div className="workspace-scroll">
        <section className="workspace-section workflow-section">
           <div className="workspace-section-heading"><div><span className="section-kicker">01</span><div><h3>{t('workflow')}</h3><p>{workflowDir || t('chooseWorkflow')}</p></div></div><span className="workflow-count">{normalizedWorkflowQuery ? `${filteredRootItems.length + filteredGroups.reduce((count, group) => count + group.items.length, 0)} / ` : ''}{workflowFiles.length} {t('items')}</span></div>
           <div className="workflow-picker-row">
             <div className="workflow-search-wrap"><input ref={workflowSearchRef} className="workflow-search" value={workflowQuery} onChange={event => setWorkflowQuery(event.target.value)} placeholder={t('searchWorkflow')} aria-label={t('searchWorkflow')} title="Ctrl/Cmd+K" />{workflowQuery && <button className="workflow-search-clear" onClick={() => { setWorkflowQuery(''); workflowSearchRef.current?.focus(); }} aria-label={t('searchWorkflow')} title={t('close')}><Icon name="close" size={12} /></button>}</div>
             <select className="wf-select" value={selectedFile} onChange={event => selectWorkflow(event.target.value)} aria-label={t('chooseWorkflow')}>
                <option value="">{t('chooseWorkflowOption')}</option>
                {filteredRootItems.length === 0 && filteredGroups.length === 0 && <option value="" disabled>{t('noMatchingWorkflow')}</option>}
                {favoriteFiles.length > 0 && <optgroup label={t('favorites')}><>{favoriteFiles.map(file => <option key={`favorite-${file}`} value={file}>★ {workflowDisplayName(file)}</option>)}</></optgroup>}
                {recentFiles.length > 0 && <optgroup label={t('recent')}><>{recentFiles.map(file => <option key={`recent-${file}`} value={file}>{workflowDisplayName(file)}</option>)}</></optgroup>}
               {filteredRootItems.map(file => <option key={file} value={file}>{file}</option>)}
               {filteredGroups.map(group => (
                <optgroup key={group.name} label={group.name}>
                  {group.items.map(file => <option key={file} value={file}>{workflowDisplayName(file)}</option>)}
                </optgroup>
              ))}
             </select>
             <button className={`btn btn-icon workflow-favorite${favoriteWorkflows.includes(selectedFile) ? ' active' : ''}`} onClick={() => toggleFavoriteWorkflow(selectedFile)} disabled={!selectedFile} title={favoriteWorkflows.includes(selectedFile) ? t('removeFavorite') : t('favoriteWorkflow')} aria-label={favoriteWorkflows.includes(selectedFile) ? t('removeFavorite') : t('favoriteWorkflow')}>★</button>
             <button className="btn" onClick={handleImportClick} title="Import ComfyUI workflow (.json)"><Icon name="upload" size={14} /> {t('import')}</button>
             <button className="btn" onClick={handleShowWorkflowDir} title={selectedFile ? `${t('directory')}: ${selectedFile}` : t('directory')}>{t('directory')}</button>
             <button className="btn node-controls-trigger" onClick={() => setShowNodeControls(true)} disabled={!workflowManifest} title={t('parameters')}><Icon name="sliders" size={14} /> {t('parameters')}{controlChangeCount > 0 && <span className="node-control-count">{controlChangeCount}</span>}</button>
            <div className="workflow-more">
               <button className="btn btn-icon" onClick={() => { setMenuOpen(value => !value); setConfirmDelete(false); }} disabled={!selectedFile} title={t('manageWorkflow')}><Icon name="more" size={15} /></button>
              {menuOpen && (
                <>
                  <div className="workflow-more-backdrop" onClick={() => setMenuOpen(false)} />
                  <div className="workflow-more-menu">
                    {confirmDelete ? (
                      <div className="workflow-more-delete-confirm">
                         <span>{t('deleteWorkflowConfirm', { name: workflowDisplayName(selectedFile) })}</span>
                        <div className="workflow-more-actions">
                           <button className="btn btn-danger" onClick={() => void handleDelete()}>{t('delete')}</button>
                           <button className="btn" onClick={() => setConfirmDelete(false)}>{t('cancel')}</button>
                        </div>
                      </div>
                    ) : (
                      <>
                         <button className="workflow-more-item" onClick={startRename}><Icon name="edit" size={13} /> {t('rename')}</button>
                         <button className="workflow-more-item danger" onClick={() => void handleDelete()}><Icon name="trash" size={13} /> {t('delete')}</button>
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
          {renameOpen && (
            <div className="workflow-rename-row">
              <input className="settings-input" value={renameValue}
                onChange={event => setRenameValue(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter') void handleRenameSubmit();
                  if (event.key === 'Escape') setRenameOpen(false);
                }}
                 placeholder={t('newFileName')} autoFocus />
               <button className="btn" onClick={() => void handleRenameSubmit()}>{t('confirm')}</button>
               <button className="btn" onClick={() => { setRenameOpen(false); setRenameValue(''); }}>{t('cancel')}</button>
            </div>
          )}
            <p className="workflow-import-hint">{t('importHint')}</p>
           {workflowManifest && <div className="workflow-manifest-summary"><span>{workflowManifest.modelType || workflowManifest.promptProfile?.family || t('genericWorkflow')}</span><span>{workflowManifest.nodeCount || 0} {t('nodes')}</span><span>{t('positive')} {positiveTargetCount} · {t('negative')} {negativeTargetCount}</span><span>{workflowManifest.capabilities?.modes?.join(' / ') || 'txt2img'}</span></div>}
           {importFeedback && <div className={`workflow-import-feedback ${importFeedback.type}`}><Icon name={importFeedback.type === 'ok' ? 'check' : 'circleAlert'} size={13} /><span>{importFeedback.text}</span></div>}
           {dragOver && <div className="workflow-drop-overlay"><Icon name="upload" size={20} /><span>{t('releaseToImport')}</span></div>}
         </section>

         <section className="workspace-section prompt-section">
           <div className="workspace-section-heading"><div><span className="section-kicker">02</span><div><h3>{t('promptTemplate')}</h3><p>{promptProfile?.family || t('waitingWorkflow')}</p></div></div><span className="prompt-target-count">{t('positive')} {positiveTargetCount} · {t('negative')} {negativeTargetCount}</span></div>
           <div className="prompt-mode-grid" role="group" aria-label={t('promptTemplate')}>
             {VISIBLE_PROMPT_MODES.map(id => <button key={id} type="button" className={`prompt-mode-card${promptMode === id ? ' active' : ''}`} onClick={() => setPromptMode(id)} aria-pressed={promptMode === id}><strong>{t(modeText[id][0])}</strong><span>{t(modeText[id][1])}</span></button>)}
          </div>
          <button className="prompt-library-launch" type="button" onClick={onOpenPromptLibrary}>
            <span className="prompt-library-launch-mark"><Icon name="library" size={15} /></span>
             <span><strong>{t('openPromptWorkspace')}</strong><small>{t('chooseEnglishFragments')}</small></span>
            <span className="prompt-library-launch-arrow"><Icon name="chevronRight" size={16} /></span>
          </button>
           <p className="prompt-mode-help"><strong>{t('currentEffect')}：</strong>{t(promptModeHelp)}</p>
           {workflowManifest && <p className="prompt-template-summary">{promptProfile?.supportsNegative === false ? t('promptOnlyPositive') : t('promptTargetsSummary', { positive: positiveTargetCount, negative: negativeTargetCount })}</p>}
        </section>

       {(status === 'error' || status === 'cancelled') && <div className={`status-bar ${status}`}><span className="status-indicator" /><span>{statusMsg || t(statusText[status])}</span></div>}

      </div>}
    </section>
  );
}
