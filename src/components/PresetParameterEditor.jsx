import { useMemo, useState } from 'react';
import { buildParameterSchema } from '../runtime/parameter-schema.mjs';
import { parseParameterOverrides } from '../runtime/preset-overrides.mjs';

function display(value) { return value === undefined || value === null || value === '' ? '默认' : String(value); }

function schemaForPreset(preset) {
  const extensionSchema = preset.extensions?.parameters?.schema;
  if (Array.isArray(extensionSchema) && extensionSchema.length) return extensionSchema;
  return buildParameterSchema({ commonSettings: preset.parameters || {} });
}

export default function PresetParameterEditor({ preset, value, onChange }) {
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
    } catch (parseError) { setError(parseError.message || '参数覆盖 JSON 无效'); }
  }

  return <div className="preset-parameter-editor">
    <div className="preset-parameter-toolbar"><span>仅应用于本次生成，不修改原预设</span><button type="button" className="btn btn-small" onClick={() => setAdvanced(current => !current)}>{advanced ? '返回可视化' : '高级 JSON'}</button></div>
    {advanced ? <div className="preset-parameter-advanced"><textarea value={advancedText} onChange={event => setAdvancedText(event.target.value)} />{error && <div className="form-error">{error}</div>}<button type="button" className="btn btn-small" onClick={applyAdvanced}>应用 JSON</button></div> : <div className="preset-parameter-grid">
      {schema.length ? schema.map(field => {
        const current = value?.[field.key];
        const type = field.type;
        return <label className="preset-parameter-field" key={field.key}><span><strong>{field.label || field.key}</strong><small>{display(current ?? field.value)}</small></span>{(type === 'select' || type === 'model') && (field.options || []).length > 0 ? <select value={current ?? ''} onChange={event => update(field.key, event.target.value)}><option value="">默认：{display(field.value)}</option>{(field.options || []).map(option => <option key={String(option)} value={option}>{String(option)}</option>)}</select> : type === 'number' && field.min !== undefined && field.max !== undefined ? <div className="preset-parameter-range"><input type="range" min={field.min} max={field.max} step={field.step} value={current ?? field.value ?? field.min} onChange={event => update(field.key, Number(event.target.value))} /><output>{display(current ?? field.value)}</output></div> : <input type={type === 'number' ? 'number' : 'text'} value={current ?? ''} placeholder={display(field.value)} min={field.min} max={field.max} step={field.step} onChange={event => update(field.key, type === 'number' ? Number(event.target.value) : event.target.value)} />}</label>;
      }) : <small className="preset-parameter-empty">当前预设没有可视化参数，使用高级 JSON。</small>}
    </div>}
  </div>;
}
