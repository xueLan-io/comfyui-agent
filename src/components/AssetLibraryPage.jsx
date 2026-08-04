import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAgent } from '../contexts/AgentContext.jsx';
import { useSession } from '../contexts/SessionContext.jsx';
import ImageAsset from './ImageAsset.jsx';
import Icon from './Icon.jsx';

const LABELS = {
  title: '\u8D44\u4EA7\u5E93',
  description: '\u5F53\u524D\u9879\u76EE\u7684\u56FE\u7247\u8D44\u4EA7',
  all: '\u5168\u90E8',
  recent: '\u6700\u8FD1 7 \u5929',
  favorites: '\u6536\u85CF',
  search: '\u641C\u7D22\u6587\u4EF6\u540D\u3001\u4EFB\u52A1\u6216\u76EE\u5F55',
  newest: '\u6700\u65B0\u4F18\u5148',
  oldest: '\u6700\u65E9\u4F18\u5148',
  name: '\u6309\u540D\u79F0',
  selectAll: '\u5168\u9009\u53EF\u89C1',
  clearSelection: '\u6E05\u9664\u9009\u62E9',
  previewSelection: '\u9884\u89C8\u6240\u9009',
  noAssets: '\u8FD8\u6CA1\u6709\u751F\u6210\u56FE\u7247',
  noResults: '\u6CA1\u6709\u5339\u914D\u7684\u8D44\u4EA7',
  noAssetsHint: '\u5B8C\u6210\u4E00\u6B21\u751F\u6210\u540E\uFF0C\u56FE\u7247\u4F1A\u81EA\u52A8\u5F52\u6863\u5230\u8FD9\u91CC\u3002',
  noResultsHint: '\u8BD5\u8BD5\u6362\u4E2A\u5173\u952E\u8BCD\u6216\u5207\u6362\u7B5B\u9009\u6761\u4EF6\u3002',
  back: '\u8FD4\u56DE\u5BF9\u8BDD',
  refresh: '\u5237\u65B0\u8D44\u4EA7',
  loading: '\u6B63\u5728\u5237\u65B0',
  selected: '\u5DF2\u9009',
  generated: '\u5386\u53F2\u751F\u6210',
};

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

function assetDate(image) {
  const timestamp = assetTime(image);
  if (!timestamp) return LABELS.generated;
  return new Intl.DateTimeFormat(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(timestamp);
}

export default function AssetLibraryPage({ onBack }) {
  const { assets, setPreview, refreshAssets, removeAsset, deleteAsset } = useAgent();
  const { activeProjectId } = useSession();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState('newest');
  const [view, setView] = useState('grid');
  const [favoriteKeys, setFavoriteKeys] = useState(() => readFavorites(''));
  const [selectedKeys, setSelectedKeys] = useState(() => new Set());
  const [refreshing, setRefreshing] = useState(false);

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
    if (!window.confirm(`确定删除「${image.filename}」吗？此操作会删除项目归档文件。`)) return;
    try {
      await deleteAsset(image);
      setSelectedKeys(previous => {
        const next = new Set(previous);
        next.delete(imageKey(image));
        return next;
      });
    } catch (error) {
      window.alert(error.message || '删除资产失败');
    }
  }

  return (
    <main className="asset-library-page">
      <header className="asset-library-header">
        <div>
          <span className="page-eyebrow">LIBRARY</span>
          <h1>{LABELS.title}</h1>
          <p>{LABELS.description}</p>
        </div>
        <div className="asset-library-header-actions">
          <span className="asset-library-count">{visibleAssets.length} / {assets.length}</span>
          <button className="btn btn-icon" onClick={() => void handleRefresh()} disabled={refreshing} title={LABELS.refresh} aria-label={LABELS.refresh}><Icon name="refresh" /></button>
          <button className="btn" onClick={onBack}>{LABELS.back}</button>
        </div>
      </header>

      <section className="asset-library-toolbar" aria-label={LABELS.title}>
        <label className="asset-library-search">
          <Icon name="search" size={14} />
          <input value={query} onChange={event => setQuery(event.target.value)} placeholder={LABELS.search} />
        </label>
        <div className="asset-library-filters" role="group" aria-label={LABELS.title}>
          {[
            ['all', LABELS.all],
            ['recent', LABELS.recent],
            ['favorites', `${LABELS.favorites} ${favoriteKeys.length}`],
          ].map(([value, label]) => (
            <button key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{label}</button>
          ))}
        </div>
        <div className="asset-library-toolbar-actions">
          <select value={sort} onChange={event => setSort(event.target.value)} aria-label={LABELS.newest}>
            <option value="newest">{LABELS.newest}</option>
            <option value="oldest">{LABELS.oldest}</option>
            <option value="name">{LABELS.name}</option>
          </select>
          <div className="asset-library-view-toggle" role="group" aria-label="View">
            <button className={view === 'grid' ? 'active' : ''} onClick={() => setView('grid')} aria-label="Grid"><Icon name="grid" size={14} /></button>
            <button className={view === 'list' ? 'active' : ''} onClick={() => setView('list')} aria-label="List"><Icon name="list" size={14} /></button>
          </div>
        </div>
      </section>

      <div className="asset-library-selection-bar">
        <span>{selectedKeys.size > 0 ? `${selectedKeys.size} ${LABELS.selected}` : `${visibleAssets.length} ${LABELS.all}`}</span>
        <div>
          <button className="btn btn-small" onClick={toggleSelectAll} disabled={visibleAssets.length === 0}>{allVisibleSelected ? LABELS.clearSelection : LABELS.selectAll}</button>
          {selectedVisibleAssets.length > 0 && <button className="btn btn-small btn-primary" onClick={() => void previewSelection()}>{LABELS.previewSelection}</button>}
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
                  <button className={`asset-library-favorite${favorite ? ' active' : ''}`} onClick={() => toggleFavorite(image)} aria-pressed={favorite} title={favorite ? 'Unfavorite' : 'Favorite'}><Icon name="star" size={14} /></button>
                  <button className="asset-library-delete" onClick={() => void handleDelete(image)} title="删除资产" aria-label={`删除 ${image.filename}`}><Icon name="trash" size={14} /></button>
                  <label className="asset-library-select" title={selectedKeys.has(key) ? 'Deselect' : 'Select'}>
                    <input type="checkbox" checked={selectedKeys.has(key)} onChange={() => toggleSelection(image)} />
                    <span aria-hidden="true" />
                  </label>
                </div>
                <div className="asset-library-item-meta">
                  <span title={image.filename}>{image.filename}</span>
                  <small title={image.subfolder}>{image.subfolder || LABELS.generated}</small>
                  <time dateTime={assetTime(image) ? new Date(assetTime(image)).toISOString() : undefined}>{assetDate(image)}</time>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="asset-library-empty">
          <strong>{assets.length > 0 ? LABELS.noResults : LABELS.noAssets}</strong>
          <span>{assets.length > 0 ? LABELS.noResultsHint : LABELS.noAssetsHint}</span>
        </div>
      )}
    </main>
  );
}
