import { useEffect, useState } from 'react';
import Icon from './Icon.jsx';
import PresetParameterEditor from './PresetParameterEditor.jsx';
import { presetTagNodes } from './PresetTags.jsx';

export default function PresetDetailModal({ preset, tagTranslations = new Map(), onClose, onReuse }) {
  const [src, setSrc] = useState('');
  const [copied, setCopied] = useState('');
  const [dependencyReport, setDependencyReport] = useState(null);
  const [checking, setChecking] = useState(false);
  const [rating, setRating] = useState(preset?.rating || 0);
  const [overrideText, setOverrideText] = useState('{}');
  const [overrideError, setOverrideError] = useState('');
  const [positive, setPositive] = useState(preset?.positive || '');
  const [negative, setNegative] = useState(preset?.negative || '');

  useEffect(() => {
    let live = true;
    setSrc('');
    setDependencyReport(null);
    setRating(preset?.rating || 0);
    setOverrideText(JSON.stringify(preset?.parameterOverrides || {}, null, 2));
    setPositive(preset?.positive || '');
    setNegative(preset?.negative || '');
    if (preset?.cover) window.electronAPI.globalPresetImageData(preset.cover).then(value => live && setSrc(value));
    return () => { live = false; };
  }, [preset]);

  async function checkDependencies() {
    if (!preset?.id || !window.electronAPI.globalPresetCheckDependencies) return;
    setChecking(true);
    try { setDependencyReport(await window.electronAPI.globalPresetCheckDependencies(preset.id)); }
    catch (error) { setDependencyReport({ valid: false, issues: [{ severity: 'error', message: error.message || '依赖检查失败' }] }); }
    finally { setChecking(false); }
  }
  async function copyPrompt(type, value) {
    if (!value) return;
    try { await navigator.clipboard.writeText(value); setCopied(type); window.setTimeout(() => setCopied(''), 1200); } catch {}
  }
  async function exportPreset() { try { await window.electronAPI.globalPresetExport(preset.id); } catch {} }
  async function rate(value) { setRating(value); await window.electronAPI.globalPresetRate?.(preset.id, value).catch(() => {}); }
  function reuse(immediate) {
    try {
      const overrides = JSON.parse(overrideText || '{}');
      if (!overrides || Array.isArray(overrides) || typeof overrides !== 'object') throw new Error('参数覆盖必须是 JSON 对象');
      setOverrideError('');
      onReuse({ ...preset, positive, negative }, immediate, { settings: overrides });
    } catch (error) { setOverrideError(error.message || '参数覆盖 JSON 无效'); }
  }
  if (!preset) return null;
  const modelIssues = dependencyReport?.dependencies?.missingModels || [];
  let overrideValue = {};
  try {
    const parsed = JSON.parse(overrideText || '{}');
    if (parsed && !Array.isArray(parsed) && typeof parsed === 'object') overrideValue = parsed;
  } catch {}
  return <div className="modal-overlay" onMouseDown={event => event.target === event.currentTarget && onClose()}><section className="modal-panel preset-detail-modal">
    <header className="modal-header"><div><h2>{preset.title}</h2><p>{preset.description || '暂无描述'}</p></div><button className="btn btn-icon" onClick={onClose}><Icon name="close" /></button></header>
    <div className="preset-detail-content"><div className="preset-detail-cover">{src ? <img src={src} alt="" /> : <span>PRESET</span>}</div><div className="preset-detail-copy">
       <div className="preset-detail-meta">{presetTagNodes(preset.tags, tagTranslations)}</div>
      <div className="preset-detail-heading"><h3>正向提示词</h3><button className="btn btn-small" onClick={() => void copyPrompt('positive', positive)} disabled={!positive}>{copied === 'positive' ? '已复制' : '复制'}</button></div>
      <textarea className="preset-detail-draft" value={positive} onChange={event => setPositive(event.target.value)} aria-label="调整后的正向提示词" />
      <div className="preset-detail-heading"><h3>负向提示词</h3><button className="btn btn-small" onClick={() => void copyPrompt('negative', negative)} disabled={!negative}>{copied === 'negative' ? '已复制' : '复制'}</button></div>
      <textarea className="preset-detail-draft" value={negative} onChange={event => setNegative(event.target.value)} aria-label="调整后的负向提示词" />
      <h3>生成参数</h3><pre>{JSON.stringify(preset.parameters || {}, null, 2)}</pre>
      <div className="preset-override-section"><div className="preset-detail-heading"><h3>本次参数覆盖</h3></div><PresetParameterEditor preset={preset} value={overrideValue} onChange={next => { setOverrideText(JSON.stringify(next, null, 2)); setOverrideError(''); }} />{overrideError && <div className="form-error">{overrideError}</div>}</div>
      <div className="preset-rating-section"><span>效果评分</span>{[1, 2, 3, 4, 5].map(value => <button className={value <= rating ? 'active' : ''} key={value} onClick={() => void rate(value)} aria-label={`${value} 星`}>★</button>)}</div>
      <div className="preset-dependency-section"><div className="preset-detail-heading"><h3>生成依赖</h3><button className="btn btn-small" onClick={() => void checkDependencies()} disabled={checking}>{checking ? '检查中...' : '检查依赖'}</button></div>{dependencyReport && (dependencyReport.valid ? <div className="preset-dependency-ok"><Icon name="check" size={13} />依赖完整，可以生成</div> : <div className="preset-dependency-errors">{dependencyReport.issues?.map((issue, index) => <span key={`${issue.code || 'issue'}-${index}`}>{issue.message}</span>)}{modelIssues.map(model => <span key={`model-${model.value}`}>建议替换为：{model.candidates?.length ? model.candidates.join('、') : '未找到相近模型'}</span>)}</div>)}{!dependencyReport && <small>生成前可检查工作流、模型和素材是否完整</small>}</div>
      {preset.versions?.length > 0 && <div className="preset-version-section"><h3>版本历史</h3>{preset.versions.slice(-5).reverse().map((version, index) => <small key={`${version.savedAt}-${index}`}>{new Date(version.savedAt).toLocaleString()} · {version.workflow || '当前工作流'}</small>)}</div>}
    </div></div>
    <footer className="settings-footer"><button className="btn" onClick={onClose}>关闭</button><button className="btn" onClick={() => void exportPreset()}>导出预设</button><span className="settings-footer-spacer" /><button className="btn btn-primary" onClick={() => reuse(false)}>调整后生成</button><button className="btn" onClick={() => reuse(true)}>立即生成</button></footer>
  </section></div>;
}
