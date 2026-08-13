import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhraseItems, createTagItem, parseTagMetadata } from '../src/components/prompt-library-collected.mjs';
import {
  COLLECTED_PHRASES_SEGMENT,
  COLLECTED_SEGMENTS,
  COLLECTED_TAG_GROUPS,
  COLLECTED_TOTAL_TAGS,
} from '../src/components/prompt-library-segments/index.mjs';

test('segment registry totals match the generated segment counts', () => {
  const tagSegments = COLLECTED_SEGMENTS.filter(segment => segment.id !== COLLECTED_PHRASES_SEGMENT);
  assert.equal(tagSegments.reduce((sum, segment) => sum + segment.count, 0), COLLECTED_TOTAL_TAGS);

  const byId = new Map(COLLECTED_SEGMENTS.map(segment => [segment.id, segment]));
  for (const [tagGroup, info] of Object.entries(COLLECTED_TAG_GROUPS)) {
    assert.ok(info.count > 0, `group ${tagGroup} should have a positive count`);
    for (const segmentId of info.segments) {
      const segment = byId.get(segmentId);
      assert.ok(segment, `group ${tagGroup} references missing segment ${segmentId}`);
      assert.ok(segment.groups.includes(tagGroup), `segment ${segmentId} should claim group ${tagGroup}`);
    }
  }
});

test('every generated segment is reachable from the registry', () => {
  const byId = new Map(COLLECTED_SEGMENTS.map(segment => [segment.id, segment]));
  for (const segment of COLLECTED_SEGMENTS) {
    if (segment.id === COLLECTED_PHRASES_SEGMENT) continue;
    assert.ok(segment.groups.length > 0, `segment ${segment.id} should belong to a group`);
    for (const group of segment.groups) {
      assert.ok(COLLECTED_TAG_GROUPS[group]?.segments.includes(segment.id), `group ${group} should reference ${segment.id}`);
    }
  }
  assert.ok(byId.has(COLLECTED_PHRASES_SEGMENT));
});

test('a sample segment parses into stable tag items', async () => {
  const sample = COLLECTED_SEGMENTS.find(segment => segment.id === 'seg-000');
  const { default: text } = await import(`../src/components/prompt-library-segments/${sample.id}.mjs`);
  const details = parseTagMetadata(text);
  const items = [...details.keys()].map(tag => createTagItem(tag, new Map(), details));

  assert.equal(items.length, sample.count);
  assert.equal(new Set(items.map(item => item.id)).size, items.length);
  assert.match(items[0].id, /^collected-tag:/);
});

test('every tag segment keeps a stable id derived from its tag', async () => {
  for (const segment of COLLECTED_SEGMENTS.filter(item => item.id !== COLLECTED_PHRASES_SEGMENT).slice(0, 3)) {
    const { default: text } = await import(`../src/components/prompt-library-segments/${segment.id}.mjs`);
    const details = parseTagMetadata(text);
    const first = [...details.keys()][0];
    const item = createTagItem(first, new Map(), details);
    assert.equal(item.id, `collected-tag:${first}`);
  }
});

test('the phrase segment parses into the expected number of phrase items', async () => {
  const { default: text } = await import(`../src/components/prompt-library-segments/${COLLECTED_PHRASES_SEGMENT}.mjs`);
  const items = createPhraseItems(text);
  const expected = COLLECTED_SEGMENTS.find(segment => segment.id === COLLECTED_PHRASES_SEGMENT).count;

  assert.equal(items.length, expected);
  assert.ok(items.every(item => item.kind === 'phrase'));
  assert.equal(new Set(items.map(item => item.id)).size, items.length);
});

test('the phrase segment is marked with a phrases kind in the registry', () => {
  const phraseSegment = COLLECTED_SEGMENTS.find(segment => segment.id === COLLECTED_PHRASES_SEGMENT);
  assert.equal(phraseSegment.kind, 'phrases');
});

test('phrase items strip the trailing metadata tail from real records', async () => {
  const sample = [
    "zoo', '动物圆', 'rgba(159, 32, 240, .4)', 1736580446, '067eaa6f-2c3a-7b91-8013-e2868a60182e",
    "((((colorful bubble))))', '彩色泡泡', 'rgba(31, 144, 255, .4)', 1736580446, '067eaa6f-2c3a-7b91-8007-637e45b77c69",
  ];
  const items = createPhraseItems(sample.join('\n'));

  assert.equal(items[0].prompt, 'zoo');
  assert.equal(items[0].title, '动物圆');
  assert.doesNotMatch(items[0].searchText, /rgba|1736580446|067eaa6f/);
  assert.equal(items[1].prompt, '((((colorful bubble))))');
  assert.equal(items[1].title, '彩色泡泡');
});

test('clean phrase records without a metadata tail still parse', () => {
  const [item] = createPhraseItems("soft portrait, '柔和肖像',");
  assert.equal(item.kind, 'phrase');
  assert.equal(item.prompt, 'soft portrait');
  assert.equal(item.title, '柔和肖像');
});