import Icon from './Icon.jsx';
import { useI18n } from '../i18n/I18nContext.jsx';

const CATEGORY_LABELS = {
  sexual_content: '色情内容',
  sexualized_minors: '未成年色情内容',
  graphic_violence: '暴力血腥内容',
  self_harm: '自残自杀内容',
  illicit_instructions: '非法指令',
  unreviewed_media: '未审查的媒体内容',
};

export default function PolicyConfirmModal({ pending, onConfirm, onCancel }) {
  const { t } = useI18n();
  if (!pending) return null;
  const categories = (pending.categories || []).map(category => CATEGORY_LABELS[category] || category);
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
          </section>
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
