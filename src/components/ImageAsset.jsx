import { useEffect, useState } from 'react';

export function isVideoImage(image = {}) {
  return /\.(mp4|webm|mov)$/i.test(image.filename || '');
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
    <button className={`image-preview-trigger${compact ? ' compact' : ''}`} onClick={() => onOpen?.({ image, src: state.src })} title="查看大图">
      {isVideoImage(image) ? (
        <video src={state.src} muted preload="metadata" aria-label={image.filename} />
      ) : (
        <img src={state.src} alt={image.filename} loading="lazy" />
      )}
    </button>
  );
}
