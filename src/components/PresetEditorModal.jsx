import { useEffect, useState } from 'react';
import Icon from './Icon.jsx';

const EMPTY = { title: '', description: '', positive: '', negative: '', tags: [], workflow: '', parameters: {}, source: 'direct', origin: 'manual' };

export default function PresetEditorModal({ preset, onSave, onClose }) {
  const [form, setForm] = useState({ ...EMPTY, ...(preset || {}) });
  const [coverPath, setCoverPath] = useState('');
  const [error, setError] = useState('');
  useEffect(() => setForm({ ...EMPTY, ...(preset || {}) }), [preset]);
  const change = (key, value) => setForm(current => ({ ...current, [key]: value }));
  async function selectCover() { const path = await window.electronAPI.globalPresetSelectCover(); if (path) setCoverPath(path); }
  async function submit(event) {
    event.preventDefault();
    if (!form.positive.trim()) { setError('正向提示词不能为空'); return; }
    try { await onSave({ ...form, tags: typeof form.tags === 'string' ? form.tags.split(/[,，]/).map(item => item.trim()).filter(Boolean) : form.tags, ...(coverPath ? { _coverPath: coverPath } : {}) }); } catch (saveError) { setError(saveError.message || '保存失败'); }
  }
  return <div className="modal-overlay" onMouseDown={event => event.target === event.currentTarget && onClose()}><section className="modal-panel preset-editor-modal" onClick={event => event.stopPropagation()}><header className="modal-header"><div><h2>{preset ? '编辑预设' : '新建预设'}</h2><p>全局预设，不绑定当前项目</p></div><button className="btn btn-icon" onClick={onClose}><Icon name="close" /></button></header><form onSubmit={submit} className="preset-editor-form"><label>名称<input value={form.title} onChange={event => change('title', event.target.value)} placeholder="例如：黄昏车站人像" required /></label><label>描述<input value={form.description} onChange={event => change('description', event.target.value)} /></label><label>正向提示词<textarea value={form.positive} onChange={event => change('positive', event.target.value)} required /></label><label>负向提示词<textarea value={form.negative} onChange={event => change('negative', event.target.value)} /></label><div className="preset-editor-two"><label>标签<input value={Array.isArray(form.tags) ? form.tags.join(', ') : form.tags} onChange={event => change('tags', event.target.value)} placeholder="人物, 电影感" /></label><label>工作流<input value={form.workflow} onChange={event => change('workflow', event.target.value)} placeholder="workflow.json" /></label></div><label>生成参数 JSON<textarea value={JSON.stringify(form.parameters || {}, null, 2)} onChange={event => { try { change('parameters', JSON.parse(event.target.value || '{}')); } catch {} }} /></label><div className="preset-cover-picker"><span>封面图：{coverPath || form.cover?.name || '默认占位图'}</span><button type="button" className="btn" onClick={selectCover}>选择封面</button></div>{error && <div className="form-error">{error}</div>}<footer className="settings-footer"><span className="settings-footer-spacer" /><button type="button" className="btn" onClick={onClose}>取消</button><button className="btn btn-primary">保存预设</button></footer></form></section></div>;
}
