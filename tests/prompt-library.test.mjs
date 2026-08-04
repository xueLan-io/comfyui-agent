import test from 'node:test';
import assert from 'node:assert/strict';
import { ANIME_PROMPT_PACKS, ANIME_VISIBLE_PROMPT } from '../src/components/prompt-library-anime.mjs';
import { createPhraseItems, createTagItems, parseTagMetadata, parseTagTranslations } from '../src/components/prompt-library-collected.mjs';
import { buildSearchIndex, matchesSearchText, randomSearchGuideTerms, SEARCH_GUIDE_TERMS, searchLibrary } from '../src/components/prompt-library-search.mjs';
import { PROMPT_LIBRARY_ITEMS } from '../src/components/prompt-library-data.mjs';
import { createCollectedTaxonomyGroups, matchesPromptTaxonomy, PROMPT_LIBRARY_TAXONOMY } from '../src/components/prompt-library-taxonomy.mjs';

test('anime prompt packs expose the sample prompt coverage', () => {
  const prompt = ANIME_VISIBLE_PROMPT.toLowerCase();
  const missing = ANIME_PROMPT_PACKS.flatMap(pack => pack.required.filter(token => !prompt.includes(token.toLowerCase())));
  assert.deepEqual(missing, []);
});

test('anime prompt packs have stable ids and non-empty prompt text', () => {
  const ids = ANIME_PROMPT_PACKS.map(pack => pack.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const pack of ANIME_PROMPT_PACKS) {
    assert.ok(pack.title);
    assert.ok(pack.category);
    assert.ok(pack.prompt);
  }
});

test('default visible packs do not include the minor-specific loli tag', () => {
  assert.equal(/\bloli\b/i.test(ANIME_VISIBLE_PROMPT), false);
});

test('collected tags expose local Chinese descriptions', () => {
  const translations = parseTagTranslations('loli\t萝莉\nlong_hair\t长发');
  const [loli] = createTagItems('loli\nlong_hair', translations);

  assert.equal(loli.title, 'loli');
  assert.equal(loli.description, '萝莉');
  assert.equal(loli.prompt, 'loli');
  assert.equal(loli.translation, loli.description);
  assert.match(loli.searchText, /萝莉/);
});

test('collected tags expose local usage metadata and search it', () => {
  const translations = parseTagTranslations('blue_eyes\t蓝眼睛');
  const metadata = parseTagMetadata('blue_eyes\t蓝眼睛\t眼睛\t用于控制眼睛相关画面内容\t123\t本地词典');
  const [item] = createTagItems('blue_eyes', translations, metadata);

  assert.equal(item.tagGroup, '眼睛');
  assert.equal(item.usage, '用于控制眼睛相关画面内容');
  assert.equal(item.sourceCount, 123);
  assert.match(item.searchText, /眼睛相关画面内容/);
});

test('a non-empty query searches base and collected items together', () => {
  const baseItems = [{ category: 'character-role', title: '角色', description: '基础词条', prompt: 'character' }];
  const collectedItems = createTagItems('loli', parseTagTranslations('loli\t萝莉'));
  const items = [...baseItems, ...collectedItems];
  const query = 'loli';
  const results = items.filter(item => (item.searchText ?? `${item.title}\n${item.description}\n${item.prompt}`).toLowerCase().includes(query));

  assert.deepEqual(results.map(item => item.prompt), ['loli']);
});

test('Chinese intent searches matching English prompt terms', () => {
  const items = [
    { title: 'Red hair', description: 'Appearance', prompt: 'red hair, long hair', searchText: 'red hair long hair' },
    { title: 'Blue eyes', description: 'Appearance', prompt: 'blue eyes', searchText: 'blue eyes appearance' },
  ];
  const results = searchLibrary(items, '红发', buildSearchIndex(items));

  assert.deepEqual(results.map(item => item.prompt), ['red hair, long hair']);
});
test('search guide terms are shuffled without duplicates', () => {
  const terms = randomSearchGuideTerms(4, () => 0);

  assert.equal(terms.length, 4);
  assert.equal(new Set(terms.map(term => term.query)).size, 4);
  assert.notDeepEqual(
    terms.map(term => term.query),
    SEARCH_GUIDE_TERMS.slice(0, 4).map(term => term.query),
  );
});

test('search falls back to related results when all requested terms do not co-occur', () => {
  const items = [
    { title: 'Red hair', description: 'Appearance', prompt: 'red hair', searchText: 'red hair appearance' },
    { title: 'Maid outfit', description: 'Clothing', prompt: 'maid outfit', searchText: 'maid outfit clothing' },
  ];
  const results = searchLibrary(items, '红发 女仆装', buildSearchIndex(items));

  assert.deepEqual(results.map(item => item.prompt), ['red hair', 'maid outfit']);
});

