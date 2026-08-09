import Icon from './Icon.jsx';
import { useI18n } from '../i18n/I18nContext.jsx';

export default function PolicyConfirmModal({ pending, onConfirm, onCancel }) {
  const { t } = useI18n();
  if (!pending) return null;
  const categoryLabel = {
    sexual_content: t('policySexualContent'),
    sexualized_minors: t('policySexualizedMinors'),
    graphic_violence: t('policyGraphicViolence'),
    self_harm: t('policySelfHarm'),
    illicit_instructions: t('policyIllicitInstructions'),
    unreviewed_media: t('policyUnreviewedMedia'),
  };
  const categories = (pending.categories || []).map(category => categoryLabel[category] || category);
  const referenceImages = pending.images || [];
  return (
    <div className="modal-overlay prompt-preview-overlay">
      <section className="prompt-preview-panel" onClick={event => event.stopPropagation()} aria-label={t('policyReviewTitle')}>
        <header className="modal-header prompt-preview-header">
          <div>
            <h2>{t('policyBlockedTitle')}</h2>
            <p>{t('policyNotSent')}</p>
          </div>
          <button className="btn btn-icon" onClick={onCancel} title={t('close')}><Icon name="close" /></button>
        </header>
        <div className="prompt-preview-body">
          <div className="prompt-preview-warning">{pending.message || t('policyBlockedDefault')}</div>
          {categories.length > 0 && (
            <section className="prompt-preview-section">
              <h3>{t('policyReason')}</h3>
              <p className="prompt-preview-text">{categories.join('、')}</p>
            </section>
          )}
          <section className="prompt-preview-section">
            <h3>{t('blockedContent')}</h3>
            <p className="prompt-preview-text">{pending.text}</p>
            {referenceImages.length > 0 && (
              <p className="prompt-preview-text"><strong>{t('policySourceLabel')}</strong>{referenceImages.map((image, index) => image.name || image.filename || t('policyAttachment', { n: index + 1 })).join('、')}</p>
            )}
          </section>
          {pending.requiresLocal && (
            <div className="prompt-preview-warning">{pending.localUnavailable ? t('policyLocalUnavailable') : t('policyLocalRequired')}</div>
          )}
          <p className="prompt-preview-assistant-note">{t('policyRiskNote')}</p>
        </div>
        <footer className="settings-footer prompt-preview-footer">
          <span>{t('policyCancelNote')}</span>
          <span className="settings-footer-spacer" />
          <button className="btn" onClick={onCancel}>{t('cancel')}</button>
          <button className="btn btn-primary" onClick={onConfirm}>{t('sendAnyway')}</button>
        </footer>
      </section>
    </div>
  );
}
