import { useEffect, useState } from 'react';
import Icon from './Icon.jsx';

const EMPTY = { title: '', description: '', positive: '', negative: '', tags: '', workflow: '', parameters: {}, source: 'direct', origin: 'chat', saveResults: true, useFirstAsCover: true };

export default function PresetSaveModal({ initial, onSave, onClose }) {
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
    if (!form.positive.trim()) { setError('正向提示词不能为空'); return; }
    let parameters;
    try { parameters = JSON.parse(parametersText || '{}'); } catch { setError('生成参数必须是有效 JSON'); return; }
    try {
      setSaving(true);
      await onSave({ ...form, parameters, tags: form.tags.split(/[,，]/).map(item => item.trim()).filter(Boolean) });
    } catch (saveError) { setError(saveError.message || '保存失败'); setSaving(false); }
  }
  return <div className="modal-overlay" onMouseDown={event => !saving && event.target === event.currentTarget && onClose()}><section className="modal-panel preset-editor-modal" onClick={event => event.stopPropagation()}><header className="modal-header"><div><h2>保存为预设</h2><p>保存当前生成配方和结果资源</p></div><button className="btn btn-icon" onClick={onClose} disabled={saving}><Icon name="close" /></button></header><form onSubmit={submit} className="preset-editor-form"><label>标题<input value={form.title} onChange={event => change('title', event.target.value)} required disabled={saving} /></label><label>描述<input value={form.description} onChange={event => change('description', event.target.value)} disabled={saving} /></label><label>正向提示词<textarea value={form.positive} onChange={event => change('positive', event.target.value)} required disabled={saving} /></label><label>负向提示词<textarea value={form.negative} onChange={event => change('negative', event.target.value)} disabled={saving} /></label><div className="preset-editor-two"><label>标签<input value={form.tags} onChange={event => change('tags', event.target.value)} placeholder="人物, 电影感" disabled={saving} /></label><label>工作流<input value={form.workflow} onChange={event => change('workflow', event.target.value)} disabled={saving} /></label></div><label>生成参数 JSON<textarea value={parametersText} onChange={event => setParametersText(event.target.value)} disabled={saving} /></label><label className="preset-checkbox"><input type="checkbox" checked={form.saveResults} onChange={event => change('saveResults', event.target.checked)} disabled={saving} />保存全部生成图片为预设资源</label><label className="preset-checkbox"><input type="checkbox" checked={form.useFirstAsCover} onChange={event => change('useFirstAsCover', event.target.checked)} disabled={saving} />第一张生成图片作为默认封面</label>{error && <div className="form-error">{error}</div>}<footer className="settings-footer"><span className="settings-footer-spacer" /><button type="button" className="btn" onClick={onClose} disabled={saving}>取消</button><button className="btn btn-primary" disabled={saving}>{saving ? '保存中...' : '保存预设'}</button></footer></form></section></div>;
}
