import { useEffect, useState } from 'react';
import Icon from './Icon.jsx';
import PresetParameterEditor from './PresetParameterEditor.jsx';
import { presetTagNodes } from './PresetTags.jsx';
import { useI18n } from '../i18n/I18nContext.jsx';
import { useBatchQueue } from '../contexts/BatchQueueContext.jsx';
import { buildPresetGenerationRequest } from '../runtime/preset-generation.mjs';

export default function PresetDetailModal({ preset, tagTranslations = new Map(), onClose, onReuse }) {
  const { t } = useI18n();
  const { addToQueue } = useBatchQueue();
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
    catch (error) { setDependencyReport({ valid: false, issues: [{ severity: 'error', message: error.message || t('pdDepCheckFailed') }] }); }
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
      if (!overrides || Array.isArray(overrides) || typeof overrides !== 'object') throw new Error(t('pdOverridesObject'));
      setOverrideError('');
      onReuse({ ...preset, positive, negative }, immediate, { settings: overrides });
    } catch (error) { setOverrideError(error.message || t('ppeJsonInvalid')); }
  }
  function enqueuePreset() {
    addToQueue(buildPresetGenerationRequest({ ...preset, positive, negative }), { sourceKind: 'preset', sourceLabel: preset.title });
  }
  if (!preset) return null;
  const modelIssues = dependencyReport?.dependencies?.missingModels || [];
  let overrideValue = {};
  try {
    const parsed = JSON.parse(overrideText || '{}');
    if (parsed && !Array.isArray(parsed) && typeof parsed === 'object') overrideValue = parsed;
  } catch {}
  return <div className="modal-overlay" onMouseDown={event => event.target === event.currentTarget && onClose()}><section className="modal-panel preset-detail-modal">
    <header className="modal-header"><div><h2>{preset.title}</h2><p>{preset.description || t('floatPresetNoDescription')}</p></div><button className="btn btn-icon" onClick={onClose}><Icon name="close" /></button></header>
    <div className="preset-detail-content"><div className="preset-detail-cover">{src ? <img src={src} alt="" /> : <span>PRESET</span>}</div><div className="preset-detail-copy">
       <div className="preset-detail-meta">{presetTagNodes(preset.tags, tagTranslations)}</div>
      <div className="preset-detail-heading"><h3>{t('ppPositiveLabel')}</h3><button className="btn btn-small" onClick={() => void copyPrompt('positive', positive)} disabled={!positive}>{copied === 'positive' ? t('floatCopied') : t('floatCopy')}</button></div>
      <textarea className="preset-detail-draft" value={positive} onChange={event => setPositive(event.target.value)} aria-label={t('pdPositiveDraft')} />
      <div className="preset-detail-heading"><h3>{t('ppNegativeLabel')}</h3><button className="btn btn-small" onClick={() => void copyPrompt('negative', negative)} disabled={!negative}>{copied === 'negative' ? t('floatCopied') : t('floatCopy')}</button></div>
      <textarea className="preset-detail-draft" value={negative} onChange={event => setNegative(event.target.value)} aria-label={t('pdNegativeDraft')} />
      <h3>{t('pdParamsTitle')}</h3><pre>{JSON.stringify(preset.parameters || {}, null, 2)}</pre>
      <div className="preset-override-section"><div className="preset-detail-heading"><h3>{t('pdOverridesTitle')}</h3></div><PresetParameterEditor preset={preset} value={overrideValue} onChange={next => { setOverrideText(JSON.stringify(next, null, 2)); setOverrideError(''); }} />{overrideError && <div className="form-error">{overrideError}</div>}</div>
      <div className="preset-rating-section"><span>{t('pdRating')}</span>{[1, 2, 3, 4, 5].map(value => <button className={value <= rating ? 'active' : ''} key={value} onClick={() => void rate(value)} aria-label={t('pdStars', { n: value })}>★</button>)}</div>
      <div className="preset-dependency-section"><div className="preset-detail-heading"><h3>{t('pdDepsTitle')}</h3><button className="btn btn-small" onClick={() => void checkDependencies()} disabled={checking}>{checking ? t('settingsChecking') : t('pdCheckDeps')}</button></div>{dependencyReport && (dependencyReport.valid ? <div className="preset-dependency-ok"><Icon name="check" size={13} />{t('pdDepsOk')}</div> : <div className="preset-dependency-errors">{dependencyReport.issues?.map((issue, index) => <span key={`${issue.code || 'issue'}-${index}`}>{issue.message}</span>)}{modelIssues.map(model => <span key={`model-${model.value}`}>{t('pdSuggestReplace', { candidates: model.candidates?.length ? model.candidates.join('、') : t('pdNoSimilar') })}</span>)}</div>)}{!dependencyReport && <small>{t('pdDepsHint')}</small>}</div>
      {preset.versions?.length > 0 && <div className="preset-version-section"><h3>{t('pdVersionsTitle')}</h3>{preset.versions.slice(-5).reverse().map((version, index) => <small key={`${version.savedAt}-${index}`}>{new Date(version.savedAt).toLocaleString()} · {version.workflow || t('pdCurrentWorkflow')}</small>)}</div>}
    </div></div>
    <footer className="settings-footer"><button className="btn" onClick={onClose}>{t('pdClose')}</button><button className="btn" onClick={() => void exportPreset()}>{t('pdExport')}</button><span className="settings-footer-spacer" /><button className="btn" onClick={enqueuePreset} title={t('queueAddHint')}><Icon name="queueAdd" size={13} />{t('queueAdd')}</button><button className="btn btn-primary" onClick={() => reuse(false)}>{t('floatPresetAdjustGenerate')}</button><button className="btn" onClick={() => reuse(true)}>{t('floatPresetGenerateNow')}</button></footer>
  </section></div>;
}
