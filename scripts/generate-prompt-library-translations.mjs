import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const extractedDir = new URL('prompts_collected/extracted/', root);
const sqlDir = new URL('prompts_collected/WeiLinPrompt/danbooru/2025_04_01/', root);
const tagsFile = new URL('prompts_collected/extracted/ALL_unique_tags.txt', root);
const outputFile = new URL('prompts_collected/extracted/ALL_tag_translations.tsv', root);
const metadataFile = new URL('prompts_collected/extracted/ALL_tag_metadata.tsv', root);

const translations = new Map();
const frequencies = new Map();
const categories = new Map();
const sources = new Map();
const sqlRowPattern = /VALUES \(\d+, '((?:''|[^'])*)', \d+, '((?:''|[^'])*)',/;

function addSource(tag, source) {
  if (!sources.has(tag)) sources.set(tag, new Set());
  sources.get(tag).add(source);
}

function setTranslation(tag, translation, source) {
  const normalizedTag = tag.trim();
  const normalizedTranslation = translation.trim();
  if (!normalizedTag || !normalizedTranslation) return;
  if (!translations.has(normalizedTag)) translations.set(normalizedTag, normalizedTranslation);
  addSource(normalizedTag, source);
}

function setCategory(tag, category, source) {
  const normalizedTag = tag.trim();
  const normalizedCategory = category.trim();
  if (!normalizedTag || !normalizedCategory) return;
  if (!categories.has(normalizedTag)) categories.set(normalizedTag, normalizedCategory);
  addSource(normalizedTag, source);
}

function readLines(name) {
  return readFileSync(new URL(name, extractedDir), 'utf8').split(/\r?\n/).filter(Boolean);
}

function readCurrentTranslations() {
  if (!existsSync(outputFile)) return;
  for (const line of readFileSync(outputFile, 'utf8').split(/\r?\n/)) {
    const [tag, translation] = line.split('\t', 2);
    if (tag && translation?.trim() && !translations.has(tag.trim())) translations.set(tag.trim(), translation.trim());
  }
}

function readDanbooruSql() {
  for (const name of readdirSync(sqlDir).filter(file => file.endsWith('.sql'))) {
    const sql = readFileSync(new URL(name, sqlDir), 'utf8');
    for (const line of sql.split(/\r?\n/)) {
      const match = line.match(sqlRowPattern);
      if (match) setTranslation(match[1].replaceAll("''", "'"), match[2].replaceAll("''", "'"), 'Danbooru SQL');
    }
  }
}

function readWeiLinTags() {
  for (const line of readLines('WeiLin_danbooru_tags.txt')) {
    const [tag, translation, count] = line.split('\t', 3);
    if (!tag) continue;
    if (translation) setTranslation(tag, translation, 'WeiLin 标签词典');
    if (/^\d+$/.test(count || '')) frequencies.set(tag.trim(), Number(count));
  }
}

function readCategorizedTags() {
  for (const line of readLines('danbooru_tags_all.txt')) {
    const [tag, category, translation] = line.split('\t', 3);
    if (!tag) continue;
    setCategory(tag, category || '', 'Danbooru 分类');
    setTranslation(tag, translation || '', 'Danbooru 分类');
  }

  for (const name of ['super_grimoire_tags.txt', 'super_grimoire_tags_single.txt']) {
    for (const line of readLines(name)) {
      const [tag, translation, category] = line.split('\t', 3);
      if (!tag) continue;
      setCategory(tag, category || '', 'Super Grimoire 分类');
      setTranslation(tag, translation || '', 'Super Grimoire 双语词典');
    }
  }
}

const fallbackTranslations = new Map([
  ['+ -', '加号与减号'],
  ['. .', '点号组合'],
  ['0 0', '数字零组合'],
  ['<o> <o>', '眼睛表情符号'],
  ['<|> <|>', '表情符号'],
  ['= =', '等号组合'],
  ['> <', '方向符号组合'],
  ['> @', '方向与符号组合'],
  ['^ ^', '抬头表情符号'],
  ['o o', '圆形符号组合'],
  ['| |', '竖线符号组合'],
  ['2.5d', '2.5D风格'],
  ['cgi', '计算机生成图像'],
  ['hdr', '高动态范围'],
  ['photoshop', 'Photoshop'],
  ['procreate', 'Procreate绘画'],
  ['s-curve', 'S形曲线构图'],
  ['stylegan', 'StyleGAN生成模型'],
]);

const categoryLabels = new Map([
  ['artistic-license', '艺术表现'],
  ['characters', '角色与作品'],
  ['human/actions', '人物动作'],
  ['human/body_ornament', '身体装饰'],
  ['human/breasts', '身体特征'],
  ['human/clothes', '服装'],
  ['human/directions', '方向与视线'],
  ['human/ears', '耳朵'],
  ['human/face', '面部特征'],
  ['human/hair', '发型'],
  ['human/head_ornament', '头部装饰'],
  ['human/humantype', '人物类型'],
  ['human/lowerbody', '下半身'],
  ['human/neck', '颈部'],
  ['human/quality', '画质'],
  ['human/shoesock', '鞋袜'],
  ['human/upperbody', '上半身'],
  ['humanities/buildings', '建筑'],
  ['humanities/cities', '城市'],
  ['humanities/indoors', '室内环境'],
  ['humanities/outdoors', '室外环境'],
  ['image-composition/articles', '画面元素'],
  ['image-composition/background', '背景'],
  ['image-composition/censorship', '画面遮挡'],
  ['image-composition/color', '色彩'],
  ['image-composition/composition', '构图'],
  ['image-composition/effects', '视觉效果'],
  ['image-composition/format', '画面格式'],
  ['image-composition/perspective', '透视与视角'],
  ['image-composition/style', '艺术风格'],
  ['items', '物品'],
  ['natural/flowers', '花卉植物'],
  ['natural/outdoors', '自然环境'],
  ['natural/sky', '天空天气'],
  ['restricted/r18-t1', '敏感分级'],
  ['restricted/r18-t2', '敏感分级'],
  ['inferred/actions', '人物动作'],
  ['inferred/background', '背景'],
  ['inferred/body', '身体特征'],
  ['inferred/characters', '角色与作品'],
  ['inferred/clothes', '服装'],
  ['inferred/composition', '构图与镜头'],
  ['inferred/face', '面部特征'],
  ['inferred/hair', '发型'],
  ['inferred/quality', '画质'],
  ['inferred/style', '艺术风格'],
  ['inferred/sensitive', '敏感分级'],
]);

const inferredCategoryRules = [
  [/\b(nsfw|explicit|r18|rating_explicit|sexual|sex|rape|censored)\b/i, 'inferred/sensitive'],
  [/(hair|bangs|braid|ponytail|pigtail|ahoge|afro|beard|mustache|sideburn)/i, 'inferred/hair'],
  [/(eye|eyes|pupil|sclera|eyelash|eyebrow|gaze|blush|mouth|lips|nose|smile|frown|expression|ahegao)/i, 'inferred/face'],
  [/(dress|shirt|skirt|pants|shorts|uniform|swimsuit|bikini|kimono|hanfu|robe|coat|jacket|hoodie|socks|stockings|tights|shoes|boots|gloves|bra|panties|underwear|apron|cape|cloak|scarf|necktie|collar)/i, 'inferred/clothes'],
  [/(breast|chest|abdomen|stomach|belly|navel|thigh|leg|foot|arm|hand|finger|tail|wing|shoulder)/i, 'inferred/body'],
  [/(pose|sitting|standing|walking|holding|carrying|looking|reaching|waving|running|dancing|fighting|eating|drinking|touching|kneeling|lying|leaning)/i, 'inferred/actions'],
  [/(background|outdoors|indoors|sky|scenery|landscape|close-up|portrait|full_body|upper_body|cowboy_shot|wide_shot|perspective|angle|view|camera)/i, 'inferred/composition'],
  [/(masterpiece|best_quality|highres|absurdres|detailed|quality|resolution|sharp_focus|8k|hdr|cgi)/i, 'inferred/quality'],
  [/(style|anime|realistic|photorealistic|watercolor|sketch|lineart|illustration|monochrome|cel_shading|lighting|palette|color)/i, 'inferred/style'],
];

function labelFor(category) {
  if (categoryLabels.has(category)) return categoryLabels.get(category);
  if (category.startsWith('humanities/food/')) return `食物 · ${category.slice('humanities/food/'.length)}`;
  return category ? category : '未分类';
}

function usageFor(category, tag) {
  if (category.startsWith('restricted/') || category === 'inferred/sensitive') return '仅用于本地敏感级别检索，不会自动发送或改写提示词';
  const label = labelFor(category);
  if (label !== '未分类') return `用于控制${label}相关画面内容`;
  if (tag.includes('_(') || tag.includes('(')) return '用于指定角色、作品或其他专名';
  return '用于描述生成画面的对象、属性或风格';
}

function inferCategory(tag) {
  const normalized = tag.replaceAll('_', ' ');
  for (const [pattern, category] of inferredCategoryRules) {
    if (pattern.test(normalized)) return category;
  }
  if (tag.includes('_(') || tag.includes('(')) return 'inferred/characters';
  return '';
}

function cleanField(value) {
  return String(value).replaceAll('\t', ' ').replaceAll(/\r?\n/g, ' ').trim();
}

readCurrentTranslations();
readDanbooruSql();
readWeiLinTags();
readCategorizedTags();

const tags = readFileSync(tagsFile, 'utf8')
  .split(/\r?\n/)
  .map(tag => tag.trim())
  .filter(Boolean);

for (const [tag, translation] of fallbackTranslations) setTranslation(tag, translation, '本地符号词典');
for (const tag of tags) {
  if (!categories.has(tag)) {
    const category = inferCategory(tag);
    if (category) setCategory(tag, category, '本地规则分类');
  }
}

const translationRows = tags.map(tag => `${tag}\t${cleanField(translations.get(tag) || '')}`);
const metadataRows = tags.map(tag => {
  const category = categories.get(tag) || '';
  const source = [...(sources.get(tag) || [])].sort().join(', ');
  return [
    tag,
    translations.get(tag) || '',
    labelFor(category),
    usageFor(category, tag),
    frequencies.get(tag) || 0,
    source || '收集标签',
  ].map(cleanField).join('\t');
});

writeFileSync(outputFile, `${translationRows.join('\n')}\n`);
writeFileSync(metadataFile, `${metadataRows.join('\n')}\n`);

const missing = tags.filter(tag => !translations.get(tag));
console.log(`Wrote ${tags.length} translations and metadata rows. Missing translations: ${missing.length}. Sources: ${translations.size}.`);
