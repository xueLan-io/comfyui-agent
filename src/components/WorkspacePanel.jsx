import { useEffect, useRef, useState } from 'react';
import { useComfyUI } from '../contexts/ComfyUIContext.jsx';
import { useAgent } from '../contexts/AgentContext.jsx';
import { countControlChanges } from './node-controls.mjs';
import Icon from './Icon.jsx';

const PROMPT_MODES = [
  { id: 'anime-character', label: '角色立绘', description: '突出人物与服装' },
  { id: 'anime-scene', label: '场景插画', description: '突出环境与镜头' },
  { id: 'anime-polish', label: '画面优化', description: '只补质量与缺陷' },
  { id: 'raw', label: '原始描述', description: '按原意执行' },
  { id: 'cinematic', label: '电影质感', description: '补足镜头与氛围' },
  { id: 'anime', label: '动漫风格', description: '强化动漫标签表达' },
  { id: 'photorealistic', label: '写实摄影', description: '强化摄影与材质' },
  { id: 'concept', label: '概念设计', description: '强化设计稿结构' },
];

function statusLabel(status) {
  return { running: '运行中', completed: '已完成', error: '失败', cancelled: '已取消' }[status] || '';
}

const PROMPT_MODE_HELP = {
  raw: '保留你的原始词序和权重，只注入当前工作流。',
  anime: '按动漫模型顺序整理角色、外观、姿势和场景。',
  'anime-character': '优先保护角色身份、年龄、服装、脸部和姿势，不擅自添加场景。',
  'anime-scene': '补充景别、空间关系、光线和背景，让角色融入场景。',
  'anime-polish': '补充渲染质量、手部和画面整洁度，不改变主体内容。',
  cinematic: '补充镜头、光影和氛围，适合有明确叙事的画面。',
  photorealistic: '补充摄影和材质语言，不适合当前动漫模型。',
  concept: '补充轮廓、构图和设计意图，适合概念设定。',
};

