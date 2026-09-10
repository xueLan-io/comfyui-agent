import { useEffect, useState } from 'react';
import ImageAsset, { isVideoImage } from './ImageAsset.jsx';
import Icon from './Icon.jsx';
import { DragGhost, useFloatingCardDrag } from './useFloatingCardDrag.jsx';
import { useI18n } from '../i18n/I18nContext.jsx';
import { useBatchQueue } from '../contexts/BatchQueueContext.jsx';
import MarkdownContent from './MarkdownContent.jsx';

function MessageMediaPlaceholder({ attachment }) {
  const kind = ['image', 'audio', 'video'].includes(attachment.kind) ? attachment.kind : 'image';
  const label = kind === 'audio' ? '音频播放器占位' : kind === 'video' ? '视频播放器占位' : '示例图片';
  const icon = kind === 'audio' ? '🎵' : kind === 'video' ? '🎬' : '🖼️';

  return (
    <figure className={`msg-media-placeholder ${kind}`}>
      <div className="msg-media-placeholder-stage" aria-hidden="true">
        <span>{icon}</span>
        {kind === 'image' && <i />}
        {kind === 'audio' && <div className="msg-media-waveform"><i /><i /><i /><i /><i /><i /><i /><i /></div>}
        {kind === 'video' && <b>▶</b>}
      </div>
      <figcaption>
        <span>{label}</span>
        <strong title={attachment.name || attachment.path}>{attachment.name || label}</strong>
      </figcaption>
    </figure>
  );
}

