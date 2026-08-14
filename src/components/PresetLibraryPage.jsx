import { useEffect, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import PresetEditorModal from './PresetEditorModal.jsx';
import PresetDetailModal from './PresetDetailModal.jsx';
import { sortRecommended } from '../runtime/preset-recommendation.mjs';
import { buildPresetGenerationRequest } from '../runtime/preset-generation.mjs';
import { DragGhost, useFloatingCardDrag } from './useFloatingCardDrag.jsx';
import { useI18n } from '../i18n/I18nContext.jsx';
import { useBatchQueue } from '../contexts/BatchQueueContext.jsx';
import { presetTagNodes, usePresetTagTranslations } from './PresetTags.jsx';

export default function PresetLibraryPage({ hidden = false, onBack, onReuse }) {
  const { t, language } = useI18n();
  const tagTranslations = usePresetTagTranslations();
  const [presets, setPresets] = useState([]);
  const [search, setSearch] = useState('');
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [editor, setEditor] = useState(null);
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState('');
  const [highlighted, setHighlighted] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [selectedIds, setSelectedIds] = useState([]);
  const [recommended, setRecommended] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const refreshVersion = useRef(0);
  const windowApi = window.electronAPI;

  useEffect(() => {
    windowApi?.windowIsMaximized?.().then(setMaximized).catch(() => {});
  }, [windowApi]);

  async function toggleMaximize() {
    if (windowApi?.windowToggleMaximize) setMaximized(await windowApi.windowToggleMaximize());
  }

  async function refresh() {
    const version = ++refreshVersion.current;
    setRefreshing(true);
    setError('');
    try { const next = await window.electronAPI.globalPresetsList(); if (version === refreshVersion.current) setPresets(next); }
    catch (e) { if (version === refreshVersion.current) setError(e.message || t('loadPresetsFailed')); }
    finally { if (version === refreshVersion.current) setRefreshing(false); }
  }

  useEffect(() => {
    void refresh();
    const onSaved = event => {
      const saved = event.detail?.preset;
      const savedId = event.detail?.id || saved?.id || '';
      if (saved?.id) setPresets(current => [saved, ...current.filter(item => item.id !== saved.id)]);
      setHighlighted(savedId);
      void refresh();
      window.setTimeout(() => setHighlighted(''), 2500);
    };
    window.addEventListener('comfy-agent:preset-highlight', onSaved);
    return () => window.removeEventListener('comfy-agent:preset-highlight', onSaved);
  }, []);

  async function save(input) {
    let value = { ...input };
    if (input._coverPath) {
      value = { ...value, coverSourcePath: input._coverPath };
    }
    delete value._coverPath;
    const saved = editor?.id
      ? await window.electronAPI.globalPresetUpdate(editor.id, value)
      : await window.electronAPI.globalPresetCreate(value);
    setEditor(null);
    setHighlighted(saved?.id || value.id || '');
    setFeedback(t('presetSavedAndOpened', { name: saved?.title || value.title }));
    window.setTimeout(() => setFeedback(''), 3500);
    if (saved?.id) setPresets(current => [saved, ...current.filter(item => item.id !== saved.id)]);
    await refresh();
  }

  async function importPreset() {
    const path = await window.electronAPI.globalPresetSelectImport();
    if (!path) return;
    try { await window.electronAPI.globalPresetImport(path); await refresh(); }
    catch (e) { setError(e.message || t('importFailed')); }
  }

  async function remove(preset) {
    if (!window.confirm(t('deletePresetConfirm', { name: preset.title }))) return;
    try { await window.electronAPI.globalPresetDelete(preset.id); await refresh(); }
    catch (e) { setError(e.message || t('deleteFailed')); }
  }

  async function toggleFavorite(preset) {
    try { await window.electronAPI.globalPresetUpdate(preset.id, { favorite: !preset.favorite }); await refresh(); }
    catch (e) { setError(e.message || t('updateFailed')); }
  }

  async function copyPreset(preset) {
    try { await window.electronAPI.globalPresetCopy(preset.id); await refresh(); }
    catch (e) { setError(e.message || t('copyFailed')); }
  }

  async function exportPreset(preset) {
    try { await window.electronAPI.globalPresetExport(preset.id); }
    catch (e) { setError(e.message || t('exportFailed')); }
  }
  async function composeSelected() {
    if (selectedIds.length < 2) return;
    try {
      await window.electronAPI.globalPresetCompose(selectedIds);
      setSelectedIds([]);
      setFeedback(t('presetComposed'));
      await refresh();
    } catch (e) { setError(e.message || t('composeFailed')); }
  }

  const filtered = presets
    .filter(preset => !favoriteOnly || preset.favorite)
    .filter(preset => `${preset.title} ${preset.description} ${preset.positive} ${(preset.tags || []).join(' ')}`.toLowerCase().includes(search.toLowerCase()));
  const visible = recommended ? sortRecommended(filtered) : [...filtered].sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <main className={`preset-library-page${hidden ? ' view-hidden' : ''}`}>
       <div className="preset-window-bar"><span>GLOBAL PRESETS</span>{windowApi && <div className="window-controls" aria-label={t('windowControls')}><button className="window-control" onClick={() => windowApi.windowMinimize()} title={t('minimize')}><Icon name="minimize" /></button><button className="window-control" onClick={toggleMaximize} title={maximized ? t('restore') : t('maximize')}><Icon name={maximized ? 'restore' : 'maximize'} /></button><button className="window-control window-control-close" onClick={() => windowApi.windowClose()} title={t('close')}><Icon name="windowClose" /></button></div>}</div>
       <header className="preset-library-header">
          <div className="preset-library-title"><span className="section-kicker">GLOBAL PRESETS</span><h1>{t('presetsTitle')}</h1><p>{t('presetsDescription')}</p></div>
          <div className="preset-library-actions"><button className="btn" onClick={onBack}>{t('back')}</button><button className="btn" onClick={importPreset}>{t('uploadPreset')}</button><button className="btn" onClick={() => void composeSelected()} disabled={selectedIds.length < 2}>{t('compose')}{selectedIds.length > 1 ? ` (${selectedIds.length})` : ''}</button><button className="btn btn-primary" onClick={() => setEditor({})}>{t('newPreset')}</button></div>
      </header>
       <div className="preset-library-toolbar"><label className="asset-library-search"><Icon name="search" size={14} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder={t('searchPresets')} /></label><button className={`btn${recommended ? ' active' : ''}`} onClick={() => setRecommended(value => !value)}><Icon name="spark" size={13} /> {t('recommendedSort')}</button><button className={`btn${favoriteOnly ? ' active' : ''}`} onClick={() => setFavoriteOnly(value => !value)}><Icon name="star" size={13} /> {t('favoritesOnly')}</button><button className="btn btn-icon" onClick={() => void refresh()} disabled={refreshing} title={t('refreshNow')} aria-label={t('refreshNow')}><Icon name="refresh" size={13} /></button><span className="asset-library-count">{refreshing ? t('refreshInProgress') : `${visible.length} / ${presets.length}`}</span></div>
      {feedback && <div className="preset-save-feedback preset-library-feedback" role="status" aria-live="polite"><Icon name="check" size={13} />{feedback}</div>}
      {error && <div className="form-error">{error}</div>}
        {visible.length ? <div className="preset-library-grid">{visible.map(preset => <DraggablePresetCard key={preset.id} preset={preset} highlighted={highlighted === preset.id} selected={selectedIds.includes(preset.id)} onSelect={() => setSelectedIds(current => current.includes(preset.id) ? current.filter(id => id !== preset.id) : [...current, preset.id])} onOpen={() => setDetail(preset)} onReuse={onReuse} onToggleFavorite={toggleFavorite} onExport={exportPreset} onEdit={setEditor} onCopy={copyPreset} onDelete={remove} t={t} language={language} tagTranslations={tagTranslations} />)}</div> : <div className="asset-library-empty"><strong>{t('noPresets')}</strong><span>{t('noPresetsHint')}</span></div>}
      {editor && <PresetEditorModal preset={editor.id ? editor : null} onSave={save} onClose={() => setEditor(null)} />}
       {detail && <PresetDetailModal preset={detail} tagTranslations={tagTranslations} onClose={() => setDetail(null)} onReuse={onReuse} />}
    </main>
  );
}

