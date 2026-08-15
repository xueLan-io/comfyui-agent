import { Agent, AgentEventTypes, ComfyUITool, configureSkills, on } from '../src/agent/index.mjs';
import { ComfyUIClient } from '../src/agent/tools/comfyui/client.mjs';
import { LongTermMemory } from '../src/agent/memory/long-term.mjs';
import { createGovernanceContext } from '../src/runtime/governance/context.mjs';
import { createAuditEvent } from '../src/runtime/governance/audit-events.mjs';
import { createPluginRegistry } from '../src/runtime/plugins/plugin-registry.mjs';
import { loadPluginsFromDirectory } from '../src/runtime/plugins/plugin-loader.mjs';
import { createToolRegistry } from '../src/agent/tools/registry.mjs';
import { AGENT_TOOL_MODULES } from '../src/agent/runtime/agent-tools.mjs';
import { JSONFileStore } from '../src/agent/memory/store.mjs';
import { join } from 'node:path';

const EVENT_TYPES = Object.values(AgentEventTypes);
const parentPort = process.parentPort || null;

const READ_ONLY_METHODS = new Set([
  'listTasks',
  'getArtifacts',
  'detectWorkflow',
  'listQueue',
  'session.getProject',
  'session.getTrace',
  'session.getState',
  'session.getConversation',
  'task.get',
]);

const agentMethods = new Set([
  'init',
  'prepareGeneration',
  'prepareFileMutation',
  'prepareWithWorkflow',
  'runPrepared',
  'discardPrepared',
  'routeIntent',
  'clarify',
  'chat',
  'handleTurn',
  'suggestSessionTitle',
  'cancel',
  'listQueue',
  'cancelPrompt',
  'clearQueue',
  'clearConversation',
  'recordConversationMessage',
  'rewindConversation',
  'listTasks',
  'getArtifacts',
  'detectWorkflow',
  'recordArtifact',
  'recordFeedback',
  'createProject',
  'deleteProject',
  'createSession',
  'deleteSession',
  'useSession',
  'recoverTasks',
]);

let agent;
let memory;
let callQueue = Promise.resolve();
let workerContext;
let pluginRegistry;
let pluginPrefs;
let pluginErrors = [];
let toolRegistry;

function send(message) {
  if (parentPort) {
    try { parentPort.postMessage(message); } catch {}
    return;
  }
  if (!process.connected) return;
  try { process.send(message); } catch {}
}

function sendAndWait(message) {
  if (parentPort) {
    try { parentPort.postMessage(message); } catch {}
    return new Promise(resolve => setImmediate(resolve));
  }
  if (!process.connected) return Promise.resolve();
  return new Promise(resolve => {
    try { process.send(message, () => resolve()); } catch { resolve(); }
  });
}

function runCall(message) {
  return invoke(message.method, message.args || [])
    .then(result => send({ type: 'response', id: message.id, ok: true, result, state: snapshot() }))
    .catch(error => send({
      type: 'response',
      id: message.id,
      ok: false,
      error: error.message,
      code: error.code || '',
      policyDecision: error.code === 'CLOUD_POLICY_BLOCKED' ? error.policyDecision || null : null,
      stack: error.stack,
      state: snapshot(),
    }));
}

function snapshot() {
  if (!agent) return null;
  const state = agent.sessionManager.getState();
  return {
    workflowDir: agent.workflowDir,
    isRunning: agent.isRunning,
    state: agent.state,
    taskId: agent.taskId,
    sessionManager: state,
    projectMemory: agent.project.toJSON(),
    tasks: agent.listTasks(50),
  };
}

function publishState() {
  send({ type: 'state', state: snapshot() });
}

function wireEvents() {
  for (const eventType of EVENT_TYPES) {
    on(eventType, data => {
      if (['agent:step', 'agent:tool-call', 'agent:tool-result', 'agent:error', 'agent:plan'].includes(eventType)) {
        agent.sessionManager.appendExecutionEvent({ ...data, type: eventType });
      }
      // Streaming deltas can arrive dozens of times per second. Their event
      // carries all renderer state needed for incremental rendering, so avoid
      // cloning and IPC-sending the complete session/task snapshot per token.
      if (!(eventType === 'agent:message' && data.streaming && !data.done)) publishState();
      send({ type: 'event', eventType, data });
    });
  }
}

