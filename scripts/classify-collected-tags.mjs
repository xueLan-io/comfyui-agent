#!/usr/bin/env node
// 把 ALL_tag_metadata.tsv 中 group=未分类 的标签分派到现有原始标签组。
//
//   node scripts/classify-collected-tags.mjs            确定性分类并改写 TSV
//   node scripts/classify-collected-tags.mjs --llm      对残留调用 LM Studio 精分类
//   node scripts/classify-collected-tags.mjs --sample 12
//   node scripts/classify-collected-tags.mjs --dry-run  只预览不改写
//   node scripts/classify-collected-tags.mjs --report path
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const METADATA = fileURLToPath(new URL('../prompts_collected/extracted/ALL_tag_metadata.tsv', import.meta.url));
const TRANSLATIONS = fileURLToPath(new URL('../prompts_collected/extracted/ALL_tag_translations.tsv', import.meta.url));
const DANBOORU_TAGS = fileURLToPath(new URL('../prompts_collected/extracted/danbooru_tags_all.txt', import.meta.url));
const DEFAULT_REPORT = fileURLToPath(new URL('../artifacts/tag-classification-report.json', import.meta.url));
const RESIDUAL_FILE = fileURLToPath(new URL('../artifacts/classification-residual.json', import.meta.url));
const LLM_STATE_FILE = fileURLToPath(new URL('../artifacts/classification-llm-state.json', import.meta.url));

const UNCLASSIFIED = '未分类';
const SYMBOL_GROUP = '符号/特殊标签';
const CHARACTER_GROUP = '角色与作品';

const DANBOORU_CATEGORY_MAP = {
  'human/actions': '人物动作',
  'human/face': '面部特征',
  'human/clothes': '服装',
  'human/breasts': '身体特征',
  'human/hair': '发型',
  'human/head_ornament': '头部装饰',
  'human/lowerbody': '下半身',
  'human/humantype': '人物类型',
  'human/upperbody': '上半身',
  'human/shoesock': '鞋袜',
  'human/neck': '颈部',
  'human/ears': '耳朵',
  'human/directions': '方向与视线',
  'human/body_ornament': '身体装饰',
  'human/quality': '画质',
  'natural/flowers': '花卉植物',
  'natural/outdoors': '自然环境',
  'natural/sky': '天空天气',
  'humanities/food/sweets': '食物 · sweets',
  'humanities/food/meal': '食物 · meal',
  'humanities/food/fruit': '食物 · fruit',
  'humanities/food/vegetable': '食物 · vegetable',
  'humanities/food/breads': '食物 · breads',
  'humanities/food/drink': '食物 · drink',
  'humanities/food/meat': '食物 · meat',
  'humanities/food/dairy': '食物 · dairy',
  'humanities/food/condiments': '食物 · condiments',
  'humanities/buildings': '建筑',
  'humanities/outdoors': '室外环境',
  'humanities/indoors': '室内环境',
  'humanities/cities': '城市',
  characters: '角色与作品',
  items: '物品',
  'image-composition/format': '画面格式',
  'image-composition/style': '艺术风格',
  'image-composition/composition': '构图',
  'image-composition/effects': '视觉效果',
  'image-composition/censorship': '敏感分级',
  'image-composition/color': '色彩',
  'image-composition/perspective': '透视与视角',
  'image-composition/background': '背景',
  'image-composition/articles': '构图与镜头',
  'restricted/r18-t1': '敏感分级',
  'restricted/r18-t2': '敏感分级',
  'artistic-license': '艺术风格',
};

function parseArgs(argv) {
  const flags = {
    llm: false,
    sample: 0,
    dryRun: false,
    report: DEFAULT_REPORT,
    baseUrl: 'http://127.0.0.1:1234',
    model: null,
    batchSize: 150,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--llm') flags.llm = true;
    else if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--sample') flags.sample = Number.parseInt(argv[++i], 10) || 0;
    else if (arg === '--report') flags.report = argv[++i];
    else if (arg === '--base-url') flags.baseUrl = argv[++i];
    else if (arg === '--model') flags.model = argv[++i];
    else if (arg === '--batch-size') flags.batchSize = Number.parseInt(argv[++i], 10) || 150;
  }
  return flags;
}