function DraggablePresetCard({ preset, highlighted, selected, onSelect, onOpen, onReuse, onToggleFavorite, onExport, onEdit, onCopy, onDelete, t, language, tagTranslations }) {
  const { addToQueue } = useBatchQueue();
  const drag = useFloatingCardDrag({
    kind: 'preset-card',
    presetId: preset.id,
    title: preset.title,
    positive: preset.positive || '',
    negative: preset.negative || '',
    target: 'preset',
    mode: 'replace',
    workflowName: preset.workflowName || preset.workflow || '',
    parameters: preset.parameters || {},
    nodeOverrides: preset.nodeOverrides || {},
    outputNodeIds: preset.outputNodeIds || null,
    sourceImages: preset.sourceImages || [],
    tags: preset.tags || [],
  });
  const enqueuePreset = () => {
    addToQueue(buildPresetGenerationRequest(preset), { sourceKind: 'preset', sourceLabel: preset.title });
  };
  return <article className={`preset-card${highlighted ? ' preset-card-highlighted' : ''}${drag.dragging ? ' is-dragging' : ''}`} onDoubleClick={onOpen} aria-hidden={drag.dragging || undefined}>
    <label className="preset-card-select"><input type="checkbox" checked={selected} onChange={onSelect} />{t('compose')}</label>
    <button className={`preset-card-favorite${preset.favorite ? ' active' : ''}`} onClick={() => void onToggleFavorite(preset)}><Icon name="star" size={14} /></button>
    <button className="preset-card-cover" onClick={onOpen}><PresetCover cover={preset.cover} /></button>
      <div className="preset-card-drag-handle" {...drag.dragHandlers}><span>{t('dragPrompt')}</span><strong>{preset.title}</strong></div>
        <div className="preset-card-body"><p>{preset.description || preset.positive}</p><div className="preset-card-tags">{presetTagNodes(preset.tags?.slice(0, 3), tagTranslations, language)}</div><small>{preset.source === 'cloud' ? t('cloud') : t('local')} · {new Date(preset.updatedAt).toLocaleDateString()} · {preset.usageCount || 0} · {t('rating')} {preset.rating ? preset.rating.toFixed(1) : t('notRated')}</small></div>
      <div className="preset-card-actions"><button className="btn btn-primary" onClick={() => onReuse(preset, false)}>{t('adjustParameters')}</button><button className="btn" onClick={() => onReuse(preset, true)}>{t('directGenerate')}</button><button className="btn" onClick={enqueuePreset} title={t('queueAddHint')}><Icon name="queueAdd" size={13} />{t('queueAdd')}</button><button className="btn btn-icon" onClick={() => void onExport(preset)} title={t('export')}><Icon name="download" size={13} /></button><button className="btn btn-icon" onClick={() => onEdit(preset)} title={t('edit')}><Icon name="edit" size={13} /></button><button className="btn btn-icon" onClick={() => void onCopy(preset)} title={t('copy')}><Icon name="copy" size={13} /></button><button className="btn btn-icon btn-danger" onClick={() => void onDelete(preset)} title={t('delete')}><Icon name="trash" size={13} /></button></div>
     <DragGhost dragging={drag.dragging} dragPoint={drag.dragPoint} label="PRESET" />
  </article>;
}


function PresetCover({ cover }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let live = true;
    setSrc('');
    if (cover) window.electronAPI.globalPresetImageData(cover).then(value => live && setSrc(value || '')).catch(() => live && setSrc(''));
    return () => { live = false; };
  }, [cover?.path]);
   return src ? <img src={src} alt="" draggable="false" onDragStart={event => event.preventDefault()} /> : <span className="preset-placeholder">PRESET</span>;
}
