import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const files = {
  context: await readFile(new URL('../src/contexts/AgentContext.jsx', import.meta.url), 'utf8'),
  panel: await readFile(new URL('../src/components/ChatPanel.jsx', import.meta.url), 'utf8'),
  library: await readFile(new URL('../src/components/PromptLibraryPage.jsx', import.meta.url), 'utf8'),
  main: await readFile(new URL('../electron/main.mjs', import.meta.url), 'utf8'),
  preload: await readFile(new URL('../electron/preload.cjs', import.meta.url), 'utf8'),
};

test('chat actions expose explicit Answer, AI Generate, and Direct Generate choices', () => {
  assert.match(files.panel, /option value="answer">回答/);
  assert.match(files.panel, /option value="generate">AI 生成/);
  assert.match(files.panel, /option value="direct">直接生成/);
  assert.match(files.library, /这里写的内容会原样用于生成/);
  assert.match(files.library, /直接生成/);
  assert.match(files.panel, /output-source/);
  assert.match(files.context, /return submitTurn\(text, action === 'generate' \? 'generate' : 'answer'\)/);
  assert.doesNotMatch(files.context, /agentChat\(text, selectedFile, workflowManifest, \{ media \}\)/);
  assert.match(files.context, /agentGenerate\(text, selectedFile, undefined/);
  assert.match(files.context, /agentGenerate\(text, selectedFile, undefined, \{[\s\S]*workflowManifest,[\s\S]*media,/);
  assert.match(files.context, /directPrepare\(/);
  assert.match(files.context, /directRunPrepared\(/);
  assert.doesNotMatch(files.context, /agentSend\(/);
});

test('AI generation IPC enters Agent prepareGeneration directly', () => {
  const start = files.main.indexOf("ipcMain.handle('agent:generate'");
  const end = files.main.indexOf("ipcMain.handle('direct:prepare'", start);
  assert.ok(start >= 0 && end > start);
  const handler = files.main.slice(start, end);
  assert.match(handler, /agent\.prepareGeneration\(/);
  assert.doesNotMatch(handler, /routeIntent\(/);
});

test('direct IPC does not initialize or call the Agent runtime', () => {
  const start = files.main.indexOf("ipcMain.handle('direct:prepare'");
  const end = files.main.indexOf("ipcMain.handle('agent:send'", start);
  assert.ok(start >= 0 && end > start);
  const handlers = files.main.slice(start, end);
  assert.doesNotMatch(handlers, /initAgent\(/);
  assert.match(handlers, /DirectService|ensureDirectService/);
});

test('preload keeps chat, AI generation, and direct generation IPC separate', () => {
  assert.match(files.preload, /agentChat: .*ipcRenderer\.invoke\('agent:chat'/);
  assert.match(files.preload, /agentGenerate: .*ipcRenderer\.invoke\('agent:generate'/);
  assert.match(files.preload, /directPrepare: .*ipcRenderer\.invoke\('direct:prepare'/);
  assert.match(files.preload, /directRunPrepared: .*ipcRenderer\.invoke\('direct:run-prepared'/);
});

test('chat IPC forwards attached media and intent to the Agent', () => {
  assert.match(files.main, /agent\.chat\(message, \{ workflowName, workflowManifest, media: controls\.media \|\| null, intent: controls\.intent \|\| 'chat' \}\)/);
  assert.match(files.preload, /agentChat: .*workflowManifest, controls = \{\}/);
});
