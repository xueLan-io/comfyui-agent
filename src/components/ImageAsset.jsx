import { useEffect, useState } from 'react';

export function isVideoImage(image = {}) {
  return image.mediaType === 'video' || /\.(mp4|webm|mov|mkv|avi)$/i.test(image.filename || '');
}

export default function ImageAsset({ image, compact = false, onOpen, onError }) {
  const [state, setState] = useState({ status: 'loading', src: '' });

  useEffect(() => {
    let active = true;
    setState({ status: 'loading', src: '' });
    window.electronAPI.comfyUIImageData(image)
      .then(src => active && setState({ status: 'ready', src }))
      .catch(() => {
        if (!active) return;
        setState({ status: 'error', src: '' });
        onError?.(image);
      });
    return () => { active = false; };
  }, [image.filename, image.subfolder, image.type, image.projectId, image.createdAt, onError]);

  if (state.status !== 'ready') {
    return <div className={`image-loading${state.status === 'error' ? ' error' : ''}`}>{state.status === 'error' ? '预览失败' : '载入中...'}</div>;
  }

  return (
      <button className={`image-preview-trigger${compact ? ' compact' : ''}`} onClick={() => onOpen?.({ image, src: state.src })} onDragStart={event => event.preventDefault()} title="查看大图" draggable="false">
      {isVideoImage(image) ? (
         <video src={state.src} muted preload="metadata" aria-label={image.filename} draggable="false" onDragStart={event => event.preventDefault()} />
      ) : (
         <img src={state.src} alt={image.filename} loading="lazy" draggable="false" onDragStart={event => event.preventDefault()} />
      )}
    </button>
  );
}