async function invoke(method, args = []) {
  if (!workerContext) throw Object.assign(new Error('Worker governance context is not initialized'), { code: 'AUTHENTICATION_REQUIRED' });
  const sideEffect = !READ_ONLY_METHODS.has(method);
  const audit = createAuditEvent({ ...workerContext, action: `worker.${method}`, decision: 'allow', reason: sideEffect ? 'worker_dispatch' : 'read', data: { sideEffect } });
  if (sideEffect) send({ type: 'audit', event: audit });
  if (agentMethods.has(method)) return agent[method](...args);
  if (method === 'session.getProject') return agent.sessionManager.getProject(args[0]);
  if (method === 'session.getTrace') return agent.getTrace(args[0]);
  if (method === 'session.getState') return agent.sessionManager.getState();
  if (method === 'session.getConversation') return agent.conversation.toJSON();
  if (method === 'session.renameProject') return agent.sessionManager.renameProject(...args);
  if (method === 'session.renameSession') return agent.sessionManager.renameSession(...args);
  if (method === 'session.setState') {
    agent.sessionManager.setSessionState(args[0] || {});
    return agent.sessionManager.getSessionState();
  }
  if (method === 'session.appendExecutionEvent') {
    return agent.sessionManager.appendExecutionEvent(args[0] || {});
  }
  if (method === 'session.upsertGenerationRecord') {
    return agent.sessionManager.upsertGenerationRecord(args[0] || {});
  }
  if (method === 'session.flush') {
    await agent.sessionManager.flush();
    return true;
  }
  if (method === 'project.set') {
    await agent.project.set(args[0], args[1]);
    return agent.project.get(args[0]);
  }
  if (method === 'project.update') {
    for (const [field, value] of Object.entries(args[0] || {})) await agent.project.set(field, value);
    return agent.sessionManager.getState();
  }
  if (method === 'task.get') return agent.taskManager.get(args[0]);
  if (method === 'task.create') return agent.taskManager.create(args[0]);
  if (method === 'task.update') return agent.taskManager.update(args[0], args[1]);
  if (method === 'task.transition') return agent.taskManager.transition(args[0], args[1], args[2] || {});
  if (method === 'task.complete') return agent.taskManager.complete(args[0], args[1] || {});
  if (method === 'task.settleComplete') return agent.taskManager.settleComplete(args[0], args[1] || {});
  if (method === 'task.persist') return agent.taskManager.persist();
  if (method === 'config.llm') return agent.reconfigureLLM(args[0]);
  if (method === 'config.research') return agent.reconfigureResearch(args[0]);
  if (method === 'config.prompt') return agent.reconfigurePrompt(args[0]);
  if (method === 'config.workflowDir') return agent.setWorkflowDir(args[0]);
  if (method === 'config.promptMode') return agent.setPromptMode(args[0]);
  if (method === 'config.comfy') {
    const config = args[0] || {};
    if (config.baseUrl) ComfyUITool.setClient(new ComfyUIClient({ baseUrl: config.baseUrl }));
    if (Object.prototype.hasOwnProperty.call(config, 'comfyRoot')) agent.comfyRoot = config.comfyRoot || '';
    if (config.workflowDir) agent.setWorkflowDir(config.workflowDir);
    return { baseUrl: ComfyUITool.client.baseUrl, comfyRoot: agent.comfyRoot, workflowDir: agent.workflowDir };
  }
  if (method.startsWith('memory.')) return invokeMemory(method, args);
  if (method === 'evaluator.score') return scoreImage(args[0], args[1]);
  if (method.startsWith('plugins.')) return invokePlugins(method, args);
  throw new Error(`RPC method is not allowed: ${method}`);
}

// Batch curation: score one generated image against its prompt using the
// agent's evaluator (technical + vision when the configured model supports it).
async function scoreImage(image, userGoal) {
  if (!agent?.evaluator) return { score: null, reason: 'no_evaluator' };
  try {
    const evaluation = await agent.evaluator.evaluate({ images: [image] }, String(userGoal || ''), {}, {});
    const score = (evaluation?.technical?.passed ? 40 : 20)
      + (evaluation?.constraint?.passed ? 30 : 0)
      + (evaluation?.creative?.passed ? 30 : 0);
    return { score, passed: evaluation?.passed === true, summary: evaluation?.summary || '' };
  } catch (error) {
    return { score: null, reason: error?.message || 'evaluation_failed' };
  }
}

// ---- Plugin host (P3) ----

// Plugins start() may register tools/skills into the shared registry used by
// the Agent; the plugin-registry gates these handles by declared capabilities.
async function initPlugins(userDataPath) {
  pluginErrors = [];
  if (!userDataPath) { pluginRegistry = createPluginRegistry({ host: pluginHost(), plugins: [] }); return { count: 0, errors: [] }; }
  pluginPrefs = new JSONFileStore(join(userDataPath, 'agent-data'), 'plugins-state.json');
  await pluginPrefs.load();
  const enabled = pluginPrefs.get('enabled') || {};
  const { plugins, errors } = await loadPluginsFromDirectory(join(userDataPath, 'plugins'));
  pluginErrors = errors;
  pluginRegistry = createPluginRegistry({ host: pluginHost(), plugins });
  for (const plugin of plugins) {
    if (enabled[plugin.manifest.pluginId] !== false) {
      await pluginRegistry.start(plugin.manifest.pluginId).catch(error => {
        pluginErrors.push({ pluginId: plugin.manifest.pluginId, error: error?.message || String(error) });
      });
    }
  }
  return { count: plugins.length, errors: pluginErrors };
}

function pluginHost() {
  return {
    registerTool: tool => toolRegistry.register(tool),
    // v1: plugin-registered skills are validated but not yet wired into the
    // skill router; only the tools capability is live in the Electron host.
    registerSkill: () => {},
    registerService: () => {},
    registerIpc: () => {},
    registerUi: () => {},
  };
}

