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
  assert.match(quick, /t\('floatVideoGeneration'\)/);
  assert.match(quick, /isMiniMaxH3Workflow\(workflowManifest\)/);
  assert.doesNotMatch(quick, /setGenerationPage\(\/minimax/);
  assert.doesNotMatch(quick, /视频生成<\/button>\n.*disabled=/);
  assert.match(presets, /target: 'preset'/);
  assert.match(prompts, /content: item\.prompt/);
  assert.match(quick, /tabRef\.current/);
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
  const actions = await source('src/components/GenerationActions.jsx');
  const record = await source('src/components/GenerationRecordCard.jsx');
  const assets = await source('src/components/AssetLibraryPage.jsx');
  const main = await source('electron/main.mjs');
  assert.match(actions, /const resultRefs = form\.saveResults \? record\.media \|\| \[\] : \[\]/);
  assert.match(assets, /positive: image\.positive \|\| prompt\.positive/);
  assert.match(main, /positive: result\.compiledPrompt\?\.positive \|\| result\.positive/);
  assert.match(main, /positive: edits\.positive \|\| preview\?\.positive/);
  assert.match(main, /writeFile\(assetRecipePath\(filePath\)/);
  assert.match(main, /unlink\(assetRecipePath\(filePath\)\)/);
  assert.doesNotMatch(actions, /satisfied|new_seed|output-feedback/);
  assert.match(record, /generation-details/);
  assert.match(record, /renderAspectRatio/);
  assert.match(record, /hasOutput && <GenerationActions record=\{record\}/);
  assert.match(record, /hasOutput = media\.length > 0 && \['completed', 'recovery'\]\.includes\(runtime\.phase\)/);
});

test('frontend keeps archived media renderable and session-scoped', async () => {
  const context = await source('src/contexts/AgentContext.jsx');
  const asset = await source('src/components/ImageAsset.jsx');
  const main = await source('electron/main.mjs');
  const session = await source('src/contexts/SessionContext.jsx');
  assert.match(context, /const all = \[\.\.\.images, \.\.\.videos, \.\.\.supplied\]/);
  assert.match(context, /task\.projectId === session\.activeProjectId[\s\S]*task\.sessionId === session\.activeSessionId/);
  assert.match(asset, /if \(image\?\.previewUrl\) return image\.previewUrl/);
  assert.match(main, /media: \[\.\.\.archived, \.\.\.archivedVideos\]/);
  assert.match(main, /mediaType: 'image'/);
  assert.match(session, /activationVersionRef/);
});

test('generation cards follow their user turn instead of globally sorting messages by timestamps', async () => {
  const panel = await source('src/components/ChatPanel.jsx');
  assert.match(panel, /const recordsByTurn = new Map\(\)/);
  assert.match(panel, /recordsByTurn\.get\(message\.turnId\)/);
  assert.doesNotMatch(panel, /return \[\.\.\.messageEntries, \.\.\.recordEntries\]\.sort/);
});

test('renderer failures have a visible fallback and Electron diagnostics', async () => {
  const entry = await source('src/main.jsx');
  const boundary = await source('src/components/RenderErrorBoundary.jsx');
  const preload = await source('electron/preload.cjs');
  const main = await source('electron/main.mjs');
  assert.match(entry, /RenderErrorBoundary/);
  assert.match(boundary, /componentDidCatch/);
  assert.match(boundary, /tr\('reload'\)/);
  assert.match(preload, /reportRendererError/);
  assert.match(main, /did-fail-load/);
  assert.match(main, /render-process-gone/);
  assert.match(main, /ipcMain\.on\('renderer:error'/);
});

test('floating generation consumes AgentContext state instead of a second task store', async () => {
  const quick = await source('src/components/QuickGenerateFloat.jsx');
  const context = await source('src/contexts/AgentContext.jsx');
  assert.match(quick, /generationResult\?\.media/);
  assert.match(quick, /generationProgress \|\| null/);
  assert.doesNotMatch(quick, /TASK_STORAGE_PREFIX/);
  assert.doesNotMatch(quick, /agentMonitorTask|monitorRecoveryTask/);
  assert.doesNotMatch(quick, /const \[task, setTask\]/);
  assert.match(context, /monitorRecoveryTask/);
});

test('floating direct generation reaches the main conversation and new sessions can be created while busy', async () => {
  const main = await source('electron/main.mjs');
  const agent = await source('src/contexts/AgentContext.jsx');
  const sessionManager = await source('src/agent/runtime/session-manager.mjs');
  const runtimeAgent = await source('src/agent/runtime/agent.mjs');
  assert.match(main, /channel === 'direct:status' \|\| channel === 'direct:progress'/);
  assert.match(main, /status: 'completed',[\s\S]*taskId,[\s\S]*result: archived/);
  assert.match(main, /agent\.createSession\(title, projectId, \{ activate \}\)/);
  assert.match(main, /GENERATION_OWNER_MISMATCH/);
  const directStart = main.indexOf("ipcMain.handle('direct:prepare'");
  const directEnd = main.indexOf("ipcMain.handle('direct:get-preview'", directStart);
  assert.ok(directStart >= 0 && directEnd > directStart);
  assert.doesNotMatch(main.slice(directStart, directEnd), /agent\.useSession\(/);
  assert.match(sessionManager, /async createSession\(title = '新会话', projectId = this\.activeProjectId, \{ activate = true \} = \{\}\)/);
  assert.match(runtimeAgent, /async createSession\(title, projectId, \{ activate = true \} = \{\}\)/);
  assert.match(agent, /directTaskId: taskId/);
});
