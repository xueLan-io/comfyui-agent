import { fork, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emit } from '../src/agent/events/agent-events.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = join(__dirname, 'agent-worker.ts');
const JOB_HOST_PATH = join(__dirname, 'job-object-host.ps1');
const DEFAULT_RPC_TIMEOUT_MS = 2700000;
const VIDEO_RPC_TIMEOUT_MS = 3600000;
const STOP_TIMEOUT_MS = 10000;
const TASK_SCOPED_METHODS = new Set(['cancel', 'getTrace', 'session.getTrace', 'task.update', 'task.transition', 'task.complete', 'task.settleComplete']);

function rejected(message: string, code = 'AGENT_PROCESS_ERROR'): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

export interface AgentProcessClientOptions {
  workflowDir?: string;
  onExit?: (error: Error) => void;
  onStderr?: (text: string) => void;
  useJobObject?: boolean;
  rpcTimeoutMs?: number;
}

export interface AgentCacheState {
  workflowDir: string;
  isRunning: boolean;
  state: string;
  taskId: string;
  sessionManager: Record<string, any>;
  projectMemory: Record<string, any>;
  tasks: any[];
}

interface PendingEntry {
  resolve: (value: any) => void;
  reject: (error: any) => void;
}

export class AgentProcessClient {
  options: AgentProcessClientOptions;
  child: any;
  jobHost: any;
  pending: Map<string, PendingEntry>;
  ready: Promise<any> | null;
  startPromise: Promise<any> | null;
  stopPromise: Promise<any> | null;
  stopResolve: ((value?: any) => void) | null = null;
  readyResolve: ((value?: any) => void) | null = null;
  readyReject: ((error: any) => void) | null = null;
  usesUtilityProcess: boolean;
  cache: AgentCacheState;
  sessionManager: any;
  project: any;
  taskManager: any;
  conversation: any;
  constructor(options: AgentProcessClientOptions = {}) {
    this.options = options;
    this.child = null;
    this.jobHost = null;
    this.pending = new Map();
    this.ready = null;
    this.startPromise = null;
    this.stopPromise = null;
    this.stopResolve = null;
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
      getProject: (projectId: string) => this.getProject(projectId),
      getActiveProject: () => this.getActiveProject(),
      getState: () => this.cache.sessionManager,
      getSessionState: () => this.cache.sessionManager.sessionState || null,
      setSessionState: (patch: any) => this.call('session.setState', [patch]),
      setStateFor: (projectId: string, sessionId: string, patch: any) => this.call('session.setStateFor', [projectId, sessionId, patch]),
      upsertGenerationRecordFor: (projectId: string, sessionId: string, record: any) => this.call('session.upsertGenerationRecordFor', [projectId, sessionId, record]),
      appendExecutionEvent: (event: any) => this.call('session.appendExecutionEvent', [event]),
      upsertGenerationRecord: (record: any) => this.call('session.upsertGenerationRecord', [record]),
      flush: () => this.call('session.flush'),
      renameProject: (...args: any[]) => this.call('session.renameProject', args),
      renameSession: (...args: any[]) => this.call('session.renameSession', args),
    };
    this.project = {
      get: (field: string) => this.cache.projectMemory?.current?.[field],
      set: (field: string, value: any) => {
        if (!this.cache.projectMemory.current) this.cache.projectMemory.current = {};
        this.cache.projectMemory.current[field] = value;
        return this.call('project.set', [field, value]);
      },
    };
    this.taskManager = {
      get: (taskId: string) => (this.cache.tasks || []).find(task => task.id === taskId) || null,
      create: (task: any) => this.call('task.create', [task]),
      update: (taskId: string, patch: any) => this.call('task.update', [taskId, patch]),
      transition: (taskId: string, state: string, patch: any) => this.call('task.transition', [taskId, state, patch]),
      complete: (taskId: string, result: any) => this.call('task.complete', [taskId, result]),
      settleComplete: (taskId: string, result: any) => this.call('task.settleComplete', [taskId, result]),
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
  get isAlive() { return Boolean(this.child && (this.usesUtilityProcess ? this.child.pid : this.child.connected)); }

  prepareGeneration(...args: any[]) { return this.call('prepareGeneration', args); }
  prepareFileMutation(...args: any[]) { return this.call('prepareFileMutation', args); }
  prepareWithWorkflow(...args: any[]) { return this.call('prepareWithWorkflow', args); }
  runPrepared(...args: any[]) { return this.call('runPrepared', args); }
  discardPrepared(...args: any[]) { return this.call('discardPrepared', args); }
  routeIntent(...args: any[]) { return this.call('routeIntent', args); }
  clarify(...args: any[]) { return this.call('clarify', args); }
  chat(...args: any[]) { return this.call('chat', args); }
  handleTurn(...args: any[]) { return this.call('handleTurn', args); }
  suggestSessionTitle(...args: any[]) { return this.call('suggestSessionTitle', args); }
  cancel(...args: any[]) { return this.call('cancel', args); }
  listQueue(...args: any[]) { return this.call('listQueue', args); }
  cancelPrompt(...args: any[]) { return this.call('cancelPrompt', args); }
  clearQueue(...args: any[]) { return this.call('clearQueue', args); }
  clearConversation(...args: any[]) { return this.call('clearConversation', args); }
  recordConversationMessage(...args: any[]) { return this.call('recordConversationMessage', args); }
  rewindConversation(...args: any[]) { return this.call('rewindConversation', args); }
  listTasks(...args: any[]) { return this.call('listTasks', args); }
  recoverTasks(...args: any[]) { return this.call('recoverTasks', args); }
  getArtifacts(...args: any[]) { return this.call('getArtifacts', args); }
  detectWorkflow(...args: any[]) { return this.call('detectWorkflow', args); }
  recordArtifact(...args: any[]) { return this.call('recordArtifact', args); }
  recordFeedback(...args: any[]) { return this.call('recordFeedback', args); }
  createProject(...args: any[]) { return this.call('createProject', args); }
  deleteProject(...args: any[]) { return this.call('deleteProject', args); }
  createSession(...args: any[]) { return this.call('createSession', args); }
  deleteSession(...args: any[]) { return this.call('deleteSession', args); }
  useSession(...args: any[]) { return this.call('useSession', args); }
  getTrace(...args: any[]) { return this.call('session.getTrace', args); }
  reconfigureLLM(...args: any[]) { return this.call('config.llm', args); }
  reconfigureResearch(...args: any[]) { return this.call('config.research', args); }
  reconfigurePrompt(...args: any[]) { return this.call('config.prompt', args); }
  setWorkflowDir(...args: any[]) {
    this.cache.workflowDir = args[0] || '';
    return this.call('config.workflowDir', args);
  }
  setPromptMode(...args: any[]) { return this.call('config.promptMode', args); }
  reconfigureComfy(...args: any[]) { return this.call('config.comfy', args); }

  getProject(projectId = this.sessionManager.activeProjectId) {
    return (this.cache.sessionManager.projects || []).find((project: any) => project.id === projectId) || null;
  }

  getActiveProject() {
    return this.getProject(this.sessionManager.activeProjectId);
  }

  start(config: Record<string, any> = {}) {
    if (this.startPromise) return this.startPromise;
    if (this.child) return Promise.resolve(this);
    this.startPromise = this._start(config).finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async _start(config: Record<string, any> = {}) {
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
      this.child = (fork as any)(WORKER_PATH, [], {
        execArgv: [],
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        windowsHide: true,
      });
    }
    this.child.on('message', (message: any) => this._handleMessage(message));
    this.child.on('error', (...args: any[]) => {
      const error = args[0] instanceof Error
        ? args[0]
        : rejected(args.filter(Boolean).join(': ') || 'Agent process error');
      this.cache.tasks = (this.cache.tasks || []).map(task => {
        if (!['queued', 'executing', 'observing', 'retrying', 'replanning'].includes(task.state || task.status)) return task;
        return { ...task, state: 'abandoned', status: 'abandoned', lastError: error.message, error: { code: 'AGENT_PROCESS_EXITED', message: error.message }, updatedAt: Date.now() };
      });
      this._failPending(error);
    });
    this.child.on('exit', (code: any, signal: any) => {
      const error = rejected(`Agent process exited${signal ? ` with ${signal}` : ` with code ${code}`}`);
      this.cache.tasks = (this.cache.tasks || []).map(task => {
        if (!['queued', 'executing', 'observing', 'retrying', 'replanning'].includes(task.state || task.status)) return task;
        return { ...task, state: 'abandoned', status: 'abandoned', lastError: error.message, error: { code: 'AGENT_PROCESS_EXITED', message: error.message }, updatedAt: Date.now() };
      });
      this._failPending(error);
      this.child = null;
      this.ready = null;
      this.options.onExit?.(error);
    });
    this.child.stderr?.on('data', (data: any) => {
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
    const host: any = spawn('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', JOB_HOST_PATH,
      '-ChildPid', String(this.child.pid),
      '-ParentPid', String(process.pid),
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.jobHost = host;
    let output = '';
    const ready = new Promise<void>((resolve, reject) => {
      const onData = (data: any) => {
        output += String(data);
        if (output.split(/\r?\n/).some(line => line.trim() === 'READY')) {
          cleanup();
          resolve();
        }
      };
      const onError = (error: any) => { cleanup(); reject(error); };
      const onExit = (code: any) => {
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

  _handleMessage(message: any): void {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'ready') {
      this.readyResolve?.();
      return;
    }
    if (message.type === 'stopped') {
      this.stopResolve?.();
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
      if (message.code === 'CLOUD_POLICY_BLOCKED') (error as any).policyDecision = message.policyDecision || null;
      request.reject(error);
    }
  }

  _updateState(state: Record<string, any>): void {
    this.cache = { ...this.cache, ...state };
  }

  _failPending(error: any): void {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    this.readyReject?.(error);
  }

  _taskIdFromArgs(args: any[] = []): string {
    const structured = args.find(value => value && typeof value === 'object' && typeof value.taskId === 'string');
    if (structured) return structured.taskId;
    return '';
  }

  _rpcTimeoutMs(method: string, args: any[] = []): number {
    const input = args.find(value => value && typeof value === 'object') || {};
    const video = input.outputType === 'video'
      || input.settings?.frames
      || /video|wan|minimax|animatediff/i.test(String(input.workflowName || input.modelType || ''));
    return video ? Math.max(this.options.rpcTimeoutMs || 0, VIDEO_RPC_TIMEOUT_MS) : (this.options.rpcTimeoutMs || DEFAULT_RPC_TIMEOUT_MS);
  }

  call(method: string, args: any[] = []): Promise<any> {
    return (async () => {
      if (this.startPromise) await this.startPromise;
      if (this.ready) await this.ready;
      if (!this.child || (!this.usesUtilityProcess && !this.child.connected) || (this.usesUtilityProcess && !this.child.pid)) {
        throw rejected('Agent process is not running', 'AGENT_PROCESS_NOT_RUNNING');
      }
      const id = randomUUID();
      const timeoutMs = this._rpcTimeoutMs(method, args);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          const error = rejected(`Agent RPC timed out: ${method}`, 'AGENT_RPC_TIMEOUT');
          const taskId = this._taskIdFromArgs(args) || (TASK_SCOPED_METHODS.has(method) && typeof args[0] === 'string' ? args[0] : '');
          if (taskId && method !== 'cancel') void this.call('cancel', [taskId]).catch(() => {});
          reject(error);
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

  _send(message: any, callback?: (error?: any) => void): void {
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
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this._stop().finally(() => {
      this.stopPromise = null;
      this.stopResolve = null;
    });
    return this.stopPromise;
  }

  async _stop() {
    const child = this.child;
    const host = this.jobHost;
    const exited = child
      ? new Promise(resolve => child.once('exit', resolve))
      : Promise.resolve();
    if (child) {
      const stopped = new Promise(resolve => { this.stopResolve = resolve; });
      try {
        if (this.usesUtilityProcess) child.postMessage({ type: 'stop' });
        else if (child.connected) child.send({ type: 'stop' });
      } catch {}
      await Promise.race([stopped, exited, new Promise(resolve => setTimeout(resolve, STOP_TIMEOUT_MS))]);
    }
    this.child = null;
    this.jobHost = null;
    this._failPending(rejected('Agent process stopped', 'AGENT_PROCESS_STOPPED'));
    this.ready = null;
    if (!this.usesUtilityProcess && child?.connected) child.disconnect();
    if (host && !host.killed) host.kill();
    if (child && !child.killed) child.kill();
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, STOP_TIMEOUT_MS))]);
  }
}
