import { useEffect, useState } from 'react';
import Icon from './Icon.jsx';
import { useI18n } from '../i18n/I18nContext.jsx';

const EMPTY = { title: '', description: '', positive: '', negative: '', tags: [], workflow: '', parameters: {}, source: 'direct', origin: 'manual' };

export default function PresetEditorModal({ preset, onSave, onClose }) {
  const { t } = useI18n();
  const [form, setForm] = useState({ ...EMPTY, ...(preset || {}) });
  const [coverPath, setCoverPath] = useState('');
  const [error, setError] = useState('');
  useEffect(() => setForm({ ...EMPTY, ...(preset || {}) }), [preset]);
  const change = (key, value) => setForm(current => ({ ...current, [key]: value }));
  async function selectCover() { const path = await window.electronAPI.globalPresetSelectCover(); if (path) setCoverPath(path); }
  async function submit(event) {
    event.preventDefault();
    if (!form.positive.trim()) { setError(t('psPositiveRequired')); return; }
    try { await onSave({ ...form, tags: typeof form.tags === 'string' ? form.tags.split(/[,，]/).map(item => item.trim()).filter(Boolean) : form.tags, ...(coverPath ? { _coverPath: coverPath } : {}) }); } catch (saveError) { setError(saveError.message || t('psSaveFailed')); }
  }
  return <div className="modal-overlay" onMouseDown={event => event.target === event.currentTarget && onClose()}><section className="modal-panel preset-editor-modal" onClick={event => event.stopPropagation()}><header className="modal-header"><div><h2>{preset ? t('peEditTitle') : t('peNewTitle')}</h2><p>{t('peSubtitle')}</p></div><button className="btn btn-icon" onClick={onClose}><Icon name="close" /></button></header><form onSubmit={submit} className="preset-editor-form"><label>{t('peNameLabel')}<input value={form.title} onChange={event => change('title', event.target.value)} placeholder={t('peNamePlaceholder')} required /></label><label>{t('psDescLabel')}<input value={form.description} onChange={event => change('description', event.target.value)} /></label><label>{t('ppPositiveLabel')}<textarea value={form.positive} onChange={event => change('positive', event.target.value)} required /></label><label>{t('ppNegativeLabel')}<textarea value={form.negative} onChange={event => change('negative', event.target.value)} /></label><div className="preset-editor-two"><label>{t('psTagsLabel')}<input value={Array.isArray(form.tags) ? form.tags.join(', ') : form.tags} onChange={event => change('tags', event.target.value)} placeholder={t('psTagsPlaceholder')} /></label><label>{t('psWorkflowLabel')}<input value={form.workflow} onChange={event => change('workflow', event.target.value)} placeholder="workflow.json" /></label></div><label>{t('psParamsLabel')}<textarea value={JSON.stringify(form.parameters || {}, null, 2)} onChange={event => { try { change('parameters', JSON.parse(event.target.value || '{}')); } catch {} }} /></label><div className="preset-cover-picker"><span>{t('peCoverLabel', { name: coverPath || form.cover?.name || t('peCoverDefault') })}</span><button type="button" className="btn" onClick={selectCover}>{t('peSelectCover')}</button></div>{error && <div className="form-error">{error}</div>}<footer className="settings-footer"><span className="settings-footer-spacer" /><button type="button" className="btn" onClick={onClose}>{t('cancel')}</button><button className="btn btn-primary">{t('psSavePreset')}</button></footer></form></section></div>;
}
