import { useEffect, useState } from 'react';
import { useI18n } from '../i18n/I18nContext.jsx';

export function isVideoImage(image = {}) {
  return image.mediaType === 'video' || /\.(mp4|webm|mov|mkv|avi)$/i.test(image.filename || '');
}

export default function ImageAsset({ image, compact = false, onOpen, onError }) {
  const { t } = useI18n();
  const [state, setState] = useState({ status: 'loading', src: '' });

  useEffect(() => {
    let active = true;
    setState({ status: 'loading', src: '' });
    const load = async () => {
      if (image?.previewUrl) return image.previewUrl;
      return window.electronAPI.comfyUIImageData(image);
    };
    load()
      .then(src => {
        if (!src) throw new Error('Image preview returned no data');
        if (active) setState({ status: 'ready', src });
      })
      .catch(() => {
        if (!active) return;
        setState({ status: 'error', src: '' });
        onError?.(image);
      });
    return () => { active = false; };
  }, [image.previewUrl, image.filename, image.subfolder, image.type, image.projectId, image.sessionId, image.createdAt, onError]);

  if (state.status !== 'ready') {
    return <div className={`image-loading${state.status === 'error' ? ' error' : ''}`}>{state.status === 'error' ? t('assetPreviewFailed') : t('assetLoading')}</div>;
  }

  return (
      <button className={`image-preview-trigger${compact ? ' compact' : ''}`} onClick={() => onOpen?.({ image, src: state.src })} onDragStart={event => event.preventDefault()} title={t('assetViewLarge')} draggable="false">
      {isVideoImage(image) ? (
         <video src={state.src} muted preload="metadata" aria-label={image.filename} draggable="false" onDragStart={event => event.preventDefault()} />
      ) : (
         <img src={state.src} alt={image.filename} loading="lazy" draggable="false" onDragStart={event => event.preventDefault()} />
      )}
    </button>
  );
}