test('combined aliases keep the non-alias query terms', () => {
  const items = [
    { title: 'Red hair', description: 'Appearance', prompt: 'red hair', searchText: 'red hair appearance' },
    { title: 'Night scene', description: 'Environment', prompt: 'night scene', searchText: 'night scene environment' },
  ];
  assert.deepEqual(searchLibrary(items, '红发 夜景', buildSearchIndex(items)).map(item => item.prompt), ['red hair', 'night scene']);
});

test('prompt matches rank above descriptive-only matches', () => {
  const items = [
    { title: 'Hair styling', description: 'red hair reference', prompt: 'portrait', searchText: 'hair styling red hair reference portrait' },
    { title: 'Red hair', description: 'Appearance', prompt: 'red hair', searchText: 'red hair appearance red hair' },
  ];
  assert.equal(searchLibrary(items, 'red hair', buildSearchIndex(items))[0].prompt, 'red hair');
});

test('Chinese search matches translated text and longer category names', () => {
  const items = [
    { title: '短发', description: '发型与发色', prompt: 'short hair', searchText: '短发\n发型与发色\nshort hair' },
    { title: '胸部结构', description: '人物身体特征', prompt: 'chest', searchText: '胸部结构\n人物身体特征\nchest' },
  ];

  assert.deepEqual(searchLibrary(items, '发型', buildSearchIndex(items)).map(item => item.prompt), ['short hair']);
  assert.equal(matchesSearchText('胸部\n胸部、胸口、锁骨', '胸部'), true);
});

test('character taxonomy exposes direct fine-grained browse paths', () => {
  const character = PROMPT_LIBRARY_TAXONOMY.find(group => group.id === 'character');
  assert.ok(character);
  assert.ok(character.children.some(group => group.id === 'clothing-upper'));
  assert.ok(character.children.some(group => group.id === 'ear-decoration'));
  assert.ok(character.children.some(group => group.id === 'character-action'));

  const upper = character.children.find(group => group.id === 'clothing-upper');
  assert.equal(matchesPromptTaxonomy({ id: 'clothing-tailored-suit', category: 'character-clothing' }, upper), true);
  assert.equal(matchesPromptTaxonomy({ id: 'clothing-jeans', category: 'character-clothing' }, upper), false);
});

test('non-character browse groups expose fine-grained taxonomy paths', () => {
  const expected = {
    'action-expression': ['expression', 'action-pose', 'action-hands', 'action-gaze'],
    composition: ['composition-framing', 'composition-angle', 'composition-layout', 'composition-format'],
    scene: ['scene-interior', 'scene-outdoor', 'scene-city', 'scene-time-weather', 'scene-elements'],
    lighting: ['lighting-source', 'lighting-time', 'lighting-color', 'lighting-effects'],
    style: ['style-medium', 'style-school', 'style-anime-photo', 'style-render'],
    quality: ['quality-clarity', 'quality-texture', 'quality-depth', 'quality-defects'],
  };

  for (const [groupId, childIds] of Object.entries(expected)) {
    const group = PROMPT_LIBRARY_TAXONOMY.find(item => item.id === groupId);
    assert.deepEqual(group?.children?.map(child => child.id), childIds);
  }

  const composition = PROMPT_LIBRARY_TAXONOMY.find(group => group.id === 'composition');
  assert.equal(matchesPromptTaxonomy({ id: 'composition-closeup', category: 'composition', title: '近距离特写', description: '放大主体表情和材质' }, composition.children.find(child => child.id === 'composition-framing')), true);
  const scene = PROMPT_LIBRARY_TAXONOMY.find(group => group.id === 'scene');
  assert.equal(matchesPromptTaxonomy({ category: 'collected', tagGroup: '室内环境', searchText: 'interior room' }, scene.children.find(child => child.id === 'scene-interior')), true);
});

test('normal body concepts keep a direct path and searchable aliases', () => {
  const chest = PROMPT_LIBRARY_ITEMS.find(item => item.id === 'build-chest');
  const character = PROMPT_LIBRARY_TAXONOMY.find(group => group.id === 'character');
  const chestGroup = character.children.find(group => group.id === 'character-chest');

  assert.ok(chest);
  assert.deepEqual(chest.aliases, ['胸口', '上半身', 'bust']);
  assert.equal(matchesPromptTaxonomy(chest, chestGroup), true);
  assert.equal(character.children.some(group => group.id === 'suit'), false);
});

test('collected phrase items are distinguishable from tags', () => {
  const [phrase] = createPhraseItems("soft portrait, '柔和肖像',");

  assert.equal(phrase.kind, 'phrase');
});

