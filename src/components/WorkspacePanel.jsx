import { useEffect, useRef, useState } from 'react';
import { useComfyUI } from '../contexts/ComfyUIContext.jsx';
import { countControlChanges } from './node-controls.mjs';
import TabBar from './TabBar.jsx';
import WorkflowSection from './WorkflowSection.jsx';
import PromptSection from './PromptSection.jsx';
import ParamsSection from './ParamsSection.jsx';
import QueueTab from './QueueTab.jsx';
import Icon from './Icon.jsx';
import { useI18n } from '../i18n/I18nContext.jsx';
import { useBatchQueue } from '../contexts/BatchQueueContext.jsx';

export default function WorkspacePanel({ onOpenPromptLibrary }) {
  const { t } = useI18n();
  const { badge: queueBadge } = useBatchQueue();
  const [collapsed, setCollapsed] = useState(false);
  const [activeTab, setActiveTab] = useState('workflow');
  const [dragOver, setDragOver] = useState(false);
  const [importFeedback, setImportFeedback] = useState(null);
  const importFeedbackTimer = useRef(null);
  const {
    selectedFile,
    workflowManifest,
    generationControls,
    generationPhase,
  } = useComfyUI();
  const controlChangeCount = countControlChanges(generationControls);

  useEffect(() => () => clearTimeout(importFeedbackTimer.current), []);

  useEffect(() => {
    const openQueueTab = () => setActiveTab('queue');
    window.addEventListener('comfy-agent:open-queue-tab', openQueueTab);
    return () => window.removeEventListener('comfy-agent:open-queue-tab', openQueueTab);
  }, []);

  const showImportFeedback = (type, text) => {
    setImportFeedback({ type, text });
    clearTimeout(importFeedbackTimer.current);
    importFeedbackTimer.current = setTimeout(() => setImportFeedback(null), 6000);
  };

  const tabs = [
    { id: 'workflow', label: t('workflow'), icon: 'workflow' },
    { id: 'prompt', label: t('promptTemplate'), icon: 'spark' },
    { id: 'params', label: t('parameters'), icon: 'sliders', badge: controlChangeCount },
    { id: 'queue', label: t('queueTabLabel'), icon: 'grid', badge: queueBadge },
  ];

  return (
    <section className={`panel-right workspace-sidebar${collapsed ? ' collapsed' : ''}${dragOver ? ' drag-over' : ''}`}>
      <div className="panel-right-header">
        <div><span className="sidebar-eyebrow">CONTROL ROOM</span><strong className="workspace-title">{t('workflow')}</strong></div>
        <div className="panel-right-controls">
          {workflowManifest && <span className="tag tag-ok">{t('workflow')} · OK</span>}
          <button className="btn btn-icon workspace-collapse" onClick={() => setCollapsed(value => !value)} title={collapsed ? t('expandSidebar') : t('collapseSidebar')}><Icon name={collapsed ? 'chevronLeft' : 'chevronRight'} /></button>
        </div>
      </div>

      {!collapsed && (
        <>
          <TabBar tabs={tabs} active={activeTab} onChange={setActiveTab} />
          <div className="workspace-scroll">
            {activeTab === 'workflow' && <WorkflowSection dragOver={dragOver} setDragOver={setDragOver} importFeedback={importFeedback} showImportFeedback={showImportFeedback} />}
            {activeTab === 'prompt' && <PromptSection onOpenPromptLibrary={onOpenPromptLibrary} />}
            {activeTab === 'params' && <ParamsSection />}
            {activeTab === 'queue' && <QueueTab />}
          </div>
        </>
      )}
    </section>
  );
}
