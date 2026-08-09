import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const files = {
  context: await readFile(new URL('../src/contexts/AgentContext.jsx', import.meta.url), 'utf8'),
  panel: await readFile(new URL('../src/components/ChatPanel.jsx', import.meta.url), 'utf8'),
  library: await readFile(new URL('../src/components/PromptLibraryPage.jsx', import.meta.url), 'utf8'),
  directService: await readFile(new URL('../src/runtime/direct/direct-service.mjs', import.meta.url), 'utf8'),
  main: await readFile(new URL('../electron/main.mjs', import.meta.url), 'utf8'),
  preload: await readFile(new URL('../electron/preload.cjs', import.meta.url), 'utf8'),
};

test('chat actions expose explicit Answer, AI Generate, and Direct Generate choices', () => {
  assert.match(files.panel, /option value="answer">\{t\('answer'\)\}/);
  assert.match(files.panel, /option value="generate">\{t\('aiGenerate'\)\}/);
  assert.match(files.panel, /option value="direct">\{t\('directGenerate'\)\}/);
  assert.match(files.library, /t\('plCartNote'\)/);
  assert.match(files.library, /t\('plGenerateNow'\)/);
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

test('direct IPC uses DirectService with an immutable active session owner', () => {
  const start = files.main.indexOf("ipcMain.handle('direct:prepare'");
  const end = files.main.indexOf("ipcMain.handle('agent:send'", start);
  assert.ok(start >= 0 && end > start);
  const handlers = files.main.slice(start, end);
  assert.match(handlers, /DirectService|ensureDirectService/);
  assert.match(handlers, /GENERATION_OWNER_MISMATCH/);
  assert.doesNotMatch(handlers, /agent\.useSession\(/);
});

test('preload keeps chat, AI generation, and direct generation IPC separate', () => {
  assert.match(files.preload, /agentChat: .*ipcRenderer\.invoke\('agent:chat'/);
  assert.match(files.preload, /agentGenerate: .*ipcRenderer\.invoke\('agent:generate'/);
  assert.match(files.main, /executionOwner\(\{ projectId: turn\.projectId, sessionId: turn\.sessionId \}\)/);
  assert.match(files.context, /agent:turn wraps chat responses and generation previews/);
  assert.match(files.preload, /directPrepare: .*ipcRenderer\.invoke\('direct:prepare'/);
  assert.match(files.preload, /directRunPrepared: .*ipcRenderer\.invoke\('direct:run-prepared'/);
  assert.match(files.preload, /agentMonitorTask: .*ipcRenderer\.invoke\('agent:monitor-task'/);
  assert.match(files.preload, /agentListRequestStatus: .*ipcRenderer\.invoke\('agent:list-request-status'/);
});

test('task recovery monitors the remote prompt before archiving completed output', () => {
  assert.match(files.main, /ipcMain\.handle\('agent:monitor-task'/);
  assert.match(files.main, /ComfyUITool\.monitor\(promptId\)/);
  assert.match(files.main, /ComfyUITool\.recoverResult\(promptId, monitored\.history\)/);
  assert.match(files.context, /monitorRecoveryTask/);
});

test('chat IPC forwards attached media and intent to the Agent', () => {
  assert.match(files.main, /agent\.chat\(message, \{\s*workflowName,\s*workflowManifest,\s*media: controls\.media \|\| null,\s*intent: controls\.intent \|\| 'chat',\s*allowPolicyOverride: controls\.allowPolicyOverride === true,\s*\}\)/);
  assert.match(files.preload, /agentChat: .*workflowManifest, controls = \{\}/);
});

test('renderer reconciles persisted request state and reports duplicate submissions', () => {
  assert.match(files.context, /JSON\.stringify\(session\.messages \|\| \[\]\)/);
  assert.match(files.context, /registeredDirectRequestsRef\.current\.add\(data\.requestId\)/);
  assert.match(files.context, /agentListRequestStatus\(\{/);
  assert.match(files.context, /setStatus\(stopping \? 'stopping' : 'idle'\)/);
  assert.match(files.context, /请求正在处理中，请勿重复发送/);
  assert.match(files.directService, /signal\?\.aborted/);
});

test('agent event forwarding never assigns a request event to the current session by fallback', () => {
  assert.match(files.main, /projectId: data\?\.projectId \|\| task\?\.projectId \|\| ''/);
  assert.match(files.main, /sessionId: data\?\.sessionId \|\| task\?\.sessionId \|\| ''/);
  assert.doesNotMatch(files.main, /data\?\.projectId \|\| task\?\.projectId \|\| agent\?\.sessionManager\?\.activeProjectId/);
  assert.doesNotMatch(files.main, /data\?\.sessionId \|\| task\?\.sessionId \|\| agent\?\.sessionManager\?\.activeSessionId/);
});
