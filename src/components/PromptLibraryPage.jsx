import { useEffect, useMemo, useRef, useState } from 'react';
import { useAgent } from '../contexts/AgentContext.jsx';
import { useComfyUI } from '../contexts/ComfyUIContext.jsx';
import { ANIME_PROMPT_PACKS } from './prompt-library-anime.mjs';
import { getCachedCollectedItemIds, hasPendingCollectedSegments, loadCachedCollectedItems, loadCollectedPromptItems, loadCollectedSearchIndex, loadCollectedTagGroup, getCollectedSearchIndex, getCollectedTagGroups, loadCollectedSegmentBatch } from './prompt-library-collected.mjs';
import { PROMPT_LIBRARY_CATEGORIES, PROMPT_LIBRARY_ITEMS } from './prompt-library-data.mjs';
import { buildSearchIndex, buildSearchIndexWithCachedCollected, matchesSearchText, randomSearchGuideTerms, searchLibrary } from './prompt-library-search.mjs';
import { matchesPromptTaxonomy, PROMPT_LIBRARY_TAXONOMY } from './prompt-library-taxonomy.mjs';
import { checkPromptStructure, STRUCTURE_LABELS } from '../agent/optimizer/prompt-guard.mjs';
import { formatWeight, normalizePromptPart, removePromptPart, reorderPromptPart, splitPromptParts, updatePromptWeight } from './prompt-parser.mjs';
import Icon from './Icon.jsx';
import { DragGhost, useFloatingCardDrag } from './useFloatingCardDrag.jsx';
import { useI18n } from '../i18n/I18nContext.jsx';

const PAGE_SIZE = 120;
const WEIGHT_STEP = 0.1;
const MIN_WEIGHT = 0.1;
const MAX_WEIGHT = 3;
const SIDEBAR_WIDTH_KEY = 'comfy-agent.prompt-library.sidebar-width';
const SIDEBAR_MIN_WIDTH = 190;
const SIDEBAR_MAX_WIDTH = 360;

function clampSidebarWidth(value) {
  const width = Number(value);
  if (!Number.isFinite(width)) return 220;
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}

function useDebouncedValue(value, delay = 200) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

function animePresets(t) {
  return [
    { id: 'anime-portrait', title: t('plPresetPortrait'), description: t('plPresetPortraitDesc'), prompt: 'anime illustration, solo character, upper body, expressive eyes, clean lineart, detailed hair, soft cel shading' },
    { id: 'anime-full-body', title: t('plPresetFullBody'), description: t('plPresetFullBodyDesc'), prompt: 'anime illustration, solo character, full body, clear silhouette, balanced pose, detailed costume, clean lineart' },
    { id: 'anime-key-visual', title: t('plPresetKeyVisual'), description: t('plPresetKeyVisualDesc'), prompt: 'anime key visual, strong focal composition, polished character design, vibrant controlled colors, cinematic lighting' },
    { id: 'anime-school-life', title: t('plPresetSchoolLife'), description: t('plPresetSchoolLifeDesc'), prompt: 'anime illustration, student character, school uniform, warm daylight, gentle everyday atmosphere, detailed background' },
  ];
}

function promptStages(t) {
  return [
    { id: 'subject', label: t('plStageSubject'), description: t('plStageSubjectDesc'), categoryIds: ['subject', 'character-role'] },
    { id: 'appearance', label: t('plStageAppearance'), description: t('plStageAppearanceDesc'), categoryIds: ['character-face', 'character-eyes', 'character-hair', 'character-build', 'character-clothing', 'character-accessory', 'character-detail'] },
    { id: 'pose', label: t('plStagePose'), description: t('plStagePoseDesc'), categoryIds: ['character-expression', 'character-pose', 'character-action'] },
    { id: 'composition', label: t('plStageComposition'), description: t('plStageCompositionDesc'), categoryIds: ['composition'] },
    { id: 'scene', label: t('plStageScene'), description: t('plStageSceneDesc'), categoryIds: ['environment', 'lighting'] },
    { id: 'finish', label: t('plStageFinish'), description: t('plStageFinishDesc'), categoryIds: ['style', 'artist', 'detail'] },
  ];
}

function promptIntents(t) {
  return [
    { id: 'portrait', label: t('plIntentPortrait'), stage: 'appearance', description: t('plIntentPortraitDesc') },
    { id: 'full-body', label: t('plIntentFullBody'), stage: 'pose', description: t('plIntentFullBodyDesc') },
    { id: 'scene', label: t('plIntentScene'), stage: 'scene', description: t('plIntentSceneDesc') },
    { id: 'style', label: t('plIntentStyle'), stage: 'finish', description: t('plIntentStyleDesc') },
    { id: 'fix', label: t('plIntentFix'), stage: 'finish', description: t('plIntentFixDesc') },
  ];
}

const BROWSE_GROUP_IDS = ['character', 'action-expression', 'composition', 'scene', 'lighting', 'style', 'artist', 'quality'];
const MY_CONTENT_GROUP_IDS = ['favorites', 'custom'];

function promptPathForItem(item, taxonomyGroups, t) {
  if (item.category === 'custom') return [t('plPathMyContent'), t('plPathCustom')];
  if (item.category === 'collected') return [t('plPathCollected'), item.kind === 'phrase' ? t('plPathPhrase') : (item.tagGroup || t('plPathUncategorized'))];

  const parent = taxonomyGroups.find(group => BROWSE_GROUP_IDS.includes(group.id) && matchesPromptTaxonomy(item, group));
  if (!parent) return [categoryLabel(item.category, t)];
  const child = parent.children?.find(group => group.itemIds?.includes(item.id))
    || parent.children?.find(group => matchesPromptTaxonomy(item, group));
  const childPath = child?.id.startsWith('clothing-')
    ? [t('plPathClothing'), child.label]
    : ['character-body', 'character-chest', 'character-arms-hands', 'character-legs-feet'].includes(child?.id)
      ? [t('plPathBody'), child.id === 'character-body' ? null : child.label]
      : [child?.label];
  return [parent.label, ...childPath].filter(Boolean);
}

function stageForCategory(categoryId, t) {
  return promptStages(t).find(stage => stage.categoryIds.includes(categoryId));
}

function categoryLabel(categoryId, t) {
  return PROMPT_LIBRARY_CATEGORIES.find(category => category.id === categoryId)?.label || t('plPathPrompt');
}

