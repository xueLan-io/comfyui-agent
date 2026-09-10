import { useEffect, useRef, useState } from 'react';
import { useComfyUI } from '../contexts/ComfyUIContext.jsx';
import Icon from './Icon.jsx';
import { useI18n } from '../i18n/I18nContext.jsx';

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

export default function WorkflowSection({ dragOver, setDragOver, importFeedback, showImportFeedback }) {
  const { t } = useI18n();
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
    inspectingWorkflow,
    handleShowWorkflowDir,
    importWorkflows,
    deleteWorkflow,
    renameWorkflow,
    favoriteWorkflows,
    recentWorkflows,
    toggleFavoriteWorkflow,
  } = useComfyUI();

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

  const applyImportResult = result => {
    if (!result) return;
    const failed = (result.results || []).filter(item => item.status !== 'imported');
    if (result.imported?.length > 0 && failed.length === 0) {
      showImportFeedback('ok', t('wsImported', { n: result.imported.length }));
    } else if (result.imported?.length > 0) {
      showImportFeedback('warn', t('wsImportedFailed', { n: result.imported.length, failed: failed.length, items: failed.map(item => `${workflowDisplayName(item.name)} ${item.error || ''}`).join('、') }));
    } else if (failed.length > 0) {
      showImportFeedback('error', failed.map(item => `${workflowDisplayName(item.name)} ${item.error || ''}`).join('、'));
    }
  };

  const handleImportClick = async () => {
    try {
      const result = await window.electronAPI.selectWorkflowFiles();
      applyImportResult(result);
    } catch (error) {
      showImportFeedback('error', error.message || t('wsImportFailed'));
    }
  };

  const handleDrop = async event => {
    setDragOver(false);
    const files = Array.from(event.dataTransfer?.files || []);
    if (files.length === 0) return;
    try {
      const paths = files.map(file => window.electronAPI.getPathForFile(file)).filter(Boolean);
      if (paths.length === 0) {
        showImportFeedback('error', t('wsCantReadDropped'));
        return;
      }
      const result = await importWorkflows(paths);
      applyImportResult(result);
    } catch (error) {
      showImportFeedback('error', error.message || t('wsImportFailed'));
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
      showImportFeedback('error', t('wsJsonRequired'));
      return;
    }
    if (/[\\/]/.test(next)) {
      showImportFeedback('error', t('wsNoPathSeparators'));
      return;
    }
    try {
      await renameWorkflow(selectedFile, next);
      setRenameOpen(false);
      setMenuOpen(false);
      showImportFeedback('ok', t('wsRenamed', { name: next }));
    } catch (error) {
      showImportFeedback('error', error.message || t('wsRenameFailed'));
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
      showImportFeedback('ok', t('wsDeleted', { name: workflowDisplayName(name) }));
    } catch (error) {
      showImportFeedback('error', error.message || t('wsDeleteFailed'));
    }
  };

  const { rootItems, groups } = workflowGroups(workflowFiles);
  const normalizedWorkflowQuery = workflowQuery.trim().toLocaleLowerCase();
  const matchesWorkflow = file => !normalizedWorkflowQuery || file.toLocaleLowerCase().includes(normalizedWorkflowQuery);
  const filteredRootItems = rootItems.filter(file => matchesWorkflow(file) && !favoriteWorkflows.includes(file) && !recentWorkflows.includes(file));
  const filteredGroups = groups.map(group => ({ ...group, items: group.items.filter(file => matchesWorkflow(file) && !favoriteWorkflows.includes(file) && !recentWorkflows.includes(file)) })).filter(group => group.items.length > 0);
  const favoriteFiles = favoriteWorkflows.filter(file => workflowFiles.includes(file) && matchesWorkflow(file));
  const recentFiles = recentWorkflows.filter(file => workflowFiles.includes(file) && matchesWorkflow(file) && !favoriteFiles.includes(file));
  const positiveTargetCount = workflowManifest?.promptProfile?.positiveTargets?.length || 0;
  const negativeTargetCount = workflowManifest?.promptProfile?.negativeTargets?.length || 0;

  return (
    <section className="workspace-section workflow-section"
      onDragEnter={event => {
        if (Array.from(event.dataTransfer?.files || []).some(file => /\.json$/i.test(file.name))) setDragOver(true);
      }}
      onDragLeave={event => {
        if (event.currentTarget === event.target) setDragOver(false);
      }}
      onDragOver={handleDragOver}
      onDrop={handleDrop}>
      <div className="workspace-section-heading">
        <div>
          <span className="section-kicker">01</span>
          <div>
            <h3>{t('workflow')}</h3>
            <p>{workflowDir || t('chooseWorkflow')}</p>
          </div>
        </div>
        <span className="workflow-count">{normalizedWorkflowQuery ? `${filteredRootItems.length + filteredGroups.reduce((count, group) => count + group.items.length, 0)} / ` : ''}{workflowFiles.length} {t('items')}</span>
      </div>
      <div className="workflow-picker-row">
        <div className="workflow-search-wrap">
          <input ref={workflowSearchRef} className="workflow-search" value={workflowQuery} onChange={event => setWorkflowQuery(event.target.value)} placeholder={t('searchWorkflow')} aria-label={t('searchWorkflow')} title="Ctrl/Cmd+K" />
          {workflowQuery && <button className="workflow-search-clear" onClick={() => { setWorkflowQuery(''); workflowSearchRef.current?.focus(); }} aria-label={t('searchWorkflow')} title={t('close')}><Icon name="close" size={12} /></button>}
        </div>
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
      {inspectingWorkflow && <div className="workflow-manifest-summary workflow-inspecting"><span>{t('wsInspecting')}</span></div>}
      {workflowManifest && <div className="workflow-manifest-summary"><span>{workflowManifest.modelType || workflowManifest.promptProfile?.family || t('genericWorkflow')}</span><span>{workflowManifest.nodeCount || 0} {t('nodes')}</span><span>{t('positive')} {positiveTargetCount} · {t('negative')} {negativeTargetCount}</span><span>{workflowManifest.capabilities?.modes?.join(' / ') || 'txt2img'}</span></div>}
      {importFeedback && <div className={`workflow-import-feedback ${importFeedback.type}`}><Icon name={importFeedback.type === 'ok' ? 'check' : 'circleAlert'} size={13} /><span>{importFeedback.text}</span></div>}
      {dragOver && <div className="workflow-drop-overlay"><Icon name="upload" size={20} /><span>{t('releaseToImport')}</span></div>}
    </section>
  );
}