function pluginEnabled(id) {
  return pluginPrefs ? pluginPrefs.get('enabled')?.[id] !== false : true;
}

async function invokePlugins(method, args = []) {
  const [id, enabled] = args;
  switch (method) {
    case 'plugins.list': {
      const registry = pluginRegistry?.list() || [];
      return { plugins: registry.map(plugin => ({ ...plugin, enabled: pluginEnabled(plugin.pluginId), signed: plugin.signed === true })), errors: pluginErrors || [] };
    }
    case 'plugins.enable': {
      if (!pluginRegistry?.get(id)) throw Object.assign(new Error(`Plugin not found: ${id}`), { code: 'PLUGIN_NOT_FOUND' });
      if (enabled) await pluginRegistry.start(id);
      else await pluginRegistry.stop(id);
      if (pluginPrefs) {
        const state = pluginPrefs.get('enabled') || {};
        state[id] = Boolean(enabled);
        pluginPrefs.set('enabled', state);
        await pluginPrefs.save();
      }
      return { pluginId: id, enabled: Boolean(enabled) };
    }
    case 'plugins.remove': {
      const removed = pluginRegistry?.remove(id);
      if (pluginPrefs) {
        const state = pluginPrefs.get('enabled') || {};
        delete state[id];
        pluginPrefs.set('enabled', state);
        await pluginPrefs.save();
      }
      return { removed: Boolean(removed) };
    }
    default: throw new Error(`RPC method is not allowed: ${method}`);
  }
}

async function invokeMemory(method, args = []) {
  const [projectId, patch] = args;
  switch (method) {
    case 'memory.getState': return memory.projectState(projectId || '');
    case 'memory.setProfile': return memory.setProfile(projectId || '', patch || {});
    case 'memory.clear': return memory.clear(projectId || '');
    case 'memory.export': return memory.exportJson();
    case 'memory.recall': return memory.recall(projectId || '', patch || {});
    default: throw new Error(`RPC method is not allowed: ${method}`);
  }
}

async function start(config = {}) {
  ComfyUITool.setClient(new ComfyUIClient({ baseUrl: config.comfyBaseUrl || 'http://127.0.0.1:8188' }));
  configureSkills({
    systemEnabled: config.skills?.system,
    custom: config.skills?.custom,
    external: config.skills?.external,
  });
  // Cross-session memory persists under agent-data when a user data path is
  // configured; otherwise it stays in-memory for the worker lifetime.
  memory = new LongTermMemory({
    filePath: config.userDataPath ? join(config.userDataPath, 'agent-data', 'memory.json') : '',
  });
  await memory.init();
  // Shared tool registry: the Agent tool surface plus any tools registered by
  // enabled plugins at start() time.
  toolRegistry = createToolRegistry({ tools: AGENT_TOOL_MODULES });
  await initPlugins(config.userDataPath || '');
  agent = new Agent({
    llmConfig: config.llm || {},
    researchConfig: config.research || {},
    promptConfig: config.prompt || {},
    workflowDir: config.workflowDir || '',
    comfyRoot: config.comfyRoot || '',
    userDataPath: config.userDataPath || '',
    projectId: config.projectId || 'project_worker',
    sessionId: config.sessionId || 'session_worker',
    memory: memory || undefined,
    toolRegistry,
  });
  workerContext = createGovernanceContext({
    principalId: config.principalId || 'principal_worker',
    tenantId: config.tenantId || 'tenant_local',
    projectId: config.projectId || 'project_worker',
    sessionId: config.sessionId || 'session_worker',
    source: 'internal',
  });
  wireEvents();
  await agent.init();
  publishState();
}

async function stop() {
  try {
    if (agent) await agent.abandon();
  } catch {}
  if (agent?.taskManager) await agent.taskManager.persist();
  if (agent?.sessionManager?.flush) await agent.sessionManager.flush().catch(() => {});
}

const handleMessage = async message => {
  if (parentPort) message = message?.data;
  if (!message || typeof message !== 'object') return;
  if (message.type === 'init') {
    try {
      await start(message.config);
      send({ type: 'ready' });
    } catch (error) {
      send({ type: 'fatal', error: error.message, stack: error.stack });
      setImmediate(() => process.exit(1));
    }
    return;
  }
  if (message.type === 'stop') {
    callQueue = callQueue.then(() => stop()).then(() => {
      return sendAndWait({ type: 'stopped' });
    }).then(() => {
      process.exit(0);
    });
    return;
  }
  if (message.type !== 'call' || !agent || typeof message.id !== 'string') return;
  if (READ_ONLY_METHODS.has(message.method) || message.method === 'cancel') {
    runCall(message);
    return;
  }
  callQueue = callQueue.then(() => runCall(message));
};

if (parentPort) parentPort.on('message', handleMessage);
else process.on('message', handleMessage);

if (!parentPort) {
  process.on('disconnect', () => {
    void stop().then(() => process.exit(0));
  });
}
