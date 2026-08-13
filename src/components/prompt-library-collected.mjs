import { searchQueryTokens, searchTokens } from './prompt-library-search.mjs';
import {
  COLLECTED_PHRASES_SEGMENT,
  COLLECTED_SEGMENTS,
  COLLECTED_TAG_GROUPS,
  COLLECTED_TOTAL_TAGS,
} from './prompt-library-segments/index.mjs';

const COLLECTION_CACHE_NAME = 'comfy-agent-prompt-library';
const COLLECTION_CACHE_VERSION = 'collected-v6-59405-separated-cache';
const COLLECTION_SCHEMA_VERSION = 3;
const SEGMENT_BATCH_SIZE = 4;

function expectedCollectedItemCount() {
  const phraseSegment = COLLECTED_SEGMENTS.find(segment => segment.id === COLLECTED_PHRASES_SEGMENT);
  return COLLECTED_TOTAL_TAGS + (phraseSegment?.count || 0);
}

let collectedItemsPromise = null;
let cachedRecord = null;
let cachedSearchIndexPromise = null;
const loadedItems = [];
const loadedSegments = new Set();
const loadPromises = new Map();
const itemCache = new Map();
const segmentLoadPromises = new Map();
const failedSegments = new Set();

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
  // Records in ALL_prompt_phrases.txt are `PROMPT, '标题', 'rgba(…)', <毫秒>, 'uuid`（uuid 引号未闭合）.
  // Tolerate the full metadata tail, a clean `PROMPT, '标题',` line, and stray text lines.
  const metadataMatch = line.match(/^(.*?),\s*'([^']*)',\s*'[^']*',\s*\d+(?:\.\d+)?,\s*'[^']*'?\s*$/);
  const cleanMatch = line.match(/^(.*?),\s*'([^']*)'?,?\s*$/);
  const match = metadataMatch || cleanMatch;
  let prompt = match ? match[1].trim() : line;
  if (prompt.endsWith("'")) prompt = prompt.slice(0, -1).trim();
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
    const request = indexedDB.open(COLLECTION_CACHE_NAME, COLLECTION_SCHEMA_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      for (const store of ['meta', 'indexes', 'segments', 'items', 'counts']) {
        if (!database.objectStoreNames.contains(store)) database.createObjectStore(store, { keyPath: 'key' });
      }
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
    const request = database.transaction('segments', 'readonly').objectStore('segments').get('all');
    request.onsuccess = () => {
      const record = request.result;
      resolve(record?.version === COLLECTION_CACHE_VERSION && Array.isArray(record?.items) && record.items.length === expectedCollectedItemCount() ? record : null);
    };
    request.onerror = () => resolve(null);
  });
}

async function writeCachedRecord(record) {
  const database = await openCollectionCache();
  if (!database) return;
  await new Promise(resolve => {
    const request = database.transaction('segments', 'readwrite').objectStore('segments').put({
      key: 'all',
      version: COLLECTION_CACHE_VERSION,
      items: record.items,
      searchIndex: record.searchIndex,
    });
    request.onsuccess = resolve;
    request.onerror = resolve;
  });
}

const INDEX_BUCKET_SIZE = 4000;

async function readCachedSearchIndex() {
  const database = await openCollectionCache();
  if (!database) return null;
  const legacy = await new Promise(resolve => {
    const request = database.transaction('indexes', 'readonly').objectStore('indexes').get(COLLECTION_CACHE_VERSION);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => resolve(null);
  });
  if (legacy && Array.isArray(legacy.records)) {
    return new Map(legacy.records.map(record => [record.token, record.itemIds || []]));
  }
  const bucketRecords = [];
  await new Promise(resolve => {
    const store = database.transaction('indexes', 'readonly').objectStore('indexes');
    const range = IDBKeyRange.bound(`${COLLECTION_CACHE_VERSION}#`, `${COLLECTION_CACHE_VERSION}#\uffff`);
    const request = store.openCursor(range);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      if (Array.isArray(cursor.value?.records)) bucketRecords.push(...cursor.value.records);
      cursor.continue();
    };
    request.onerror = () => resolve();
  });
  if (bucketRecords.length === 0) return null;
  return new Map(bucketRecords.map(record => [record.token, record.itemIds || []]));
}

async function writeCachedSearchIndex(index) {
  const database = await openCollectionCache();
  if (!database) return;
  const records = [...index].map(([token, itemIds]) => ({ token, itemIds: itemIds instanceof Set ? [...itemIds] : itemIds }));
  const bucketCount = Math.max(1, Math.ceil(records.length / INDEX_BUCKET_SIZE));
  const bucketKeys = [];
  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const slice = records.slice(bucket * INDEX_BUCKET_SIZE, (bucket + 1) * INDEX_BUCKET_SIZE);
    const key = `${COLLECTION_CACHE_VERSION}#${bucket}`;
    bucketKeys.push(key);
    await new Promise(resolve => {
      const request = database.transaction('indexes', 'readwrite').objectStore('indexes').put({
        key,
        version: COLLECTION_CACHE_VERSION,
        bucket,
        records: slice,
      });
      request.onsuccess = resolve;
      request.onerror = resolve;
    });
  }
  await new Promise(resolve => {
    const transaction = database.transaction('indexes', 'readwrite');
    const store = transaction.objectStore('indexes');
    store.delete(COLLECTION_CACHE_VERSION);
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const key = String(cursor.key);
      if (key.startsWith(`${COLLECTION_CACHE_VERSION}#`) && !bucketKeys.includes(key)) store.delete(cursor.key);
      cursor.continue();
    };
    request.onerror = () => resolve();
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
  });
}

