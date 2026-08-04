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

function imageKey(image = {}) {
  return `${image.type || ''}:${image.projectId || ''}:${image.subfolder || ''}:${image.filename || ''}`;
}

function isCurrentResultMessage(message, currentImages) {
  if (!message.images?.length || !currentImages.length) return false;
  const currentKeys = new Set(currentImages.map(imageKey));
  return message.images.every(image => currentKeys.has(imageKey(image)));
}

export default function ChatPanel() {
  const [runtimeOpen, setRuntimeOpen] = useState(false);
  const [outputOpen, setOutputOpen] = useState(true);
  const [chatAction, setChatAction] = useState('answer');
  const {
    messages,
    activityEvents,
    graphSteps,
    images,
    removeAsset,
    generationPending,
    thinking,
    lastGenerationRequest,
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
  } = useAgent();
  const handleSend = () => sendMessage(chatAction);
  const generationSourceLabel = generationSource === 'direct'
    ? '直接生成 · 原文执行'
    : generationSource === 'ai'
      ? 'AI 生成 · Agent 规划'
      : generationSource === 'agent'
        ? 'Agent 对话'
        : '';
  const { setShowNodeControls } = useComfyUI();

  useEffect(() => {
    if (thinking) setRuntimeOpen(true);
  }, [thinking]);

  function editLastPrompt() {
    if (!lastGenerationRequest) return;
    setInput(lastGenerationRequest);
    inputRef.current?.focus();
  }

  return (
    <aside className="panel-left">
      <div className="panel-left-content">
        <div ref={conversationRef} className="conversation" onScroll={handleConversationScroll}>
          {messages.length > 0 && <button className="btn btn-icon btn-clear conversation-clear" onClick={clearConversation} disabled={status === 'running'} title={status === 'running' ? '请先停止当前任务' : '清空对话'}><Icon name="trash" /></button>}
          {messages.length === 0 && <div className="conversation-empty"><strong>开始新的创作</strong></div>}
          {messages.map((message, index) => (
            <AgentMessage
              key={`${message.ts || message.time || index}-${index}`}
              msg={message}
              onOpenImage={setPreview}
              onImageError={removeAsset}
              onEdit={() => handleEditMessage(index)}
              hideImages={isCurrentResultMessage(message, images)}
            />
          ))}

          {messages.length > 0 && (graphSteps.length > 0 || activityEvents.length > 0 || thinking) && (
            <section className="thread-section runtime-card">
              <div className="thread-section-heading">
                <div className="thread-section-title"><span className="section-kicker">运行过程</span><strong>{thinking ? '正在处理' : '执行摘要'}</strong></div>
                <button className="collapse-toggle" onClick={() => setRuntimeOpen(open => !open)} aria-expanded={runtimeOpen} title={runtimeOpen ? '收起运行过程' : '展开运行过程'}><span className="section-count">{graphSteps.length + activityEvents.length} 个步骤</span><span className="collapse-caret"><Icon name={runtimeOpen ? 'chevronDown' : 'chevronRight'} size={14} /></span></button>
              </div>
              {thinking && (
                <div className="thinking-live">
                  <div className="thinking-live-label"><span className="streaming-cursor" />正在思考...</div>
                  <pre ref={thinkingTextRef} className="thinking-live-text">{thinking.slice(-600)}</pre>
                </div>
              )}
              {runtimeOpen && (
                <>
                  {graphSteps.length > 0 && <section className="activity-section"><div className="section-heading"><span>执行图</span><span className="section-count">{graphSteps.length} 个节点</span></div><ExecutionGraph steps={graphSteps} /></section>}
                  {activityEvents.length > 0 && <section className="activity-section timeline-section"><div className="section-heading"><span>活动记录</span><span className="section-count">{activityEvents.length} 条</span></div><ActivityTimeline events={activityEvents} /></section>}
                </>
              )}
            </section>
          )}

          {messages.length > 0 && images.length > 0 && !generationPending && (
            <section className="thread-section output-card">
              <div className="thread-section-heading">
                <div className="thread-section-title"><span className="section-kicker">生成结果</span><strong>会话生成记录</strong>{generationSourceLabel && <small className="output-source">{generationSourceLabel}</small>}</div>
                <button className="collapse-toggle" onClick={() => setOutputOpen(open => !open)} aria-expanded={outputOpen} title={outputOpen ? '收起生成结果' : '展开生成结果'}><span className="output-count">{images.length} 张</span><span className="collapse-caret"><Icon name={outputOpen ? 'chevronDown' : 'chevronRight'} size={14} /></span></button>
              </div>
              {outputOpen && (
                <>
                  <div className={`image-grid chat-output-grid ${outputGalleryClass(images.length)}`}>{images.map((image, index) => <article key={`${image.filename}-${image.subfolder || ''}-${index}`} className="image-item"><ImageAsset image={image} onOpen={preview => setPreview({ ...preview, images, index })} onError={removeAsset} /><div className="image-item-info"><span title={image.filename}>{image.filename}</span><b>{String(index + 1).padStart(2, '0')}</b></div></article>)}</div>
                  <div className="output-controls">
                    <div className="output-primary-actions"><button className="btn btn-primary" onClick={handleRegenerate} disabled={status === 'running' || !lastGenerationRequest}><Icon name="refresh" size={14} /> 重新生成</button><button className="btn output-secondary-action" onClick={editLastPrompt} disabled={!lastGenerationRequest}><Icon name="edit" size={13} /> 编辑提示词</button><button className="btn btn-icon output-settings-action" onClick={() => setShowNodeControls(true)} title="调整生成参数" aria-label="调整生成参数"><Icon name="sliders" size={14} /></button></div>
                    <div className="output-feedback"><span>反馈</span><button onClick={() => recordFeedback('satisfied')}>满意</button><button onClick={() => recordFeedback('new_seed')}>换种子</button></div>
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
                <span>{generationProgress?.message || statusMsg || '正在处理请求'}</span>
                {Number.isFinite(generationProgress?.percent) && <strong>{generationProgress.percent}%</strong>}
              </div>
              <div className="generation-progress-track">
                <span className={Number.isFinite(generationProgress?.percent) ? '' : 'indeterminate'} style={Number.isFinite(generationProgress?.percent) ? { width: `${Math.max(2, generationProgress.percent)}%` } : undefined} />
              </div>
            </div>
          )}
          <div className="composer-toolbar">
            <select className="composer-intent" value={chatAction} onChange={event => setChatAction(event.target.value)} aria-label="聊天操作" disabled={status === 'running'}>
              <option value="answer">回答</option>
              <option value="generate">AI 生成</option>
              <option value="direct">直接生成</option>
            </select>
            <ModelSelector />
          </div>
          <div className="attachment-bar">
            <button className="btn attachment-add" onClick={handleAttachMedia} disabled={status === 'running'} title="添加参考图片或视频"><Icon name="paperclip" size={14} /> 参考素材</button>
            {attachments.map(item => (
              <span className="attachment-chip" key={item.path} title={item.path}>
                <span>{item.kind === 'video' ? '视频' : '图片'}</span>
                <strong>{item.name}</strong>
                <button onClick={() => removeAttachment(item.path)} disabled={status === 'running'} title={`移除 ${item.name}`}><Icon name="close" size={13} /></button>
              </span>
            ))}
          </div>
          {editingMessageIndex >= 0 && (
            <div className="edit-context-bar">
              <span>正在修改历史消息，后续内容会从上下文中移除</span>
              <button className="btn btn-icon" onClick={cancelEdit} title="取消修改"><Icon name="close" /></button>
            </div>
          )}
          <div className="chat-input-row">
            <textarea
              ref={inputRef}
              className="chat-input"
              value={input}
              onChange={event => setInput(event.target.value)}
              onKeyDown={event => handleKeyDown(event, chatAction)}
              placeholder="和创作助手对话，或直接描述要生成的画面..."
              rows="3"
              disabled={status === 'running'}
            />
            {status === 'running' ? (
              <button className="btn btn-cancel input-action" onClick={handleCancel} title="停止任务"><Icon name="stop" size={14} /></button>
            ) : (
              <button className="btn btn-primary input-action" onClick={handleSend} disabled={!input.trim() && attachments.length === 0} title="发送"><Icon name="send" size={15} /></button>
            )}
          </div>
      </div>
    </aside>
  );
}
