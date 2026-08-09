import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ConversationMemory, createSessionMemory, SessionMemory } from '../memory/conversation.mjs';
import { ProjectMemory } from '../memory/project.mjs';
import { JSONFileStore } from '../memory/store.mjs';

function projectDefaults() {
  return { projects: [], activeProjectId: '', activeSessionId: '' };
}

function conversationDefaults() {
  return { conversations: {}, sessionStates: {} };
}

function sessionStateDefaults() {
  return {
    revision: 1,
    updatedAt: Date.now(),
    state: 'idle',
    phase: 'idle',
    lastIntent: '',
    pending: null,
    lastTaskId: '',
    traceId: '',
    currentStep: '',
    currentAttempt: 0,
    promptId: '',
    lastError: '',
    needsConfirmation: false,
    lastPrompt: '',
    lastCompiledPrompt: null,
    lastImages: [],
    lastGenerationSource: '',
    turnId: '',
    pendingIntent: null,
    pendingRequest: '',
    supplementalInput: '',
    preparedPreview: null,
    taskStatus: 'idle',
    currentArtifactId: '',
    taskFailure: null,
    retryAction: null,
    executionRecords: {},
    contextArchive: { version: 1, segments: [], archivedMessageIds: [] },
    sessionMemory: createSessionMemory(),
  };
}

const SESSION_GENERATION_FIELDS = [
  'lastPrompt',
  'lastCompiledPrompt',
  'lastImages',
  'lastGenerationSource',
];

