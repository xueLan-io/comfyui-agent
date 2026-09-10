import { useState } from 'react';
import Icon from './Icon.jsx';
import { useI18n } from '../i18n/I18nContext.jsx';

export default function ImagePreviewModal({ preview, onClose }) {
  const { t } = useI18n();
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
      <section className="image-preview-panel" onClick={event => event.stopPropagation()} aria-label={t('previewImageTitle')}>
        <div className="modal-header image-preview-header">
          <div className="image-preview-title">
            <h3>{preview.image?.filename || t('previewImageTitle')}</h3>
            <span>{preview.image?.subfolder || preview.image?.type || ''}</span>
          </div>
          <div className="image-preview-actions">
            {actionState === 'saved' && <span>{t('previewSaved')}</span>}
            {actionState === 'error' && <span className="error">{t('previewActionFailed')}</span>}
            <button className="btn" onClick={showImage} disabled={actionState === 'showing'}>{t('previewOpenLocation')}</button>
            <button className="btn btn-primary" onClick={saveImage} disabled={actionState === 'saving'}>{actionState === 'saving' ? t('previewSaving') : t('previewSaveAs')}</button>
            <button className="btn btn-icon" onClick={onClose} title={t('close')}><Icon name="close" /></button>
          </div>
        </div>
        <div className="image-preview-body">
          <img src={preview.src} alt={preview.image?.filename || t('previewAlt')} />
        </div>
      </section>
    </div>
  );
}
