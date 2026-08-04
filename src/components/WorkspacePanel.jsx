import { useState } from 'react';
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

export default function WorkspacePanel({ onOpenPromptLibrary }) {
  const [collapsed, setCollapsed] = useState(false);
  const {
    selectedFile,
    setSelectedFile,
    workflowFiles,
    workflowDir,
    workflowManifest,
    generationControls,
    setShowNodeControls,
    handleShowWorkflowDir,
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
  return (
    <section className={`panel-right workspace-sidebar${collapsed ? ' collapsed' : ''}`}>
      <div className="panel-right-header">
        <div><span className="sidebar-eyebrow">CONTROL ROOM</span><strong className="workspace-title">工作流</strong></div>
        <div className="panel-right-controls">
          {statusLabel(status) && <span className={`tag tag-${status === 'error' ? 'err' : status === 'running' ? 'processing' : 'ok'}`}>{statusLabel(status)}</span>}
          <button className="btn btn-icon workspace-collapse" onClick={() => setCollapsed(value => !value)} title={collapsed ? '展开工作区' : '收起工作区'}><Icon name={collapsed ? 'chevronLeft' : 'chevronRight'} /></button>
        </div>
      </div>

      {!collapsed && <div className="workspace-scroll">
        <section className="workspace-section workflow-section">
          <div className="workspace-section-heading"><div><span className="section-kicker">01</span><div><h3>工作流</h3><p>{workflowDir || '选择一个 ComfyUI 工作流'}</p></div></div></div>
          <div className="workflow-picker-row">
            <select className="wf-select" value={selectedFile} onChange={event => setSelectedFile(event.target.value)} aria-label="选择工作流">
              <option value="">选择工作流...</option>
              {workflowFiles.map(file => <option key={file} value={file}>{file}</option>)}
            </select>
            <button className="btn" onClick={handleShowWorkflowDir} title={selectedFile ? '打开 ' + selectedFile + ' 所在目录' : (workflowDir || '打开工作流目录')}>目录</button>
            <button className="btn node-controls-trigger" onClick={() => setShowNodeControls(true)} disabled={!workflowManifest} title="编辑工作流参数"><Icon name="sliders" size={14} /> 参数{controlChangeCount > 0 && <span className="node-control-count">{controlChangeCount}</span>}</button>
          </div>
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
