const MAX_SCORED_CANDIDATES = 4000;

const SEARCH_ALIASES = new Map([
  ['红发', ['red hair', 'red-haired', 'copper red hair']],
  ['红色头发', ['red hair', 'red-haired', 'copper red hair']],
  ['白发', ['white hair', 'silver-white hair', 'platinum blonde hair']],
  ['黑发', ['black hair', 'raven black hair']],
  ['蓝发', ['blue hair', 'dark hair with blue tips']],
  ['粉发', ['pink hair', 'pastel pink hair']],
  ['金发', ['blonde hair', 'platinum blonde hair']],
  ['绿发', ['green hair']],
  ['红眼', ['red eyes']],
  ['蓝眼', ['blue eyes']],
  ['绿眼', ['green eyes']],
  ['黄眼', ['yellow eyes', 'golden eyes']],
  ['紫眼', ['purple eyes', 'violet eyes']],
  ['少女', ['girl', 'teenage girl', 'young woman', '1girl']],
  ['男孩', ['boy', 'teenage boy', '1boy']],
  ['男性', ['man', 'male character', '1boy']],
  ['女仆装', ['maid', 'maid dress', 'maid apron', 'maid headdress']],
  ['校服', ['school uniform', 'schoolgirl']],
  ['军装', ['military uniform', 'military clothing']],
  ['连衣裙', ['dress', 'sundress', 'evening gown']],
  ['全身', ['full body', 'full-length', 'standing']],
  ['半身', ['upper body', 'bust', 'portrait']],
  ['侧面', ['side view', 'profile', 'from side']],
  ['正面', ['front view', 'facing viewer', 'looking at viewer']],
  ['低角度', ['low angle', 'low-angle shot']],
  ['高角度', ['high angle', 'high-angle shot']],
  ['微笑', ['smile', 'smiling', 'soft smile']],
  ['看镜头', ['looking at viewer', 'eye contact', 'direct eye contact']],
  ['站立', ['standing', 'standing pose']],
  ['坐着', ['sitting', 'seated']],
  ['躺着', ['lying', 'lying on ground']],
  ['夜景', ['night', 'nighttime', 'night sky']],
  ['白背景', ['white background', 'simple background']],
  ['教室', ['classroom', 'school interior']],
  ['赛博朋克', ['cyberpunk']],
  ['动漫', ['anime', 'anime illustration']],
  ['高质量', ['masterpiece', 'best quality', 'score_9', 'very aesthetic', 'ultra detailed']],
  ['胸口', ['胸部', '上半身', 'upper body', 'bust', 'chest']],
  ['胸部', ['胸口', '上半身', 'upper body', 'bust', 'chest']],
]);

export const SEARCH_GUIDE_TERMS = [
  { label: '红发', query: '红发', hint: 'red hair' },
  { label: '女仆装', query: '女仆装', hint: 'maid' },
  { label: '全身', query: '全身', hint: 'full body' },
  { label: '侧面', query: '侧面', hint: 'side view' },
  { label: '夜景', query: '夜景', hint: 'night scene' },
  { label: '高质量', query: '高质量', hint: 'masterpiece' },
];

export function randomSearchGuideTerms(count = 4, random = Math.random) {
  const terms = [...SEARCH_GUIDE_TERMS];
  for (let index = terms.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(random() * (index + 1));
    [terms[index], terms[swapIndex]] = [terms[swapIndex], terms[index]];
  }
  return terms.slice(0, count);
}

function searchTerms(value) {
  return (String(value).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter(Boolean);
}

function searchTokens(value) {
  const tokens = new Set(searchTerms(value));
  for (const chunk of String(value).toLowerCase().match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/gu) || []) {
    for (const char of chunk) tokens.add(char);
    for (let size = 2; size <= 3; size++) {
      for (let index = 0; index + size <= chunk.length; index++) tokens.add(chunk.slice(index, index + size));
    }
  }
  return tokens;
}

export { searchTokens };

