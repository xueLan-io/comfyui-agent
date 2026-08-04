import { useState } from 'react';
import ImageAsset from './ImageAsset.jsx';
import Icon from './Icon.jsx';

export default function AgentMessage({ msg, onOpenImage, onEdit, onImageError, hideImages = false }) {
  const isUser = msg.role === 'user';
  const [copied, setCopied] = useState(false);
  const displayContent = msg.content;
  const streamStateLabel = msg.streamState === 'cancelled' ? '已停止' : msg.streamState === 'error' || msg.streamState === 'failed' ? '生成中断' : '';

  const copyMessage = async () => {
    try {
      const promptText = [
        msg.prompt ? `正向提示词：\n${msg.prompt}` : '',
        msg.negative ? `负向提示词：\n${msg.negative}` : '',
      ].filter(Boolean).join('\n\n');
      await navigator.clipboard.writeText([msg.content || '', promptText].filter(Boolean).join('\n\n'));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className={`msg ${isUser ? 'user' : 'agent'}`}>
      <div className="msg-avatar">{isUser ? 'U' : 'A'}</div>
      <div className="msg-bubble">
        <div className="msg-text" aria-busy={msg.streaming || undefined}>
          {displayContent}
          {msg.streaming && <span className="streaming-cursor" aria-hidden="true" />}
          {streamStateLabel && <span className={`msg-stream-state msg-stream-state-${msg.streamState}`}>{streamStateLabel}</span>}
        </div>
        {(msg.prompt?.trim() || msg.negative?.trim()) && (
          <section className="msg-prompt-card" aria-label="提示词">
            <div className="msg-prompt-card-header"><Icon name="spark" size={12} />提示词</div>
            {msg.prompt?.trim() && <div className="msg-prompt-block"><span>正向</span><code>{msg.prompt.trim()}</code></div>}
            {msg.negative?.trim() && <div className="msg-prompt-block msg-prompt-block-negative"><span>负向</span><code>{msg.negative.trim()}</code></div>}
          </section>
        )}
        {msg.attachments?.length > 0 && (
          <div className="msg-attachments">
            {msg.attachments.map((attachment, index) => (
              <div className="msg-attachment" key={`${attachment.name || attachment.path}-${index}`}>
                {attachment.kind === 'image' && attachment.previewUrl && (
                  <img className="msg-attachment-preview" src={attachment.previewUrl} alt={attachment.name || '参考图片'} />
                )}
                <div className="msg-attachment-meta">
                  <Icon name="paperclip" size={12} />
                  <span>{attachment.kind === 'video' ? 'VIDEO' : 'IMAGE'}</span>
                  <strong title={attachment.name || attachment.path}>{attachment.name || attachment.path}</strong>
                </div>
              </div>
            ))}
          </div>
        )}
        {!hideImages && msg.images?.length > 0 && (
          <div className="msg-images">
            {msg.images.map((image, index) => (
              <ImageAsset key={index} image={image} compact onOpen={onOpenImage} onError={onImageError} />
            ))}
          </div>
        )}
        <div className="msg-meta">
          <span className="msg-time">{msg.time}</span>
          {msg.duration_ms > 0 && <span className="msg-duration">{Math.round(msg.duration_ms / 1000)}s</span>}
        </div>
        <div className="msg-actions">
          <button className="msg-action" onClick={copyMessage} title="复制消息"><Icon name={copied ? 'check' : 'copy'} size={13} /> {copied ? '已复制' : '复制'}</button>
          {isUser && onEdit && <button className="msg-action" onClick={onEdit} title="编辑并重发"><Icon name="edit" size={13} /> 编辑</button>}
        </div>
      </div>
    </div>
  );
}
