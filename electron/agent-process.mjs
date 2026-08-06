import { fork, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emit } from '../src/agent/events/agent-events.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = join(__dirname, 'agent-worker.mjs');
const JOB_HOST_PATH = join(__dirname, 'job-object-host.ps1');
const DEFAULT_RPC_TIMEOUT_MS = 900000;

function rejected(message, code = 'AGENT_PROCESS_ERROR') {
  const error = new Error(message);
  error.code = code;
  return error;
}

export class AgentProcessClient {
  constructor(options = {}) {
    this.options = options;
    this.child = null;
    this.jobHost = null;
    this.pending = new Map();
    this.ready = null;
    this.startPromise = null;
    this.usesUtilityProcess = false;
    this.cache = {
      workflowDir: options.workflowDir || '',
      isRunning: false,
      state: 'idle',
      taskId: '',
      sessionManager: { projects: [], activeProjectId: '', activeSessionId: '', messages: [], project: null, sessionState: null },
      projectMemory: { current: {}, history: [] },
      tasks: [],
    };

    const thisOwner = this;
    this.sessionManager = {
      get projects() { return thisOwner.cache.sessionManager.projects || []; },
      get activeProjectId() { return thisOwner.cache.sessionManager.activeProjectId || ''; },
      get activeSessionId() { return thisOwner.cache.sessionManager.activeSessionId || ''; },
      getProject: projectId => this.getProject(projectId),
      getActiveProject: () => this.getActiveProject(),
      getState: () => this.cache.sessionManager,
      getSessionState: () => this.cache.sessionManager.sessionState || null,
      renameProject: (...args) => this.call('session.renameProject', args),
      renameSession: (...args) => this.call('session.renameSession', args),
    };
    this.project = {
      get: field => this.cache.projectMemory?.current?.[field],
      set: (field, value) => {
        if (!this.cache.projectMemory.current) this.cache.projectMemory.current = {};
        this.cache.projectMemory.current[field] = value;
        return this.call('project.set', [field, value]);
      },
    };
    this.taskManager = {
      get: taskId => (this.cache.tasks || []).find(task => task.id === taskId) || null,
      create: task => this.call('task.create', [task]),
      update: (taskId, patch) => this.call('task.update', [taskId, patch]),
      transition: (taskId, state, patch) => this.call('task.transition', [taskId, state, patch]),
      complete: (taskId, result) => this.call('task.complete', [taskId, result]),
      settleComplete: (taskId, result) => this.call('task.settleComplete', [taskId, result]),
      persist: () => this.call('task.persist'),
    };
    this.conversation = {
      toJSON: () => this.cache.sessionManager.messages || [],
    };
  }

  get workflowDir() { return this.cache.workflowDir; }
  get isRunning() { return this.cache.isRunning; }
  get state() { return this.cache.state; }
  get taskId() { return this.cache.taskId; }

  prepareGeneration(...args) { return this.call('prepareGeneration', args); }
  prepareFileMutation(...args) { return this.call('prepareFileMutation', args); }
  prepareWithWorkflow(...args) { return this.call('prepareWithWorkflow', args); }
  runPrepared(...args) { return this.call('runPrepared', args); }
  discardPrepared(...args) { return this.call('discardPrepared', args); }
  routeIntent(...args) { return this.call('routeIntent', args); }
  clarify(...args) { return this.call('clarify', args); }
  chat(...args) { return this.call('chat', args); }
  handleTurn(...args) { return this.call('handleTurn', args); }
  suggestSessionTitle(...args) { return this.call('suggestSessionTitle', args); }
  cancel(...args) { return this.call('cancel', args); }
  listQueue(...args) { return this.call('listQueue', args); }
  cancelPrompt(...args) { return this.call('cancelPrompt', args); }
  clearQueue(...args) { return this.call('clearQueue', args); }
  clearConversation(...args) { return this.call('clearConversation', args); }
  recordConversationMessage(...args) { return this.call('recordConversationMessage', args); }
  rewindConversation(...args) { return this.call('rewindConversation', args); }
  listTasks(...args) { return this.call('listTasks', args); }
  recoverTasks(...args) { return this.call('recoverTasks', args); }
  getArtifacts(...args) { return this.call('getArtifacts', args); }
  detectWorkflow(...args) { return this.call('detectWorkflow', args); }
  recordArtifact(...args) { return this.call('recordArtifact', args); }
  recordFeedback(...args) { return this.call('recordFeedback', args); }
  createProject(...args) { return this.call('createProject', args); }
  deleteProject(...args) { return this.call('deleteProject', args); }
  createSession(...args) { return this.call('createSession', args); }
  deleteSession(...args) { return this.call('deleteSession', args); }
  useSession(...args) { return this.call('useSession', args); }
  getTrace(...args) { return this.call('session.getTrace', args); }
  reconfigureLLM(...args) { return this.call('config.llm', args); }
  reconfigureResearch(...args) { return this.call('config.research', args); }
  setWorkflowDir(...args) {
    this.cache.workflowDir = args[0] || '';
    return this.call('config.workflowDir', args);
  }
  setPromptMode(...args) { return this.call('config.promptMode', args); }

  getProject(projectId = this.sessionManager.activeProjectId) {
    return (this.cache.sessionManager.projects || []).find(project => project.id === projectId) || null;
  }

  getActiveProject() {
    return this.getProject(this.sessionManager.activeProjectId);
  }