export default function AgentMessage({ msg, onOpenImage, onEdit, onImageError, onContinue, onInsertPrompt, hideImages = false }) {
  const { t } = useI18n();
  const { addToQueue } = useBatchQueue();
  const isUser = msg.role === 'user';
  const [copied, setCopied] = useState('');
  const [menu, setMenu] = useState(null);
  const displayContent = msg.content;
  const hasContent = Boolean(String(displayContent || '').trim());
  const hasAttachments = msg.attachments?.length > 0;
  const hasMedia = msg.media?.length > 0 || msg.images?.length > 0 || msg.videos?.length > 0;
  const streamStateLabel = msg.streamState === 'cancelled' ? t('stopped') : ['error', 'failed', 'abandoned', 'timed_out', 'archive_failed'].includes(msg.streamState) ? t('generationInterrupted') : '';
  const promptDrag = useFloatingCardDrag({
    kind: 'prompt-card',
    positive: msg.prompt || '',
    negative: msg.negative || '',
    mode: 'replace',
    replaceBoth: true,
    workflowName: msg.workflowName || '',
    messageId: msg.messageId || msg.turnId || '',
  });

  useEffect(() => {
    if (!menu) return undefined;
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
    };
  }, [menu]);

  const copyText = async (text, feedbackKey) => {
    try {
      await navigator.clipboard.writeText(text || '');
      setCopied(feedbackKey);
      window.setTimeout(() => setCopied(''), 1200);
    } catch {
      setCopied('');
    }
  };

  const copyMessage = () => copyText([
      msg.content || '',
      msg.prompt ? `${t('positiveLabel')} ${t('promptLabel')}：\n${msg.prompt}` : '',
      msg.negative ? `${t('negativeLabel')} ${t('promptLabel')}：\n${msg.negative}` : '',
    ].filter(Boolean).join('\n\n'), 'copyAll');

  const mediaImages = (msg.media || [...(msg.images || []), ...(msg.videos || [])]).filter(image => !isVideoImage(image));
  const firstImage = mediaImages[0];

  const enqueuePlan = () => {
    if (!msg.prompt?.trim()) return;
    addToQueue({
      positive: msg.prompt,
      negative: msg.negative || '',
      workflowName: msg.workflowName || '',
      parameters: msg.parameters || msg.settings || {},
      nodeOverrides: msg.nodeOverrides || {},
      outputNodeIds: msg.outputNodeIds || null,
      media: { images: [], videos: [] },
    }, { sourceKind: 'plan', sourceLabel: t('queueSourcePlan') });
  };

  const runImageAction = async action => {
    if (!firstImage) return;
    try {
      if (action === 'save') await window.electronAPI.comfyUISaveImage(firstImage);
      else if (action === 'copy') {
        const dataUrl = await window.electronAPI.comfyUIImageData(firstImage);
        await window.electronAPI.clipboardWriteImage(dataUrl);
        setCopied('copyImage');
        window.setTimeout(() => setCopied(''), 1200);
      }
    } catch {
      setCopied('');
    } finally {
      setMenu(null);
    }
  };

  const menuItems = [
    { key: 'copyAll', label: t('copyMessage'), icon: 'copy', run: () => { setMenu(null); void copyMessage(); } },
    ...(msg.prompt?.trim() ? [{ key: 'copyPositive', label: t('copyPositive'), icon: 'copy', run: () => { setMenu(null); void copyText(msg.prompt, 'copyPositive'); } }] : []),
    ...(msg.negative?.trim() ? [{ key: 'copyNegative', label: t('copyNegative'), icon: 'copy', run: () => { setMenu(null); void copyText(msg.negative, 'copyNegative'); } }] : []),
    ...(onInsertPrompt && (msg.prompt?.trim() || msg.content?.trim()) ? [{ key: 'insert', label: t('insertToInput'), icon: 'edit', run: () => { setMenu(null); onInsertPrompt(msg.prompt?.trim() || msg.content); } }] : []),
    ...(isUser && onEdit ? [{ key: 'edit', label: t('editAndResend'), icon: 'edit', run: () => { setMenu(null); onEdit(); } }] : []),
    ...(!isUser && msg.outputTruncated && onContinue ? [{ key: 'continue', label: t('continueGenerate'), icon: 'spark', run: () => { setMenu(null); onContinue(); } }] : []),
    ...(firstImage ? [
      { key: 'saveImage', label: t('saveImage'), icon: 'download', run: () => void runImageAction('save') },
      { key: 'copyImage', label: t('copyImage'), icon: 'copy', run: () => void runImageAction('copy') },
    ] : []),
  ];

  const menuStyle = menu ? {
    left: Math.min(menu.x, window.innerWidth - 220),
    top: Math.min(menu.y, window.innerHeight - 60 - menuItems.length * 30),
  } : {};

  return (
    <div className={`msg ${isUser ? 'user' : 'agent'}`}>
      <div className="msg-bubble" onContextMenu={event => { event.preventDefault(); setMenu(menu ? null : { x: event.clientX, y: event.clientY }); }}>
        <div className="msg-text" aria-busy={msg.streaming || undefined}>
          {hasContent ? (isUser ? displayContent : <MarkdownContent>{displayContent}</MarkdownContent>) : (hasAttachments || hasMedia) ? <span className="msg-content-placeholder">{isUser ? '已发送参考素材' : '已生成媒体结果'}</span> : <span className="msg-content-placeholder">（无文本内容）</span>}
           {msg.streaming && <span className="streaming-cursor" aria-hidden="true" />}
           {msg.outputTruncated && <span className="msg-stream-state">回复达到模型输出上限，可继续生成</span>}
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
        {hasAttachments && (
          <div className="msg-attachments">
            {msg.attachments.map((attachment, index) => (
              <MessageMediaPlaceholder attachment={attachment} key={`${attachment.name || attachment.path}-${index}`} />
            ))}
          </div>
        )}
        {!hideImages && hasMedia && (
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
          <button className="msg-action" onClick={copyMessage} title={t('copyMessage')}><Icon name={copied === 'copyAll' ? 'check' : 'copy'} size={13} /> {copied === 'copyAll' ? t('copied') : t('copyMessage')}</button>
          {msg.prompt?.trim() && <button className="msg-action" onClick={enqueuePlan} title={t('queueAddHint')}><Icon name="queueAdd" size={13} /> {t('queueAdd')}</button>}
          {!isUser && msg.outputTruncated && onContinue && <button className="msg-action" onClick={onContinue}>{t('continueGenerate')}</button>}
          {isUser && onEdit && <button className="msg-action" onClick={onEdit} title={t('editAndResend')}><Icon name="edit" size={13} /> {t('editAndResend')}</button>}
        </div>
      </div>
      {menu && menuItems.length > 0 && (
        <div className="msg-context-menu" style={menuStyle} role="menu" onContextMenu={event => event.preventDefault()}>
          {menuItems.map(item => (
            <button className="msg-context-item" key={item.key} role="menuitem" onClick={item.run} onMouseDown={event => event.preventDefault()}>
              <Icon name={item.icon} size={13} />
              <span>{item.label}</span>
              {copied === item.key && <Icon name="check" size={12} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
