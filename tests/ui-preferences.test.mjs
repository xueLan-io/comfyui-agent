import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_UI_PREFERENCES, SOUND_STYLE_IDS, UI_THEME_IDS, normalizeUIPreferences } from '../src/ui-preferences.mjs';
import { PromptEnhanceTool } from '../src/agent/tools/prompt/enhance.mjs';

test('UI preferences normalize invalid values to safe ranges', () => {
  const result = normalizeUIPreferences({ language: 'fr-FR', theme: 'unknown', accent: 'red', contrast: 200, uiFontSize: 4, codeFontSize: 40 });
  assert.equal(result.language, DEFAULT_UI_PREFERENCES.language);
  assert.equal(result.theme, DEFAULT_UI_PREFERENCES.theme);
  assert.equal(result.accent, DEFAULT_UI_PREFERENCES.accent);
  assert.equal(result.contrast, 100);
  assert.equal(result.uiFontSize, 12);
  assert.equal(result.codeFontSize, 18);
});

test('UI preferences accept English language', () => {
  assert.equal(normalizeUIPreferences({ language: 'en-US' }).language, 'en-US');
});

test('UI preferences accept the extra theme palettes', () => {
  for (const theme of ['paper', 'mist', 'warm', 'navy']) assert.equal(normalizeUIPreferences({ theme }).theme, theme);
  assert.equal(UI_THEME_IDS.includes('light'), true);
});

test('UI preferences normalize notification and sound toggles', () => {
  const result = normalizeUIPreferences({ notifyOnComplete: 0, notifyOnFail: 'false', soundOnComplete: 1, soundStyle: 'alarm' });
  assert.equal(result.notifyOnComplete, false);
  assert.equal(result.notifyOnFail, true);
  assert.equal(result.soundOnComplete, true);
  assert.equal(result.soundStyle, DEFAULT_UI_PREFERENCES.soundStyle);
  for (const style of SOUND_STYLE_IDS) assert.equal(normalizeUIPreferences({ soundStyle: style }).soundStyle, style);
  assert.equal(normalizeUIPreferences({}).notifyOnComplete, DEFAULT_UI_PREFERENCES.notifyOnComplete);
});

test('prompt strategies include anime-specific workflows', () => {
  const ids = PromptEnhanceTool.getStrategies().map(item => item.id);
  assert.ok(ids.includes('anime-character'));
  assert.ok(ids.includes('anime-scene'));
  assert.ok(ids.includes('anime-polish'));
});
