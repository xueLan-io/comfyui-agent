import { useEffect, useState } from 'react';
import { useAgent } from '../contexts/AgentContext.jsx';
import { useComfyUI } from '../contexts/ComfyUIContext.jsx';
import AgentMessage from './AgentMessage.jsx';
import ExecutionGraph from './ExecutionGraph.jsx';
import ActivityTimeline from './ActivityTimeline.jsx';
import ImageAsset from './ImageAsset.jsx';
import { outputGalleryClass } from './image-layout.mjs';
import ModelSelector from './ModelSelector.jsx';
import Icon from './Icon.jsx';
import PresetSaveModal from './PresetSaveModal.jsx';
import { useI18n } from '../i18n/I18nContext.jsx';
import { progressTimeEstimate } from '../runtime/generation-time-estimate.mjs';

function imageKey(image = {}) {
  return `${image.type || ''}:${image.projectId || ''}:${image.subfolder || ''}:${image.filename || ''}`;
}

function isCurrentResultMessage(message, currentMedia) {
  const messageMedia = message.media || [...(message.images || []), ...(message.videos || [])];
  if (!messageMedia.length || !currentMedia.length) return false;
  const currentKeys = new Set(currentMedia.map(imageKey));
  return messageMedia.every(image => currentKeys.has(imageKey(image)));
}