function id(prefix) {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

function newSession(title = '新会话') {
  return { id: id('session'), title, createdAt: Date.now() };
}

function projectState(project) {
  return {
    goal: project.goal || '',
    workflow: project.workflow || '',
    model: project.model || '',
    style: project.style || '',
    assets: Array.isArray(project.assets) ? project.assets : [],
    lastResult: project.lastResult || null,
    promptMode: project.promptMode || 'raw',
    budgets: project.budgets || null,
    confirmedConstraints: project.confirmedConstraints || {},
    commonParameters: project.commonParameters || {},
    savedPreferences: project.savedPreferences || {},
    researchSettings: project.researchSettings || {},
    metadata: project.metadata || {},
  };
}

function generationStateFromProject(project = {}) {
  return {
    lastPrompt: project.lastPrompt || '',
    lastCompiledPrompt: project.lastCompiledPrompt || null,
    lastImages: Array.isArray(project.lastImages) ? project.lastImages : [],
    lastGenerationSource: project.lastGenerationSource || '',
  };
}

function hasGenerationValues(state = {}) {
  return Boolean(
    state.lastPrompt
    || state.lastCompiledPrompt
    || (Array.isArray(state.lastImages) && state.lastImages.length > 0)
    || state.lastGenerationSource,
  );
}

export class SessionManager {
  constructor(storageDir = '', options = {}) {
    this.storageDir = storageDir;
    this.defaultProjectDir = options.defaultProjectDir || (storageDir ? join(storageDir, 'projects') : '');
    this.projectStore = options.projectStore || (storageDir
      ? new JSONFileStore(storageDir, 'projects.json', projectDefaults())
      : null);
    this.conversationStore = options.conversationStore || (storageDir
      ? new JSONFileStore(storageDir, 'conversations.json', conversationDefaults())
      : null);
    this.projects = [];
    this.conversations = {};
    this.sessionStates = {};
    this.activeProjectId = '';
    this.activeSessionId = '';
    this.project = new ProjectMemory();
    this.conversation = new ConversationMemory();
    this.sessionMemory = new SessionMemory({}, () => this._saveSessionMemory());
    this.sessionState = sessionStateDefaults();
  }

  async init() {
    const projectData = this.projectStore ? await this.projectStore.load() : projectDefaults();
    const conversationData = this.conversationStore ? await this.conversationStore.load() : conversationDefaults();
    this.projects = Array.isArray(projectData.projects) ? projectData.projects : [];
    this.conversations = conversationData.conversations && typeof conversationData.conversations === 'object'
      ? conversationData.conversations
      : {};
    this.sessionStates = conversationData.sessionStates && typeof conversationData.sessionStates === 'object'
      ? conversationData.sessionStates
      : {};

    if (this.projects.length === 0) {
      const session = newSession('默认会话');
      const projectId = id('project');
      const legacy = projectData.project?.current || projectData.current || {};
      this.projects.push({
        id: projectId,
        name: '默认项目',
        isDefault: true,
        dir: this.defaultProjectDir ? join(this.defaultProjectDir, projectId) : '',
        ...projectState(legacy),
        ...generationStateFromProject(legacy),
        promptMode: legacy.promptMode || 'raw',
        sessions: [session],
        createdAt: Date.now(),
      });
      this.sessionStates[projectId] = { [session.id]: sessionStateDefaults() };
      this.conversations[projectId] = { [session.id]: Array.isArray(conversationData.messages) ? conversationData.messages : [] };
    }

    // Migrate the legacy single default project once; later display logic uses the stable flag.
    if (this.projects.length === 1 && this.projects[0].isDefault === undefined && this.projects[0].name === '默认项目') {
      this.projects[0].isDefault = true;
    }

    for (const project of this.projects) {
      if (!Array.isArray(project.sessions) || project.sessions.length === 0) project.sessions = [newSession()];
      if (!this.conversations[project.id]) this.conversations[project.id] = {};
      if (!this.sessionStates[project.id]) this.sessionStates[project.id] = {};
      for (const session of project.sessions) {
        if (!Array.isArray(this.conversations[project.id][session.id])) this.conversations[project.id][session.id] = [];
        if (!this.sessionStates[project.id][session.id]) this.sessionStates[project.id][session.id] = sessionStateDefaults();
      }
    }

    this.activeProjectId = this.projects.some(item => item.id === projectData.activeProjectId)
      ? projectData.activeProjectId
      : this.projects[0].id;
    const activeProject = this.getActiveProject();
    this.activeSessionId = activeProject.sessions.some(item => item.id === projectData.activeSessionId)
      ? projectData.activeSessionId
      : activeProject.sessions[0].id;
    this._loadActiveMemory();
    await this._persistAll();
    return this.getState();
  }

  _loadActiveMemory() {
    const project = this.getActiveProject();
    const storedState = this.sessionStates[this.activeProjectId]?.[this.activeSessionId] || {};
    const hasSessionGeneration = Object.values(this.sessionStates[this.activeProjectId] || {})
      .some(state => hasGenerationValues(state));
    const legacyGeneration = generationStateFromProject(project);
    const migrateLegacyGeneration = !hasSessionGeneration && hasGenerationValues(legacyGeneration);
    if (migrateLegacyGeneration) {
      Object.assign(storedState, legacyGeneration);
      for (const field of SESSION_GENERATION_FIELDS) delete project[field];
    }
    const generation = hasGenerationValues(storedState) || migrateLegacyGeneration
      ? {
        lastPrompt: storedState.lastPrompt || '',
        lastCompiledPrompt: storedState.lastCompiledPrompt || null,
        lastImages: Array.isArray(storedState.lastImages) ? storedState.lastImages : [],
        lastGenerationSource: storedState.lastGenerationSource || '',
      }
      : {
        lastPrompt: '',
        lastCompiledPrompt: null,
        lastImages: [],
        lastGenerationSource: '',
      };
    this.project = new ProjectMemory(() => this._saveProjectMemory());
    this.project.loadFrom({ current: { ...projectState(project), ...generation }, history: project.history || [] });
    this.conversation = new ConversationMemory(100, () => this._saveConversationMemory());
    this.conversation.loadFrom(this.conversations[this.activeProjectId]?.[this.activeSessionId] || []);
    this.sessionMemory = new SessionMemory(storedState.sessionMemory || {}, () => this._saveSessionMemory());
    this.sessionState = {
      ...sessionStateDefaults(),
      ...storedState,
      ...generation,
      sessionMemory: this.sessionMemory.toJSON(),
    };
    if (!storedState.state) {
      this.sessionState.state = {
        running: 'executing',
        awaiting_clarification: 'clarifying',
        awaiting_preview: 'awaiting_confirmation',
        error: 'failed',
      }[storedState.phase] || storedState.phase || 'idle';
    }
  }

  _saveProjectMemory() {
    const project = this.getActiveProject();
    if (!project) return;
    const current = { ...this.project.current };
    const generation = {};
    for (const field of SESSION_GENERATION_FIELDS) {
      generation[field] = current[field];
      delete current[field];
      delete project[field];
    }
    this.sessionState = {
      ...this.sessionState,
      ...generation,
      revision: (this.sessionState.revision || 0) + 1,
      updatedAt: Date.now(),
    };
    if (!this.sessionStates[this.activeProjectId]) this.sessionStates[this.activeProjectId] = {};
    this.sessionStates[this.activeProjectId][this.activeSessionId] = this.getSessionState();
    Object.assign(project, current, { history: this.project.history });
    void this._persistProjects().catch(() => {});
    void this._persistConversations().catch(() => {});
  }

  _saveConversationMemory() {
    if (!this.conversations[this.activeProjectId]) this.conversations[this.activeProjectId] = {};
    this.conversations[this.activeProjectId][this.activeSessionId] = this.conversation.toJSON();
    this.sessionState = { ...this.sessionState, revision: (this.sessionState.revision || 0) + 1, updatedAt: Date.now() };
    if (!this.sessionStates[this.activeProjectId]) this.sessionStates[this.activeProjectId] = {};
    this.sessionStates[this.activeProjectId][this.activeSessionId] = this.getSessionState();
    void this._persistConversations().catch(() => {});
  }

  _saveSessionMemory() {
    this.sessionState = { ...this.sessionState, sessionMemory: this.sessionMemory.toJSON(), revision: (this.sessionState.revision || 0) + 1, updatedAt: Date.now() };
    if (!this.sessionStates[this.activeProjectId]) this.sessionStates[this.activeProjectId] = {};
    this.sessionStates[this.activeProjectId][this.activeSessionId] = this.getSessionState();
    void this._persistConversations().catch(() => {});
  }

  async _persistProjects() {
    if (!this.projectStore) return;
    this.projectStore.data = {
      projects: this.projects,
      activeProjectId: this.activeProjectId,
      activeSessionId: this.activeSessionId,
    };
    await this.projectStore.save();
  }

  async _persistConversations() {
    if (!this.conversationStore) return;
    this.conversationStore.data = { conversations: this.conversations, sessionStates: this.sessionStates };
    await this.conversationStore.save();
  }

  async _persistAll() {
    await Promise.all([this._persistProjects(), this._persistConversations()]);
  }

  async flush() {
    await this._persistAll();
  }

  getActiveProject() {
    return this.projects.find(item => item.id === this.activeProjectId) || null;
  }

  getProject(projectId) {
    return this.projects.find(item => item.id === projectId) || null;
  }

  listProjects() {
    return this.projects.map(project => ({ ...project, sessions: project.sessions.map(session => ({ ...session })) }));
  }

  getState() {
    return {
      projects: this.listProjects(),
      activeProjectId: this.activeProjectId,
      activeSessionId: this.activeSessionId,
      messages: this.conversation.toJSON(),
      project: this.getActiveProject(),
      sessionState: this.sessionState,
    };
  }

  async createProject({ name = '新项目', dir = '' } = {}) {
    const projectId = id('project');
    const session = newSession();
    const project = {
      id: projectId,
      name: name.trim() || '新项目',
      isDefault: false,
      dir: dir || (this.defaultProjectDir ? join(this.defaultProjectDir, projectId) : ''),
      workflow: '',
      promptMode: 'raw',
      assets: [],
      sessions: [session],
      createdAt: Date.now(),
    };
    this.projects.push(project);
    this.conversations[projectId] = { [session.id]: [] };
    this.sessionStates[projectId] = { [session.id]: sessionStateDefaults() };
    await this.activate(projectId, session.id);
    return project;
  }

  async renameProject(projectId, name) {
    const project = this.getProject(projectId);
    if (!project) throw new Error('项目不存在');
    project.name = name.trim() || project.name;
    await this._persistProjects();
    return project;
  }

  async deleteProject(projectId) {
    if (this.projects.length === 1) throw new Error('至少保留一个项目');
    const index = this.projects.findIndex(item => item.id === projectId);
    if (index < 0) throw new Error('项目不存在');
    this.projects.splice(index, 1);
    delete this.conversations[projectId];
    delete this.sessionStates[projectId];
    if (this.activeProjectId === projectId) {
      this.activeProjectId = this.projects[Math.max(0, index - 1)].id;
      this.activeSessionId = this.getActiveProject().sessions[0].id;
      this._loadActiveMemory();
    }
    await this._persistAll();
    return this.getState();
  }

  async createSession(title = '新会话', projectId = this.activeProjectId, { activate = true } = {}) {
    const project = this.getProject(projectId);
    if (!project) throw new Error('项目不存在');
    const session = newSession(title.trim() || '新会话');
    project.sessions.push(session);
    if (!this.conversations[projectId]) this.conversations[projectId] = {};
    this.conversations[projectId][session.id] = [];
    if (!this.sessionStates[projectId]) this.sessionStates[projectId] = {};
    this.sessionStates[projectId][session.id] = sessionStateDefaults();
    if (activate) await this.activate(projectId, session.id);
    else await this._persistAll();
    return session;
  }

  async deleteSession(sessionId, projectId = this.activeProjectId) {
    const project = this.getProject(projectId);
    if (!project) throw new Error('项目不存在');
    if (project.sessions.length === 1) throw new Error('至少保留一个会话');
    const index = project.sessions.findIndex(item => item.id === sessionId);
    if (index < 0) throw new Error('会话不存在');
    project.sessions.splice(index, 1);
    project.assets = (project.assets || []).filter(item => item.sessionId !== sessionId);
    delete this.conversations[projectId]?.[sessionId];
    delete this.sessionStates[projectId]?.[sessionId];
    if (this.activeProjectId === projectId && this.activeSessionId === sessionId) {
      this.activeSessionId = project.sessions[Math.max(0, index - 1)].id;
      this._loadActiveMemory();
    }
    await this._persistAll();
    return this.getState();
  }

  async renameSession(sessionId, title, projectId = this.activeProjectId) {
    const project = this.getProject(projectId);
    if (!project) throw new Error('项目不存在');
    const session = project.sessions.find(item => item.id === sessionId);
    if (!session) throw new Error('会话不存在');
    session.title = title.trim() || session.title;
    await this._persistProjects();
    return this.getState();
  }

  async activate(projectId, sessionId) {
    const project = this.getProject(projectId);
    if (!project) throw new Error('项目不存在');
    const session = project.sessions.find(item => item.id === sessionId) || project.sessions[0];
    this.activeProjectId = projectId;
    this.activeSessionId = session.id;
    this._loadActiveMemory();
    await this._persistProjects();
    return this.getState();
  }

  getSessionState() {
    return {
      ...this.sessionState,
      pending: this.sessionState.pending ? { ...this.sessionState.pending } : null,
      pendingIntent: this.sessionState.pendingIntent ? { ...this.sessionState.pendingIntent } : null,
      preparedPreview: this.sessionState.preparedPreview ? { ...this.sessionState.preparedPreview } : null,
      sessionMemory: this.sessionMemory?.toJSON?.() || createSessionMemory(this.sessionState.sessionMemory),
    };
  }

  getSessionMemory() {
    return this.sessionMemory?.toJSON?.() || createSessionMemory(this.sessionState.sessionMemory);
  }

  setSessionMemory(patch = {}) {
    this.sessionMemory.update(patch);
    return this.getSessionMemory();
  }

  setSessionState(patch = {}) {
    const next = {
      ...this.sessionState,
      ...patch,
      revision: (this.sessionState.revision || 0) + 1,
      updatedAt: Date.now(),
    };
    if (patch.phase && !patch.state) {
      const legacyState = {
        running: 'executing',
        awaiting_clarification: 'clarifying',
        awaiting_preview: 'awaiting_confirmation',
        error: 'failed',
      }[patch.phase];
      if (legacyState) next.state = legacyState;
    }
    if (patch.state && !patch.phase) {
      next.phase = {
        classifying: 'running',
        clarifying: 'awaiting_clarification',
        planning: 'running',
        awaiting_confirmation: 'awaiting_preview',
        executing: 'running',
        observing: 'running',
        retrying: 'running',
        replanning: 'running',
        failed: 'error',
      }[patch.state] || patch.state;
    }
    this.sessionState = next;
    if (!this.sessionStates[this.activeProjectId]) this.sessionStates[this.activeProjectId] = {};
    this.sessionStates[this.activeProjectId][this.activeSessionId] = this.getSessionState();
    void this._persistConversations().catch(() => {});
    return this.getSessionState();
  }

  appendExecutionEvent(event = {}) {
    const turnId = event.turnId || this.sessionState.turnId || '';
    if (!turnId) return this.getSessionState();
    const records = { ...(this.sessionState.executionRecords || {}) };
    const events = [...(records[turnId] || []), event].slice(-48);
    records[turnId] = events;
    return this.setSessionState({ executionRecords: records });
  }

  clearCurrentTask() {
    return this.setSessionState({
      traceId: '',
      currentStep: '',
      currentAttempt: 0,
      promptId: '',
      lastError: '',
      needsConfirmation: false,
      pending: null,
    });
  }
}