function loadLibraryState(key, fallback) {
  try {
    return JSON.parse(window.localStorage.getItem(key) || 'null') ?? fallback;
  } catch {
    return fallback;
  }
}

function appendPrompt(current, prompt) {
  const value = current.trim();
  const candidate = prompt.trim();
  if (!candidate) return value;
  const key = normalizePromptPart(candidate);
  if (splitPromptParts(value).some(part => normalizePromptPart(part.source) === key)) return value;
  return value ? `${value}, ${candidate}` : candidate;
}

function applyLibraryFilters(items, filters) {
  return items.filter(item => {
    if (filters.source === 'curated' && (item.category === 'collected' || item.category === 'custom')) return false;
    if (filters.source === 'collected' && item.category !== 'collected') return false;
    if (filters.source === 'custom' && item.category !== 'custom') return false;
    if (filters.contentType === 'tag' && item.kind === 'phrase') return false;
    if (filters.contentType === 'phrase' && item.kind !== 'phrase') return false;
    if (filters.tagGroup !== 'all' && item.tagGroup !== filters.tagGroup) return false;
    return true;
  });
}

function workflowPromptExamples(manifest, t) {
  return (manifest?.editableNodes || [])
    .filter(node => /promptlist/i.test(node.type || ''))
    .flatMap(node => (node.inputs || [])
      .filter(input => /^prompt_\d+$/.test(input.name) && typeof input.value === 'string' && input.value.trim())
      .map(input => ({
        id: `workflow-${node.id}-${input.name}`,
        category: 'workflow-example',
        title: t('plWorkflowExampleTitle', { name: input.name.slice(7) }),
        description: t('plWorkflowExampleDesc'),
        prompt: input.value.trim(),
        source: manifest.workflowName,
      })));
}

function DraggablePromptCard({ item, path, related, added, favorite, onToggleFavorite, onAdd, onReplace, onDelete, onDragLabel, target }) {
  const { t } = useI18n();
  const drag = useFloatingCardDrag({
    kind: 'prompt-card',
    title: item.title || item.prompt || '',
    positive: item.prompt || '',
    content: item.prompt || '',
    negative: '',
    target,
    mode: item.kind === 'phrase' ? 'replace' : 'append',
    promptId: item.id || '',
  });

  return (
    <article className={`prompt-workbench-card${drag.dragging ? ' is-dragging' : ''}`} aria-hidden={drag.dragging || undefined}>
      <div className={`prompt-workbench-card-art prompt-workbench-card-art-${item.category} prompt-workbench-card-drag-handle`} {...drag.dragHandlers}><span>{item.tagGroup || categoryLabel(item.category, t)}</span><Icon name="spark" size={16} /></div>
      <div className="prompt-workbench-card-body">
        <div className="prompt-workbench-card-meta"><span>{item.kind === 'phrase' ? t('plCardPhrase') : (stageForCategory(item.category, t)?.label || t('plCardFallback'))}</span>{item.sourceCount > 0 && <small>{t('plUsageCount', { n: item.sourceCount.toLocaleString() })}</small>}<button type="button" className={`prompt-library-favorite${favorite ? ' active' : ''}`} onClick={() => onToggleFavorite(item)} title={favorite ? t('plUnfavorite') : t('plFavorite')} aria-label={favorite ? t('plUnfavorite') : t('plFavorite')}><Icon name="star" size={13} /></button></div>
        <h3>{item.title}</h3>
        <div className="prompt-workbench-card-path">{path.join(' > ')}</div>
        <p>{item.description}</p>
        {item.usage && <div className="prompt-workbench-card-related"><span>{t('plUsage')}</span>{item.usage}</div>}
        {item.aliases?.length > 0 && <div className="prompt-workbench-card-related"><span>{t('plAliases')}</span>{item.aliases.slice(0, 3).join('、')}</div>}
        {related.length > 0 && <div className="prompt-workbench-card-related"><span>{t('plRelated')}</span>{related.join('、')}</div>}
        <div className="prompt-workbench-card-prompt" title={item.prompt}>{item.prompt}</div>
        <div className="prompt-workbench-card-actions"><button type="button" className={`prompt-library-add${added ? ' added' : ''}`} onClick={() => onAdd(item)}><Icon name={added ? 'check' : 'plus'} size={13} />{added ? t('plAdded') : t('plAdd')}</button><button type="button" className="prompt-workbench-card-replace" onClick={() => onReplace(item)} title={t('plReplaceTitle')}>{t('plReplace')}</button>{item.category === 'custom' && <button type="button" className="prompt-library-delete" onClick={() => onDelete(item)} title={t('plDeleteTitle')} aria-label={t('plDeleteAria', { title: item.title })}><Icon name="trash" size={12} /></button>}</div>
      </div>
      <DragGhost dragging={drag.dragging} dragPoint={drag.dragPoint} label="PROMPT" />
    </article>
  );
}

