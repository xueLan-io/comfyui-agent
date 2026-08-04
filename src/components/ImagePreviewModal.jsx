import { useState } from 'react';
import Icon from './Icon.jsx';

export default function ImagePreviewModal({ preview, onClose }) {
  const [actionState, setActionState] = useState('');
  if (!preview) return null;

  async function saveImage() {
    setActionState('saving');
    try {
      const result = await window.electronAPI.comfyUISaveImage(preview.image);
      setActionState(result.saved ? 'saved' : '');
    } catch {
      setActionState('error');
    }
  }

  async function showImage() {
    setActionState('showing');
    try {
      await window.electronAPI.comfyUIShowImage(preview.image);
      setActionState('shown');
    } catch {
      setActionState('error');
    }
  }

  return (
    <div className="modal-overlay image-preview-overlay" onClick={onClose}>
      <section className="image-preview-panel" onClick={event => event.stopPropagation()} aria-label="图片预览">
        <div className="modal-header image-preview-header">
          <div className="image-preview-title">
            <h3>{preview.image?.filename || '图片预览'}</h3>
            <span>{preview.image?.subfolder || preview.image?.type || ''}</span>
          </div>
          <div className="image-preview-actions">
            {actionState === 'saved' && <span>已保存</span>}
            {actionState === 'error' && <span className="error">操作失败</span>}
            <button className="btn" onClick={showImage} disabled={actionState === 'showing'}>打开位置</button>
            <button className="btn btn-primary" onClick={saveImage} disabled={actionState === 'saving'}>{actionState === 'saving' ? '保存中...' : '另存为'}</button>
            <button className="btn btn-icon" onClick={onClose} title="关闭"><Icon name="close" /></button>
          </div>
        </div>
        <div className="image-preview-body">
          <img src={preview.src} alt={preview.image?.filename || '预览图片'} />
        </div>
      </section>
    </div>
  );
}