  start(config = {}) {
    if (this.startPromise) return this.startPromise;
    if (this.child) return Promise.resolve(this);
    this.startPromise = this._start(config).finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async _start(config = {}) {
    this.ready = null;
    this.usesUtilityProcess = Boolean(process.versions.electron);
    if (this.usesUtilityProcess) {
      const { utilityProcess } = await import('electron');
      this.child = utilityProcess.fork(WORKER_PATH, [], {
        env: process.env,
        execArgv: [],
        stdio: ['ignore', 'ignore', 'pipe'],
        serviceName: 'ComfyUI Agent Worker',
      });
    } else {
      this.child = fork(WORKER_PATH, [], {
        execArgv: [],
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        windowsHide: true,
      });
    }
    this.child.on('message', message => this._handleMessage(message));
    this.child.on('error', (...args) => {
      const error = args[0] instanceof Error
        ? args[0]
        : rejected(args.filter(Boolean).join(': ') || 'Agent process error');
      this._failPending(error);
    });
    this.child.on('exit', (code, signal) => {
      const error = rejected(`Agent process exited${signal ? ` with ${signal}` : ` with code ${code}`}`);
      this._failPending(error);
      this.child = null;
      this.ready = null;
    });
    this.child.stderr?.on('data', data => {
      this.options.onStderr?.(String(data));
    });

    if (this.usesUtilityProcess) {
      await new Promise(resolve => this.child.once('spawn', resolve));
    }
    if (process.platform === 'win32' && this.options.useJobObject !== false) {
      await this._startJobHost();
    }
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this._send({ type: 'init', config });
    await this.ready;
    return this;
  }

  async _startJobHost() {
    const host = spawn('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', JOB_HOST_PATH,
      '-ChildPid', String(this.child.pid),
      '-ParentPid', String(process.pid),
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.jobHost = host;
    let output = '';
    const ready = new Promise((resolve, reject) => {
      const onData = data => {
        output += String(data);
        if (output.split(/\r?\n/).some(line => line.trim() === 'READY')) {
          cleanup();
          resolve();
        }
      };
      const onError = error => { cleanup(); reject(error); };
      const onExit = code => {
        if (code !== 0) {
          cleanup();
          reject(rejected(`Windows Job Object setup failed: ${output.trim() || `exit ${code}`}`, 'JOB_OBJECT_SETUP_FAILED'));
        }
      };
      const cleanup = () => {
        host.stdout.off('data', onData);
        host.stderr.off('data', onData);
        host.off('error', onError);
        host.off('exit', onExit);
      };
      host.stdout.on('data', onData);
      host.stderr.on('data', onData);
      host.on('error', onError);
      host.on('exit', onExit);
    });
    try {
      await ready;
    } catch (error) {
      if (!host.killed) host.kill();
      if (this.child && !this.child.killed) this.child.kill();
      throw error;
    }
  }

  _handleMessage(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'ready') {
      this.readyResolve?.();
      return;
    }
    if (message.type === 'fatal') {
      const error = rejected(message.error || 'Agent worker failed to initialize', 'AGENT_WORKER_INIT_FAILED');
      error.stack = message.stack || error.stack;
      this.readyReject?.(error);
      this._failPending(error);
      return;
    }
    if (message.state) this._updateState(message.state);
    if (message.type === 'event') {
      emit(message.eventType, message.data || {});
      return;
    }
    if (message.type !== 'response' || typeof message.id !== 'string') return;
    const request = this.pending.get(message.id);
    if (!request) return;
    this.pending.delete(message.id);
    if (message.ok) request.resolve(message.result);
    else {
      const error = rejected(message.error || 'Agent RPC failed', message.code || 'AGENT_RPC_FAILED');
      error.stack = message.stack || error.stack;
      if (message.code === 'CLOUD_POLICY_BLOCKED') error.policyDecision = message.policyDecision || null;
      request.reject(error);
    }
  }

  _updateState(state) {
    this.cache = { ...this.cache, ...state };
  }

  _failPending(error) {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    this.readyReject?.(error);
  }

  call(method, args = []) {
    return (async () => {
      if (this.startPromise) await this.startPromise;
      if (this.ready) await this.ready;
      if (!this.child || (!this.usesUtilityProcess && !this.child.connected) || (this.usesUtilityProcess && !this.child.pid)) {
        throw rejected('Agent process is not running', 'AGENT_PROCESS_NOT_RUNNING');
      }
      const id = randomUUID();
      const timeoutMs = this.options.rpcTimeoutMs || DEFAULT_RPC_TIMEOUT_MS;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(rejected(`Agent RPC timed out: ${method}`, 'AGENT_RPC_TIMEOUT'));
        }, timeoutMs);
        this.pending.set(id, {
          resolve: value => { clearTimeout(timer); resolve(value); },
          reject: error => { clearTimeout(timer); reject(error); },
        });
        try {
          this._send({ type: 'call', id, method, args }, error => {
            if (!error) return;
            clearTimeout(timer);
            this.pending.delete(id);
            reject(error);
          });
        } catch (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        }
      });
    })();
  }

  _send(message, callback) {
    if (this.usesUtilityProcess) {
      try {
        this.child.postMessage(message);
        callback?.();
      } catch (error) {
        callback?.(error);
      }
      return;
    }
    this.child.send(message, callback);
  }

  async stop() {
    const child = this.child;
    const host = this.jobHost;
    const exited = child
      ? new Promise(resolve => child.once('exit', resolve))
      : Promise.resolve();
    this.child = null;
    this.jobHost = null;
    this._failPending(rejected('Agent process stopped', 'AGENT_PROCESS_STOPPED'));
    this.ready = null;
    if (child) {
      try {
        if (this.usesUtilityProcess) child.postMessage({ type: 'stop' });
        else if (child.connected) child.send({ type: 'stop' });
      } catch {}
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 1500))]);
    }
    if (!this.usesUtilityProcess && child?.connected) child.disconnect();
    if (host && !host.killed) host.kill();
    if (child) child.kill();
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 2000))]);
  }
}
