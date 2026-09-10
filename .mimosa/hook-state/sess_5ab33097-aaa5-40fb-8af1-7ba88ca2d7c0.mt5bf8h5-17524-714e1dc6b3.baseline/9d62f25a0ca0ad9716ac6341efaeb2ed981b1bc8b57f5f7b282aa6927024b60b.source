import { useEffect, useState } from 'react';
import Icon from './Icon.jsx';
import { useI18n } from '../i18n/I18nContext.jsx';

const EMPTY = { title: '', description: '', positive: '', negative: '', tags: '', workflow: '', parameters: {}, source: 'direct', origin: 'chat', saveResults: true, useFirstAsCover: true };

export default function PresetSaveModal({ initial, onSave, onClose }) {
  const { t } = useI18n();
  const [form, setForm] = useState({ ...EMPTY, ...(initial || {}) });
  const [parametersText, setParametersText] = useState(JSON.stringify(initial?.parameters || {}, null, 2));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setForm({ ...EMPTY, ...(initial || {}) });
    setParametersText(JSON.stringify(initial?.parameters || {}, null, 2));
  }, [initial]);
  const change = (key, value) => setForm(current => ({ ...current, [key]: value }));
  async function submit(event) {
    event.preventDefault();
    if (saving) return;
    setError('');
    if (!form.positive.trim()) { setError(t('psPositiveRequired')); return; }
    let parameters;
    try { parameters = JSON.parse(parametersText || '{}'); } catch { setError(t('psParamsJsonInvalid')); return; }
    try {
      setSaving(true);
      await onSave({ ...form, parameters, tags: form.tags.split(/[,，]/).map(item => item.trim()).filter(Boolean) });
    } catch (saveError) { setError(saveError.message || t('psSaveFailed')); setSaving(false); }
  }
  return <div className="modal-overlay" onMouseDown={event => !saving && event.target === event.currentTarget && onClose()}><section className="modal-panel preset-editor-modal" onClick={event => event.stopPropagation()}><header className="modal-header"><div><h2>{t('psSaveTitle')}</h2><p>{t('psSaveSubtitle')}</p></div><button className="btn btn-icon" onClick={onClose} disabled={saving}><Icon name="close" /></button></header><form onSubmit={submit} className="preset-editor-form"><label>{t('psTitleLabel')}<input value={form.title} onChange={event => change('title', event.target.value)} required disabled={saving} /></label><label>{t('psDescLabel')}<input value={form.description} onChange={event => change('description', event.target.value)} disabled={saving} /></label><label>{t('ppPositiveLabel')}<textarea value={form.positive} onChange={event => change('positive', event.target.value)} required disabled={saving} /></label><label>{t('ppNegativeLabel')}<textarea value={form.negative} onChange={event => change('negative', event.target.value)} disabled={saving} /></label><div className="preset-editor-two"><label>{t('psTagsLabel')}<input value={form.tags} onChange={event => change('tags', event.target.value)} placeholder={t('psTagsPlaceholder')} disabled={saving} /></label><label>{t('psWorkflowLabel')}<input value={form.workflow} onChange={event => change('workflow', event.target.value)} disabled={saving} /></label></div><label>{t('psParamsLabel')}<textarea value={parametersText} onChange={event => setParametersText(event.target.value)} disabled={saving} /></label><label className="preset-checkbox"><input type="checkbox" checked={form.saveResults} onChange={event => change('saveResults', event.target.checked)} disabled={saving} />{t('psSaveResultsLabel')}</label><label className="preset-checkbox"><input type="checkbox" checked={form.useFirstAsCover} onChange={event => change('useFirstAsCover', event.target.checked)} disabled={saving} />{t('psCoverLabel')}</label>{error && <div className="form-error">{error}</div>}<footer className="settings-footer"><span className="settings-footer-spacer" /><button type="button" className="btn" onClick={onClose} disabled={saving}>{t('cancel')}</button><button className="btn btn-primary" disabled={saving}>{saving ? t('psSaving') : t('psSavePreset')}</button></footer></form></section></div>;
}
