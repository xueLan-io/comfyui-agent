import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), 'utf8');
}

test('library generation executes in place without a view switch or timer', async () => {
  const app = await source('src/App.jsx');
  const context = await source('src/contexts/AgentContext.jsx');
  assert.match(app, /pendingLibraryGenerationRef/);
  assert.match(app, /onReady=\{handleChatReady\}/);
  assert.match(app, /queueLibraryGeneration/);
  assert.match(app, /onGenerate=\{\(text, negative\) => queueLibraryGeneration\(text, negative, \{ immediate: true \}\)\}/);
  assert.match(context, /origin: 'prompt_library',[\s\S]*autoConfirm: options\.immediate === true/);
  assert.match(context, /quickGenerate: overrides\.quickGenerate === true \|\| overrides\.autoConfirm === true/);
  assert.doesNotMatch(app, /setActiveView\('chat'\); return runLibraryGeneration/);
  assert.doesNotMatch(app, /onGenerate=[\s\S]*setTimeout\(resolve, 0\)/);
});

test('drag payloads preserve preset and phrase semantics', async () => {
  const presets = await source('src/components/PresetLibraryPage.jsx');
  const prompts = await source('src/components/PromptLibraryPage.jsx');
  const quick = await source('src/components/QuickGenerateFloat.jsx');
  assert.match(quick, /quick-generate-pages/);
  assert.match(quick, /quick-generation-editor/);
  assert.match(quick, /视频生成/);
  assert.match(quick, /isMiniMaxH3Workflow\(workflowManifest\)/);
  assert.doesNotMatch(quick, /setGenerationPage\(\/minimax/);
  assert.doesNotMatch(quick, /视频生成<\/button>\n.*disabled=/);
  assert.match(presets, /target: 'preset'/);
  assert.match(prompts, /content: item\.prompt/);
  assert.match(quick, /tabRef\.current/);
  assert.match(quick, /restored\.phase === 'complete'/);
  assert.match(quick, /payload\.content \|\| payload\.positive/);
});

test('floating movement and cross-window drag use cancellation tokens', async () => {
  const main = await source('electron/main.mjs');
  const preload = await source('electron/preload.cjs');
  const cardDrag = await source('src/components/useFloatingCardDrag.jsx');
  assert.match(main, /token !== floatingWindowPointerGrab\.token/);
  assert.match(main, /floatingMoveToken \+= 1/);
  assert.match(preload, /floatingMoveAt: \(clientX, clientY, token\)/);
  assert.match(cardDrag, /floatingDragCancel\?\.\(drag\.dragId\)/);
});

test('preset saving uses current media and persisted asset recipes', async () => {
  const chat = await source('src/components/ChatPanel.jsx');
  const assets = await source('src/components/AssetLibraryPage.jsx');
  const main = await source('electron/main.mjs');
  assert.match(chat, /const resultRefs = form\.saveResults \? media : \[\]/);
  assert.match(assets, /positive: image\.positive \|\| prompt\.positive/);
  assert.match(main, /positive: result\.compiledPrompt\?\.positive \|\| result\.positive/);
  assert.match(main, /positive: edits\.positive \|\| preview\?\.positive/);
});
