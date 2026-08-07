import { Agent, AgentEventTypes, ComfyUITool, configureSkills, on } from '../src/agent/index.mjs';
import { ComfyUIClient } from '../src/agent/tools/comfyui/client.mjs';
import { createGovernanceContext } from '../src/runtime/governance/context.mjs';
import { createAuditEvent } from '../src/runtime/governance/audit-events.mjs';

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
]);

let agent;
let callQueue = Promise.resolve();
let workerContext;

function send(message) {
  if (parentPort) {
    try { parentPort.postMessage(message); } catch {}
    return;
  }
  if (!process.connected) return;
  try { process.send(message); } catch {}
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
      send({ type: 'event', eventType, data });
      publishState();
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
  if (method === 'project.set') {
    agent.project.set(args[0], args[1]);
    return agent.project.get(args[0]);
  }
  if (method === 'project.update') {
    for (const [field, value] of Object.entries(args[0] || {})) agent.project.set(field, value);
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
  if (method === 'config.workflowDir') return agent.setWorkflowDir(args[0]);
  if (method === 'config.promptMode') return agent.setPromptMode(args[0]);
  throw new Error(`RPC method is not allowed: ${method}`);
}

async function start(config = {}) {
  ComfyUITool.setClient(new ComfyUIClient({ baseUrl: config.comfyBaseUrl || 'http://127.0.0.1:8188' }));
  configureSkills({ systemEnabled: config.skills?.system, custom: config.skills?.custom });
  agent = new Agent({
    llmConfig: config.llm || {},
    researchConfig: config.research || {},
    workflowDir: config.workflowDir || '',
    comfyRoot: config.comfyRoot || '',
    userDataPath: config.userDataPath || '',
    projectId: config.projectId || 'project_worker',
    sessionId: config.sessionId || 'session_worker',
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
      send({ type: 'stopped' });
      setImmediate(() => process.exit(0));
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
