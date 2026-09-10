import { useEffect, useMemo, useState } from 'react';
import { useAgent } from '../contexts/AgentContext.jsx';
import { useComfyUI } from '../contexts/ComfyUIContext.jsx';
import { useSession } from '../contexts/SessionContext.jsx';
import AgentMessage from './AgentMessage.jsx';
import ExecutionGraph from './ExecutionGraph.jsx';
import ActivityTimeline from './ActivityTimeline.jsx';
import ModelSelector from './ModelSelector.jsx';
import Icon from './Icon.jsx';
import GenerationRecordCard from './GenerationRecordCard.jsx';
import BatchResultCard from './BatchResultCard.jsx';
import ShortcutsHelpModal from './ShortcutsHelpModal.jsx';
import { useI18n } from '../i18n/I18nContext.jsx';
import { useBatchQueue } from '../contexts/BatchQueueContext.jsx';
import { matchingSlashCommands, parseSlashCommand } from '../runtime/slash-commands.mjs';

function conversationSearchId(message = {}) {
  return message.messageId || message.id || `${message.turnId || 'message'}:${message.role || 'x'}`;
}

function buildConversationExport({ entries, executionRecords, sessionTitle, projectTitle, format }) {
  const diagnostics = Object.entries(executionRecords || {}).map(([turnId, events]) => ({
    turnId,
    events: (events || []).map(event => ({
      time: event.time || '', type: event.type || '', stage: event.stage || '', status: event.status || '', description: event.description || event.message || '', tool: event.tool || '', taskId: event.taskId || '', traceId: event.traceId || '', code: event.code || '', error: event.error || null, result: event.result || null,
    })),
  })).filter(item => item.events.length > 0);
  const meta = {
    title: sessionTitle || '会话',
    project: projectTitle || '',
    exportedAt: new Date().toLocaleString(),
    entries: entries.filter(entry => entry.kind === 'message').map(entry => {
      const message = entry.data;
      const base = { role: message.role, time: message.time || '', content: message.content || '', prompt: message.prompt || '', negative: message.negative || '', turnId: message.turnId || '' };
      const attachments = (message.attachments || []).map(item => ({ name: item.name || '', kind: item.kind || 'image' }));
      const media = (message.media || [...(message.images || []), ...(message.videos || [])]).map(item => ({ filename: item.filename || item.name || '', subfolder: item.subfolder || '', type: item.type || item.mediaType || '' }));
      return { ...base, attachments, media };
    }),
    records: entries.filter(entry => entry.kind === 'record').map(entry => ({
      turnId: entry.data.turnId || '', prompt: entry.data.prompt || '', negative: entry.data.negative || '', workflowName: entry.data.workflowName || '', status: entry.data.status || '', parameters: entry.data.parameters || {}, error: entry.data.error || null,
      media: (entry.data.media || [...(entry.data.images || []), ...(entry.data.videos || [])]).map(item => ({ filename: item.filename || item.name || '', subfolder: item.subfolder || '', type: item.type || item.mediaType || '' })),
    })),
    diagnostics,
  };
  if (format === 'json') return JSON.stringify(meta, null, 2);
  const lines = [`# ${meta.title}`, '', `- 项目：${meta.project || '未指定'}`, `- 导出时间：${meta.exportedAt}`, ''];
  for (const entry of meta.entries) {
    if (entry.role === 'user') {
      lines.push('## 用户', '', entry.content || '（图片）', '');
      if (entry.attachments.length) lines.push(`参考素材：${entry.attachments.map(item => item.name).join('、')}`, '');
    } else {
      lines.push('## 助手', '', entry.content || '', '');
      if (entry.prompt) lines.push(`正向提示词：${entry.prompt}`, '');
      if (entry.negative) lines.push(`负向提示词：${entry.negative}`, '');
    }
  }
  if (meta.records.length) {
    lines.push('## 生成记录', '');
    for (const record of meta.records) lines.push(`- ${record.workflowName || '未指定工作流'} · ${record.status || ''}`, `  正向：${record.prompt || '无'}`, record.negative ? `  负向：${record.negative}` : '', record.media.length ? `  媒体：${record.media.map(item => item.filename).join('、')}` : '', record.error ? `  错误：${record.error.message || JSON.stringify(record.error)}` : '');
    lines.push('');
  }
  if (meta.diagnostics.length) {
    lines.push('## 执行诊断', '');
    for (const diagnostic of meta.diagnostics) {
      lines.push(`### 轮次 ${diagnostic.turnId}`, '');
      for (const event of diagnostic.events) lines.push(`- [${event.status || 'info'}] ${event.description || event.type || '执行事件'}${event.tool ? ` · ${event.tool}` : ''}${event.code ? ` · ${event.code}` : ''}${event.traceId ? ` · Trace: ${event.traceId}` : ''}`);
      lines.push('');
    }
  }
  return lines.filter((line, index, list) => line || list[index - 1] !== '').join('\n');
}

