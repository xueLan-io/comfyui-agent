import { useState } from 'react';
import Icon from './Icon.jsx';
import { buildFeedbackReport, buildGitHubIssueUrl } from '../runtime/feedback-report.mjs';
import { useI18n } from '../i18n/I18nContext.jsx';

export default function ErrorFeedbackModal({ error, version = '', onClose }) {
  const { t } = useI18n();
  const [details, setDetails] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const report = buildFeedbackReport({ ...error, details, version });

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      const result = await window.electronAPI.openExternal(buildGitHubIssueUrl(report, ['bug']));
      if (result === false) throw new Error(t('feedbackCantOpenBrowser'));
      onClose();
    } catch (submitError) {
      setMessage(submitError.message || t('feedbackOpenFailed'));
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={event => event.target === event.currentTarget && !busy && onClose()}>
      <section className="modal-panel error-feedback-modal" onClick={event => event.stopPropagation()}>
        <header className="modal-header">
          <div><h2>{t('feedbackTitle')}</h2><p>{t('feedbackSubtitle')}</p></div>
          <button className="btn btn-icon" onClick={onClose} disabled={busy} aria-label={t('close')}><Icon name="close" size={15} /></button>
        </header>
        <form onSubmit={submit} className="error-feedback-form">
          <div className="error-feedback-notice"><Icon name="circleAlert" size={14} />{t('feedbackNotice')}</div>
          <label>{t('feedbackDetailsLabel')}<textarea value={details} onChange={event => setDetails(event.target.value)} placeholder={t('feedbackDetailsPlaceholder')} rows={5} autoFocus /></label>
          <label>{t('feedbackSummaryLabel')}<textarea value={report.body} readOnly rows={10} /></label>
          {message && <div className="form-error">{message}</div>}
          <footer className="settings-footer"><span className="settings-footer-spacer" /><button type="button" className="btn" onClick={onClose} disabled={busy}>{t('cancel')}</button><button type="submit" className="btn btn-primary" disabled={busy}>{busy ? t('feedbackOpening') : t('feedbackOpenGitHub')}</button></footer>
        </form>
      </section>
    </div>
  );
}
