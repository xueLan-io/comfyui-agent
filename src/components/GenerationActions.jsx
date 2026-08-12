import { useState } from 'react';
import Icon from './Icon.jsx';
import PresetSaveModal from './PresetSaveModal.jsx';
import { useI18n } from '../i18n/I18nContext.jsx';

export default function GenerationActions({ record, onRegenerate, onEdit, onAdjust }) {
  const { t } = useI18n();
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');
  const savePreset = async form => {
    const resultRefs = form.saveResults ? record.media || [] : [];
    const saved = await window.electronAPI.globalPresetCreate({
      ...form,
      source: record.source === 'openai-image' ? 'cloud' : 'direct',
      origin: 'chat',
      workflow: record.workflowName || '',
      workflowName: record.workflowName || '',
      parameters: form.parameters || record.parameters || {},
      nodeOverrides: record.nodeOverrides || {},
      outputNodeIds: record.outputNodeIds || null,
      modelRequirements: [],
      resultRefs,
      coverRef: form.useFirstAsCover ? resultRefs[0] : null,
    });
    setSaveOpen(false);
    setSaveMessage(t('presetSaved', { name: saved?.title || form.title }));
    window.setTimeout(() => setSaveMessage(''), 3500);
    window.dispatchEvent(new CustomEvent('comfy-agent:preset-saved', { detail: { id: saved?.id || '', title: saved?.title || form.title, preset: saved } }));
  };
  return <>
    <div className="output-controls">
      <div className="output-primary-actions">
        <button className="btn btn-primary" onClick={() => onRegenerate(record)}><Icon name="refresh" size={14} /> {t('regenerate')}</button>
        <button className="btn output-secondary-action" onClick={() => onEdit(record)}><Icon name="edit" size={13} /> {t('editPrompt')}</button>
        <button className="btn output-secondary-action" onClick={() => setSaveOpen(true)}><Icon name="bookmark" size={13} /> {t('saveAsPreset')}</button>
        <button className="btn btn-icon output-settings-action" onClick={() => onAdjust(record)} title={t('adjustParameters')} aria-label={t('adjustParameters')}><Icon name="sliders" size={14} /></button>
      </div>
      {saveMessage && <span className="output-save-message" role="status">{saveMessage}</span>}
    </div>
    {saveOpen && <PresetSaveModal initial={{ title: (record.prompt || '').slice(0, 28) || t('newPresetDefault'), positive: record.prompt || '', negative: record.negative || '', workflow: record.workflowName || '', parameters: record.parameters || {}, tags: '' }} onSave={savePreset} onClose={() => setSaveOpen(false)} />}
  </>;
}