let fullRecordWritten = false;
let persistChain = Promise.resolve();

function persistCollectedCache(items, index, idIndex) {
  const indexForWrite = idIndex || index;
  persistChain = persistChain.then(async () => {
    await writeCachedSearchIndex(indexForWrite);
    if (fullRecordWritten) return;
    if (items.length !== expectedCollectedItemCount()) return;
    await writeCachedRecord({ items, searchIndex: indexForWrite });
    fullRecordWritten = true;
  }).catch(() => {});
  return persistChain;
}

async function writeCachedSegment(segment, items) {
  const database = await openCollectionCache();
  if (!database) return;
  if (!Array.isArray(items)) {
    console.error('[collected] writeCachedSegment skipped: items is not an array for', segment.id);
    return;
  }
  await new Promise(resolve => {
    const request = database.transaction('segments', 'readwrite').objectStore('segments').put({
      key: segment.id,
      version: COLLECTION_CACHE_VERSION,
      segmentId: segment.id,
      items,
    });
    request.onsuccess = resolve;
    request.onerror = () => resolve();
  });
}

async function writeCachedItems(items) {
  const database = await openCollectionCache();
  if (!database || items.length === 0) return;
  if (!Array.isArray(items)) {
    console.error('[collected] writeCachedItems skipped: items is not an array');
    return;
  }
  await new Promise(resolve => {
    const transaction = database.transaction('items', 'readwrite');
    const store = transaction.objectStore('items');
    for (const item of items) store.put({ key: item.id, version: COLLECTION_CACHE_VERSION, item });
    transaction.oncomplete = resolve;
    transaction.onerror = resolve;
  });
}

async function loadSegmentModule(segmentId) {
  const loader = getSegmentLoaders()?.[`./prompt-library-segments/${segmentId}.mjs`];
  if (!loader) throw new Error(`missing collected segment ${segmentId}`);
  return loader();
}

async function loadSegmentItems(segment) {
  const database = await openCollectionCache();
  if (database) {
    const cached = await new Promise(resolve => {
      const request = database.transaction('segments', 'readonly').objectStore('segments').get(segment.id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    });
    if (cached?.version === COLLECTION_CACHE_VERSION && Array.isArray(cached.items) && cached.items.length === segment.count) {
      for (const item of cached.items) itemCache.set(item.id, item);
      return cached.items;
    }
  }
  const module = await loadSegmentModule(segment.id);
  const items = segment.kind === 'phrases'
    ? createPhraseItems(module.default)
    : await createTagItemsFromSegment(module.default);
  await writeCachedSegment(segment, items);
  for (const item of items) itemCache.set(item.id, item);
  await writeCachedItems(items);
  return items;
}

async function collectSegmentItems(segment, onProgress = () => {}, allowRetry = false) {
  if (loadedSegments.has(segment.id)) return;
  if (!allowRetry && failedSegments.has(segment.id)) return;
  let promise = segmentLoadPromises.get(segment.id);
  if (!promise) {
    promise = loadSegmentItems(segment).then(next => {
      failedSegments.delete(segment.id);
      if (!loadedSegments.has(segment.id)) {
        loadedItems.push(...next);
        loadedSegments.add(segment.id);
      }
      return next;
    });
    segmentLoadPromises.set(segment.id, promise);
  }
  try {
    return await promise;
  } catch (error) {
    failedSegments.add(segment.id);
    segmentLoadPromises.delete(segment.id);
    onProgress({ stage: 'error', segmentId: segment.id, error: String(error?.message || error) });
    return [];
  }
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
    await Promise.all(batch.map(segment => loadSegmentModule(segment.id).catch(() => null)));
    for (const segment of batch) await collectSegmentItems(segment, onProgress, true);
    loadedCount += batch.reduce((sum, segment) => sum + segment.count, 0);
    onProgress({ stage: 'tags', percent: 20 + (loadedCount / COLLECTED_TOTAL_TAGS) * 50, count: loadedItems.length });
    await yieldToBrowser();
  }
  onProgress({ stage: 'phrases', percent: 72, count: loadedItems.length });
  const phrasesSegment = COLLECTED_SEGMENTS.find(segment => segment.id === COLLECTED_PHRASES_SEGMENT);
  if (phrasesSegment) await collectSegmentItems(phrasesSegment, onProgress, true);
  const items = loadedItems;
  cachedRecord = { items, searchIndex: await buildSearchIndexWithYield(items) };
  const idIndex = new Map([...cachedRecord.searchIndex].map(([token, indexes]) => [token, indexes.map(index => items[index]?.id).filter(Boolean)]));
  onProgress({ stage: 'ready', percent: 100, count: items.length });
  persistCollectedCache(items, cachedRecord.searchIndex, idIndex);
  return items;
}

