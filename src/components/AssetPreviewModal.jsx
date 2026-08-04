import { useEffect, useRef, useState } from 'react';
import { isVideoImage } from './ImageAsset.jsx';
import Icon from './Icon.jsx';

export default function AssetPreviewModal({ preview, onClose }) {
  const [current, setCurrent] = useState(preview);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [actionState, setActionState] = useState('');
  const panRef = useRef(null);

  useEffect(() => {
    setCurrent(preview);
    setScale(1);
    setOffset({ x: 0, y: 0 });
    setActionState('');
  }, [preview]);

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
    if (video || event.target.closest('button, video')) return;
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
      setScale(1);
      setOffset({ x: 0, y: 0 });
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
      <section className="image-preview-panel" onClick={event => event.stopPropagation()} aria-label="图片预览">
        <div className="modal-header image-preview-header">
          <div className="image-preview-title"><h3>{current.image?.filename || '图片预览'}</h3><span>{current.image?.subfolder || current.image?.type || ''}</span></div>
          <div className="image-preview-actions">
            {items.length > 1 && <span className="preview-position">{index + 1} / {items.length}</span>}
            {actionState === 'saved' && <span>已保存</span>}
            {actionState === 'error' && <span className="error">操作失败</span>}
            {!video && <button className="btn btn-icon" onClick={() => setScale(value => Math.max(.5, value - .25))} title="缩小"><Icon name="minus" /></button>}
            {!video && <button className="btn preview-zoom-value" onClick={() => setScale(1)} title="恢复 100%">{Math.round(scale * 100)}%</button>}
            {!video && <button className="btn btn-icon" onClick={() => setScale(value => Math.min(3, value + .25))} title="放大"><Icon name="plus" /></button>}
            <button className="btn" onClick={showImage} disabled={actionState === 'showing'}>打开位置</button>
            <button className="btn btn-primary" onClick={saveImage} disabled={actionState === 'saving'}>{actionState === 'saving' ? '保存中...' : '另存为'}</button>
            <button className="btn btn-icon" onClick={onClose} title="关闭"><Icon name="close" /></button>
          </div>
        </div>
        <div
          className={'image-preview-body' + (isPanning ? ' is-panning' : '')}
          style={{ '--image-pan-x': offset.x + 'px', '--image-pan-y': offset.y + 'px' }}
          onWheel={handleWheel}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={stopPanning}
          onPointerCancel={stopPanning}
        >
          {items.length > 1 && <button className="preview-nav preview-nav-prev" onClick={() => void move(-1)} title="上一张"><Icon name="chevronLeft" size={20} /></button>}
          <div className="image-preview-canvas">{video ? <video src={current.src} controls /> : <img src={current.src} alt={current.image?.filename || '预览图片'} style={{ transform: `scale(${scale})` }} />}</div>
          {items.length > 1 && <button className="preview-nav preview-nav-next" onClick={() => void move(1)} title="下一张"><Icon name="chevronRight" size={20} /></button>}
        </div>
      </section>
    </div>
  );
}
