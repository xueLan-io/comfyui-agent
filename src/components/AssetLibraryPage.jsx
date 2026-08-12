import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAgent } from '../contexts/AgentContext.jsx';
import { useSession } from '../contexts/SessionContext.jsx';
import ImageAsset from './ImageAsset.jsx';
import Icon from './Icon.jsx';
import PresetSaveModal from './PresetSaveModal.jsx';
import { useI18n } from '../i18n/I18nContext.jsx';

const RECENT_WINDOW = 7 * 24 * 60 * 60 * 1000;

function imageKey(image) {
  return `${image.type || ''}:${image.projectId || ''}:${image.subfolder || ''}:${image.filename || ''}`;
}

function favoritesStorageKey(projectId) {
  return `comfy-agent.asset-favorites.${projectId || 'default'}`;
}

function readFavorites(projectId) {
  try {
    const value = JSON.parse(window.localStorage.getItem(favoritesStorageKey(projectId)) || '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function assetTime(image) {
  const value = Number(image.createdAt);
  return Number.isFinite(value) ? value : 0;
}

function assetDate(image, language, fallback) {
  const timestamp = assetTime(image);
  if (!timestamp) return fallback;
  return new Intl.DateTimeFormat(language, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(timestamp);
}

function assetSource(image) {
  return image.source === 'openai-image' || image.source === 'cloud' ? 'cloud' : 'local';
}

function isPresetImage(image) {
  return image.mediaType !== 'video' && image.type !== 'video' && /\.(png|jpe?g|webp|gif|bmp)$/i.test(image.filename || '');
}

function tracePrompt(trace, image) {
  const prompt = trace?.promptResult || trace?.result?.compiledPrompt || trace?.compiledPrompt || {};
  return {
    positive: image.positive || prompt.positive || trace?.request || trace?.rawInput || '',
    negative: image.negative || prompt.negative || '',
    workflow: image.workflowName || trace?.workflowName || trace?.result?.workflowName || '',
    parameters: image.parameters || trace?.result?.settings || trace?.settings || {},
    source: image.source === 'cloud' ? 'cloud' : 'direct',
  };
}

export default function AssetLibraryPage({ onBack }) {
  const { language, t } = useI18n();
  const { assets, setPreview, refreshAssets, removeAsset, deleteAsset } = useAgent();
  const { activeProjectId } = useSession();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState('newest');
  const [view, setView] = useState('grid');
  const [favoriteKeys, setFavoriteKeys] = useState(() => readFavorites(''));
  const [selectedKeys, setSelectedKeys] = useState(() => new Set());
  const [refreshing, setRefreshing] = useState(false);
  const [presetDraft, setPresetDraft] = useState(null);

  useEffect(() => {
    setFavoriteKeys(readFavorites(activeProjectId));
    setSelectedKeys(new Set());
  }, [activeProjectId]);

  useEffect(() => {
    void refreshAssets({ replace: true }).catch(() => {});
  }, [refreshAssets]);

  const visibleAssets = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const favoriteSet = new Set(favoriteKeys);
    const result = assets.filter(image => {
      const searchable = [image.filename, image.subfolder, image.taskId].filter(Boolean).join(' ').toLocaleLowerCase();
      if (normalizedQuery && !searchable.includes(normalizedQuery)) return false;
      if (filter === 'favorites' && !favoriteSet.has(imageKey(image))) return false;
      if (filter === 'recent' && (!assetTime(image) || Date.now() - assetTime(image) > RECENT_WINDOW)) return false;
      return true;
    });

    return result.sort((left, right) => {
      if (sort === 'name') return (left.filename || '').localeCompare(right.filename || '');
      const direction = sort === 'oldest' ? 1 : -1;
      return (assetTime(left) - assetTime(right)) * direction;
    });
  }, [assets, favoriteKeys, filter, query, sort]);

  const selectedVisibleAssets = useMemo(
    () => visibleAssets.filter(image => selectedKeys.has(imageKey(image))),
    [selectedKeys, visibleAssets],
  );
  const allVisibleSelected = visibleAssets.length > 0 && selectedVisibleAssets.length === visibleAssets.length;

  const handleAssetUnavailable = useCallback((image) => {
    removeAsset(image);
    setSelectedKeys(previous => {
      const next = new Set(previous);
      next.delete(imageKey(image));
      return next;
    });
  }, [removeAsset]);

  function persistFavorites(next) {
    setFavoriteKeys(next);
    try {
      window.localStorage.setItem(favoritesStorageKey(activeProjectId), JSON.stringify(next));
    } catch {}
  }

  function toggleFavorite(image) {
    const key = imageKey(image);
    const next = favoriteKeys.includes(key)
      ? favoriteKeys.filter(item => item !== key)
      : [...favoriteKeys, key];
    persistFavorites(next);
  }

  function toggleSelection(image) {
    const key = imageKey(image);
    setSelectedKeys(previous => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelectedKeys(previous => {
      const next = new Set(previous);
      if (allVisibleSelected) visibleAssets.forEach(image => next.delete(imageKey(image)));
      else visibleAssets.forEach(image => next.add(imageKey(image)));
      return next;
    });
  }

  function openPreview(preview, previewImages = visibleAssets) {
    const index = previewImages.findIndex(item => imageKey(item) === imageKey(preview.image));
    setPreview({ ...preview, images: previewImages, index: index < 0 ? 0 : index });
  }

  async function previewSelection() {
    if (selectedVisibleAssets.length === 0) return;
    const image = selectedVisibleAssets[0];
    try {
      const src = await window.electronAPI.comfyUIImageData(image);
      openPreview({ image, src }, selectedVisibleAssets);
    } catch {}
  }

  async function handleRefresh() {
    setRefreshing(true);
    try {
      await refreshAssets({ replace: true });
    } finally {
      setRefreshing(false);
    }
  }

  async function handleDelete(image) {
    if (!window.confirm(t('deleteAssetConfirm', { name: image.filename }))) return;
    try {
      await deleteAsset(image);
      setSelectedKeys(previous => {
        const next = new Set(previous);
        next.delete(imageKey(image));
        return next;
      });
    } catch (error) {
      window.alert(error.message || t('deleteAsset'));
    }
  }

  async function openPresetSave(selected) {
    if (!selected.length) return;
    const images = selected.filter(isPresetImage);
    if (!images.length) {
      window.alert(t('savePresetFailed'));
      return;
    }
    let metadata = tracePrompt(null, images[0]);
    if (images[0].taskId && window.electronAPI.agentGetTrace) {
      try { metadata = tracePrompt(await window.electronAPI.agentGetTrace(images[0].taskId), images[0]); } catch {}
    }
    setPresetDraft({
      images,
      initial: {
        title: images[0].filename?.replace(/\.[^.]+$/, '') || t('historicalPreset'),
        description: t('assetFromHistory', { n: images.length }),
        positive: metadata.positive || '',
        negative: metadata.negative || '',
        workflow: metadata.workflow || '',
        parameters: metadata.parameters || {},
        tags: t('assetHistoryTag'),
        source: metadata.source || 'direct',
        origin: 'asset-library',
      },
    });
  }

  async function saveAssetsAsPreset(value) {
    if (!presetDraft) return;
    const { workflow, saveResults, useFirstAsCover, ...input } = value;
    try {
      const saved = await window.electronAPI.globalPresetCreate({
        ...input,
        workflowName: workflow,
        resultRefs: saveResults ? presetDraft.images : [],
        ...(useFirstAsCover ? { coverRef: presetDraft.images[0] } : {}),
      });
      setPresetDraft(null);
      window.dispatchEvent(new CustomEvent('comfy-agent:preset-saved', { detail: { id: saved?.id || '', title: input.title } }));
    } catch (error) { throw new Error(error.message || t('savePresetFailed')); }
  }

  return (
    <main className="asset-library-page">
      <header className="asset-library-header">
        <div>
          <span className="page-eyebrow">LIBRARY</span>
          <h1>{t('assetTitle')}</h1>
          <p>{t('assetDescription')}</p>
        </div>
        <div className="asset-library-header-actions">
          <span className="asset-library-count">{visibleAssets.length} / {assets.length}</span>
          <button className="btn btn-icon" onClick={() => void handleRefresh()} disabled={refreshing} title={t('refreshAssets')} aria-label={t('refreshAssets')}><Icon name="refresh" /></button>
          <button className="btn" onClick={onBack}>{t('backToChat')}</button>
        </div>
      </header>

      <section className="asset-library-toolbar" aria-label={t('assetTitle')}>
        <label className="asset-library-search">
          <Icon name="search" size={14} />
          <input value={query} onChange={event => setQuery(event.target.value)} placeholder={t('searchAssets')} />
        </label>
        <div className="asset-library-filters" role="group" aria-label={t('assetTitle')}>
          {[
            ['all', t('all')],
            ['recent', t('recent7Days')],
            ['favorites', `${t('favorites')} ${favoriteKeys.length}`],
          ].map(([value, label]) => (
            <button key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{label}</button>
          ))}
        </div>
        <div className="asset-library-toolbar-actions">
          <select value={sort} onChange={event => setSort(event.target.value)} aria-label={t('newestFirst')}>
            <option value="newest">{t('newestFirst')}</option>
            <option value="oldest">{t('oldestFirst')}</option>
            <option value="name">{t('sortByName')}</option>
          </select>
        <div className="asset-library-view-toggle" role="group" aria-label={t('view')}>
          <button className={view === 'grid' ? 'active' : ''} onClick={() => setView('grid')} aria-label={t('grid')}><Icon name="grid" size={14} /></button>
          <button className={view === 'list' ? 'active' : ''} onClick={() => setView('list')} aria-label={t('list')}><Icon name="list" size={14} /></button>
          </div>
        </div>
      </section>

      <div className="asset-library-selection-bar">
        <span>{selectedKeys.size > 0 ? `${selectedKeys.size} ${t('selected')}` : `${visibleAssets.length} ${t('all')}`}</span>
        <div>
          <button className="btn btn-small" onClick={toggleSelectAll} disabled={visibleAssets.length === 0}>{allVisibleSelected ? t('clearSelection') : t('selectAllVisible')}</button>
          {selectedVisibleAssets.length > 0 && <><button className="btn btn-small btn-primary" onClick={() => void previewSelection()}>{t('previewSelection')}</button><button className="btn btn-small" onClick={() => void openPresetSave(selectedVisibleAssets)}>{t('saveAsPreset')}</button></>}
        </div>
      </div>

      {visibleAssets.length > 0 ? (
        <div className={`asset-library-grid ${view === 'list' ? 'list-view' : ''}`}>
          {visibleAssets.map(image => {
            const key = imageKey(image);
            const favorite = favoriteKeys.includes(key);
            return (
              <article key={key} className={`asset-library-item${selectedKeys.has(key) ? ' selected' : ''}`}>
                <div className="asset-library-media">
                  <ImageAsset image={image} onOpen={preview => openPreview(preview)} onError={handleAssetUnavailable} />
                <span className={`asset-library-source-badge ${assetSource(image)}`} title={assetSource(image) === 'cloud' ? t('cloudImage') : t('localImage')}>{assetSource(image) === 'cloud' ? t('cloud') : t('local')}</span>
                  <div className="asset-library-actions">
                  <button className={`asset-library-favorite${favorite ? ' active' : ''}`} onClick={() => toggleFavorite(image)} aria-pressed={favorite} title={favorite ? t('unfavorite') : t('favorite')}><Icon name="star" size={14} /></button>
                  <button className="asset-library-save-preset" onClick={() => void openPresetSave([image])} title={t('saveAsPreset')} aria-label={`${t('saveAsPreset')} ${image.filename}`}><Icon name="bookmark" size={14} /></button>
                  <button className="asset-library-delete" onClick={() => void handleDelete(image)} title={t('deleteAsset')} aria-label={`${t('deleteAsset')} ${image.filename}`}><Icon name="trash" size={14} /></button>
                  </div>
                <label className="asset-library-select" title={selectedKeys.has(key) ? t('deselect') : t('select')}>
                    <input type="checkbox" checked={selectedKeys.has(key)} onChange={() => toggleSelection(image)} />
                    <span aria-hidden="true" />
                  </label>
                </div>
                <div className="asset-library-item-meta">
                  <span title={image.filename}>{image.filename}</span>
                <small title={image.subfolder}>{image.subfolder || t('generatedHistory')}</small>
                <time dateTime={assetTime(image) ? new Date(assetTime(image)).toISOString() : undefined}>{assetDate(image, language, t('generatedHistory'))}</time>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="asset-library-empty">
          <strong>{assets.length > 0 ? t('noMatchingAssets') : t('noGeneratedImages')}</strong>
          <span>{assets.length > 0 ? t('noResultsHint') : t('noAssetsHint')}</span>
        </div>
      )}
      {presetDraft && <PresetSaveModal initial={presetDraft.initial} onSave={saveAssetsAsPreset} onClose={() => setPresetDraft(null)} />}
    </main>
  );
}
