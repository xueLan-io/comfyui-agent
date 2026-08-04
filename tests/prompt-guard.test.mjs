import assert from 'node:assert/strict';
import test from 'node:test';
import {
  estimateTokens,
  dedupeTerms,
  fitToBudget,
  checkConflicts,
  checkConstraintPreservation,
  checkEditedPrompt,
  checkPromptStructure,
  hasTerm,
  applyGuard,
} from '../src/agent/optimizer/prompt-guard.mjs';

test('estimateTokens counts CJK chars as one token and latin words weighted', () => {
  assert.equal(estimateTokens('晴天'), 2);
  assert.equal(estimateTokens('a cat'), 3);
  assert.ok(estimateTokens('masterpiece, best quality, 1girl, red dress') > estimateTokens('a cat'));
});

test('dedupeTerms removes exact duplicate comma terms', () => {
  const result = dedupeTerms('masterpiece, best quality, masterpiece, 1girl');
  assert.equal(result.text, 'masterpiece, best quality, 1girl');
  assert.deepEqual(result.removed, ['masterpiece']);
});

test('dedupeTerms leaves narrative text untouched', () => {
  const result = dedupeTerms('A girl with red hair sits by a window');
  assert.equal(result.text, 'A girl with red hair sits by a window');
  assert.equal(result.removed.length, 0);
});

test('checkConflicts flags positive/negative contradictions', () => {
  const issues = checkConflicts({ positive: '晴天, 户外', negative: '雨天' });
  const contradiction = issues.find(issue => issue.detail.includes('雨天'));
  assert.ok(contradiction);
  assert.equal(contradiction.severity, 'medium');
});

test('checkConflicts flags shared positive/negative terms', () => {
  const issues = checkConflicts({ positive: '长发, 微笑, 精致', negative: '长发' });
  assert.ok(issues.some(issue => issue.type === 'conflict' && issue.severity === 'low'));
});

test('checkConflicts flags opposite terms inside positive alone', () => {
  const issues = checkConflicts({ positive: '白天, 夜晚' });
  assert.ok(issues.some(issue => issue.detail.includes('白天')));
});

test('checkConstraintPreservation reports missing user colors', () => {
  const issues = checkConstraintPreservation('戴红色帽子的女孩', { positive: 'a girl with a hat' });
  assert.ok(issues.some(issue => issue.detail.includes('红色')));
  assert.equal(issues.find(issue => issue.detail.includes('红色')).severity, 'medium');
});

test('checkConstraintPreservation accepts kept colors', () => {
  const issues = checkConstraintPreservation('戴红色帽子的女孩', { positive: 'a girl with a red hat' });
  assert.ok(!issues.some(issue => issue.detail.includes('红色')));
});

test('checkConstraintPreservation reports people count changes', () => {
  const issues = checkConstraintPreservation('两个人坐在长椅上', { positive: 'one person on a bench' });
  assert.ok(issues.some(issue => issue.detail.includes('人数')));
});

test('checkConstraintPreservation accepts kept count', () => {
  const issues = checkConstraintPreservation('两个人坐在长椅上', { positive: 'two people sitting on a bench' });
  assert.ok(!issues.some(issue => issue.detail.includes('人数')));
});

test('fitToBudget drops trailing tag terms', () => {
  const long = Array.from({ length: 30 }, (_, i) => `tag${i}`).join(', ');
  const result = fitToBudget(long, 20);
  assert.equal(result.truncated, true);
  assert.ok(estimateTokens(result.text) <= 20);
  assert.ok(result.text.startsWith('tag0'));
  assert.ok(result.dropped.length > 0);
});

test('fitToBudget drops trailing narrative sentences', () => {
  const text = '第一句是一个比较长的句子描述场景。第二句介绍人物动作。第三句补充镜头细节。';
  const result = fitToBudget(text, 10);
  assert.equal(result.truncated, true);
  assert.ok(estimateTokens(result.text) <= 10);
  assert.ok(result.text.startsWith('第一句'));
});

test('fitToBudget leaves short text unchanged', () => {
  const result = fitToBudget('a cat', 100);
  assert.equal(result.truncated, false);
  assert.equal(result.text, 'a cat');
});