function formatTokens(value) {
  const tokens = Number(value) || 0;
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(tokens >= 10000 ? 0 : 1)}k` : String(tokens);
}

const TIMING_LABELS = {
  turn_start: '请求开始',
  turn_end: '请求结束',
  intent_start: '意图分类中',
  intent_end: '意图分类结束',
  plan_start: '规划中',
  plan_end: '规划结束',
  enhance_start: '提示词增强中',
  enhance_end: '提示词增强结束',
  planner_llm_start: '规划器 LLM 调用中',
  planner_llm_end: '规划器 LLM 调用结束',
  enhance_llm_start: '增强器 LLM 调用中',
  enhance_llm_end: '增强器 LLM 调用结束',
  enhance_vision_skipped: '已忽略参考图（当前模型不支持图像输入，参考图仍将作为工作流输入）',
};

function displayExecutionEvent(event = {}) {
  const planSteps = event.steps ?? event.plan?.steps ?? [];
  if (event.scope === 'timing') {
    const completed = event.stage?.endsWith('_end');
    return {
      ...event,
      description: event.description || event.message || TIMING_LABELS[event.stage] || event.stage || '计时事件',
      status: event.outcome === 'error' ? 'error' : event.outcome === 'cancelled' ? 'cancelled' : completed ? 'completed' : 'running',
    };
  }
  if (event.type === 'agent:plan' && planSteps.length > 0) return {
    ...event,
    stage: 'planning',
    description: event.description || `已创建执行计划，共 ${planSteps.length} 步`,
    status: 'planning',
  };
  if (event.type === 'agent:tool-call') return {
    ...event,
    description: event.description || `正在调用 ${event.tool || '工具'}...`,
    status: 'running',
  };
  if (event.type === 'agent:tool-result') return {
    ...event,
    description: event.description || `${event.tool || '工具'} 已完成`,
    status: event.error ? 'error' : 'completed',
  };
  if (event.type === 'agent:error') return {
    ...event,
    description: event.description || event.message || '任务执行失败',
    status: 'error',
    error: event.error || event.message,
  };
  return event;
}

function executionEventKey(event = {}) {
  const planSteps = event.steps ?? event.plan?.steps ?? [];
  const planKey = planSteps.map(step => step.id || step.stepId || step.tool || '').join(',');
  return [
    event.turnId || '',
    event.taskId || '',
    event.traceId || '',
    event.type || '',
    event.stage || '',
    event.stepId || '',
    event.status || '',
    event.tool || '',
    event.attemptId || '',
    event.currentAttempt || event.attempt || '',
    event.outcome || '',
    event.duration_ms ?? '',
    planKey,
  ].join('|');
}

function isVisibleExecutionEvent(event = {}) {
  // Older persisted plan records were emitted before task ownership existed.
  // They cannot be reliably associated with a live turn, so never render them.
  if (!event.taskId && !event.traceId && !event.turnId) return false;
  if (event.type !== 'agent:plan') return true;
  return (event.steps ?? event.plan?.steps ?? []).length > 0;
}

function graphStepsFor(events = []) {
  const steps = new Map();
  events.forEach((event, index) => {
    const item = displayExecutionEvent(event);
    if (!item.status || (!item.tool && item.stage !== 'planning')) return;
    const key = [item.stepId || item.tool || item.stage || 'event', item.attemptId || item.currentAttempt || item.attempt || '', item.sequence ?? index].join(':');
    steps.set(key, { ...item, _key: key, _order: index });
  });
  return [...steps.values()].sort((a, b) => a._order - b._order);
}

function ExecutionThread({ events, progress, active, statusLabel, statusMsg, recoverable, onCancel, t, onOpenTrace }) {
  const [open, setOpen] = useState(false);
  const visibleEvents = events.filter(isVisibleExecutionEvent).map(displayExecutionEvent);
  const steps = graphStepsFor(visibleEvents);
  useEffect(() => {
    if (active) setOpen(true);
  }, [active]);
  const terminalEvent = [...visibleEvents].reverse().find(event => ['completed', 'error', 'failed', 'cancelled', 'abandoned', 'archive_failed'].includes(event.status));
  if (!active && !visibleEvents.length) return null;
  const summary = statusMsg || t('processing');
  return (
    <section className={`execution-thread${active ? ' execution-thread-active' : ''}`}>
      <button className="execution-thread-toggle" onClick={() => setOpen(value => !value)} aria-expanded={open}>
        <span>{active ? (statusLabel || t('runtime')) : `${t('runtime')} · ${steps.length} ${t('steps')}`}</span>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={13} />
      </button>
      {open && <>
        {active && <div className="execution-thread-live-status" role="status" aria-live="polite">
          <span className="execution-thread-live-indicator" aria-hidden="true" />
          <span>{summary}</span>
          {recoverable && <small>{t('continueWatching')}</small>}
          {onCancel && <button className="btn btn-clear execution-thread-stop" onClick={onCancel} title={t('stopTask')} aria-label={t('stopTask')}><Icon name="stop" size={13} /></button>}
        </div>}
        {!active && terminalEvent && <div className={`execution-thread-summary execution-thread-summary-${terminalEvent.status}`}>{terminalEvent.description || terminalEvent.message || terminalEvent.status}</div>}
        {steps.length > 0 && <ExecutionGraph steps={steps} progress={progress} />}
        {visibleEvents.length > 0 && <ActivityTimeline events={visibleEvents} onOpenTrace={onOpenTrace} />}
      </>}
    </section>
  );
}

function ContextRing({ usage, t }) {
  const displayUsage = usage || {
    occupancyPercent: 0,
    inputTokens: 0,
    reservedOutputTokens: 1024,
    inputBudget: 0,
    contextWindow: 0,
    mode: 'unknown',
    source: 'estimate',
    archiveCount: 0,
  };
  const hasUsage = Boolean(usage);
  const percent = Math.max(0, Math.min(100, Number(displayUsage.occupancyPercent) || 0));
  const radius = 12;
  const circumference = 2 * Math.PI * radius;
  const color = percent >= 90 ? 'critical' : percent >= 75 ? 'warning' : 'normal';
  return (
    <div className={`context-ring-wrap ${color} ${hasUsage ? '' : 'context-ring-empty'}`} title={t('contextBudget')}>
      <div className="context-ring" tabIndex="0" aria-label={hasUsage ? t('contextUsage', { percent }) : t('contextAfterMessage')}>
        <svg viewBox="0 0 32 32" aria-hidden="true">
          <circle className="context-ring-track" cx="16" cy="16" r={radius} />
          <circle className="context-ring-value" cx="16" cy="16" r={radius} style={{ strokeDasharray: circumference, strokeDashoffset: circumference * (1 - percent / 100) }} />
        </svg>
        <span>{hasUsage ? `${percent}%` : '--'}</span>
      </div>
      <div className="context-ring-popover" role="status">
         <strong>{t('contextBudget')}</strong>
         {!hasUsage && <span>{t('contextAfterSend')}</span>}
        {hasUsage && <>
           <span>{t('inputReserved', { input: formatTokens(displayUsage.inputTokens), output: formatTokens(displayUsage.reservedOutputTokens) })}</span>
          <span>{formatTokens(displayUsage.inputBudget)} / {formatTokens(displayUsage.contextWindow)} tokens</span>
           <span>{displayUsage.mode === 'local' ? t('localBudget') : t('cloudBudget')} · {displayUsage.source === 'provider' ? t('providerValue') : t('estimatedValue')}</span>
           {displayUsage.archiveCount > 0 && <span>{t('archivedSegments', { count: displayUsage.archiveCount })}</span>}
           {displayUsage.retryAttempt > 0 && <b>{t('degradedRetry', { count: displayUsage.retryAttempt + 1 })}</b>}
           {displayUsage.truncated && <b>{t('compressedHistory', { count: displayUsage.droppedMessageCount || 0 })}</b>}
        </>}
      </div>
    </div>
  );
}

export default function ChatPanel({ active = true, onReady }) {
  const { t } = useI18n();
  const session = useSession();
  const { completedBatches } = useBatchQueue();
  const [chatAction, setChatAction] = useState('creative');
  const [imageOptions, setImageOptions] = useState({ size: 'auto', count: 1, quality: 'auto' });
  const [presetFeedback, setPresetFeedback] = useState('');
  const [skills, setSkills] = useState([]);
  const [commandIndex, setCommandIndex] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchActiveId, setSearchActiveId] = useState('');
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState('');
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const {
    messages,
    activityEvents,
    executionRecords,
    generationRecords,
    images,
    media,
    removeAsset,
    generationPending,
    thinking,
    generationSource,
    handleRegenerate,
    input,
    setInput,
    attachments,
    handleAttachMedia,
    handlePasteImage,
    removeAttachment,
    status,
    runtimeView,
    statusMsg,
    generationProgress,
    handleSend: sendMessage,
    handleCancel,
    handleKeyDown,
    inputRef,
    msgEndRef,
    conversationRef,
    thinkingTextRef,
    handleConversationScroll,
    setPreview,
    setTrace,
    setShowTrace,
    clearConversation,
    compactConversation,
    createNewSession,
    getRuntimeStatus,
    editingMessageIndex,
    handleEditMessage,
    cancelEdit,
    contextUsage,
  } = useAgent();
  const commandMatches = matchingSlashCommands(input, skills);
  const slashCommand = parseSlashCommand(input, skills);

  useEffect(() => {
    window.electronAPI.skillsList().then(data => setSkills(data.registry || [])).catch(() => setSkills([]));
  }, []);

  useEffect(() => setCommandIndex(0), [input]);

  useEffect(() => {
    if (!exportOpen) return undefined;
    const closeMenu = event => {
      if (!event.target.closest('.composer-export')) setExportOpen(false);
    };
    window.addEventListener('mousedown', closeMenu);
    return () => window.removeEventListener('mousedown', closeMenu);
  }, [exportOpen]);
  const handleSend = () => runCommand().then(handled => { if (!handled) return sendMessage(chatAction, imageOptions); }).catch(error => setPresetFeedback(error.message || '命令执行失败'));

  async function runCommand() {
    const parsed = parseSlashCommand(input, skills);
    if (!parsed?.command) return false;
    const { command, argument } = parsed;
    if (command.type === 'skill') {
      if (!argument.trim() && attachments.length === 0) return false;
      setInput('');
      await sendMessage(chatAction, imageOptions, argument, { skillId: command.id });
      return true;
    }
    if (argument.trim()) return false;
    if (command.action === 'compact') {
      const result = await compactConversation();
      setInput('');
      setPresetFeedback(result.archived ? `已归档并压缩 ${result.archived} 段较早对话。` : '当前没有足够的较早对话可压缩。');
    } else if (command.action === 'new') {
      await createNewSession();
      setInput('');
    } else if (command.action === 'clear') {
      await clearConversation();
      setInput('');
    } else if (command.action === 'stop') {
      await handleCancel();
      setInput('');
    } else if (command.action === 'context') {
      setInput('');
      setPresetFeedback(contextUsage ? `上下文使用率 ${contextUsage.percent || 0}%；已归档 ${contextUsage.archiveCount || 0} 段。` : '发送消息后可显示上下文统计。');
    } else if (command.action === 'status') {
      const runtime = await getRuntimeStatus();
      setInput('');
      setPresetFeedback(`Agent：${runtime.state || 'idle'}；工作流目录：${runtime.workflowDir || '未配置'}。`);
    } else if (command.action === 'help' || command.action === 'skills') {
      setInput('');
      if (command.action === 'skills') {
        setPresetFeedback(`已启用技能：${skills.filter(skill => skill.enabled !== false).map(skill => `/${skill.id}`).join('、') || '无'}。`);
      } else {
        setShortcutsOpen(true);
        setPresetFeedback('');
        return true;
      }
    } else if (command.action === 'shortcuts') {
      setInput('');
      setShortcutsOpen(true);
      setPresetFeedback('');
      return true;
    }
    window.setTimeout(() => setPresetFeedback(''), 5000);
    return true;
  }

  function chooseCommand(command) {
    setInput(`${command.label}${command.type === 'skill' ? ' ' : ''}`);
    inputRef.current?.focus();
  }
  const handlePasteEvent = async event => {
    const added = await handlePasteImage(event);
    if (added) {
      setPresetFeedback(t('pasteImageAdded'));
      window.setTimeout(() => setPresetFeedback(''), 3000);
    }
  };
  const continueTruncatedReply = () => {
    if (taskActive) return;
    setInput('请从上一条回复中断处继续，不要重复已经输出的内容。');
    inputRef.current?.focus();
  };
  const taskActive = runtimeView.busy;
  const openTrace = async taskId => {
    if (!taskId) return;
    try {
      const nextTrace = await window.electronAPI.agentGetTrace(taskId);
      setTrace(nextTrace);
      setShowTrace(true);
    } catch (error) {
      setPresetFeedback(error.message || '无法读取任务 Trace');
    }
  };
  const [taskStartedAt, setTaskStartedAt] = useState(0);
  const generationSourceLabel = generationSource === 'direct'
    ? t('sourceDirect')
    : generationSource === 'ai'
      ? t('sourceAi')
      : generationSource === 'agent'
        ? t('sourceAgent')
        : '';
  const { setShowNodeControls } = useComfyUI();
  const [now, setNow] = useState(() => Date.now());
  const executionByTurn = useMemo(() => {
    const records = {};
    for (const [turnId, events] of Object.entries(executionRecords || {})) {
      records[turnId] = events.filter(isVisibleExecutionEvent);
    }
    for (const event of activityEvents) {
      if (!event.turnId) continue;
      const target = records[event.turnId] || (records[event.turnId] = []);
      const duplicate = target.some(saved => executionEventKey(saved) === executionEventKey(event));
      if (!duplicate) target.push(event);
    }
    return records;
  }, [activityEvents, executionRecords]);

  useEffect(() => {
    if (!taskActive) {
      setTaskStartedAt(0);
      return undefined;
    }
    if (!taskStartedAt) setTaskStartedAt(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [taskActive, taskStartedAt]);

  const activeTurnId = taskActive ? messages.filter(message => message.role === 'user').at(-1)?.turnId || '' : '';
  const hasStreamingReply = messages.some(message => message.role === 'agent' && message.streaming && message.content);
  const waitSeconds = taskStartedAt ? Math.floor((now - taskStartedAt) / 1000) : 0;
  const progressMessage = generationProgress?.percentScope === 'node' && generationProgress?.nodePercent !== null
    ? `${t('nodes')}：${generationProgress.message || generationProgress.node || t('processing')}`
    : generationProgress?.message || (taskActive && !hasStreamingReply && waitSeconds >= 3
      ? `模型正在生成，已等待 ${waitSeconds} 秒`
      : statusMsg || t('processingRequest'));

  useEffect(() => {
    if (active) onReady?.();
  }, [active, onReady]);


  useEffect(() => {
    if (status === 'idle' && ['ai', 'direct', 'openai-image'].includes(generationSource)) {
      setChatAction('creative');
    }
  }, [status, generationSource]);

  const conversationEntries = useMemo(() => {
    const recordsByTurn = new Map();
    const orphaned = [];
    const turns = new Set(messages.map(message => message.turnId).filter(Boolean));
    for (const record of Object.values(generationRecords || {})) {
      if (record.turnId && turns.has(record.turnId)) {
        const items = recordsByTurn.get(record.turnId) || [];
        items.push(record);
        recordsByTurn.set(record.turnId, items);
      } else orphaned.push(record);
    }
    const entries = [];
    messages.forEach((message, index) => {
      entries.push({ kind: 'message', data: message, index });
      if (message.role !== 'user') return;
      for (const record of (recordsByTurn.get(message.turnId) || []).sort((left, right) => (left.createdAt || 0) - (right.createdAt || 0))) entries.push({ kind: 'record', data: record });
    });
    return [...entries, ...orphaned.sort((left, right) => (left.createdAt || 0) - (right.createdAt || 0)).map(data => ({ kind: 'record', data }))];
  }, [messages, generationRecords]);

  const searchResults = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return [];
    const results = [];
    for (const entry of conversationEntries) {
      if (entry.kind !== 'message') continue;
      const message = entry.data;
      const diagnostics = executionByTurn[message.turnId] || [];
      const records = Object.values(generationRecords || {}).filter(record => record.turnId && record.turnId === message.turnId);
      const haystack = [message.content, message.prompt, message.negative, ...(message.attachments || []).map(item => item.name || ''), ...diagnostics.flatMap(event => [event.description, event.message, event.error, event.code, event.tool, event.traceId]), ...records.flatMap(record => [record.workflowName, record.status, record.error?.message])].filter(value => typeof value === 'string' && value).join('\n').toLowerCase();
      if (!haystack.includes(query)) continue;
      const content = message.content || message.prompt || (message.attachments || []).map(item => item.name).join('、');
      results.push({ id: conversationSearchId(message), role: message.role, snippet: String(content || '').slice(0, 80), time: message.time || '' });
    }
    return results.slice(0, 50);
  }, [conversationEntries, executionByTurn, generationRecords, searchQuery]);

  function jumpToSearchResult(id) {
    setSearchActiveId(id);
    const container = conversationRef.current;
    const target = container?.querySelector(`[data-search-id="${CSS.escape(id)}"]`);
    target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    window.setTimeout(() => setSearchActiveId(''), 2500);
  }

  function handleSearchKeyDown(event) {
    if (event.key !== 'Enter' || searchResults.length === 0) return;
    event.preventDefault();
    const currentIndex = Math.max(0, searchResults.findIndex(result => result.id === searchActiveId));
    jumpToSearchResult(searchResults[(currentIndex + 1) % searchResults.length].id);
  }

  async function exportConversation(format) {
    if (exporting) return;
    setExporting(format);
    setExportOpen(false);
    try {
      const activeProject = session.projects?.find(project => project.id === session.activeProjectId);
      const sessionTitle = activeProject?.sessions?.find(item => item.id === session.activeSessionId)?.title || '会话';
      const content = buildConversationExport({ entries: conversationEntries, executionRecords: executionByTurn, sessionTitle, projectTitle: activeProject?.name || '', format });
      const defaultName = `${sessionTitle || 'conversation'}-${new Date().toISOString().slice(0, 10)}.${format}`;
      const result = await window.electronAPI.saveTextFile({ defaultName, content, filterName: format === 'json' ? 'JSON 文件' : 'Markdown 文档' });
      if (result.saved) setPresetFeedback(format === 'json' ? '对话已导出为 JSON。' : '对话已导出为 Markdown。');
    } catch (error) {
      setPresetFeedback(error.message || '导出失败');
    } finally {
      window.setTimeout(() => setPresetFeedback(''), 5000);
      setExporting('');
    }
  }

  return (
    <aside className="panel-left">
      <div className="panel-left-content">
        <div ref={conversationRef} className="conversation" onScroll={handleConversationScroll}>
           {conversationEntries.length === 0 && <div className="conversation-empty"><strong>{t('startCreation')}</strong></div>}
           {conversationEntries.map((entry, entryIndex) => entry.kind === 'message' ? <div key={entry.data.messageId || entry.data.id || `${entry.data.turnId || 'message'}:${entry.index}`} className={`conversation-turn${searchActiveId && conversationSearchId(entry.data) === searchActiveId ? ' search-target' : ''}`} data-search-id={conversationSearchId(entry.data)}>
              <AgentMessage msg={entry.data} onOpenImage={setPreview} onImageError={removeAsset} onContinue={taskActive ? undefined : continueTruncatedReply} onEdit={() => handleEditMessage(entry.index)} onInsertPrompt={text => { if (text) { setInput(text); inputRef.current?.focus(); } }} hideImages={Boolean(entry.data.turnId && Object.values(generationRecords || {}).some(record => record.turnId === entry.data.turnId))} />
              {entry.data.role === 'user' && <ExecutionThread events={executionByTurn[entry.data.turnId] || []} progress={generationProgress} active={entry.data.turnId === activeTurnId} statusLabel={runtimeView.label} statusMsg={entry.data.turnId === activeTurnId ? progressMessage : statusMsg} recoverable={entry.data.turnId === activeTurnId && runtimeView.recoverable} onCancel={entry.data.turnId === activeTurnId ? handleCancel : undefined} t={t} onOpenTrace={openTrace} />}
            </div> : <GenerationRecordCard key={entry.data.requestId || entry.data.turnId || `record-${entry.data.createdAt || entryIndex}`} record={entry.data} onOpenImage={setPreview} onError={removeAsset} onRegenerate={handleRegenerate} onEdit={record => { setInput(record.prompt || ''); inputRef.current?.focus(); }} onAdjust={() => setShowNodeControls(true)} />)}

           {thinking && <section className="execution-thread execution-thread-live"><div className="thinking-live"><div className="thinking-live-label"><span className="streaming-cursor" />{t('thinking')}</div><pre ref={thinkingTextRef} className="thinking-live-text">{thinking}</pre></div></section>}

           {completedBatches.map(batch => <BatchResultCard key={batch.id} batch={batch} onOpenImage={setPreview} />)}

          <div ref={msgEndRef} />
        </div>
      </div>

      <div className="chat-input-area">
          <div className="composer-toolbar">
              <select className="composer-intent" value={chatAction} onChange={event => setChatAction(event.target.value)} aria-label={t('chatActions')} disabled={taskActive}>
                <option value="creative">{t('creativeChat')}</option>
               <option value="direct">{t('directGenerate')}</option>
               <option value="openai-image">{t('cloudImage')}</option>
            </select>
             {chatAction === 'openai-image' && <div className="image-options" role="group" aria-label={t('imageParameters')}>
                 <select value={imageOptions.size} onChange={event => setImageOptions(value => ({ ...value, size: event.target.value }))} title={t('size')}>
                 <option value="default">{t('sizeDefault')}</option>
                 <option value="auto">{t('sizeAuto')}</option>
                <option value="1024x1024">1024 x 1024</option>
                <option value="1536x1024">1536 x 1024</option>
                <option value="1024x1536">1024 x 1536</option>
              </select>
               <select value={imageOptions.count} onChange={event => setImageOptions(value => ({ ...value, count: Number(event.target.value) }))} title={t('quantity')}>
                 {[1, 2, 3, 4].map(count => <option key={count} value={count}>{t('quantity')}：{count}</option>)}
              </select>
               <select value={imageOptions.quality} onChange={event => setImageOptions(value => ({ ...value, quality: event.target.value }))} title={t('quality')}>
                 <option value="default">{t('qualityDefault')}</option>
                 <option value="auto">{t('qualityAuto')}</option>
                 <option value="low">{t('qualityLow')}</option>
                 <option value="high">{t('qualityHigh')}</option>
              </select>
            </div>}
            <ModelSelector mode={chatAction === 'openai-image' ? 'image' : 'chat'} />
            <div className="composer-actions">
              <button className="btn btn-icon" onClick={() => setSearchOpen(value => !value)} title={t('searchConversation')} aria-label={t('searchConversation')}><Icon name="search" size={14} /></button>
              <div className="composer-export">
                <button className="btn btn-icon" onClick={() => setExportOpen(value => !value)} title={t('exportConversation')} aria-label={t('exportConversation')}><Icon name="download" size={14} /></button>
                {exportOpen && <div className="composer-export-menu" role="menu">
                  <button role="menuitem" onClick={() => void exportConversation('md')} disabled={Boolean(exporting)}>{t('exportMarkdown')}</button>
                  <button role="menuitem" onClick={() => void exportConversation('json')} disabled={Boolean(exporting)}>{t('exportJson')}</button>
                </div>}
              </div>
              <button className="btn btn-icon" onClick={() => setShortcutsOpen(true)} title={t('shortcuts')} aria-label={t('shortcuts')}><Icon name="help" size={14} /></button>
            </div>
          </div>
          {searchOpen && <div className="conversation-search">
            <div className="conversation-search-input">
              <Icon name="search" size={13} />
              <input autoFocus value={searchQuery} onChange={event => setSearchQuery(event.target.value)} onKeyDown={handleSearchKeyDown} placeholder={t('searchPlaceholder')} aria-label={t('searchPlaceholder')} />
              <button className="btn btn-icon" onClick={() => setSearchOpen(false)} title={t('close')}><Icon name="close" size={12} /></button>
            </div>
            {searchQuery.trim() && <div className="conversation-search-results">
              {searchResults.length === 0 ? <span className="conversation-search-empty">{t('searchNoResults')}</span> : searchResults.map(result => (
                <button key={result.id} className="conversation-search-result" onClick={() => jumpToSearchResult(result.id)}>
                  <span className={`conversation-search-role ${result.role}`}>{result.role === 'user' ? t('searchRoleUser') : t('searchRoleAgent')}</span>
                  <span className="conversation-search-snippet">{result.snippet || '…'}</span>
                  <small>{result.time}</small>
                </button>
              ))}
            </div>}
          </div>}
          <div className="attachment-bar">
              <button className="btn attachment-add" onClick={handleAttachMedia} disabled={taskActive} title={t('addReference')}><Icon name="paperclip" size={14} /> {t('references')}</button>
            {attachments.map(item => (
              <span className="attachment-chip" key={item.path} title={item.path}>
                 <span>{item.kind === 'video' ? t('video') : t('image')}</span>
                <strong>{item.name}</strong>
                  <button onClick={() => removeAttachment(item.path)} disabled={taskActive} title={t('remove', { name: item.name })}><Icon name="close" size={13} /></button>
              </span>
            ))}
          </div>
           {presetFeedback && <div className="composer-feedback" role="status" aria-live="polite">{presetFeedback}</div>}
           {editingMessageIndex >= 0 && (
            <div className="edit-context-bar">
               <span>{t('editingHistory')}</span>
               <button className="btn btn-icon" onClick={cancelEdit} title={t('cancelEdit')}><Icon name="close" /></button>
            </div>
          )}
           <div className="chat-input-row">
             {commandMatches.length > 0 && <div className="slash-command-menu" role="listbox" aria-label="命令列表">
               {commandMatches.map((command, index) => <button key={`${command.type}:${command.id}`} className={index === commandIndex ? 'active' : ''} onMouseDown={event => { event.preventDefault(); chooseCommand(command); }} role="option" aria-selected={index === commandIndex}><code>{command.label}</code><span>{command.description}</span></button>)}
             </div>}
              <textarea
               ref={inputRef}
               className="chat-input"
               value={input}
                onChange={event => setInput(event.target.value)}
                onPaste={event => { void handlePasteEvent(event); }}
                onKeyDown={event => {
                  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
                    event.preventDefault();
                    setSearchOpen(true);
                    return;
                  }
                  if (commandMatches.length && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
                   event.preventDefault();
                   setCommandIndex(current => (current + (event.key === 'ArrowDown' ? 1 : -1) + commandMatches.length) % commandMatches.length);
                   return;
                 }
                 if (commandMatches.length && (event.key === 'Tab' || event.key === 'Enter') && !event.shiftKey) {
                   const parsed = parseSlashCommand(input, skills);
                   if (!parsed?.command) { event.preventDefault(); chooseCommand(commandMatches[commandIndex]); return; }
                 }
                 if (event.key === 'Escape' && commandMatches.length) { event.preventDefault(); setInput(''); return; }
                 if (event.key === 'Enter' && !event.shiftKey) {
                   event.preventDefault();
                   runCommand().then(handled => { if (!handled) sendMessage(chatAction, imageOptions); }).catch(error => setPresetFeedback(error.message || '命令执行失败'));
                 }
               }}
               placeholder={t('chatPlaceholder')}
              rows="3"
               disabled={taskActive}
             />
              <ContextRing usage={contextUsage} t={t} />
             {taskActive ? (
               <button className="btn btn-cancel input-action" onClick={handleCancel} title={t('stopTask')}><Icon name="stop" size={14} /></button>
            ) : (
               <button className="btn btn-primary input-action" onClick={handleSend} disabled={!input.trim() && attachments.length === 0} title={t('send')}><Icon name="send" size={15} /></button>
            )}
          </div>
      </div>
      {shortcutsOpen && <ShortcutsHelpModal onClose={() => setShortcutsOpen(false)} />}
    </aside>
  );
}
