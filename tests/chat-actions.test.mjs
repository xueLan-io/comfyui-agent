import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const files = {
  context: await readFile(new URL('../src/contexts/AgentContext.jsx', import.meta.url), 'utf8'),
  panel: await readFile(new URL('../src/components/ChatPanel.jsx', import.meta.url), 'utf8'),
  recordCard: await readFile(new URL('../src/components/GenerationRecordCard.jsx', import.meta.url), 'utf8'),
  library: await readFile(new URL('../src/components/PromptLibraryPage.jsx', import.meta.url), 'utf8'),
  directService: await readFile(new URL('../src/runtime/direct/direct-service.mjs', import.meta.url), 'utf8'),
  main: await readFile(new URL('../electron/main.mjs', import.meta.url), 'utf8'),
  preload: await readFile(new URL('../electron/preload.cjs', import.meta.url), 'utf8'),
  worker: await readFile(new URL('../electron/agent-worker.mjs', import.meta.url), 'utf8'),
  agent: await readFile(new URL('../src/agent/runtime/agent.mjs', import.meta.url), 'utf8'),
};

test('chat actions expose creative conversation, direct generation, and cloud generation choices', () => {
  assert.match(files.panel, /option value="creative">\{t\('creativeChat'\)\}/);
  assert.doesNotMatch(files.panel, /option value="generate">\{t\('aiGenerate'\)\}/);
  assert.match(files.panel, /option value="direct">\{t\('directGenerate'\)\}/);
  assert.match(files.library, /t\('plCartNote'\)/);
  assert.match(files.library, /t\('plGenerateNow'\)/);
  assert.match(files.recordCard, /generation-record/);
  assert.match(files.recordCard, /GenerationActions/);
  assert.match(files.context, /return submitTurn\(text, 'creative', options\)/);
  assert.doesNotMatch(files.context, /agentChat\(text, selectedFile, workflowManifest, \{ media \}\)/);
  assert.match(files.context, /agentGenerate\(text, selectedFile, undefined/);
  assert.match(files.context, /agentGenerate\(text, selectedFile, undefined, \{[\s\S]*workflowManifest,[\s\S]*media,/);
  assert.match(files.context, /directPrepare\(/);
  assert.match(files.context, /directRunPrepared\(/);
  assert.doesNotMatch(files.context, /agentSend\(/);
});

test('plan events only record executable plans and deduplicate replayed plans', () => {
  assert.match(files.context, /Array\.isArray\(steps\) && steps\.length > 0/);
  assert.match(files.context, /recordedPlanEventsRef\.current\.has\(planKey\)/);
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
  const end = files.main.indexOf("ipcMain.handle('agent:turn'", start);
  assert.ok(start >= 0 && end > start);
  const handlers = files.main.slice(start, end);
  assert.match(handlers, /DirectService|ensureDirectService/);
  assert.match(handlers, /GENERATION_OWNER_MISMATCH/);
  assert.doesNotMatch(handlers, /agent\.useSession\(/);
});

test('preload keeps unified turn, AI generation, and direct generation IPC separate', () => {
  assert.match(files.preload, /agentGenerate: .*ipcRenderer\.invoke\('agent:generate'/);
  assert.doesNotMatch(files.preload, /agentChat: .*ipcRenderer\.invoke\('agent:chat'/);
  assert.doesNotMatch(files.preload, /agentSend: .*ipcRenderer\.invoke\('agent:send'/);
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

test('unified turn chat branch forwards attached media and intent to the Agent', () => {
  assert.match(files.agent, /this\.chat\(text, \{ \.\.\.options, intent: decision\.intent, execution: decision\.execution, turnId, skipUserMessage: true \}\)/);
  assert.match(files.preload, /agentHandleTurn: \(turn = \{\}\) => ipcRenderer\.invoke\('agent:turn', turn\)/);
});

test('renderer reconciles persisted request state and reports duplicate submissions', () => {
  assert.match(files.context, /JSON\.stringify\(session\.messages \|\| \[\]\)/);
  assert.match(files.context, /registeredDirectRequestsRef\.current\.add\(data\.requestId\)/);
  assert.match(files.context, /agentListRequestStatus\(\{/);
  assert.match(files.context, /transitionGeneration\(stopping \? PHASE_STOPPING : PHASE_IDLE, [\s\S]{0,60}status: stopping \? 'stopping' : 'idle'/);
  assert.match(files.context, /请求正在处理中，请勿重复发送/);
  assert.match(files.directService, /signal\?\.aborted/);
});

test('agent event forwarding never assigns a request event to the current session by fallback', () => {
  assert.match(files.main, /projectId: data\?\.projectId \|\| task\?\.projectId \|\| ''/);
  assert.match(files.main, /sessionId: data\?\.sessionId \|\| task\?\.sessionId \|\| ''/);
  assert.doesNotMatch(files.main, /data\?\.projectId \|\| task\?\.projectId \|\| agent\?\.sessionManager\?\.activeProjectId/);
  assert.doesNotMatch(files.main, /data\?\.sessionId \|\| task\?\.sessionId \|\| agent\?\.sessionManager\?\.activeSessionId/);
});

test('chat execution events with the current turn can establish task ownership', () => {
  assert.match(files.context, /if \(!canClaimTask \|\| \(activeTurnIdRef\.current && data\.turnId !== activeTurnIdRef\.current\)\) return false/);
  assert.match(files.context, /onAgentProgress\(data => \{\s*if \(!isCurrentAgentEvent\(data, \{ canClaimTask: data\.scope === 'timing' \}\)\) return;/);
  assert.match(files.context, /onAgentStep\(data => \{[\s\S]*isCurrentAgentEvent\(data, \{ canClaimTask: true \}\)/);
  assert.match(files.context, /onAgentToolCall\(data => \{[\s\S]*isCurrentAgentEvent\(data, \{ canClaimTask: true \}\)/);
  assert.match(files.context, /onAgentToolResult\(data => \{[\s\S]*isCurrentAgentEvent\(data, \{ canClaimTask: true \}\)/);
  assert.match(files.context, /onAgentMessage\(data => \{\s*if \(!isCurrentAgentEvent\(data, \{ canClaimTask: true \}\)\) return;/);
  assert.match(files.context, /const terminal = \['completed', 'failed', 'error', 'cancelled', 'abandoned'\]\.includes\(data\.status\)/);
});

test('streaming deltas avoid complete worker snapshots and UI keeps visible wait feedback', () => {
  assert.match(files.worker, /if \(!\(eventType === 'agent:message' && data\.streaming && !data\.done\)\) publishState\(\);/);
  assert.match(files.panel, /模型正在生成，已等待 \$\{waitSeconds\} 秒/);
  assert.match(files.context, /setGenerationProgress\(null\);\s*transitionGeneration\(PHASE_RUNNING, \{ status: 'running', statusMsg: '正在回复\.\.\.' \}\)/);
});

test('creative chat is the unified AI entry point and ignores stale RPC replies', () => {
  assert.match(files.context, /const submitTurn = useCallback\(async \(text, modeHint = 'creative', options = \{\}\) =>/);
  assert.match(files.context, /return submitTurn\(text, 'creative', options\)/);
  assert.match(files.context, /generationToken !== generationTokenRef\.current \|\| activeTurnIdRef\.current !== turnId/);
  assert.match(files.main, /modeHint: turn\.modeHint === 'generate' \? 'generate' : 'creative'/);
});

test('direct completion preserves archived prompt metadata when top-level fields are absent', () => {
  assert.match(files.main, /positive: archived\.compiledPrompt\?\.positive \|\| archived\.positive/);
  assert.match(files.main, /negative: archived\.compiledPrompt\?\.negative \|\| archived\.negative/);
  assert.match(files.main, /workflowName: archived\.workflowName \|\| archived\.workflow\?\.name/);
  assert.match(files.main, /parameters: preview\?\.settings \|\| archived\.parameters \|\| archived\.settings/);
  assert.match(files.context, /result\.positive \|\| result\.compiledPrompt\?\.positive/);
  assert.match(files.context, /result\.negative \|\| result\.compiledPrompt\?\.negative/);
  assert.match(files.context, /result\.workflowName \|\| result\.workflow\?\.name/);
  assert.match(files.context, /firstNonEmptyObject\(data\.parameters, result\.parameters, result\.settings/);
});

test('creative chat creates a generation record only after the user confirms execution', () => {
  assert.doesNotMatch(files.context, /const requestId = turnId;\s*activeTurnIdRef\.current = turnId;\s*activeDirectRequestIdRef\.current = turnId;\s*upsertRecord/);
  assert.match(files.context, /const recordRequestId = preview\.requestId \|\| preview\.executionContext\?\.turnId \|\| activeTurnIdRef\.current;[\s\S]*?upsertRecord\(recordRequestId, \{ turnId: recordTurnId/);
  assert.doesNotMatch(files.context, /payload\?\.action === 'generate' && payload\.preview[\s\S]{0,800}upsertRecord/);
  assert.doesNotMatch(files.context, /payload\?\.action === 'prepare'[\s\S]{0,800}upsertRecord/);
  assert.match(files.context, /if \(!generationRecordsRef\.current\[requestId\]\) return;/);
});

test('streamed reasoning is surfaced as thinking plan events and cleared on first content', () => {
  assert.match(files.agent, /emit\(AgentEventTypes\.PLAN, \{ stage: 'thinking', partial: '正在思考…', taskId, traceId, turnId: options\.turnId \|\| '' \}\);/);
  assert.match(files.agent, /onReasoningStart: \(\) => \{\s*thinkingBuffer = '';\s*emit\(AgentEventTypes\.PLAN, \{ stage: 'thinking', partial: '正在思考…', taskId, traceId, turnId: options\.turnId \|\| '' \}\);/);
  assert.match(files.agent, /onReasoningText: text => \{\s*thinkingBuffer \+= text;\s*emit\(AgentEventTypes\.PLAN, \{ stage: 'thinking', partial: thinkingBuffer\.slice\(-1500\), taskId, traceId, turnId: options\.turnId \|\| '' \}\);/);
  assert.match(files.agent, /if \(!contentStarted\) \{\s*contentStarted = true;\s*emit\(AgentEventTypes\.PLAN, \{ stage: 'complete', taskId, traceId, turnId: options\.turnId \|\| '' \}\);/);
  assert.match(files.agent, /emit\(AgentEventTypes\.PLAN, \{ stage: 'error', taskId, traceId \}\);/);
  assert.match(files.panel, /thinking\.slice\(-600\)/);
  assert.match(files.context, /onAgentPlan\(data => \{[\s\S]*isCurrentAgentEvent\(data, \{ canClaimTask: true \}\)/);
});