export function loadCollectedPromptItems(onProgress = () => {}) {
  if (!collectedItemsPromise) {
    collectedItemsPromise = readCachedRecord().catch(() => null).then(record => {
      if (record) {
        cachedRecord = record;
        loadedItems.length = 0;
        loadedItems.push(...record.items);
        for (const segment of COLLECTED_SEGMENTS) loadedSegments.add(segment.id);
        onProgress({ stage: 'ready', percent: 100, count: record.items.length });
        return record.items;
      }
      return loadAllSegments(onProgress);
    });
  }
  return collectedItemsPromise;
}

export function loadCollectedSearchIndex() {
  if (!cachedSearchIndexPromise) cachedSearchIndexPromise = readCachedSearchIndex();
  return cachedSearchIndexPromise;
}

function mergeSearchIndex(target, items) {
  for (const item of items) {
    for (const token of searchTokens(item.searchText)) {
      const ids = target.get(token);
      if (ids instanceof Set) ids.add(item.id);
      else if (Array.isArray(ids)) {
        const next = new Set(ids);
        next.add(item.id);
        target.set(token, next);
      } else {
        target.set(token, new Set([item.id]));
      }
    }
  }
  return target;
}

export async function loadCachedCollectedItems(itemIds = null) {
  const database = await openCollectionCache();
  if (!database) return [];
  if (Array.isArray(itemIds) && database.objectStoreNames.contains('items')) {
    const missingIds = itemIds.filter(itemId => !itemCache.has(itemId));
    const records = missingIds.length === 0 ? [] : await new Promise(resolve => {
      const transaction = database.transaction('items', 'readonly');
      const store = transaction.objectStore('items');
      const results = [];
      for (const itemId of missingIds) {
        const request = store.get(itemId);
        request.onsuccess = () => results.push(request.result || null);
        request.onerror = () => results.push(null);
      }
      transaction.oncomplete = () => resolve(results);
      transaction.onerror = () => resolve(results);
    });
    for (const record of records) {
      if (record?.version === COLLECTION_CACHE_VERSION && record.item) itemCache.set(record.item.id, record.item);
    }
    return itemIds.map(itemId => itemCache.get(itemId)).filter(Boolean);
  }
  const records = await new Promise(resolve => {
    const request = database.transaction('segments', 'readonly').objectStore('segments').getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => resolve([]);
  });
  return records
    .filter(record => record.version === COLLECTION_CACHE_VERSION)
    .flatMap(record => Array.isArray(record.items) ? record.items : []);
}

export function getCachedCollectedItemIds(query, index) {
  const terms = searchQueryTokens(query);
  const ids = new Set();
  for (const term of terms) {
    for (const itemId of index?.get(term) || []) ids.add(itemId);
  }
  return [...ids];
}

export function loadCollectedSegmentBatch(onProgress = () => {}) {
  const segments = COLLECTED_SEGMENTS.filter(segment => !loadedSegments.has(segment.id) && !failedSegments.has(segment.id));
  if (segments.length === 0) return Promise.resolve(loadedItems);
  const batch = segments.slice(0, SEGMENT_BATCH_SIZE);
  return Promise.all(batch.map(async segment => {
    const start = loadedItems.length;
    await collectSegmentItems(segment, onProgress);
    return loadedItems.slice(start);
  })).then(async loadedBatch => {
    const currentIndex = (await loadCollectedSearchIndex()) || new Map();
    const index = mergeSearchIndex(new Map(currentIndex), loadedBatch.flat());
    cachedSearchIndexPromise = Promise.resolve(index);
    cachedRecord = { items: loadedItems, searchIndex: index };
    if (!hasPendingCollectedSegments()) {
      persistCollectedCache(loadedItems, index);
    }
    onProgress({ stage: 'background', percent: (loadedSegments.size / COLLECTED_SEGMENTS.length) * 100, count: loadedItems.length });
    return loadedItems;
  });
}

export function hasPendingCollectedSegments() {
  return COLLECTED_SEGMENTS.some(segment => !loadedSegments.has(segment.id) && !failedSegments.has(segment.id));
}

export function getCollectedLoadFailures() {
  return [...failedSegments];
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
        await Promise.all(batch.map(segment => loadSegmentModule(segment.id).catch(() => null)));
        for (const segment of batch) await collectSegmentItems(segment, onProgress, true);
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
  return loadCollectedSearchIndex().then(index => index || cachedRecord?.searchIndex || null);
}

export function getCollectedTagGroups() {
  return Object.entries(COLLECTED_TAG_GROUPS)
    .map(([tagGroup, info]) => ({ tagGroup, label: tagGroup.replace(/^\d+_/, ''), count: info.count }))
    .sort((a, b) => b.count - a.count);
}

export function getCollectedItemTotal() {
  return expectedCollectedItemCount();
}
