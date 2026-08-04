export const DEFAULT_BUDGETS = { positiveTokens: 250, negativeTokens: 100 };

const CJK_RANGE = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/;
const CJK_RANGE_G = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g;

export function estimateTokens(text = '') {
  const value = String(text);
  const cjk = (value.match(CJK_RANGE_G) || []).length;
  const words = value.replace(CJK_RANGE_G, ' ').trim().split(/\s+/).filter(Boolean).length;
  return cjk + Math.ceil(words * 1.3);
}

function splitTerms(text) {
  return String(text || '').split(',').map(term => term.trim()).filter(Boolean);
}

function splitSegments(text) {
  const commaCount = (String(text).match(/,/g) || []).length;
  if (commaCount >= 4) return { segments: splitTerms(text), separator: ', ' };
  const sentences = String(text).match(/[^。．!！?？]+[。．!！?？]?/g);
  return { segments: (sentences || [String(text)]).map(s => s.trim()).filter(Boolean), separator: ' ' };
}

function trimByTokens(text, budget) {
  const parts = String(text).match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]|[^\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g) || [];
  let out = '';
  let tokens = 0;
  for (const part of parts) {
    const isCjk = CJK_RANGE.test(part) && part.length === 1;
    const partTokens = isCjk ? 1 : Math.ceil(part.split(/\s+/).filter(Boolean).length * 1.3);
    if (tokens + partTokens > budget) break;
    out += part;
    tokens += partTokens;
  }
  return out;
}

export function dedupeTerms(text) {
  if (!text) return { text: '', removed: [] };
  const terms = splitTerms(text);
  if (terms.length < 2) return { text: String(text), removed: [] };
  const seen = new Set();
  const kept = [];
  const removed = [];
  for (const term of terms) {
    const key = term.toLowerCase();
    if (seen.has(key)) {
      removed.push(term);
      continue;
    }
    seen.add(key);
    kept.push(term);
  }
  return { text: kept.join(', '), removed };
}

export function fitToBudget(text, budget) {
  if (!text || budget == null || budget <= 0) return { text: text || '', truncated: false, dropped: [] };
  if (estimateTokens(text) <= budget) return { text: String(text), truncated: false, dropped: [] };
  const { segments, separator } = splitSegments(text);
  const dropped = [];
  let remaining = segments;
  while (remaining.length > 1 && estimateTokens(remaining.join(separator)) > budget) {
    dropped.unshift(remaining.pop());
  }
  let joined = remaining.join(separator);
  if (estimateTokens(joined) > budget) {
    joined = trimByTokens(joined, budget);
    dropped.unshift('(truncated tail)');
  }
  return { text: joined, truncated: true, dropped };
}

const TERM_BLOCKLIST = {
  '白天': ['白天鹅'],
};

const CJK_BOUNDARY = '\\u4e00-\\u9fff\\u3040-\\u30ff\\uac00-\\ud7af';

export function hasTerm(text, term) {
  const value = String(text || '');
  if (!term) return false;
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (/^[a-z][a-z ]*$/i.test(term)) {
    return new RegExp(`\\b${escaped}\\b`, 'i').test(value);
  }
  if ([...term].length === 1) {
    return new RegExp(`(?<![${CJK_BOUNDARY}])${escaped}`).test(value);
  }
  for (const compound of TERM_BLOCKLIST[term] || []) {
    if (value.includes(compound)) return false;
  }
  return value.includes(term);
}

const CONFLICT_PAIRS = [
  ['白天', '夜晚'], ['白天', '黑夜'], ['白天', '晚上'], ['晴天', '雨天'], ['晴空', '暴雨'],
  ['室内', '室外'], ['室内', '户外'], ['明亮', '昏暗'], ['鲜艳', '灰暗'], ['清晰', '模糊'],
  ['睁眼', '闭眼'], ['微笑', '哭泣'], ['夏天', '冬天'], ['日出', '日落'], ['现代', '古代'],
  ['欢乐', '悲伤'], ['热闹', '空旷'], ['干净', '肮脏'], ['甜美', '阴沉'],
];

export function checkConflicts(compiled) {
  const issues = [];
  const positive = String(compiled?.positive || '');
  const negative = String(compiled?.negative || '');
  if (!positive) return issues;

  for (const [a, b] of CONFLICT_PAIRS) {
    if (hasTerm(positive, a) && hasTerm(positive, b)) {
      issues.push({ type: 'conflict', severity: 'medium', detail: `正向提示词同时包含冲突词："${a}"与"${b}"` });
    }
    if (negative && hasTerm(positive, a) && hasTerm(negative, b)) {
      issues.push({ type: 'conflict', severity: 'medium', detail: `正向提示词包含"${a}"，负向提示词却包含"${b}"` });
    }
  }

  if (negative) {
    for (const term of splitTerms(positive)) {
      if (term.length < 2) continue;
      if (negative.toLowerCase().includes(term.toLowerCase())) {
        issues.push({ type: 'conflict', severity: 'low', detail: `正负向提示词重复词条："${term}"` });
      }
    }
  }
  return issues;
}