export default function PromptLibraryPage({ onBack, onGenerate, hidden = false }) {
  const { t } = useI18n();
  const { input, setInput } = useAgent();
  const { workflowManifest } = useComfyUI();
  const [activeGroup, setActiveGroup] = useState('character');
  const [activeStage, setActiveStage] = useState('');
  const [activeIntent, setActiveIntent] = useState('');
  const [search, setSearch] = useState('');
  const [artistTier, setArtistTier] = useState('high');
  const [negative, setNegative] = useState('');
  const [composerTarget, setComposerTarget] = useState('positive');
  const [expandedGroups, setExpandedGroups] = useState(() => new Set());
  const [addedId, setAddedId] = useState('');
  const [visibleLimit, setVisibleLimit] = useState(PAGE_SIZE);
  const [collectedItems, setCollectedItems] = useState([]);
  const [collectionState, setCollectionState] = useState('idle');
  const [collectionProgress, setCollectionProgress] = useState({ percent: 0 });
  const [favorites, setFavorites] = useState(() => new Set(loadLibraryState('comfy-agent.prompt-library.favorites', [])));
  const [customItems, setCustomItems] = useState(() => loadLibraryState('comfy-agent.prompt-library.custom', []));
  const [customPrompt, setCustomPrompt] = useState('');
  const [savedSearches, setSavedSearches] = useState(() => loadLibraryState('comfy-agent.prompt-library.quick-search', []));
  const [quickSearchInput, setQuickSearchInput] = useState('');
  const [searchHints] = useState(() => randomSearchGuideTerms());
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [advancedFilters, setAdvancedFilters] = useState({ source: 'all', contentType: 'all', tagGroup: 'all' });
  const [collectedTagGroups] = useState(() => getCollectedTagGroups());
  const [collectedSearchIndex, setCollectedSearchIndex] = useState(null);
  const [cachedCollectedItems, setCachedCollectedItems] = useState([]);
  const [fullCollectionRequested, setFullCollectionRequested] = useState(false);
  const collectionLoad = useRef(null);
  const windowApi = window.electronAPI;
  const [maximized, setMaximized] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() => clampSidebarWidth(loadLibraryState(SIDEBAR_WIDTH_KEY, 220)));
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);
  const sidebarResizeStart = useRef(null);
  const promptDragRef = useRef(null);
  const negativeSupported = workflowManifest?.promptProfile?.supportsNegative !== false;
  const debouncedSearch = useDebouncedValue(search);
  const query = debouncedSearch.trim().toLowerCase();
  const isGlobalSearch = Boolean(query);
  const shouldLoadCollection = fullCollectionRequested || activeGroup === 'collected'
    || advancedFilters.source === 'collected'
    ;

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    if (!isResizingSidebar) return undefined;
    const handlePointerMove = event => {
      const start = sidebarResizeStart.current;
      if (!start) return;
      setSidebarWidth(clampSidebarWidth(start.width + event.clientX - start.x));
    };
    const stopResizing = () => {
      sidebarResizeStart.current = null;
      setIsResizingSidebar(false);
    };
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', stopResizing);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', stopResizing);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizingSidebar]);

  useEffect(() => {
    window.localStorage.setItem('comfy-agent.prompt-library.favorites', JSON.stringify([...favorites]));
  }, [favorites]);

  useEffect(() => {
    window.localStorage.setItem('comfy-agent.prompt-library.custom', JSON.stringify(customItems));
  }, [customItems]);

  useEffect(() => {
    window.localStorage.setItem('comfy-agent.prompt-library.quick-search', JSON.stringify(savedSearches));
  }, [savedSearches]);

  useEffect(() => {
    if (!windowApi?.windowIsMaximized) return undefined;
    windowApi.windowIsMaximized().then(setMaximized).catch(() => {});
    return undefined;
  }, [windowApi]);

  useEffect(() => {
    let active = true;
    loadCollectedSearchIndex().then(index => {
      if (!active) return;
      if (index) setCollectedSearchIndex(index);
    }).catch(() => {});
    return () => { active = false; };
  }, []);

  useEffect(() => {
    setCachedCollectedItems([]);
    if (!query) return undefined;
    let active = true;
    loadCollectedSearchIndex().then(index => loadCachedCollectedItems(getCachedCollectedItemIds(query, index))).then(items => {
      if (active && items.length > 0) setCachedCollectedItems(items);
    }).catch(() => {});
    return () => { active = false; };
  }, [query]);

  useEffect(() => {
    if (!shouldLoadCollection || (activeGroup === 'collected' && !fullCollectionRequested && advancedFilters.tagGroup === 'all')) return undefined;
    const groupOnly = activeGroup === 'collected' && advancedFilters.tagGroup !== 'all' && !query;
    const key = fullCollectionRequested ? 'full' : groupOnly ? `group:${advancedFilters.tagGroup}` : 'batch';
    let active = true;
    let load = collectionLoad.current;
    if (!load || load.key !== key) {
      setCollectionState('loading');
      load = {
        key,
        promise: groupOnly
          ? loadCollectedTagGroup(advancedFilters.tagGroup, setCollectionProgress)
          : fullCollectionRequested
            ? loadCollectedPromptItems(setCollectionProgress)
            : loadCollectedSegmentBatch(setCollectionProgress),
      };
      collectionLoad.current = load;
    }
    load.promise
      .then(items => { if (active) { setCollectedItems(items); setCollectionState('ready'); } })
      .catch(() => { if (active) setCollectionState('error'); });
    if (groupOnly) {
      setCollectedSearchIndex(null);
    } else {
      load.promise
        .then(() => getCollectedSearchIndex())
        .then(index => { if (active && index) setCollectedSearchIndex(index); })
        .catch(() => {});
    }
    return () => { active = false; };
  }, [shouldLoadCollection, advancedFilters.tagGroup, activeGroup, query, fullCollectionRequested]);

  useEffect(() => {
    if (activeGroup !== 'collected' || fullCollectionRequested || advancedFilters.tagGroup !== 'all') return undefined;
    let cancelled = false;
    let idle;
    const schedule = () => {
      if (cancelled || !hasPendingCollectedSegments()) return;
      idle = window.requestIdleCallback ? window.requestIdleCallback(runBatch, { timeout: 1500 }) : window.setTimeout(runBatch, 800);
    };
    const runBatch = () => {
      if (cancelled) return;
      loadCollectedSegmentBatch(setCollectionProgress).then(items => {
        if (!cancelled) {
          setCollectedItems(items);
          schedule();
        }
      }).catch(() => {});
    };
    schedule();
    return () => {
      cancelled = true;
      if (window.cancelIdleCallback && typeof idle === 'number') window.cancelIdleCallback(idle);
      else window.clearTimeout(idle);
    };
  }, [activeGroup, advancedFilters.tagGroup, fullCollectionRequested]);

  const availableCollectedItems = useMemo(() => {
    const items = new Map();
    for (const item of [...cachedCollectedItems, ...collectedItems]) items.set(item.id, item);
    return [...items.values()];
  }, [cachedCollectedItems, collectedItems]);
  const libraryItems = useMemo(() => [...PROMPT_LIBRARY_ITEMS, ...availableCollectedItems, ...customItems], [availableCollectedItems, customItems]);
  const indexedItems = useMemo(() => libraryItems.map(item => ({
    ...item,
    kind: item.kind || 'tag',
    searchText: item.searchText || `${item.title}\n${item.description}\n${item.prompt}\n${(item.aliases || []).join('\n')}`.toLowerCase(),
  })), [libraryItems]);
  const promptDisplayLabels = useMemo(() => {
    const labels = new Map();
    for (const item of indexedItems) {
      const label = item.category === 'collected' && item.kind === 'tag' && item.translation
        ? item.description
        : item.title || item.description || item.prompt;
      if (item.prompt && label) labels.set(normalizePromptPart(item.prompt), label);
    }
    return labels;
  }, [indexedItems]);
  const filteredLibraryItems = useMemo(() => applyLibraryFilters(indexedItems, advancedFilters), [advancedFilters, indexedItems]);
  const useCollectedSearchIndex = Boolean(collectedSearchIndex)
    && advancedFilters.source === 'all'
    && advancedFilters.contentType === 'all'
    && advancedFilters.tagGroup === 'all';
  const searchIndex = useMemo(() => isGlobalSearch
    ? useCollectedSearchIndex
      ? buildSearchIndexWithCachedCollected(filteredLibraryItems, collectedSearchIndex)
      : buildSearchIndex(filteredLibraryItems)
    : null, [collectedSearchIndex, filteredLibraryItems, isGlobalSearch, useCollectedSearchIndex]);
  const collectedGroups = useMemo(() => collectedTagGroups.map(group => ({
    id: `collected-group:${group.tagGroup}`,
    label: group.label,
    description: t('plCollectedCount', { n: group.count.toLocaleString() }),
    source: 'collected',
    categoryIds: ['collected'],
    tagGroup: group.tagGroup,
    count: group.count,
  })), [collectedTagGroups, t]);
  const taxonomyGroups = useMemo(() => [...PROMPT_LIBRARY_TAXONOMY, ...collectedGroups], [collectedGroups]);
  const taxonomyNodes = useMemo(() => taxonomyGroups.flatMap(group => [group, ...(group.children || [])]), [taxonomyGroups]);
  const countableTaxonomyNodes = useMemo(() => PROMPT_LIBRARY_TAXONOMY.flatMap(group => [
    group,
    ...(group.children || []).filter(child => isGlobalSearch || expandedGroups.has(group.id) || activeGroup === child.id || group.children?.some(item => item.id === activeGroup)),
  ]), [activeGroup, expandedGroups, isGlobalSearch]);
  const [taxonomyCounts, setTaxonomyCounts] = useState({ counts: {}, favoritesCount: favorites.size });
  useEffect(() => {
    let cancelled = false;
    const calculate = () => {
      if (cancelled) return;
      const counts = {};
      for (const node of countableTaxonomyNodes) counts[node.id] = 0;
      let favoritesCount = 0;
      for (const item of indexedItems) {
        if (favorites.has(item.id)) favoritesCount += 1;
        for (const node of countableTaxonomyNodes) {
          if (matchesPromptTaxonomy(item, node)) counts[node.id] += 1;
        }
      }
      if (!cancelled) setTaxonomyCounts({ counts, favoritesCount });
    };
    const task = window.requestIdleCallback
      ? window.requestIdleCallback(calculate, { timeout: 1200 })
      : window.setTimeout(calculate, 0);
    return () => {
      cancelled = true;
      if (window.cancelIdleCallback && window.requestIdleCallback) window.cancelIdleCallback(task);
      else window.clearTimeout(task);
    };
  }, [countableTaxonomyNodes, favorites, indexedItems]);
  const categoryCounts = useMemo(() => PROMPT_LIBRARY_TAXONOMY.reduce((counts, group) => {
    counts[group.id] = group.id === 'favorites'
      ? taxonomyCounts.favoritesCount
      : taxonomyCounts.counts[group.id] || 0;
    return counts;
}, {}), [taxonomyCounts]);
  const selectedGroup = taxonomyNodes.find(group => group.id === activeGroup) || PROMPT_LIBRARY_TAXONOMY[1];
  const selectedParent = PROMPT_LIBRARY_TAXONOMY.find(group => group.children?.some(child => child.id === activeGroup));
  const selectedStage = promptStages(t).find(stage => stage.id === activeStage);
  const isArtistView = (activeGroup === 'artist' || activeGroup === 'artist-anime') && !activeStage && !isGlobalSearch;
  const browsedItems = useMemo(() => {
    if (activeGroup === 'favorites') return indexedItems.filter(item => favorites.has(item.id));
    if (activeStage) return indexedItems.filter(item => selectedStage.categoryIds.includes(item.category));
    let items = indexedItems.filter(item => matchesPromptTaxonomy(item, selectedGroup));
    if (isArtistView) items = items.filter(item => !item.tier || item.tier === artistTier);
    return items;
  }, [activeGroup, activeStage, favorites, indexedItems, selectedGroup, selectedStage, isArtistView, artistTier]);
  const filteredItems = useMemo(() => {
    if (isGlobalSearch) return searchLibrary(filteredLibraryItems, query, searchIndex);
    return applyLibraryFilters(browsedItems, advancedFilters);
  }, [advancedFilters, browsedItems, filteredLibraryItems, isGlobalSearch, query, searchIndex]);
  const sortedItems = useMemo(() => {
    if (isGlobalSearch || selectedGroup.source === 'collected') {
      return [...filteredItems].sort((a, b) => (b.sourceCount || 0) - (a.sourceCount || 0));
    }
    return filteredItems;
  }, [filteredItems, isGlobalSearch, selectedGroup.source]);
  const visibleItems = sortedItems.slice(0, visibleLimit);
  const promptParts = useMemo(() => splitPromptParts(input), [input]);
  const negativeParts = useMemo(() => splitPromptParts(negative), [negative]);
  const activeParts = composerTarget === 'positive' ? promptParts : negativeParts;
  const missingStructure = useMemo(() => checkPromptStructure({ positive: input }).map(issue => issue.dimension), [input]);
  const workflowExamples = useMemo(() => workflowPromptExamples(workflowManifest, t), [workflowManifest, t]);

  useEffect(() => { setVisibleLimit(PAGE_SIZE); }, [activeGroup, activeStage, advancedFilters, query, artistTier]);

  function markAdded(id) {
    setAddedId(id);
    window.setTimeout(() => setAddedId(current => current === id ? '' : current), 850);
  }

  function addPrompt(item) {
    if (composerTarget === 'negative') setNegative(current => appendPrompt(current, item.prompt));
    else setInput(current => appendPrompt(current, item.prompt));
    markAdded(item.id);
  }

  function replacePrompt(item) {
    if (composerTarget === 'negative') setNegative(item.prompt.trim());
    else setInput(item.prompt.trim());
    markAdded(item.id);
  }

  function addPreset(preset) { addPrompt(preset); }

  function chooseStage(stage) {
    setActiveStage(stage.id);
    setActiveIntent('');
    setSearch('');
    setAdvancedFilters({ source: 'all', contentType: 'all', tagGroup: 'all' });
  }

  function chooseGroup(groupId) {
    setActiveGroup(groupId);
    setActiveStage('');
    setActiveIntent('');
    setSearch('');
    setAdvancedFilters({ source: 'all', contentType: 'all', tagGroup: 'all' });
  }

  function toggleGroupExpanded(groupId) {
    setExpandedGroups(current => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }

  function runQuickSearch(term) {
    setSearch(term);
    setActiveStage('');
    setActiveIntent('');
  }

  function addQuickSearch(event) {
    event.preventDefault();
    const term = quickSearchInput.trim();
    if (!term) return;
    setSavedSearches(current => current.includes(term) ? current : [...current, term]);
    setQuickSearchInput('');
    runQuickSearch(term);
  }

  function removeQuickSearch(term) {
    setSavedSearches(current => current.filter(item => item !== term));
  }

  function startSidebarResize(event) {
    if (event.button !== 0) return;
    sidebarResizeStart.current = { x: event.clientX, width: sidebarWidth };
    setIsResizingSidebar(true);
  }

  function resizeSidebarWithKeyboard(event) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    setSidebarWidth(current => clampSidebarWidth(current + (event.key === 'ArrowRight' ? 16 : -16)));
  }

  async function toggleMaximize() {
    if (!windowApi?.windowToggleMaximize) return;
    setMaximized(await windowApi.windowToggleMaximize());
  }

  function chooseIntent(intent) {
    setActiveIntent(intent.id);
    setActiveGroup('character');
    setActiveStage(intent.stage);
    setSearch('');
    setAdvancedFilters({ source: 'all', contentType: 'all', tagGroup: 'all' });
  }

  function toggleFavorite(item) {
    setFavorites(current => {
      const next = new Set(current);
      if (next.has(item.id)) next.delete(item.id);
      else next.add(item.id);
      return next;
    });
  }

  function deleteCustomItem(item) {
    setCustomItems(current => current.filter(entry => entry.id !== item.id));
    setFavorites(current => { const next = new Set(current); next.delete(item.id); return next; });
  }

  function addCustomItem(event) {
    event.preventDefault();
    const prompt = customPrompt.trim();
    if (!prompt || customItems.some(item => normalizePromptPart(item.prompt) === normalizePromptPart(prompt))) return;
    setCustomItems(current => [{ id: `custom-${Date.now()}`, category: 'custom', title: prompt.slice(0, 42), description: '用户保存的自定义词条', prompt, searchText: prompt.toLowerCase() }, ...current]);
    setCustomPrompt('');
  }

  function changeWeight(index, change) {
    const setter = composerTarget === 'negative' ? setNegative : setInput;
    setter(current => updatePromptWeight(current, index, change, MIN_WEIGHT, MAX_WEIGHT));
  }

  function removePart(index) {
    const setter = composerTarget === 'negative' ? setNegative : setInput;
    setter(current => removePromptPart(current, index));
  }

  useEffect(() => {
    const stack = document.querySelector('.prompt-workbench-cart-stack');
    if (!stack) return undefined;

    function clearDragState() {
      stack.querySelectorAll('.prompt-composer-chip').forEach(chip => chip.classList.remove('dragging', 'drag-over'));
      document.body.style.userSelect = '';
    }

    function handlePointerDown(event) {
      const chip = event.target.closest('.prompt-composer-chip');
      if (!chip || !stack.contains(chip) || event.button !== 0 || event.target.closest('button')) return;
      event.preventDefault();
      document.getSelection()?.removeAllRanges();
      const fromIndex = [...stack.children].indexOf(chip);
      promptDragRef.current = { fromIndex, targetIndex: fromIndex, target: composerTarget };
      chip.classList.add('dragging', 'drag-over');
      document.body.style.userSelect = 'none';
    }

    function handlePointerMove(event) {
      const drag = promptDragRef.current;
      if (!drag) return;
      const chip = document.elementFromPoint(event.clientX, event.clientY)?.closest('.prompt-composer-chip');
      if (!chip || !stack.contains(chip)) return;
      stack.querySelectorAll('.prompt-composer-chip').forEach(item => item.classList.remove('drag-over'));
      chip.classList.add('drag-over');
      drag.targetIndex = [...stack.children].indexOf(chip);
    }

    function stopDragging() {
      const drag = promptDragRef.current;
      if (!drag) return;
      if (drag.fromIndex !== drag.targetIndex) {
        const setter = drag.target === 'negative' ? setNegative : setInput;
        const insertionIndex = drag.targetIndex;
        setter(current => reorderPromptPart(current, drag.fromIndex, insertionIndex));
      }
      promptDragRef.current = null;
      clearDragState();
    }

    stack.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('pointermove', handlePointerMove);
    document.addEventListener('pointerup', stopDragging);
    document.addEventListener('pointercancel', stopDragging);
    return () => {
      stack.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerup', stopDragging);
      document.removeEventListener('pointercancel', stopDragging);
      clearDragState();
    };
  }, [composerTarget]);

  const collectionLabel = collectionState === 'ready'
    ? t('plCollectedCount', { n: collectedItems.length.toLocaleString() })
    : collectionState === 'loading'
      ? t('plCollecting', { n: Math.round(collectionProgress.percent || 0) })
      : collectionState === 'error' ? t('plCollectedUnavailable') : t('plCollectedOnDemand');
  const browseGroups = PROMPT_LIBRARY_TAXONOMY.filter(group => BROWSE_GROUP_IDS.includes(group.id));
  const visibleBrowseGroups = useMemo(() => {
    if (!query) return browseGroups;
    return browseGroups.flatMap(group => {
      const children = group.children?.filter(child => !child.hidden && matchesSearchText(`${child.label}\n${child.description || ''}`, query)) || [];
      if (matchesSearchText(`${group.label}\n${group.description || ''}`, query) || children.length > 0) {
        return [{ ...group, children: group.children ? children : undefined }];
      }
      return [];
    });
  }, [browseGroups, query]);
  const myContentGroups = PROMPT_LIBRARY_TAXONOMY.filter(group => MY_CONTENT_GROUP_IDS.includes(group.id));
  const visibleTagItems = visibleItems.filter(item => item.kind !== 'phrase');
  const visiblePhraseItems = visibleItems.filter(item => item.kind === 'phrase');

  function renderPromptCard(item) {
    const path = promptPathForItem(item, taxonomyGroups, t);
    const related = item.related?.slice(0, 4) || [];
    return <DraggablePromptCard key={item.id} item={item} path={path} related={related} added={addedId === item.id} favorite={favorites.has(item.id)} onToggleFavorite={toggleFavorite} onAdd={addPrompt} onReplace={replacePrompt} onDelete={deleteCustomItem} onDragLabel={t('plDragLabel')} target={composerTarget} />;
  }

  return (
    <main className={'prompt-library-page prompt-library-workbench' + (hidden ? ' view-hidden' : '')}>
      <header className="prompt-workbench-header">
        <div className="prompt-workbench-title"><span className="page-eyebrow">PROMPT WORKBENCH</span><h1>{t('plTitle')}</h1><span>{t('plSubtitle')}</span></div>
        <div className="prompt-workbench-header-actions"><span className="prompt-library-model-badge"><Icon name="spark" size={13} /> {t('plLocalLibrary')}</span><button className="btn btn-icon" onClick={onBack} title={t('plBackToChat')} aria-label={t('plBackToChat')}><Icon name="chevronLeft" size={15} /></button>{windowApi && <div className="window-controls prompt-workbench-window-controls" aria-label={t('plWindowControls')}><button className="window-control" onClick={() => windowApi.windowMinimize()} title={t('plMinimize')} aria-label={t('plMinimize')}><Icon name="minimize" /></button><button className="window-control" onClick={toggleMaximize} title={maximized ? t('plRestore') : t('plMaximize')} aria-label={maximized ? t('plRestore') : t('plMaximize')}><Icon name={maximized ? 'restore' : 'maximize'} /></button><button className="window-control window-control-close" onClick={() => windowApi.windowClose()} title={t('close')} aria-label={t('close')}><Icon name="windowClose" /></button></div>}</div>
      </header>

      {shouldLoadCollection && collectionState === 'loading' && <div className="prompt-library-sync-status" role="status" aria-live="polite">
        <div className="prompt-library-sync-dialog">
          <span className="prompt-library-sync-spinner" aria-hidden="true"><Icon name="spark" size={24} /></span>
          <strong>{t('plSyncing')}</strong>
          <span>{collectionLabel}</span>
          <progress value={collectionProgress.percent || 0} max="100" aria-label={t('plSyncAria')} />
        </div>
      </div>}

      <nav className="prompt-workbench-progress" aria-label={t('plBuildAria')}>
        <span className="prompt-workbench-progress-label">{t('plPromptPath')}</span>
        <div className="prompt-workbench-progress-steps">
          {promptStages(t).map((stage, index) => <button type="button" key={stage.id} className={!isGlobalSearch && activeStage === stage.id ? 'active' : ''} onClick={() => chooseStage(stage)}><span>{index + 1}</span><strong>{stage.label}</strong><small>{stage.description}</small></button>)}
        </div>
      </nav>

      <div
        className="prompt-workbench-grid"
        data-sidebar-resizing={isResizingSidebar ? 'true' : 'false'}
        style={{ '--prompt-workbench-sidebar-width': `${sidebarWidth}px` }}
      >
        <aside className="prompt-workbench-sidebar">
            <div className="prompt-workbench-sidebar-scroll">
            <div className="prompt-workbench-sidebar-section"><span className="section-kicker">QUICK SEARCH</span><strong>{t('plQuickSearch')}</strong></div>
            <form className="prompt-workbench-quick-search-form" onSubmit={addQuickSearch}>
              <input value={quickSearchInput} onChange={event => setQuickSearchInput(event.target.value)} placeholder={t('plQuickSearchPlaceholder')} aria-label={t('plQuickSearchAddAria')} />
              <button type="submit" disabled={!quickSearchInput.trim()} title={t('plQuickSearchAdd')} aria-label={t('plQuickSearchAdd')}><Icon name="plus" size={13} /></button>
            </form>
            {savedSearches.length > 0 && <div className="prompt-workbench-quick-search-list">
              {savedSearches.map(term => <span className="prompt-workbench-quick-search-chip" key={term}>
                <button type="button" onClick={() => runQuickSearch(term)} title={t('plSearchTerm', { term })}>{term}</button>
                <button type="button" className="prompt-workbench-quick-search-remove" onClick={() => removeQuickSearch(term)} aria-label={t('plDeleteTerm', { term })} title={t('plDeleteTerm', { term })}><Icon name="close" size={10} /></button>
              </span>)}
            </div>}
            <div className="prompt-workbench-sidebar-rule" />
            <div className="prompt-workbench-sidebar-section"><span className="section-kicker">START</span><strong>{t('plStartFromGoal')}</strong></div>
            <div className="prompt-workbench-sidebar-recipe-list" aria-label={t('plQuickStartAria')}>{animePresets(t).map(preset => <button type="button" className={`prompt-workbench-recipe${addedId === preset.id ? ' added' : ''}`} key={preset.id} onClick={() => addPreset(preset)}><span className="prompt-workbench-recipe-mark"><Icon name="spark" size={13} /></span><span><strong>{preset.title}</strong><small>{preset.description}</small></span><Icon name={addedId === preset.id ? 'check' : 'plus'} size={12} /></button>)}</div>
            <div className="prompt-workbench-intent-list">
              {promptIntents(t).map(intent => <button type="button" key={intent.id} className={activeIntent === intent.id ? 'active' : ''} onClick={() => chooseIntent(intent)}><span>{intent.label}</span><small>{intent.description}</small></button>)}
            </div>
            <div className="prompt-workbench-sidebar-rule" />
            <div className="prompt-workbench-sidebar-section"><span className="section-kicker">BROWSE</span><strong>{t('plBrowse')}</strong></div>
            <nav className="prompt-workbench-category-list" aria-label={t('plBrowseAria')}>
              {visibleBrowseGroups.filter(group => !group.hidden).map(group => {
                const hasChildren = group.children?.length > 0;
                const groupActive = !activeIntent && !activeStage && (activeGroup === group.id || selectedParent?.id === group.id);
                const groupExpanded = Boolean(query) || expandedGroups.has(group.id) || selectedParent?.id === group.id;
                return <div className="prompt-workbench-category-branch" key={group.id}>
                  <div className="prompt-workbench-category-row">
                    <button type="button" className={groupActive ? 'active' : ''} onClick={() => chooseGroup(group.id)}><span>{group.label}</span><small>{categoryCounts[group.id]}</small></button>
                    {hasChildren && <button type="button" className="prompt-workbench-category-toggle" onClick={() => toggleGroupExpanded(group.id)} title={groupExpanded ? t('plCollapseSub', { label: group.label }) : t('plExpandSub', { label: group.label })} aria-label={groupExpanded ? t('plCollapseSub', { label: group.label }) : t('plExpandSub', { label: group.label })}><Icon name={groupExpanded ? 'chevronUp' : 'chevronDown'} size={12} /></button>}
                  </div>
                  {hasChildren && groupExpanded && <div className="prompt-workbench-subcategory-list"><span className="prompt-workbench-subcategory-label">{t('plSubdivide')}</span>{group.children.filter(child => !child.hidden).map(child => <button type="button" key={child.id} className={activeGroup === child.id && !activeIntent && !activeStage ? 'active' : ''} onClick={() => chooseGroup(child.id)}><span>{child.label}</span><small>{(taxonomyCounts.counts[child.id] || 0).toLocaleString()}</small></button>)}</div>}
                </div>;
              })}
            </nav>
            <div className="prompt-workbench-sidebar-rule" />
            <div className="prompt-workbench-sidebar-section"><span className="section-kicker">MY CONTENT</span><strong>{t('plMyContent')}</strong></div>
            <nav className="prompt-workbench-category-list" aria-label={t('plMyContentAria')}>
              {myContentGroups.map(group => <button type="button" key={group.id} className={!activeIntent && !activeStage && activeGroup === group.id ? 'active' : ''} onClick={() => chooseGroup(group.id)}><span>{group.label}</span><small>{group.id === 'favorites' ? favorites.size : customItems.length}</small></button>)}
            </nav>
            <button type="button" className={`prompt-workbench-filter-toggle${advancedOpen ? ' active' : ''}`} onClick={() => setAdvancedOpen(value => !value)}><Icon name="settings" size={13} /><span>{t('plAdvanced')}</span><Icon name={advancedOpen ? 'chevronUp' : 'chevronDown'} size={12} /></button>
          </div>
        </aside>

        <div
          className="prompt-workbench-resizer"
          role="separator"
          aria-label={t('plSidebarResizeAria')}
          aria-orientation="vertical"
          aria-valuemin={SIDEBAR_MIN_WIDTH}
          aria-valuemax={SIDEBAR_MAX_WIDTH}
          aria-valuenow={sidebarWidth}
          tabIndex="0"
          onPointerDown={startSidebarResize}
          onKeyDown={resizeSidebarWithKeyboard}
          title={t('plSidebarResizeTitle')}
        />

        <section className="prompt-workbench-browser">
          <div className="prompt-workbench-browser-top">
            <div><span className="section-kicker">{isGlobalSearch ? 'SEARCH' : activeIntent ? 'RECOMMENDATION' : 'LIBRARY'}</span><h2>{isGlobalSearch ? t('plSearchHeading', { term: search.trim() }) : activeIntent ? promptIntents(t).find(intent => intent.id === activeIntent)?.label : activeStage ? selectedStage.label : selectedGroup.label}</h2></div>
            <span className="prompt-workbench-result-count">{t('plResultCount', { n: filteredItems.length.toLocaleString() })}</span>
          </div>
          <div className="prompt-workbench-search-row">
            <label className="prompt-library-search"><Icon name="search" size={14} /><input value={search} onChange={event => { const value = event.target.value; setSearch(value); if (value.trim()) { setActiveStage(''); setActiveIntent(''); } }} placeholder={t('plSearchPlaceholder')} aria-label={t('plSearchAria')} /></label>
            <div className="prompt-workbench-search-hints">{searchHints.map(term => <button type="button" key={term.query} onClick={() => { setSearch(term.query); setActiveStage(''); setActiveIntent(''); }}>{term.label}</button>)}</div>
          </div>

          {advancedOpen && <div className="prompt-workbench-advanced-filters">
            <label><span>{t('plFilterSource')}</span><select value={advancedFilters.source} onChange={event => setAdvancedFilters(current => ({ ...current, source: event.target.value, tagGroup: event.target.value === 'collected' ? current.tagGroup : 'all' }))}><option value="all">{t('plSourceAll')}</option><option value="curated">{t('plSourceCurated')}</option><option value="collected">{t('plSourceCollected')}</option><option value="custom">{t('plSourceCustom')}</option></select></label>
            <label><span>{t('plFilterContent')}</span><select value={advancedFilters.contentType} onChange={event => setAdvancedFilters(current => ({ ...current, contentType: event.target.value }))}><option value="all">{t('plContentAll')}</option><option value="tag">{t('plContentTag')}</option><option value="phrase">{t('plContentPhrase')}</option></select></label>
            <label><span>{t('plFilterTagGroup')}</span><select value={advancedFilters.tagGroup} onChange={event => setAdvancedFilters(current => ({ ...current, tagGroup: event.target.value }))}><option value="all">{t('plTagGroupAll')}</option>{collectedTagGroups.map(group => <option value={group.tagGroup} key={group.tagGroup}>{group.label} · {group.count.toLocaleString()}</option>)}</select></label>
          </div>}

          {!isGlobalSearch && activeGroup === 'custom' && <form className="prompt-workbench-custom-form" onSubmit={addCustomItem}>
            <label htmlFor="prompt-workbench-custom-input">{t('plCustomSaveLabel')}</label>
            <div><input id="prompt-workbench-custom-input" value={customPrompt} onChange={event => setCustomPrompt(event.target.value)} placeholder={t('plCustomPlaceholder')} /><button type="submit" className="btn btn-primary" disabled={!customPrompt.trim()} title={t('plCustomSaveTitle')}><Icon name="plus" size={13} />{t('plCustomSave')}</button></div>
          </form>}


           {workflowExamples.length > 0 && !isGlobalSearch && <div className="prompt-workbench-workflow-row"><span><strong>{t('plWorkflowExamples')}</strong><small>{workflowManifest.workflowName}</small></span>{workflowExamples.slice(0, 2).map(example => <button type="button" key={example.id} onClick={() => replacePrompt(example)}>{example.title}<Icon name="chevronRight" size={13} /></button>)}</div>}

          {isArtistView && <div className="prompt-workbench-artist-tiers" role="tablist" aria-label={t('plArtistAria')}>
            {[{ id: 'high', label: t('plTierHigh'), count: indexedItems.filter(item => item.category === 'artist' && item.tier === 'high').length },
              { id: 'medium', label: t('plTierMedium'), count: indexedItems.filter(item => item.category === 'artist' && item.tier === 'medium').length },
              { id: 'low', label: t('plTierLow'), count: indexedItems.filter(item => item.category === 'artist' && item.tier === 'low').length }].map(tier => (
              <button type="button" key={tier.id} role="tab" aria-selected={artistTier === tier.id} className={artistTier === tier.id ? 'active' : ''} onClick={() => setArtistTier(tier.id)}><span>{tier.label}</span><small>{tier.count}</small></button>
            ))}
          </div>}

           <div className="prompt-workbench-cards-heading"><strong>{activeIntent ? t('plNextSuggestions') : t('plAvailableContent')}</strong><span>{activeGroup === 'artist' || activeGroup === 'artist-anime' ? t('plArtistNote') : t('plCartHint')}</span>{activeGroup === 'collected' && !fullCollectionRequested && <button type="button" className="prompt-library-load-more" onClick={() => setFullCollectionRequested(true)}>{t('plLoadFullLibrary', { n: getCollectedTagGroups().reduce((sum, group) => sum + group.count, 0).toLocaleString() })}</button>}</div>
          <div className="prompt-workbench-card-scroll">
            {!isGlobalSearch && advancedFilters.source === 'collected' && collectionState === 'loading' ? <div className="prompt-library-empty"><strong>{t('plLoadingCollected')}</strong><span>{t('plLoadingCollectedNote')}</span></div> : visibleItems.length === 0 ? <div className="prompt-library-empty"><strong>{t('plNoMatches')}</strong><span>{t('plNoMatchesHint')}</span></div> : <div className="prompt-workbench-results-sections">
              {visibleTagItems.length > 0 && <section className="prompt-workbench-result-section"><div className="prompt-workbench-result-section-heading"><strong>{t('plTagsSection')}</strong><span>{t('plResultCount', { n: visibleTagItems.length.toLocaleString() })}</span></div><div className="prompt-workbench-card-grid">{visibleTagItems.map(renderPromptCard)}</div></section>}
              {visiblePhraseItems.length > 0 && <section className="prompt-workbench-result-section"><div className="prompt-workbench-result-section-heading"><strong>{t('plPhrasesSection')}</strong><span>{t('plResultCount', { n: visiblePhraseItems.length.toLocaleString() })}</span></div><div className="prompt-workbench-card-grid">{visiblePhraseItems.map(renderPromptCard)}</div></section>}
            </div>}
            {filteredItems.length > visibleLimit && <button type="button" className="prompt-library-load-more" onClick={() => setVisibleLimit(limit => limit + PAGE_SIZE)}>{t('plLoadMore', { n: filteredItems.length - visibleLimit })}</button>}
          </div>
        </section>

        <aside className="prompt-workbench-cart" aria-label={t('plCartAria')}>
          <div className="prompt-workbench-cart-header"><div><span className="section-kicker">CART</span><h2>{t('plCart')}</h2></div><span>{t('plPartsCount', { n: activeParts.length })}</span></div>
          <div className="prompt-workbench-cart-body">
            <div className="prompt-workbench-cart-target"><button type="button" className={composerTarget === 'positive' ? 'active' : ''} onClick={() => setComposerTarget('positive')}><Icon name="plus" size={12} />{t('plWant')}<span>{promptParts.length}</span></button><button type="button" className={composerTarget === 'negative' ? 'active' : ''} onClick={() => setComposerTarget('negative')} disabled={!negativeSupported}><Icon name="minus" size={12} />{t('plDontWant')}<span>{negativeParts.length}</span></button></div>
            <div className="prompt-workbench-cart-stack">{activeParts.length === 0 ? <span className="prompt-composer-empty">{t('plCartEmpty')}</span> : activeParts.map((part, index) => <span className="prompt-composer-chip" key={`${part.start}-${index}`}><span className="prompt-composer-chip-label" title={part.source}><span className="prompt-composer-chip-translation">{promptDisplayLabels.get(normalizePromptPart(part.raw)) || part.raw}</span>{promptDisplayLabels.has(normalizePromptPart(part.raw)) && promptDisplayLabels.get(normalizePromptPart(part.raw)) !== part.raw && <small>{part.raw}</small>}</span>{part.weight !== 1 && <b className="prompt-composer-weight">{formatWeight(part.weight)}x</b>}<button type="button" onClick={() => changeWeight(index, -WEIGHT_STEP)} aria-label={t('plLowerWeight', { part: part.raw })} disabled={part.editableWeight === false || part.weight <= MIN_WEIGHT}><Icon name="minus" size={10} /></button><button type="button" onClick={() => changeWeight(index, WEIGHT_STEP)} aria-label={t('plRaiseWeight', { part: part.raw })} disabled={part.editableWeight === false || part.weight >= MAX_WEIGHT}><Icon name="plus" size={10} /></button><button type="button" onClick={() => removePart(index)} aria-label={t('plRemovePart', { part: part.raw })}><Icon name="close" size={10} /></button></span>)}</div>
            <div className="prompt-workbench-cart-editor-label"><strong>{composerTarget === 'positive' ? t('plWant') : t('plDontWant')}</strong><span>{composerTarget === 'positive' ? t('plEditorPositive') : t('plEditorNegative')}</span></div>
            <textarea value={composerTarget === 'positive' ? input : negative} onChange={event => composerTarget === 'positive' ? setInput(event.target.value) : setNegative(event.target.value)} placeholder={composerTarget === 'positive' ? t('plEditorPlaceholderPositive') : t('plEditorPlaceholderNegative')} disabled={composerTarget === 'negative' && !negativeSupported} aria-label={composerTarget === 'positive' ? t('plEditorAriaPositive') : t('plEditorAriaNegative')} />
            {composerTarget === 'positive' && missingStructure.length > 0 && <p className="prompt-workbench-structure-hint">{t('plStructureHint', { dims: missingStructure.map(dimension => STRUCTURE_LABELS[dimension]).join('、') })}</p>}
            <div className="prompt-workbench-cart-note">{t('plCartNote')}</div>
            {!negativeSupported && composerTarget === 'negative' && <p className="prompt-library-negative-note">{t('plNegativeUnsupported')}</p>}
          </div>
          <div className="prompt-workbench-cart-footer"><button type="button" className="btn" onClick={() => { setInput(''); setNegative(''); }} disabled={!input.trim() && !negative.trim()}><Icon name="trash" size={13} />{t('plClear')}</button><button type="button" className="btn btn-primary" onClick={() => onGenerate(input.trim(), negative.trim())} disabled={!input.trim()}><Icon name="send" size={13} />{t('plGenerateNow')}</button></div>
        </aside>
      </div>
    </main>
  );
}
