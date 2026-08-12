import { useMemo, useState } from 'react';
import Icon from './Icon.jsx';
import { useI18n } from '../i18n/I18nContext.jsx';
import { TEMPLATES, TEMPLATE_GROUPS } from '../provider-templates.js';

export default function ProviderPickerModal({ onPick, onCustom, onClose }) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState('deepseek');
  const [confirming, setConfirming] = useState(null);
  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return TEMPLATE_GROUPS.map(group => ({
      ...group,
      items: group.ids
        .map(id => TEMPLATES[id])
        .filter(item => !q
          || item.name.toLowerCase().includes(q)
          || String(item.mark || '').toLowerCase().includes(q)
          || (item.models || []).some(model => String(model.id || '').toLowerCase().includes(q) || String(model.name || '').toLowerCase().includes(q))),
    })).filter(group => group.items.length > 0);
  }, [query]);

  const selected = TEMPLATES[selectedId];

  function requestKey(template) {
    setConfirming(template.id);
    setName(template.name);
    setApiKey('');
    setError('');
  }

  async function submitKey() {
    setBusy(true);
    setError('');
    try {
      await onPick(TEMPLATES[confirming], { name: name.trim() || TEMPLATES[confirming].name, apiKey: apiKey.trim() });
    } catch (error) {
      setError(error.message || t('saveFailed'));
    } finally {
      setBusy(false);
    }
  }

  if (confirming) {
    const template = TEMPLATES[confirming];
    const local = template.type === 'ollama' || template.id === 'lmstudio' || /^http:\/\/(127\.0\.0\.1|localhost)/.test(template.baseUrl);
    return <div className="modal-overlay" onClick={onClose}>
      <section className="settings-panel picker-key-panel" onClick={event => event.stopPropagation()} aria-label={t('providerKeyTitle')}>
        <div className="modal-header"><div><h2>{t('providerKeyTitle')}</h2><p className="settings-header-note">{t('providerKeyHint')}</p></div><button className="btn btn-icon" onClick={() => setConfirming(null)} title={t('back')}><Icon name="chevronLeft" /></button></div>
        <div className="picker-key-body">
          <div className="picker-key-summary"><span className="template-card-mark">{template.mark}</span><div><strong>{template.name}</strong><code>{template.baseUrl}</code></div></div>
          <div className="settings-field"><label>{t('displayName')}</label><input value={name} onChange={event => setName(event.target.value)} placeholder={template.name} /></div>
          <div className="settings-field"><label>{t('apiKey')}</label><input type="password" value={apiKey} onChange={event => setApiKey(event.target.value)} placeholder={local ? t('localNoApiKey') : 'sk-...'} autoFocus /></div>
          {local && <p className="settings-muted">{t('providerKeyLocalHint')}</p>}
          {error && <p className="provider-status error">{error}</p>}
          <div className="settings-actions">
            <button className="btn" onClick={() => setConfirming(null)} disabled={busy}>{t('back')}</button>
            <button className="btn btn-primary" onClick={submitKey} disabled={busy}>{busy ? t('saving') : t('saveAndEnable')}</button>
          </div>
        </div>
      </section>
    </div>;
  }

  return <div className="modal-overlay" onClick={onClose}>
    <section className="settings-panel picker-panel" onClick={event => event.stopPropagation()} aria-label={t('templatePickerTitle')}>
      <div className="modal-header"><div><h2>{t('templatePickerTitle')}</h2><p className="settings-header-note">{t('templatePickerHint')}</p></div><button className="btn btn-icon" onClick={onClose} title={t('close')}><Icon name="close" /></button></div>
      <div className="picker-body">
        <div className="picker-list-column">
          <div className="picker-search"><Icon name="search" size={14} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder={t('templateSearchPlaceholder')} autoFocus /></div>
          <div className="picker-list">
            {groups.length === 0 ? <div className="settings-empty-state">{t('templateNoResults')}</div> : groups.map(group => <div className="template-group" key={group.key}>
              <div className="template-group-title">{t(group.labelKey)}</div>
              {group.items.map(item => <button key={item.id} className={`template-list-item${selectedId === item.id ? ' active' : ''}`} onClick={() => setSelectedId(item.id)}>
                <span className="template-card-mark">{item.mark}</span>
                <span className="template-list-item-name">{item.name}</span>
              </button>)}
            </div>)}
          </div>
        </div>
        <div className="picker-preview-column">
          <div className="picker-preview-head">
            <span className="template-card-mark">{selected.mark}</span>
            <div><strong>{selected.name}</strong><span className="provider-type-badge">{selected.type === 'ollama' ? 'Ollama' : 'OpenAI Compatible'}</span></div>
          </div>
          <div className="picker-preview-row"><span>{t('apiAddress')}</span><code>{selected.baseUrl}</code></div>
          <div className="picker-preview-models">
            <strong>{t('previewModels')}</strong>
            {(selected.models || []).map(model => <div className="picker-preview-model" key={model.id}>
              <code>{model.id}</code><span>{model.name || model.id}{model.kind === 'image' ? ` · ${t('imageCapability')} (${model.runtime === 'local' ? t('local') : t('cloud')})` : ''}</span>
            </div>)}
          </div>
          <div className="picker-preview-actions">
            <button className="btn btn-primary" onClick={() => requestKey(selected)}><Icon name="check" size={14} />{t('useTemplate')}</button>
            <button className="btn" onClick={onCustom}>{t('customConfig')}</button>
          </div>
        </div>
      </div>
    </section>
  </div>;
}