function splitLines(raw) {
  return raw.split(/\r?\n/).filter(line => line.length > 0);
}

function englishTokens(tag) {
  return tag.toLowerCase().split(/[^a-z0-9]+/).filter(token => /^[a-z0-9]{2,}$/.test(token));
}

function cjkFeatures(text) {
  const chars = (text || '').match(/[\u4e00-\u9fff]/g) || [];
  const features = [...chars];
  for (let i = 0; i + 1 < chars.length; i++) features.push(chars[i] + chars[i + 1]);
  return features;
}

function tagFeatures(tag, translation) {
  return [...englishTokens(tag), ...cjkFeatures(translation)];
}

const SYMBOL_ONLY = /^[!?+.&%#@*=|~^<>()/\\';:\[\]{},_0-9\s]+$/;
function isSymbolTag(tag) {
  const t = tag.trim();
  if (SYMBOL_ONLY.test(t)) return true;
  if (/^\d{4}$/.test(t)) return true;
  if (t.length <= 8 && /[a-z]/i.test(t) && !/[a-z]{3,}/i.test(t)) {
    const symbols = (t.match(/[!?+<>@;:/\\^=_*]/g) || []).length;
    const digitsLetters = (t.match(/[a-z0-9]/gi) || []).length;
    if (symbols >= 2 && symbols >= digitsLetters) return true;
  }
  return false;
}

function isCharacterName(tag, translation) {
  if (tag.includes('(') || tag.includes('[')) return true;
  const tr = translation || '';
  return /[\u4e00-\u9fff]/.test(tr) && /[a-z]/i.test(tr) && tr.includes('-');
}

function buildClassifier(classifiedRows) {
  const tokenGroupCount = new Map();
  const tokenTotal = new Map();
  for (const row of classifiedRows) {
    const features = tagFeatures(row.tag, row.translation);
    for (const feature of features) {
      tokenTotal.set(feature, (tokenTotal.get(feature) || 0) + 1);
      if (!tokenGroupCount.has(feature)) tokenGroupCount.set(feature, new Map());
      const counts = tokenGroupCount.get(feature);
      counts.set(row.group, (counts.get(row.group) || 0) + 1);
    }
  }
  const MIN_TOKEN_TOTAL = 3;
  const clean = new Map();
  for (const [feature, counts] of tokenGroupCount) {
    if (tokenTotal.get(feature) < MIN_TOKEN_TOTAL) continue;
    clean.set(feature, counts);
  }
  return clean;
}

function scoreTag(features, classifier) {
  const scores = new Map();
  let recognized = 0;
  for (const feature of features) {
    const counts = classifier.get(feature);
    if (!counts) continue;
    const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
    recognized += 1;
    for (const [group, count] of counts) {
      const p = count / total;
      scores.set(group, (scores.get(group) || 0) + Math.log1p(p));
    }
  }
  if (recognized === 0) return { group: null, score: 0, margin: 0 };
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const topScore = ranked[0][1];
  const secondScore = ranked.length > 1 ? ranked[1][1] : 0;
  return { group: ranked[0][0], score: topScore, margin: topScore - secondScore };
}

function classify(tag, translation, classifier, danbooruCategory) {
  if (isSymbolTag(tag)) return SYMBOL_GROUP;
  if (danbooruCategory && DANBOORU_CATEGORY_MAP[danbooruCategory]) return DANBOORU_CATEGORY_MAP[danbooruCategory];
  if (isCharacterName(tag, translation)) return CHARACTER_GROUP;
  const result = scoreTag(tagFeatures(tag, translation), classifier);
  if (result.group && result.score >= 0.35 && result.margin >= 0.15) return result.group;
  return null;
}

function readTsv(path) {
  const raw = readFileSync(path, 'utf8');
  const bom = raw.startsWith('\ufeff') ? '\ufeff' : '';
  const body = bom ? raw.slice(1) : raw;
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const parts = body.split(/\r?\n/);
  let trailingNewline = '';
  if (parts[parts.length - 1] === '') {
    trailingNewline = eol;
    parts.pop();
  }
  return { bom, eol, parts, trailingNewline };
}

function writeTsv(path, { bom, eol, parts, trailingNewline }) {
  writeFileSync(path, bom + parts.join(eol) + trailingNewline, 'utf8');
}

function loadTranslations() {
  const map = new Map();
  for (const line of splitLines(readFileSync(TRANSLATIONS, 'utf8'))) {
    const separator = line.indexOf('\t');
    if (separator > 0) map.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return map;
}

function loadDanbooruCategories() {
  const map = new Map();
  for (const line of splitLines(readFileSync(DANBOORU_TAGS, 'utf8'))) {
    const parts = line.split('\t', 3);
    if (parts.length >= 2) {
      const key = parts[0].trim().replaceAll('_', ' ');
      if (!map.has(key)) map.set(key, parts[1].trim());
    }
  }
  return map;
}

function seededRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x100000000;
  };
}