test('collected phrase items do not inflate tag group counts', () => {
  const items = [
    { id: 'a', category: 'collected', kind: 'tag', tagGroup: '上半身' },
    { id: 'b', category: 'collected', kind: 'phrase' },
  ];
  const groups = createCollectedTaxonomyGroups(items);
  assert.deepEqual(groups.map(group => [group.label, group.count]), [['上半身', 1]]);
});

test('collected metadata groups become browsable taxonomy nodes', () => {
  const items = [
    { id: 'a', category: 'collected', tagGroup: '上半身' },
    { id: 'b', category: 'collected', tagGroup: '上半身' },
    { id: 'c', category: 'collected', tagGroup: '耳朵' },
  ];
  const groups = createCollectedTaxonomyGroups(items);
  assert.deepEqual(groups.map(group => [group.label, group.count]), [['上半身', 2], ['耳朵', 1]]);
  assert.equal(matchesPromptTaxonomy(items[0], groups[0]), true);
  assert.equal(matchesPromptTaxonomy(items[2], groups[0]), false);
});

test('every browse-group child shows a distinct non-empty curated subset', () => {
  const groupIds = ['action-expression', 'composition', 'scene', 'lighting', 'style', 'quality'];
  for (const groupId of groupIds) {
    const group = PROMPT_LIBRARY_TAXONOMY.find(item => item.id === groupId);
    const sets = group.children.map(child => new Set(PROMPT_LIBRARY_ITEMS.filter(item => matchesPromptTaxonomy(item, child)).map(item => item.id)));
    for (let i = 0; i < sets.length; i++) {
      assert.ok(sets[i].size > 0, `${group.children[i].id} should not be empty`);
      for (let j = i + 1; j < sets.length; j++) {
        assert.notDeepEqual([...sets[i]].sort(), [...sets[j]].sort(), `${group.children[i].id} vs ${group.children[j].id} must differ`);
      }
    }
  }
});

test('non-character secondary categories route curated items by Chinese tags', () => {
  const child = id => PROMPT_LIBRARY_TAXONOMY.flatMap(group => group.children || []).find(node => node.id === id);
  const cases = [
    [{ id: 'composition-closeup', category: 'composition', title: '近距离特写', description: '放大主体表情和材质' }, 'composition-framing', 'composition-angle'],
    [{ id: 'composition-wide', category: 'composition', title: '宽幅场景', description: '展示主体与空间关系' }, 'composition-framing', 'composition-format'],
    [{ id: 'composition-lowangle', category: 'composition', title: '低角度镜头', description: '加强力量感和视觉冲击' }, 'composition-angle', 'composition-layout'],
    [{ id: 'environment-forest', category: 'environment', title: '雾中森林', description: '安静、神秘的自然场景' }, 'scene-outdoor', 'scene-interior'],
    [{ id: 'environment-library', category: 'environment', title: '古典图书馆', description: '适合知识和神秘叙事' }, 'scene-interior', 'scene-outdoor'],
    [{ id: 'subject-vehicle', category: 'subject', title: '交通工具', description: '突出车辆轮廓与设计' }, 'scene-elements', 'scene-city'],
    [{ id: 'lighting-golden', category: 'lighting', title: '黄金时刻', description: '温暖的日落电影感' }, 'lighting-time', 'lighting-source'],
    [{ id: 'lighting-spotlight', category: 'lighting', title: '聚光灯', description: '把注意力集中到主体' }, 'lighting-source', 'lighting-color'],
    [{ id: 'style-watercolor', category: 'style', title: '水彩画', description: '保留纸张和流动笔触' }, 'style-medium', 'style-school'],
    [{ id: 'style-pixel', category: 'style', title: '像素艺术', description: '适合复古游戏和图标' }, 'style-render', 'style-medium'],
    [{ id: 'detail-sharp', category: 'detail', title: '清晰主体', description: '让主体边缘更明确' }, 'quality-clarity', 'quality-texture'],
    [{ id: 'detail-skin', category: 'detail', title: '皮肤质感', description: '避免塑料感并保留自然细节' }, 'quality-texture', 'quality-clarity'],
    [{ id: 'pose-standing', category: 'character-pose', title: '自然站立', description: '基础姿势词块' }, 'action-pose', 'action-hands'],
    [{ id: 'action-reading', category: 'character-action', title: '阅读书籍', description: '人物动作词块' }, 'action-hands', 'action-pose'],
    [{ id: 'pose-looking-back', category: 'character-pose', title: '回头看', description: '姿势词块' }, 'action-gaze', 'action-pose'],
  ];
  for (const [item, yes, no] of cases) {
    assert.equal(matchesPromptTaxonomy(item, child(yes)), true, `${item.id} should match ${yes}`);
    assert.equal(matchesPromptTaxonomy(item, child(no)), false, `${item.id} should not match ${no}`);
  }
});