function formatTokens(value) {
  const tokens = Number(value) || 0;
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(tokens >= 10000 ? 0 : 1)}k` : String(tokens);
}

function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.ceil((Number(milliseconds) || 0) / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}:${String(remainder).padStart(2, '0')}` : `${remainder}s`;
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
  const [runtimeOpen, setRuntimeOpen] = useState(false);
  const [outputOpen, setOutputOpen] = useState(true);
  const [chatAction, setChatAction] = useState('answer');
  const [imageOptions, setImageOptions] = useState({ size: 'auto', count: 1, quality: 'auto' });
  const [savePresetOpen, setSavePresetOpen] = useState(false);
  const [presetFeedback, setPresetFeedback] = useState('');
  const {
    messages,
    activityEvents,
    graphSteps,
    images,
    media,
    removeAsset,
    generationPending,
    thinking,
    lastGenerationRequest,
    lastGenerationNegative,
    generationSource,
    handleRegenerate,
    recordFeedback,
    input,
    setInput,
    attachments,
    handleAttachMedia,
    removeAttachment,
    status,
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
    clearConversation,
    editingMessageIndex,
    handleEditMessage,
    cancelEdit,
    contextUsage,
  } = useAgent();
  const handleSend = () => sendMessage(chatAction, imageOptions);
  const generationSourceLabel = generationSource === 'direct'
    ? t('sourceDirect')
    : generationSource === 'ai'
      ? t('sourceAi')
      : generationSource === 'agent'
        ? t('sourceAgent')
        : '';
  const { setShowNodeControls, selectedFile, generationControls, workflowManifest } = useComfyUI();
  const [now, setNow] = useState(() => Date.now());
  const timeProgress = progressTimeEstimate(generationProgress?.timeEstimate, {
    startedAt: generationProgress?.startedAt || now,
    percent: generationProgress?.percent,
    now,
  });

  useEffect(() => {
    if (status !== 'running' || !generationProgress?.timeEstimate) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [status, generationProgress?.timeEstimate]);

  useEffect(() => {
    if (thinking) setRuntimeOpen(true);
  }, [thinking]);

  useEffect(() => {
    if (active) onReady?.();
  }, [active, onReady]);


  useEffect(() => {
    if (status === 'idle' && ['ai', 'direct', 'openai-image'].includes(generationSource)) {
      setChatAction('answer');
    }
  }, [status, generationSource]);

  function editLastPrompt() {
    if (!lastGenerationRequest) return;
    setInput(lastGenerationRequest);
    inputRef.current?.focus();
  }

  async function saveAsPreset() {
    if (!lastGenerationRequest) return;
    setSavePresetOpen(true);
  }

  async function createSavedPreset(form) {
    const resultRefs = form.saveResults ? media : [];
    const coverRef = form.useFirstAsCover ? resultRefs[0] : null;
    const saved = await window.electronAPI.globalPresetCreate({
      ...form,
      source: generationSource === 'openai-image' ? 'cloud' : 'direct',
      origin: 'chat',
      workflow: selectedFile,
      workflowName: selectedFile,
      parameters: form.parameters || generationControls.settings || {},
      nodeOverrides: generationControls.nodeOverrides || {},
      outputNodeIds: generationControls.outputNodeIds || null,
      modelRequirements: workflowManifest?.modelRequirements || [],
      resultRefs,
      coverRef,
    });
    setSavePresetOpen(false);
    const detail = { id: saved?.id || '', title: saved?.title || form.title, preset: saved };
    setPresetFeedback(t('presetSaved', { name: detail.title }));
    window.setTimeout(() => setPresetFeedback(''), 3500);
    window.dispatchEvent(new CustomEvent('comfy-agent:preset-saved', { detail }));
  }

  return (
    <aside className="panel-left">
      <div className="panel-left-content">
        <div ref={conversationRef} className="conversation" onScroll={handleConversationScroll}>
          {messages.length > 0 && <button className="btn btn-icon btn-clear conversation-clear" onClick={clearConversation} disabled={status === 'running'} title={status === 'running' ? t('stopCurrentTask') : t('clearConversation')}><Icon name="trash" /></button>}
          {messages.length === 0 && <div className="conversation-empty"><strong>{t('startCreation')}</strong></div>}
          {messages.map((message, index) => (
            <AgentMessage
              key={`${message.ts || message.time || index}-${index}`}
              msg={message}
              onOpenImage={setPreview}
              onImageError={removeAsset}
              onEdit={() => handleEditMessage(index)}
              hideImages={isCurrentResultMessage(message, media)}
            />
          ))}

          {messages.length > 0 && (graphSteps.length > 0 || activityEvents.length > 0 || thinking) && (
            <section className="thread-section runtime-card">
              <div className="thread-section-heading">
               <div className="thread-section-title"><span className="section-kicker">{t('runtime')}</span><strong>{thinking ? t('processingRequest') : t('executionSummary')}</strong></div>
                 <button className="collapse-toggle" onClick={() => setRuntimeOpen(open => !open)} aria-expanded={runtimeOpen} title={runtimeOpen ? t('collapseRuntime') : t('expandRuntime')}><span className="section-count">{graphSteps.length + activityEvents.length} {t('steps')}</span><span className="collapse-caret"><Icon name={runtimeOpen ? 'chevronDown' : 'chevronRight'} size={14} /></span></button>
              </div>
              {thinking && (
                <div className="thinking-live">
                   <div className="thinking-live-label"><span className="streaming-cursor" />{t('thinking')}</div>
                  <pre ref={thinkingTextRef} className="thinking-live-text">{thinking.slice(-600)}</pre>
                </div>
              )}
              {runtimeOpen && (
                <>
                   {graphSteps.length > 0 && <section className="activity-section"><div className="section-heading"><span>{t('executionGraph')}</span><span className="section-count">{graphSteps.length} {t('nodes')}</span></div><ExecutionGraph steps={graphSteps} /></section>}
                   {activityEvents.length > 0 && <section className="activity-section timeline-section"><div className="section-heading"><span>{t('activityLog')}</span><span className="section-count">{activityEvents.length} {t('records')}</span></div><ActivityTimeline events={activityEvents} /></section>}
                </>
              )}
            </section>
          )}

          {messages.length > 0 && media.length > 0 && !generationPending && (
            <section className="thread-section output-card">
              <div className="thread-section-heading">
                 <div className="thread-section-title"><span className="section-kicker">{t('generationResults')}</span><strong>{t('sessionGeneration')}</strong>{generationSourceLabel && <small className="output-source">{generationSourceLabel}</small>}</div>
                  <button className="collapse-toggle" onClick={() => setOutputOpen(open => !open)} aria-expanded={outputOpen} title={outputOpen ? t('collapseResults') : t('expandResults')}><span className="output-count">{media.length} {t('items')}</span><span className="collapse-caret"><Icon name={outputOpen ? 'chevronDown' : 'chevronRight'} size={14} /></span></button>
              </div>
              {outputOpen && (
                <>
                   <div className={`image-grid chat-output-grid ${outputGalleryClass(media.length)}`}>{media.map((image, index) => <article key={`${image.filename}-${image.subfolder || ''}-${index}`} className="image-item"><ImageAsset image={image} onOpen={preview => setPreview({ ...preview, images: media, index })} onError={removeAsset} /><div className="image-item-info"><span title={image.filename}>{image.filename}</span><b>{String(index + 1).padStart(2, '0')}</b></div></article>)}</div>
                  <div className="output-controls">
                      <div className="output-primary-actions"><button className="btn btn-primary" onClick={handleRegenerate} disabled={status === 'running' || !lastGenerationRequest}><Icon name="refresh" size={14} /> {t('regenerate')}</button><button className="btn output-secondary-action" onClick={editLastPrompt} disabled={!lastGenerationRequest}><Icon name="edit" size={13} /> {t('editPrompt')}</button><button className="btn output-secondary-action" onClick={saveAsPreset} disabled={!lastGenerationRequest}><Icon name="bookmark" size={13} /> {t('saveAsPreset')}</button><button className="btn btn-icon output-settings-action" onClick={() => setShowNodeControls(true)} title={t('adjustParameters')} aria-label={t('adjustParameters')}><Icon name="sliders" size={14} /></button></div>
                     <div className="output-feedback"><span>{t('feedback')}</span><button onClick={() => recordFeedback('satisfied')}>{t('satisfied')}</button><button onClick={() => recordFeedback('new_seed')}>{t('newSeed')}</button></div>
                    {presetFeedback && <div className="preset-save-feedback" role="status" aria-live="polite"><Icon name="check" size={13} />{presetFeedback}</div>}
                  </div>
                </>
              )}
            </section>
          )}
          <div ref={msgEndRef} />
        </div>
      </div>

      <div className="chat-input-area">
          {status === 'running' && (
            <div className="generation-progress-chat" role="status" aria-live="polite">
               <div className="generation-progress-meta">
                <span>{generationProgress?.percentScope === 'node' && generationProgress?.nodePercent !== null
                   ? `${t('nodes')}：${generationProgress.message || generationProgress.node || t('processing')}`
                   : generationProgress?.message || statusMsg || t('processingRequest')}</span>
                 {Number.isFinite(generationProgress?.percent) && <strong>{generationProgress.percent}%</strong>}
               </div>
               {timeProgress && (
                 <div className="generation-time-estimate">
                   <span>已用 {formatDuration(timeProgress.elapsedMs)}</span>
                   <strong>预计剩余 {formatDuration(timeProgress.remainingMs)}</strong>
                   <small>{timeProgress.confidence === 'calibrated' ? '已按实际采样进度校正' : '预估时长，首个采样进度后会校正'}</small>
                 </div>
               )}
               <div className="generation-progress-track">
                <span className={Number.isFinite(generationProgress?.percent) ? '' : 'indeterminate'} style={Number.isFinite(generationProgress?.percent) ? { width: `${Math.max(2, generationProgress.percent)}%` } : undefined} />
              </div>
            </div>
          )}
          <div className="composer-toolbar">
             <select className="composer-intent" value={chatAction} onChange={event => setChatAction(event.target.value)} aria-label={t('chatActions')} disabled={status === 'running'}>
               <option value="answer">{t('answer')}</option>
               <option value="generate">{t('aiGenerate')}</option>
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
          </div>
          <div className="attachment-bar">
             <button className="btn attachment-add" onClick={handleAttachMedia} disabled={status === 'running'} title={t('addReference')}><Icon name="paperclip" size={14} /> {t('references')}</button>
            {attachments.map(item => (
              <span className="attachment-chip" key={item.path} title={item.path}>
                 <span>{item.kind === 'video' ? t('video') : t('image')}</span>
                <strong>{item.name}</strong>
                 <button onClick={() => removeAttachment(item.path)} disabled={status === 'running'} title={t('remove', { name: item.name })}><Icon name="close" size={13} /></button>
              </span>
            ))}
          </div>
          {editingMessageIndex >= 0 && (
            <div className="edit-context-bar">
               <span>{t('editingHistory')}</span>
               <button className="btn btn-icon" onClick={cancelEdit} title={t('cancelEdit')}><Icon name="close" /></button>
            </div>
          )}
           <div className="chat-input-row">
            <textarea
              ref={inputRef}
              className="chat-input"
              value={input}
              onChange={event => setInput(event.target.value)}
               onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendMessage(chatAction, imageOptions); } }}
               placeholder={t('chatPlaceholder')}
              rows="3"
              disabled={status === 'running'}
             />
              <ContextRing usage={contextUsage} t={t} />
            {status === 'running' ? (
               <button className="btn btn-cancel input-action" onClick={handleCancel} title={t('stopTask')}><Icon name="stop" size={14} /></button>
            ) : (
               <button className="btn btn-primary input-action" onClick={handleSend} disabled={!input.trim() && attachments.length === 0} title={t('send')}><Icon name="send" size={15} /></button>
            )}
          </div>
      </div>
       {savePresetOpen && <PresetSaveModal initial={{ title: lastGenerationRequest.slice(0, 28) || t('newPresetDefault'), positive: lastGenerationRequest, negative: lastGenerationNegative || '', workflow: selectedFile, parameters: generationControls.settings || {}, tags: '' }} onSave={createSavedPreset} onClose={() => setSavePresetOpen(false)} />}
    </aside>
  );
}