function sampleForReview(rows, count, groups) {
  const random = seededRandom(20260803);
  const result = {};
  for (const group of groups) {
    const members = rows.filter(row => row.group === group);
    const picked = [];
    const seen = new Set();
    let guard = 0;
    while (picked.length < Math.min(count, members.length) && guard++ < members.length * 3) {
      const item = members[Math.floor(random() * members.length)];
      if (seen.has(item.tag)) continue;
      seen.add(item.tag);
      picked.push(item);
    }
    if (picked.length > 0) result[group] = picked.map(row => ({ tag: row.tag, translation: row.translation }));
  }
  return result;
}

async function llmClassifyResidual(residual, flags, groupList) {
  const { baseUrl, model } = flags;
  let modelId = model;
  if (!modelId) {
    try {
      const res = await fetch(`${baseUrl}/v1/models`);
      const data = await res.json();
      const candidates = (data.data || []).map(item => item.id);
      modelId = candidates.find(id => /qwen/i.test(id)) || candidates[0];
    } catch (error) {
      console.error(`无法连接 LM Studio (${baseUrl}): ${error.message}`);
      return residual.map(row => ({ ...row, group: null }));
    }
  }
  if (!modelId) {
    console.error('未找到可用模型，请用 --model 指定。');
    return residual.map(row => ({ ...row, group: null }));
  }

  const systemPrompt = [
    '你是标签分类器。把每个提示词标签归入且只归入一个类别，类别只能从下面列表选择：',
    groupList.join('、'),
    '优先按标签的英文含义，再参考给出的中文释义。角色名、系列名、作品名归入「角色与作品」；标点、表情符号、纯年份归入「符号/特殊标签」；确实无法归入任何类别的标为「未分类」。',
    '只输出一个 JSON 对象，键是标签原文，值是类别名，不要输出其它内容。',
  ].join('\n');

  const assigned = new Map();
  let cursor = 0;
  let done = 0;
  const statePath = LLM_STATE_FILE;
  const saved = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null;
  if (saved && saved.baseUrl === baseUrl && saved.modelId === modelId && saved.residualLength === residual.length) {
    for (const [tag, group] of Object.entries(saved.assigned)) {
      if (group) assigned.set(tag, group);
    }
    done = saved.done;
    console.log(`续跑：已完成 ${done}/${residual.length}`);
  }

  const remaining = residual.slice(done);
  for (let offset = 0; offset < remaining.length; offset += flags.batchSize) {
    const batch = remaining.slice(offset, offset + flags.batchSize);
    const tagList = batch.map(row => `${row.tag}${row.translation ? `（${row.translation}）` : ''}`).join('\n');
    const userPrompt = `请给以下标签分类：\n${tagList}`;
    let parsed = null;
    for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
      try {
        const res = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: modelId,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            temperature: 0,
            max_tokens: 16384,
            thinking: false,
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const content = data.choices?.[0]?.message?.content || '';
        const jsonText = content.replace(/```json\s*/i, '').replace(/```/g, '').trim();
        const jsonStart = jsonText.indexOf('{');
        const jsonEnd = jsonText.lastIndexOf('}');
        if (jsonStart >= 0 && jsonEnd > jsonStart) {
          parsed = JSON.parse(jsonText.slice(jsonStart, jsonEnd + 1));
        }
      } catch (error) {
        if (attempt === 1) console.error(`批次解析失败：${error.message}`);
      }
    }
    if (parsed) {
      const normalized = {};
      for (const [key, value] of Object.entries(parsed)) {
        const clean = key.replace(/（.*$/s, '').trim();
        if (clean) normalized[clean] = value;
      }
      for (const row of batch) {
        const group = normalized[row.tag];
        if (group && groupList.includes(group)) assigned.set(row.tag, group);
      }
    }
    done += batch.length;
    const next = { baseUrl, modelId, residualLength: residual.length, done, assigned: Object.fromEntries(assigned) };
    writeFileSync(statePath, JSON.stringify(next), 'utf8');
    console.log(`LLM 已处理 ${done}/${residual.length}`);
  }

  return residual.map(row => ({ ...row, group: assigned.get(row.tag) || null }));
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  mainAsync(flags).catch(error => {
    console.error(error);
    process.exit(1);
  });
}