test('applyGuard dedupes, checks constraints, and enforces budgets', () => {
  const compiled = {
    positive: '红色连衣裙, 1girl, 红色连衣裙, best quality, sunlit garden, cinematic lighting, ultra detailed, 8k, masterpiece, award winning, trending',
    negative: 'low quality, 红色连衣裙',
    mode: 'anime',
  };
  const result = applyGuard(compiled, {
    userPrompt: '一个穿红色连衣裙的女孩',
    budgets: { positiveTokens: 8 },
  });

  assert.equal(result.positive.split(', ').filter(term => term === '红色连衣裙').length, 1);
  assert.ok(result.issues.some(issue => issue.type === 'conflict' && issue.severity === 'low'));
  assert.equal(result.positiveTruncated, true);
  assert.ok(estimateTokens(result.positive) <= 8);
  assert.ok(result.positive.startsWith('红色连衣裙'));
});

test('applyGuard merges existing compiler issues', () => {
  const compiled = {
    positive: 'a girl',
    issues: [{ type: 'constraint', severity: 'high', detail: 'did not preserve identity' }],
  };
  const result = applyGuard(compiled, {});
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].severity, 'high');
});

test('hasTerm ignores compound CJK words that only contain the term', () => {
  assert.equal(hasTerm('白天鹅在湖面', '白天'), false);
  assert.equal(hasTerm('从白天到夜晚', '白天'), true);
  assert.equal(hasTerm('夜色中, 白天', '白天'), true);
});

test('hasTerm ignores suffix CJK color chars', () => {
  assert.equal(hasTerm('她的脸红红的', '红'), false);
  assert.equal(hasTerm('涂了口红', '红'), false);
  assert.equal(hasTerm('红头发少女', '红'), true);
});

test('hasTerm uses word boundaries for latin terms', () => {
  assert.equal(hasTerm('red ready reduce', 'red'), true);
  assert.equal(hasTerm('ready reduce', 'red'), false);
  assert.equal(hasTerm('a girl with a red hat', 'red'), true);
});

test('checkConflicts does not flag compounds containing conflict terms', () => {
  const issues = checkConflicts({ positive: '白天鹅在夜晚的水面, 一只白天鹅', negative: '' });
  assert.ok(!issues.some(issue => issue.detail.includes('白天')));
});

test('checkConstraintPreservation ignores non-color uses of color chars', () => {
  const issues = checkConstraintPreservation('戴红色帽子的女孩', { positive: '脸红红的口红女孩' });
  assert.ok(issues.some(issue => issue.detail.includes('红色')));
});

test('checkEditedPrompt flags conflicts introduced by edits', () => {
  const issues = checkEditedPrompt({ positive: '晴天, 室外野餐', negative: '雨天' });
  assert.ok(issues.some(issue => issue.type === 'conflict' && issue.detail.includes('雨天')));
});

test('checkEditedPrompt reports budget overruns without truncating', () => {
  const long = Array.from({ length: 30 }, (_, i) => `tag${i}`).join(', ');
  const issues = checkEditedPrompt({ positive: long, negative: 'ok' }, { budgets: { positiveTokens: 20 } });
  const budget = issues.find(issue => issue.type === 'budget' && issue.detail.includes('正向'));
  assert.ok(budget);
  assert.equal(budget.severity, 'medium');
});

test('checkPromptStructure flags missing subject, action, scene and style', () => {
  const issues = checkPromptStructure({ positive: 'golden hour lighting' });
  assert.equal(issues.length, 4);
  assert.ok(issues.every(issue => issue.type === 'structure' && issue.severity === 'low'));
  assert.deepEqual(issues.map(issue => issue.dimension), ['subject', 'action', 'scene', 'style']);
  for (const label of ['主体', '动作姿态', '场景', '风格']) {
    assert.ok(issues.some(issue => issue.detail.includes(label)), `expected a ${label} warning`);
  }
});

test('checkPromptStructure accepts a complete prompt', () => {
  const issues = checkPromptStructure({ positive: 'a girl standing in a café, anime illustration, cinematic lighting' });
  assert.equal(issues.length, 0);
});

test('checkPromptStructure accepts non-human subjects', () => {
  const issues = checkPromptStructure({ positive: 'a cat sitting on the floor, photograph' });
  assert.equal(issues.length, 0);
});

test('checkPromptStructure ignores empty prompts', () => {
  assert.deepEqual(checkPromptStructure({ negative: 'blurry' }), []);
  assert.deepEqual(checkPromptStructure({}), []);
});

test('checkEditedPrompt without budgets returns only conflicts', () => {
  const issues = checkEditedPrompt({ positive: 'a girl', negative: '' });
  assert.equal(issues.length, 0);
});