const COLORS = [
  { term: '红色', char: '红', aliases: ['red'] },
  { term: '蓝色', char: '蓝', aliases: ['blue'] },
  { term: '绿色', char: '绿', aliases: ['green'] },
  { term: '黄色', char: '黄', aliases: ['yellow'] },
  { term: '白色', char: '白', aliases: ['white'] },
  { term: '黑色', char: '黑', aliases: ['black'] },
  { term: '紫色', char: '紫', aliases: ['purple', 'violet'] },
  { term: '粉色', char: '粉', aliases: ['pink'] },
  { term: '橙色', char: '橙', aliases: ['orange'] },
  { term: '棕色', char: '棕', aliases: ['brown'] },
  { term: '灰色', char: '灰', aliases: ['grey', 'gray'] },
  { term: '金色', char: '金', aliases: ['gold'] },
  { term: '银色', char: '银', aliases: ['silver'] },
  { term: '青色', char: '青', aliases: ['cyan', 'teal'] },
  { term: 'red', char: '', aliases: ['红'] },
  { term: 'blue', char: '', aliases: ['蓝'] },
  { term: 'green', char: '', aliases: ['绿'] },
  { term: 'yellow', char: '', aliases: ['黄'] },
  { term: 'white', char: '', aliases: ['白'] },
  { term: 'black', char: '', aliases: ['黑'] },
  { term: 'purple', char: '', aliases: ['紫'] },
  { term: 'pink', char: '', aliases: ['粉'] },
  { term: 'orange', char: '', aliases: ['橙'] },
  { term: 'brown', char: '', aliases: ['棕'] },
  { term: 'grey', char: '', aliases: ['灰'] },
  { term: 'gray', char: '', aliases: ['灰'] },
  { term: 'gold', char: '', aliases: ['金'] },
  { term: 'silver', char: '', aliases: ['银'] },
];

function hasColor(positive, color) {
  if (hasTerm(positive, color.term)) return true;
  if (color.char && hasTerm(positive, color.char)) return true;
  return (color.aliases || []).some(alias => hasTerm(positive, alias));
}

const COUNT_PATTERNS = [
  { user: /(?:两|二|2)\s*(?:个|位|名|人)/i, positive: /(?:两|二|2)(?:个|位|名|人)|two\s+(?:people|persons|men|women|girls|boys)/i },
  { user: /(?:三|3)\s*(?:个|位|名|人)/i, positive: /(?:三|3)(?:个|位|名|人)|three\s+/i },
  { user: /(?:四|4)\s*(?:个|位|名|人)/i, positive: /(?:四|4)(?:个|位|名|人)|four\s+/i },
  { user: /(?:五|5)\s*(?:个|位|名|人)/i, positive: /(?:五|5)(?:个|位|名|人)|five\s+/i },
  { user: /(?:六|6)\s*(?:个|位|名|人)/i, positive: /(?:六|6)(?:个|位|名|人)|six\s+/i },
  { user: /(?:一|1)\s*(?:个|位|名|人)/i, positive: /(?:一|1)(?:个|位|名|人|girl|woman|man)|one\s+(?:person|woman|man|girl|boy)/i },
  { user: /one\s+(?:person|woman|man|girl|boy)/i, positive: /one\s+(?:person|woman|man|girl|boy)|(?:一|1)(?:个|位|名|人|girl|woman|man)/i },
  { user: /two\s+(?:people|persons|men|women|girls|boys)/i, positive: /two\s+(?:people|persons|men|women|girls|boys)|(?:两|二|2)(?:个|位|名|人)/i },
  { user: /three\s+(?:people|persons|men|women|girls|boys)/i, positive: /three\s+(?:people|persons|men|women|girls|boys)|(?:三|3)(?:个|位|名|人)/i },
];

export function checkConstraintPreservation(userPrompt, compiled) {
  const issues = [];
  const user = String(userPrompt || '');
  const positive = String(compiled?.positive || '');
  if (!user || !positive) return issues;

  for (const color of COLORS) {
    if (!user.toLowerCase().includes(color.term)) continue;
    if (!hasColor(positive, color)) {
      issues.push({ type: 'constraint', severity: 'medium', detail: `用户指定的颜色未保留：${color.term}` });
    }
  }

  for (const pattern of COUNT_PATTERNS) {
    if (!pattern.user.test(user)) continue;
    if (!pattern.positive.test(positive)) {
      issues.push({ type: 'constraint', severity: 'medium', detail: `用户指定的人数可能发生变化：${user.match(pattern.user)[0].trim()}` });
    }
  }
  return issues;
}

