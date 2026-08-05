import { searchTokens } from './prompt-library-search.mjs';
import {
  COLLECTED_PHRASES_SEGMENT,
  COLLECTED_SEGMENTS,
  COLLECTED_TAG_GROUPS,
  COLLECTED_TOTAL_TAGS,
} from './prompt-library-segments/index.mjs';

const COLLECTION_CACHE_NAME = 'comfy-agent-prompt-library';
const COLLECTION_CACHE_VERSION = 'collected-v4-2026-08-05';
const SEGMENT_BATCH_SIZE = 4;

let collectedItemsPromise = null;
let cachedRecord = null;
const loadedItems = [];
const loadedSegments = new Set();
const loadPromises = new Map();

function getSegmentLoaders() {
  return import.meta.glob('./prompt-library-segments/seg-*.mjs');
}

function createSearchText(title, description, prompt) {
  return `${title}\n${description}\n${prompt}`.toLowerCase();
}

function splitLines(value) {
  return value
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
}

export function parseTagTranslations(rawTranslations) {
  const translations = new Map();
  for (const line of splitLines(rawTranslations)) {
    const separator = line.indexOf('\t');
    if (separator > 0) {
      translations.set(line.slice(0, separator), line.slice(separator + 1).trim());
    }
  }
  return translations;
}

export function parseTagMetadata(rawMetadata) {
  const metadata = new Map();
  for (const line of splitLines(rawMetadata)) {
    const [tag, translation, group, usage, count, source] = line.split('\t', 6);
    if (tag) {
      metadata.set(tag, {
        translation: translation?.trim() || '',
        group: group?.trim() || '未分类',
        usage: usage?.trim() || '用于描述生成画面的对象、属性或风格',
        sourceCount: Number.parseInt(count, 10) || 0,
        source: source?.trim() || '收集标签',
      });
    }
  }
  return metadata;
}

export function createTagItem(tag, translations = new Map(), metadata = new Map()) {
  const title = tag.replaceAll('_', ' ');
  const detail = metadata.get(tag) || {};
  const translation = translations.get(tag) || detail.translation;
  const description = translation || '中文释义暂缺';
  const usage = detail.usage || '用于描述生成画面的对象、属性或风格';
  return {
    id: `collected-tag:${tag}`,
    category: 'collected',
    kind: 'tag',
    title,
    description,
    translation: translation || '',
    prompt: tag,
    tagGroup: detail.group || '未分类',
    usage,
    sourceCount: detail.sourceCount || 0,
    source: detail.source || '收集标签',
    searchText: createSearchText(title, `${description}\n${usage}\n${detail.group || ''}`, tag),
  };
}

export function createTagItems(allUniqueTags, translations = new Map(), metadata = new Map()) {
  return splitLines(allUniqueTags).map(tag => createTagItem(tag, translations, metadata));
}

export function createPhraseItems(allPromptPhrases) {
  return splitLines(allPromptPhrases).map((line, index) => createPhraseItem(line, index));
}

function createPhraseItem(line, index) {
  const match = line.match(/^(.*?),\s*'([^']*)',\s*$/);
  const prompt = match ? match[1].trim() : line;
  const title = match?.[2]?.trim() || `${prompt.slice(0, 42)}${prompt.length > 42 ? '...' : ''}`;
  const description = '完整提示词短语 · 可直接加入';
  return {
    id: `collected-phrase-${index}`,
    category: 'collected',
    kind: 'phrase',
    title,
    description,
    prompt,
    searchText: createSearchText(title, description, prompt),
  };
}

async function createTagItemsFromSegment(text) {
  const details = parseTagMetadata(text);
  const items = [];
  let index = 0;
  for (const tag of details.keys()) {
    items.push(createTagItem(tag, new Map(), details));
    index += 1;
    if (index % 400 === 0) await yieldToBrowser();
  }
  return items;
}

function yieldToBrowser() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