const VISIBLE_PROMPT_MODES = PROMPT_MODES.filter(item => ['raw', 'anime', 'anime-character', 'anime-scene', 'anime-polish'].includes(item.id));

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
  const promptModeHelp = PROMPT_MODE_HELP[promptMode] || PROMPT_MODE_HELP.anime;

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
        <div><span className="sidebar-eyebrow">CONTROL ROOM</span><strong className="workspace-title">工作流</strong></div>
        <div className="panel-right-controls">
          {statusLabel(status) && <span className={`tag tag-${status === 'error' ? 'err' : status === 'running' ? 'processing' : 'ok'}`}>{statusLabel(status)}</span>}
          <button className="btn btn-icon workspace-collapse" onClick={() => setCollapsed(value => !value)} title={collapsed ? '展开工作区' : '收起工作区'}><Icon name={collapsed ? 'chevronLeft' : 'chevronRight'} /></button>
        </div>
      </div>

      {!collapsed && <div className="workspace-scroll">
        <section className="workspace-section workflow-section">
           <div className="workspace-section-heading"><div><span className="section-kicker">01</span><div><h3>工作流</h3><p>{workflowDir || '选择一个 ComfyUI 工作流'}</p></div></div><span className="workflow-count">{normalizedWorkflowQuery ? `${filteredRootItems.length + filteredGroups.reduce((count, group) => count + group.items.length, 0)} / ` : ''}{workflowFiles.length} 个</span></div>
           <div className="workflow-picker-row">
             <div className="workflow-search-wrap"><input ref={workflowSearchRef} className="workflow-search" value={workflowQuery} onChange={event => setWorkflowQuery(event.target.value)} placeholder="搜索工作流..." aria-label="搜索工作流" title="快捷键 Ctrl/Cmd+K" />{workflowQuery && <button className="workflow-search-clear" onClick={() => { setWorkflowQuery(''); workflowSearchRef.current?.focus(); }} aria-label="清空工作流搜索" title="清空搜索"><Icon name="close" size={12} /></button>}</div>
             <select className="wf-select" value={selectedFile} onChange={event => selectWorkflow(event.target.value)} aria-label="选择工作流">
               <option value="">选择工作流...</option>
               {filteredRootItems.length === 0 && filteredGroups.length === 0 && <option value="" disabled>没有匹配的工作流</option>}
               {favoriteFiles.length > 0 && <optgroup label="收藏"><>{favoriteFiles.map(file => <option key={`favorite-${file}`} value={file}>★ {workflowDisplayName(file)}</option>)}</></optgroup>}
               {recentFiles.length > 0 && <optgroup label="最近使用"><>{recentFiles.map(file => <option key={`recent-${file}`} value={file}>{workflowDisplayName(file)}</option>)}</></optgroup>}
               {filteredRootItems.map(file => <option key={file} value={file}>{file}</option>)}
               {filteredGroups.map(group => (
                <optgroup key={group.name} label={group.name}>
                  {group.items.map(file => <option key={file} value={file}>{workflowDisplayName(file)}</option>)}
                </optgroup>
              ))}
             </select>
             <button className={`btn btn-icon workflow-favorite${favoriteWorkflows.includes(selectedFile) ? ' active' : ''}`} onClick={() => toggleFavoriteWorkflow(selectedFile)} disabled={!selectedFile} title={favoriteWorkflows.includes(selectedFile) ? '取消收藏' : '收藏工作流'} aria-label={favoriteWorkflows.includes(selectedFile) ? '取消收藏' : '收藏工作流'}>★</button>
            <button className="btn" onClick={handleImportClick} title="从外部导入 ComfyUI 工作流文件（.json）"><Icon name="upload" size={14} /> 导入</button>
            <button className="btn" onClick={handleShowWorkflowDir} title={selectedFile ? '打开 ' + selectedFile + ' 所在目录' : (workflowDir || '打开工作流目录')}>目录</button>
            <button className="btn node-controls-trigger" onClick={() => setShowNodeControls(true)} disabled={!workflowManifest} title="编辑工作流参数"><Icon name="sliders" size={14} /> 参数{controlChangeCount > 0 && <span className="node-control-count">{controlChangeCount}</span>}</button>
            <div className="workflow-more">
              <button className="btn btn-icon" onClick={() => { setMenuOpen(value => !value); setConfirmDelete(false); }} disabled={!selectedFile} title="管理工作流"><Icon name="more" size={15} /></button>
              {menuOpen && (
                <>
                  <div className="workflow-more-backdrop" onClick={() => setMenuOpen(false)} />
                  <div className="workflow-more-menu">
                    {confirmDelete ? (
                      <div className="workflow-more-delete-confirm">
                        <span>确定删除 <strong>{workflowDisplayName(selectedFile)}</strong>？</span>
                        <div className="workflow-more-actions">
                          <button className="btn btn-danger" onClick={() => void handleDelete()}>删除</button>
                          <button className="btn" onClick={() => setConfirmDelete(false)}>取消</button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <button className="workflow-more-item" onClick={startRename}><Icon name="edit" size={13} /> 重命名</button>
                        <button className="workflow-more-item danger" onClick={() => void handleDelete()}><Icon name="trash" size={13} /> 删除</button>
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
                placeholder="新文件名（保留 .json）" autoFocus />
              <button className="btn" onClick={() => void handleRenameSubmit()}>确定</button>
              <button className="btn" onClick={() => { setRenameOpen(false); setRenameValue(''); }}>取消</button>
            </div>
          )}
           <p className="workflow-import-hint">支持从对话框选择或直接拖拽 .json 文件导入，导入后自动复制到工作流目录并选中。</p>
           {workflowManifest && <div className="workflow-manifest-summary"><span>{workflowManifest.modelType || workflowManifest.promptProfile?.family || '通用工作流'}</span><span>{workflowManifest.nodeCount || 0} 个节点</span><span>正向 {positiveTargetCount} · 负向 {negativeTargetCount}</span><span>{workflowManifest.capabilities?.modes?.join(' / ') || 'txt2img'}</span></div>}
          {importFeedback && <div className={`workflow-import-feedback ${importFeedback.type}`}><Icon name={importFeedback.type === 'ok' ? 'check' : 'circleAlert'} size={13} /><span>{importFeedback.text}</span></div>}
          {dragOver && <div className="workflow-drop-overlay"><Icon name="upload" size={20} /><span>松开以导入工作流</span></div>}
        </section>

        <section className="workspace-section prompt-section">
          <div className="workspace-section-heading"><div><span className="section-kicker">02</span><div><h3>提示词模板</h3><p>{promptProfile?.family || '等待工作流识别'}</p></div></div><span className="prompt-target-count">正向 {positiveTargetCount} · 负向 {negativeTargetCount}</span></div>
          <div className="prompt-mode-grid" role="group" aria-label="提示词模板">
            {VISIBLE_PROMPT_MODES.map(item => <button key={item.id} type="button" className={`prompt-mode-card${promptMode === item.id ? ' active' : ''}`} onClick={() => setPromptMode(item.id)} aria-pressed={promptMode === item.id}><strong>{item.label}</strong><span>{item.description}</span></button>)}
          </div>
          <button className="prompt-library-launch" type="button" onClick={onOpenPromptLibrary}>
            <span className="prompt-library-launch-mark"><Icon name="library" size={15} /></span>
            <span><strong>打开提示词工作台</strong><small>按分类挑选英文片段</small></span>
            <span className="prompt-library-launch-arrow"><Icon name="chevronRight" size={16} /></span>
          </button>
          <p className="prompt-mode-help"><strong>当前作用：</strong>{promptModeHelp}</p>
          {workflowManifest && <p className="prompt-template-summary">{promptProfile?.supportsNegative === false ? '当前工作流只写入正向提示词。' : `当前工作流将写入 ${positiveTargetCount} 个正向目标和 ${negativeTargetCount} 个负向目标。`}</p>}
        </section>

        {(status === 'error' || status === 'cancelled') && <div className={`status-bar ${status}`}><span className="status-indicator" /><span>{statusMsg || statusLabel(status)}</span></div>}

      </div>}
    </section>
  );
}
