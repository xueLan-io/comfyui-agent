import { useMemo, useState } from 'react';
import { buildParameterSchema } from '../runtime/parameter-schema.mjs';
import { parseParameterOverrides } from '../runtime/preset-overrides.mjs';
import { useI18n } from '../i18n/I18nContext.jsx';

function display(value, t) { return value === undefined || value === null || value === '' ? t('ppeDefault') : String(value); }

function schemaForPreset(preset) {
  const extensionSchema = preset.extensions?.parameters?.schema;
  if (Array.isArray(extensionSchema) && extensionSchema.length) return extensionSchema;
  return buildParameterSchema({ commonSettings: preset.parameters || {} });
}

export default function PresetParameterEditor({ preset, value, onChange }) {
  const { t } = useI18n();
  const schema = useMemo(() => schemaForPreset(preset), [preset]);
  const [advanced, setAdvanced] = useState(false);
  const [advancedText, setAdvancedText] = useState(JSON.stringify(value || {}, null, 2));
  const [error, setError] = useState('');

  function update(key, next) {
    const result = { ...(value || {}) };
    if (next === undefined || next === '') delete result[key];
    else result[key] = next;
    onChange(result);
    setAdvancedText(JSON.stringify(result, null, 2));
  }

  function applyAdvanced() {
    try {
      const next = parseParameterOverrides(advancedText);
      onChange(next);
      setAdvancedText(JSON.stringify(next, null, 2));
      setError('');
    } catch (parseError) { setError(parseError.message || t('ppeJsonInvalid')); }
  }

  return <div className="preset-parameter-editor">
    <div className="preset-parameter-toolbar"><span>{t('ppeToolbarNote')}</span><button type="button" className="btn btn-small" onClick={() => setAdvanced(current => !current)}>{advanced ? t('ppeBackVisual') : t('ppeAdvancedJson')}</button></div>
    {advanced ? <div className="preset-parameter-advanced"><textarea value={advancedText} onChange={event => setAdvancedText(event.target.value)} />{error && <div className="form-error">{error}</div>}<button type="button" className="btn btn-small" onClick={applyAdvanced}>{t('ppeApplyJson')}</button></div> : <div className="preset-parameter-grid">
      {schema.length ? schema.map(field => {
        const current = value?.[field.key];
        const type = field.type;
        return <label className="preset-parameter-field" key={field.key}><span><strong>{field.label || field.key}</strong><small>{display(current ?? field.value, t)}</small></span>{(type === 'select' || type === 'model') && (field.options || []).length > 0 ? <select value={current ?? ''} onChange={event => update(field.key, event.target.value)}><option value="">{t('ppeDefaultOption', { value: display(field.value, t) })}</option>{(field.options || []).map(option => <option key={String(option)} value={option}>{String(option)}</option>)}</select> : type === 'number' && field.min !== undefined && field.max !== undefined ? <div className="preset-parameter-range"><input type="range" min={field.min} max={field.max} step={field.step} value={current ?? field.value ?? field.min} onChange={event => update(field.key, Number(event.target.value))} /><output>{display(current ?? field.value, t)}</output></div> : <input type={type === 'number' ? 'number' : 'text'} value={current ?? ''} placeholder={display(field.value, t)} min={field.min} max={field.max} step={field.step} onChange={event => update(field.key, type === 'number' ? Number(event.target.value) : event.target.value)} />}</label>;
      }) : <small className="preset-parameter-empty">{t('ppeNoVisualParams')}</small>}
    </div>}
  </div>;
}
