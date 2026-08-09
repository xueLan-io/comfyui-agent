import { useState } from 'react';
import ImageAsset from './ImageAsset.jsx';
import Icon from './Icon.jsx';
import { DragGhost, useFloatingCardDrag } from './useFloatingCardDrag.jsx';
import { useI18n } from '../i18n/I18nContext.jsx';

export default function AgentMessage({ msg, onOpenImage, onEdit, onImageError, hideImages = false }) {
  const { t } = useI18n();
  const isUser = msg.role === 'user';
  const [copied, setCopied] = useState(false);
  const displayContent = msg.content;
  const streamStateLabel = msg.streamState === 'cancelled' ? t('stopped') : msg.streamState === 'error' || msg.streamState === 'failed' ? t('generationInterrupted') : '';
  const promptDrag = useFloatingCardDrag({
    kind: 'prompt-card',
    positive: msg.prompt || '',
    negative: msg.negative || '',
    mode: 'replace',
    replaceBoth: true,
    workflowName: msg.workflowName || '',
    messageId: msg.messageId || msg.turnId || '',
  });

  const copyMessage = async () => {
    try {
      const promptText = [
          msg.prompt ? `${t('positiveLabel')} ${t('promptLabel')}：\n${msg.prompt}` : '',
          msg.negative ? `${t('negativeLabel')} ${t('promptLabel')}：\n${msg.negative}` : '',
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
      <div className="msg-bubble">
        <div className="msg-text" aria-busy={msg.streaming || undefined}>
          {displayContent}
          {msg.streaming && <span className="streaming-cursor" aria-hidden="true" />}
          {streamStateLabel && <span className={`msg-stream-state msg-stream-state-${msg.streamState}`}>{streamStateLabel}</span>}
        </div>
        {(msg.prompt?.trim() || msg.negative?.trim()) && (
          <section className={`msg-prompt-card${promptDrag.dragging ? ' is-dragging' : ''}`} aria-label={t('promptLabel')} aria-hidden={promptDrag.dragging || undefined}>
            <div className="msg-prompt-card-header" {...promptDrag.dragHandlers}><Icon name="spark" size={12} />{t('promptLabel')} <span>{t('dragPrompt')}</span></div>
            {msg.prompt?.trim() && <div className="msg-prompt-block"><span>{t('positiveLabel')}</span><code>{msg.prompt.trim()}</code></div>}
            {msg.negative?.trim() && <div className="msg-prompt-block msg-prompt-block-negative"><span>{t('negativeLabel')}</span><code>{msg.negative.trim()}</code></div>}
          </section>
        )}
         <DragGhost dragging={promptDrag.dragging} dragPoint={promptDrag.dragPoint} label="PROMPT" />
        {msg.attachments?.length > 0 && (
          <div className="msg-attachments">
            {msg.attachments.map((attachment, index) => (
              <div className="msg-attachment" key={`${attachment.name || attachment.path}-${index}`}>
                {attachment.kind === 'image' && attachment.previewUrl && (
                    <img className="msg-attachment-preview" src={attachment.previewUrl} alt={attachment.name || t('referenceImage')} />
                )}
                <div className="msg-attachment-meta">
                  <Icon name="paperclip" size={12} />
                  <span>{attachment.kind === 'video' ? t('videoAttachment') : t('imageAttachment')}</span>
                  <strong title={attachment.name || attachment.path}>{attachment.name || attachment.path}</strong>
                </div>
              </div>
            ))}
          </div>
        )}
        {!hideImages && (msg.media?.length > 0 || msg.images?.length > 0 || msg.videos?.length > 0) && (
          <div className="msg-images">
            {(msg.media || [...(msg.images || []), ...(msg.videos || [])]).map((image, index, media) => (
              <ImageAsset key={index} image={image} compact onOpen={preview => onOpenImage?.({ ...preview, images: media, index })} onError={onImageError} />
            ))}
          </div>
        )}
        <div className="msg-meta">
          <span className="msg-time">{msg.time}</span>
          {msg.duration_ms > 0 && <span className="msg-duration">{Math.round(msg.duration_ms / 1000)}s</span>}
        </div>
        <div className="msg-actions">
          <button className="msg-action" onClick={copyMessage} title={t('copyMessage')}><Icon name={copied ? 'check' : 'copy'} size={13} /> {copied ? t('copied') : t('copyMessage')}</button>
          {isUser && onEdit && <button className="msg-action" onClick={onEdit} title={t('editAndResend')}><Icon name="edit" size={13} /> {t('editAndResend')}</button>}
        </div>
      </div>
    </div>
  );
}