async function mainAsync(flags) {
  const translations = loadTranslations();
  const danbooru = loadDanbooruCategories();

  const { bom, eol, parts, trailingNewline } = readTsv(METADATA);
  const rows = [];
  const lineIndexByTag = new Map();
  for (let i = 0; i < parts.length; i++) {
    const fields = parts[i].split('\t', 6);
    const tag = fields[0]?.trim() || '';
    if (!tag) continue;
    rows.push({ tag, translation: fields[1]?.trim() || translations.get(tag) || '', group: fields[2]?.trim() || UNCLASSIFIED });
    lineIndexByTag.set(tag, i);
  }

  const classified = rows.filter(row => row.group !== UNCLASSIFIED);
  const classifier = buildClassifier(classified);

  const unclassified = rows.filter(row => row.group === UNCLASSIFIED);
  const groupSet = new Set(classified.map(row => row.group));

  for (const row of unclassified) {
    const danbooruCategory = danbooru.get(row.tag.replaceAll('_', ' '));
    const group = classify(row.tag, row.translation, classifier, danbooruCategory);
    if (group) {
      row.group = group;
      groupSet.add(group);
    }
  }

  const residual = unclassified.filter(row => row.group === UNCLASSIFIED);
  if (flags.llm) {
    const groupList = [...groupSet, SYMBOL_GROUP, UNCLASSIFIED];
    const llmRows = await llmClassifyResidual(residual, flags, groupList);
    const llmByTag = new Map(llmRows.map(row => [row.tag, row.group]));
    for (const row of unclassified) {
      if (row.group === UNCLASSIFIED) row.group = llmByTag.get(row.tag) || UNCLASSIFIED;
    }
  }

  const counts = new Map();
  for (const row of rows) counts.set(row.group, (counts.get(row.group) || 0) + 1);

  if (!flags.dryRun) {
    for (const row of rows) {
      const index = lineIndexByTag.get(row.tag);
      const fields = parts[index].split('\t', 6);
      fields[2] = row.group;
      parts[index] = fields.join('\t');
    }
    writeTsv(METADATA, { bom, eol, parts, trailingNewline });
  }

  const summary = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`总行数 ${rows.length}，标签组 ${counts.size}，未分类 ${counts.get(UNCLASSIFIED) || 0}`);
  if (!flags.dryRun) console.log(`已改写 ${METADATA}`);

  const report = {
    generatedAt: new Date().toISOString(),
    total: rows.length,
    unclassifiedRemaining: counts.get(UNCLASSIFIED) || 0,
    groupCounts: Object.fromEntries(summary),
    residual: residual.map(row => ({ tag: row.tag, translation: row.translation })),
  };
  if (flags.sample > 0) report.samples = sampleForReview(rows, flags.sample, [...groupSet]);
  writeFileSync(flags.report, JSON.stringify(report, null, 2), 'utf8');
  console.log(`报告已写入 ${flags.report}`);

  if (flags.sample > 0) {
    for (const [group, items] of Object.entries(report.samples)) {
      console.log(`\n[${group}]`);
      for (const item of items) console.log(`  ${item.tag}  |  ${item.translation}`);
    }
  }
}

main();