function openCollectionCache() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise(resolve => {
    const request = indexedDB.open(COLLECTION_CACHE_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('collections', { keyPath: 'version' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

async function readCachedRecord() {
  const database = await openCollectionCache();
  if (!database) return null;
  return new Promise(resolve => {
    const request = database.transaction('collections', 'readonly').objectStore('collections').get(COLLECTION_CACHE_VERSION);
    request.onsuccess = () => {
      const record = request.result;
      resolve(Array.isArray(record?.items) ? record : null);
    };
    request.onerror = () => resolve(null);
  });
}

async function writeCachedRecord(record) {
  const database = await openCollectionCache();
  if (!database) return;
  await new Promise(resolve => {
    const request = database.transaction('collections', 'readwrite').objectStore('collections').put({
      version: COLLECTION_CACHE_VERSION,
      items: record.items,
      searchIndex: record.searchIndex,
    });
    request.onsuccess = resolve;
    request.onerror = resolve;
  });
}

async function loadSegmentModule(segmentId) {
  const loader = getSegmentLoaders()?.[`./prompt-library-segments/${segmentId}.mjs`];
  if (!loader) throw new Error(`missing collected segment ${segmentId}`);
  return loader();
}

async function loadSegmentItems(segment) {
  const module = await loadSegmentModule(segment.id);
  return segment.kind === 'phrases'
    ? createPhraseItems(module.default)
    : createTagItemsFromSegment(module.default);
}

async function collectSegmentItems(segment) {
  if (loadedSegments.has(segment.id)) return;
  const next = await loadSegmentItems(segment);
  loadedItems.push(...next);
  loadedSegments.add(segment.id);
}

async function buildSearchIndexWithYield(items) {
  const index = new Map();
  for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
    for (const token of searchTokens(items[itemIndex].searchText)) {
      const matches = index.get(token) || [];
      matches.push(itemIndex);
      index.set(token, matches);
    }
    if (itemIndex % 1200 === 1199) await yieldToBrowser();
  }
  return index;
}

async function loadAllSegments(onProgress) {
  const tagSegments = COLLECTED_SEGMENTS.filter(segment => segment.id !== COLLECTED_PHRASES_SEGMENT);
  onProgress({ stage: 'loading', percent: 5 });
  let loadedCount = 0;
  for (let offset = 0; offset < tagSegments.length; offset += SEGMENT_BATCH_SIZE) {
    const batch = tagSegments.slice(offset, offset + SEGMENT_BATCH_SIZE);
    await Promise.all(batch.map(segment => loadSegmentModule(segment.id)));
    for (const segment of batch) await collectSegmentItems(segment);
    loadedCount += batch.reduce((sum, segment) => sum + segment.count, 0);
    onProgress({ stage: 'tags', percent: 20 + (loadedCount / COLLECTED_TOTAL_TAGS) * 50, count: loadedCount });
    await yieldToBrowser();
  }
  onProgress({ stage: 'phrases', percent: 72, count: loadedItems.length });
  await collectSegmentItems({ id: COLLECTED_PHRASES_SEGMENT, kind: 'phrases' });
  const items = loadedItems;
  cachedRecord = { items, searchIndex: await buildSearchIndexWithYield(items) };
  try {
    await writeCachedRecord(cachedRecord);
  } catch {
    // IndexedDB is an optional performance cache; segment imports are the source of truth.
  }
  onProgress({ stage: 'ready', percent: 100, count: items.length });
  return items;
}

export function loadCollectedPromptItems(onProgress = () => {}) {
  if (!collectedItemsPromise) {
    collectedItemsPromise = readCachedRecord().catch(() => null).then(record => {
      if (record) {
        cachedRecord = record;
        onProgress({ stage: 'ready', percent: 100, count: record.items.length });
        return record.items;
      }
      return loadAllSegments(onProgress);
    });
  }
  return collectedItemsPromise;
}

export function loadCollectedTagGroup(tagGroup, onProgress = () => {}) {
  const key = `group:${tagGroup}`;
  if (!loadPromises.has(key)) {
    loadPromises.set(key, (async () => {
      const groupSegments = (COLLECTED_TAG_GROUPS[tagGroup]?.segments || [])
        .map(segmentId => COLLECTED_SEGMENTS.find(segment => segment.id === segmentId))
        .filter(Boolean);
      const missing = groupSegments.filter(segment => !loadedSegments.has(segment.id));
      if (missing.length === 0) {
        onProgress({ stage: 'ready', percent: 100, count: loadedItems.length });
        return loadedItems;
      }
      onProgress({ stage: 'loading', percent: 5 });
      for (let offset = 0; offset < missing.length; offset += SEGMENT_BATCH_SIZE) {
        const batch = missing.slice(offset, offset + SEGMENT_BATCH_SIZE);
        await Promise.all(batch.map(segment => loadSegmentModule(segment.id)));
        for (const segment of batch) await collectSegmentItems(segment);
        const progress = Math.min(offset + batch.length, missing.length);
        onProgress({ stage: 'tags', percent: 20 + (progress / missing.length) * 75, count: loadedItems.length });
        await yieldToBrowser();
      }
      onProgress({ stage: 'ready', percent: 100, count: loadedItems.length });
      return loadedItems;
    })());
  }
  return loadPromises.get(key);
}

export function getCollectedSearchIndex() {
  return loadCollectedPromptItems().then(() => cachedRecord?.searchIndex || null);
}

export function getCollectedTagGroups() {
  return Object.entries(COLLECTED_TAG_GROUPS)
    .map(([tagGroup, info]) => ({ tagGroup, label: tagGroup.replace(/^\d+_/, ''), count: info.count }))
    .sort((a, b) => b.count - a.count);
}