export const STRUCTURE_LABELS = {
  subject: '主体',
  action: '动作姿态',
  scene: '场景',
  style: '风格',
};

const STRUCTURE_TERMS = {
  subject: ['person', 'people', 'character', 'woman', 'man', 'girl', 'boy', '1girl', '1boy', 'solo', 'cat', 'dog', 'bird', 'flower', 'tree', 'car', 'building', 'food', 'animal', '人物', '角色', '少女', '少年', '女性', '男性', '女孩', '男孩', '动物'],
  action: ['standing', 'sitting', 'lying', 'walking', 'running', 'holding', 'looking', 'posing', 'reaching', '姿势', '站立', '坐着', '行走', '姿态', '动作', '望向', '微笑'],
  scene: ['background', 'room', 'street', 'city', 'forest', 'beach', 'sea', 'field', 'interior', 'exterior', 'outdoors', 'night', 'indoor', 'café', 'floor', 'ground', '场景', '背景', '室内', '室外', '街道', '森林', '城市', '房间', '环境', '夜晚'],
  style: ['anime', 'manga', 'illustration', 'painting', 'photograph', 'photographic', 'cinematic', 'render', 'oil painting', 'watercolor', '画风', '风格', '动漫', '插画', '油画', '水彩', '摄影', '渲染'],
};

export function checkPromptStructure(compiled) {
  const issues = [];
  const positive = String(compiled?.positive || '');
  if (!positive) return issues;
  const value = positive.toLowerCase();
  for (const [dimension, terms] of Object.entries(STRUCTURE_TERMS)) {
    if (!terms.some(term => hasTerm(value, term))) {
      issues.push({
        type: 'structure',
        severity: 'low',
        dimension,
        detail: `提示词缺少${STRUCTURE_LABELS[dimension]}描述，生成结果可能偏离预期`,
      });
    }
  }
  return issues;
}

export function applyGuard(compiled, options = {}) {
  const { userPrompt, budgets } = options;
  if (!compiled?.positive) return compiled;
  const result = { ...compiled, issues: Array.isArray(compiled.issues) ? [...compiled.issues] : [] };

  const dedupedPositive = dedupeTerms(compiled.positive);
  if (dedupedPositive.text !== compiled.positive) result.positive = dedupedPositive.text;
  const dedupedNegative = dedupeTerms(compiled.negative);
  if (dedupedNegative.text !== compiled.negative) result.negative = dedupedNegative.text;

  result.issues.push(...checkConflicts(result));
  result.issues.push(...checkConstraintPreservation(userPrompt, result));

  if (budgets) {
    const positiveBudget = budgets.positiveTokens ?? DEFAULT_BUDGETS.positiveTokens;
    const negativeBudget = budgets.negativeTokens ?? DEFAULT_BUDGETS.negativeTokens;
    const fitPositive = fitToBudget(result.positive, positiveBudget);
    if (fitPositive.truncated) {
      result.positive = fitPositive.text;
      result.positiveTruncated = true;
      result.droppedPositive = fitPositive.dropped;
    }
    const fitNegative = fitToBudget(result.negative, negativeBudget);
    if (fitNegative.truncated) {
      result.negative = fitNegative.text;
      result.negativeTruncated = true;
      result.droppedNegative = fitNegative.dropped;
    }
  }
  return result;
}

export function checkEditedPrompt(compiled, options = {}) {
  const issues = [...checkConflicts(compiled)];
  const budgets = options.budgets;
  if (!budgets) return issues;
  const positiveTokens = budgets.positiveTokens ?? DEFAULT_BUDGETS.positiveTokens;
  const negativeTokens = budgets.negativeTokens ?? DEFAULT_BUDGETS.negativeTokens;
  if (compiled?.positive) {
    const positiveTokensUsed = estimateTokens(compiled.positive);
    if (positiveTokensUsed > positiveTokens) {
      issues.push({ type: 'budget', severity: 'medium', detail: `正向提示词约 ${positiveTokensUsed} tokens，超出预算 ${positiveTokens}` });
    }
  }
  if (compiled?.negative) {
    const negativeTokensUsed = estimateTokens(compiled.negative);
    if (negativeTokensUsed > negativeTokens) {
      issues.push({ type: 'budget', severity: 'medium', detail: `负向提示词约 ${negativeTokensUsed} tokens，超出预算 ${negativeTokens}` });
    }
  }
  return issues;
}