function queryGroups(query) {
  const value = String(query).toLowerCase();
  const matchedLabels = [...SEARCH_ALIASES.keys()]
    .filter(label => value.includes(label))
    .sort((a, b) => b.length - a.length);
  const groups = matchedLabels.map(label => [label, ...SEARCH_ALIASES.get(label)]);
  const residual = matchedLabels.reduce((result, label) => result.replaceAll(label, ' '), value);
  return [...groups, ...searchTerms(residual).map(term => [term])];
}

export function matchesSearchText(value, query) {
  const text = String(value || '').toLowerCase();
  return queryGroups(query).some(group => group.some(term => text.includes(term.toLowerCase())));
}

export function buildSearchIndex(items) {
  const index = new Map();
  items.forEach((item, itemIndex) => {
    for (const token of searchTokens(item.searchText)) {
      const matches = index.get(token) || [];
      matches.push(itemIndex);
      index.set(token, matches);
    }
  });
  return index;
}

export function buildSearchIndexWithCachedCollected(items, cachedCollectedIndex) {
  const index = new Map();
  let collectedStart = -1;
  items.forEach((item, itemIndex) => {
    if (item.category === 'collected') {
      if (collectedStart < 0) collectedStart = itemIndex;
      return;
    }
    for (const token of searchTokens(item.searchText)) {
      const matches = index.get(token) || [];
      matches.push(itemIndex);
      index.set(token, matches);
    }
  });
  if (collectedStart < 0 || !cachedCollectedIndex) return index;
  const offset = collectedStart;
  for (const [token, itemIndexes] of cachedCollectedIndex) {
    const matches = index.get(token);
    const remapped = itemIndexes.map(itemIndex => itemIndex + offset);
    if (matches) matches.push(...remapped);
    else index.set(token, remapped);
  }
  return index;
}

function intersect(groups) {
  if (groups.length === 0) return new Set();
  return groups.slice(1).reduce((result, group) => new Set([...result].filter(itemIndex => group.has(itemIndex))), new Set(groups[0]));
}

function matchingIndexes(group, index) {
  const result = new Set();
  for (const term of group) {
    const termMatches = [...searchTokens(term)].map(part => new Set(index.get(part) || []));
    for (const itemIndex of intersect(termMatches)) result.add(itemIndex);
  }
  return result;
}

export function searchLibrary(items, query, index) {
  const groups = queryGroups(query);
  if (groups.length === 0) return items;
  const matches = groups.map(group => matchingIndexes(group, index));
  const strict = intersect(matches);
  const candidateIndexes = strict.size > 0
    ? strict
    : new Set(matches.flatMap(group => [...group]));

  let candidates = [...candidateIndexes];
  if (candidates.length > MAX_SCORED_CANDIDATES) {
    const queryText = String(query).toLowerCase();
    const direct = [];
    const rest = [];
    for (const itemIndex of candidates) {
      const text = String(items[itemIndex]?.searchText || '').toLowerCase();
      if (text.includes(queryText)) direct.push(itemIndex);
      else rest.push(itemIndex);
    }
    candidates = [...direct, ...rest].slice(0, MAX_SCORED_CANDIDATES);
  }

  return candidates
    .map(itemIndex => items[itemIndex])
    .map(item => {
      const text = String(item.searchText || '').toLowerCase();
      const title = String(item.title || '').toLowerCase();
      const prompt = String(item.prompt || '').toLowerCase();
      const description = String(item.description || '').toLowerCase();
      const score = groups.reduce((total, group) => {
        const matched = group.filter(term => text.includes(term.toLowerCase())).sort((a, b) => b.length - a.length)[0];
        if (!matched) return total;
        const term = matched.toLowerCase();
        return total + (prompt.includes(term) ? 12 : 0)
          + (title.includes(term) ? 8 : 0)
          + (description.includes(term) ? 2 : 0)
          + Math.min(matched.length, 6);
      }, 0);
      const directMatch = text.includes(String(query).toLowerCase());
      return { item, score: score + (directMatch ? 8 : 0) };
    })
    .sort((a, b) => b.score - a.score)
    .map(entry => entry.item);
}
