import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_UI_PREFERENCES, normalizeUIPreferences } from '../src/ui-preferences.mjs';
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

test('prompt strategies include anime-specific workflows', () => {
  const ids = PromptEnhanceTool.getStrategies().map(item => item.id);
  assert.ok(ids.includes('anime-character'));
  assert.ok(ids.includes('anime-scene'));
  assert.ok(ids.includes('anime-polish'));
});
