import { useEffect, useRef, useState } from 'react';
import { isVideoImage } from './ImageAsset.jsx';
import Icon from './Icon.jsx';
import { useI18n } from '../i18n/I18nContext.jsx';

export default function AssetPreviewModal({ preview, onClose }) {
  const { t } = useI18n();
  const [current, setCurrent] = useState(preview);
  const [scale, setScale] = useState(.75);
  const [fitScale, setFitScale] = useState(.75);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [actionState, setActionState] = useState('');
  const panRef = useRef(null);
  const bodyRef = useRef(null);
  const imageRef = useRef(null);

  function resetView() {
    setScale(fitScale);
    setOffset({ x: 0, y: 0 });
    panRef.current = null;
    setIsPanning(false);
  }

  function setCenteredScale(nextScale) {
    setScale(nextScale);
    setOffset({ x: 0, y: 0 });
  }

  function calculateFitScale() {
    const body = bodyRef.current;
    const image = imageRef.current;
    if (!body || !image?.naturalWidth || !image?.naturalHeight) return;
    const style = window.getComputedStyle(body);
    const horizontalPadding = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
    const verticalPadding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
    const availableWidth = Math.max(1, body.clientWidth - horizontalPadding);
    const availableHeight = Math.max(1, body.clientHeight - verticalPadding);
    const nextFit = Math.min(1, availableWidth / image.naturalWidth, availableHeight / image.naturalHeight);
    if (!Number.isFinite(nextFit) || nextFit <= 0) return;
    setFitScale(nextFit);
    setScale(nextFit);
    setOffset({ x: 0, y: 0 });
    panRef.current = null;
    setIsPanning(false);
  }

  useEffect(() => {
    setCurrent(preview);
    setFitScale(.75);
    resetView();
    setActionState('');
  }, [preview]);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => {
      if (scale === fitScale) calculateFitScale();
    });
    observer.observe(body);
    return () => observer.disconnect();
  }, [current.src, fitScale, scale]);

  useEffect(() => {
    function handleKeyDown(event) {
      if (!current) return;
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowLeft') void move(-1);
      if (event.key === 'ArrowRight') void move(1);
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  });

  function handleWheel(event) {
    const isVideo = isVideoImage(current?.image);
    if (isVideo || event.target.closest('button, video')) return;
    event.preventDefault();
    const body = event.currentTarget.getBoundingClientRect();
    const point = {
      x: event.clientX - body.left - body.width / 2,
      y: event.clientY - body.top - body.height / 2,
    };
    const nextScale = Math.min(3, Math.max(.5, scale * (event.deltaY < 0 ? 1.1 : .9)));
    const ratio = nextScale / scale;
    setOffset(currentOffset => ({
      x: point.x - (point.x - currentOffset.x) * ratio,
      y: point.y - (point.y - currentOffset.y) * ratio,
    }));
    setScale(nextScale);
  }

  function handlePointerDown(event) {
    if (video || event.button !== 0 || event.target.closest('button, video')) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    panRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, offset };
    setIsPanning(true);
  }

  function handlePointerMove(event) {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    event.preventDefault();
    setOffset({
      x: pan.offset.x + event.clientX - pan.x,
      y: pan.offset.y + event.clientY - pan.y,
    });
  }

  function stopPanning(event) {
    if (!panRef.current || panRef.current.pointerId !== event.pointerId) return;
    panRef.current = null;
    setIsPanning(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  if (!current) return null;

  const items = current.images || [current.image];
  const index = Math.max(0, current.index || 0);
  const video = isVideoImage(current.image);

  async function move(delta) {
    if (items.length < 2) return;
    const nextIndex = (index + delta + items.length) % items.length;
    const image = items[nextIndex];
    try {
      const src = await window.electronAPI.comfyUIImageData(image);
      setCurrent({ ...current, image, src, index: nextIndex });
      resetView();
    } catch {
      setActionState('error');
    }
  }

  async function saveImage() {
    setActionState('saving');
    try {
      const result = await window.electronAPI.comfyUISaveImage(current.image);
      setActionState(result.saved ? 'saved' : '');
    } catch {
      setActionState('error');
    }
  }

  async function showImage() {
    setActionState('showing');
    try {
      await window.electronAPI.comfyUIShowImage(current.image);
      setActionState('shown');
    } catch {
      setActionState('error');
    }
  }

  return (
    <div className="modal-overlay image-preview-overlay" onClick={onClose}>
      <section className="image-preview-panel" onClick={event => event.stopPropagation()} aria-label={t('previewImageTitle')}>
        <div className="modal-header image-preview-header">
          <div className="image-preview-title"><h3>{current.image?.filename || t('previewImageTitle')}</h3><span>{current.image?.subfolder || current.image?.type || ''}</span></div>
          <div className="image-preview-actions">
            {items.length > 1 && <span className="preview-position">{index + 1} / {items.length}</span>}
            {actionState === 'saved' && <span>{t('previewSaved')}</span>}
            {actionState === 'error' && <span className="error">{t('previewActionFailed')}</span>}
             {!video && <button className="btn btn-icon" onClick={() => setCenteredScale(Math.max(.5, scale - .25))} title={t('previewZoomOut')}><Icon name="minus" /></button>}
             {!video && <button className="btn preview-zoom-value" onClick={resetView} title={t('previewFitWindow')}>{Math.round(scale * 100)}%</button>}
             {!video && <button className="btn btn-icon" onClick={() => setCenteredScale(Math.min(3, scale + .25))} title={t('previewZoomIn')}><Icon name="plus" /></button>}
            <button className="btn" onClick={showImage} disabled={actionState === 'showing'}>{t('previewOpenLocation')}</button>
            <button className="btn btn-primary" onClick={saveImage} disabled={actionState === 'saving'}>{actionState === 'saving' ? t('previewSaving') : t('previewSaveAs')}</button>
            <button className="btn btn-icon" onClick={onClose} title={t('close')}><Icon name="close" /></button>
          </div>
        </div>
       <div
         className={'image-preview-body' + (isPanning ? ' is-panning' : '')}
          ref={bodyRef}
          style={{ '--image-pan-x': offset.x + 'px', '--image-pan-y': offset.y + 'px' }}
          onWheel={handleWheel}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={stopPanning}
          onPointerCancel={stopPanning}
        >
          {items.length > 1 && <button className="preview-nav preview-nav-prev" onClick={() => void move(-1)} title={t('previewPrev')}><Icon name="chevronLeft" size={20} /></button>}
           <div className="image-preview-canvas" style={{ transform: `translate3d(${offset.x}px, ${offset.y}px, 0) scale(${scale})` }}>{video ? <video src={current.src} controls /> : <img ref={imageRef} src={current.src} onLoad={calculateFitScale} alt={current.image?.filename || t('previewAlt')} />}</div>
          {items.length > 1 && <button className="preview-nav preview-nav-next" onClick={() => void move(1)} title={t('previewNext')}><Icon name="chevronRight" size={20} /></button>}
        </div>
      </section>
    </div>
  );
}
