const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  windowMinimize: () => ipcRenderer.invoke('window:minimize'),
  windowToggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
  windowIsMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  windowClose: () => ipcRenderer.invoke('window:close'),

  // Legacy ComfyUI workflow API
  listWorkflows: () => ipcRenderer.invoke('list-workflows'),
  selectWorkflowDir: () => ipcRenderer.invoke('select-workflow-dir'),
  showWorkflowDir: (workflowName) => ipcRenderer.invoke('show-workflow-dir', { workflowName }),
  selectMediaFiles: () => ipcRenderer.invoke('select-media-files'),
  mediaImageData: (media) => ipcRenderer.invoke('media:image-data', media),

  // Agent API
  agentRun: (message, workflowName, clientId, controls = {}) => ipcRenderer.invoke('agent:run', { message, workflowName, clientId, controls }),
  agentPrepare: (message, workflowName, clientId, controls = {}) => ipcRenderer.invoke('agent:prepare', { message, workflowName, clientId, controls }),
  agentGenerate: (message, workflowName, clientId, controls = {}) => ipcRenderer.invoke('agent:generate', { message, workflowName, clientId, controls }),
  agentRunPrepared: (previewId, edits = {}) => ipcRenderer.invoke('agent:run-prepared', { previewId, edits }),
  agentDiscardPreview: (previewId) => ipcRenderer.invoke('agent:discard-preview', { previewId }),
  directPrepare: (request) => ipcRenderer.invoke('direct:prepare', { request }),
  directGetPreview: (previewId) => ipcRenderer.invoke('direct:get-preview', { previewId }),
  directRunPrepared: (previewId, edits = {}, options = {}) => ipcRenderer.invoke('direct:run-prepared', { previewId, edits, options }),
  directDiscardPreview: (previewId) => ipcRenderer.invoke('direct:discard-preview', { previewId }),
  directCancel: () => ipcRenderer.invoke('direct:cancel'),
  agentSend: (message, workflowName, workflowManifest, controls = {}) => ipcRenderer.invoke('agent:send', { message, workflowName, workflowManifest, controls }),
  agentChat: (message, workflowName, workflowManifest, controls = {}) => ipcRenderer.invoke('agent:chat', { message, workflowName, workflowManifest, controls }),
  agentHandleTurn: (turn = {}) => ipcRenderer.invoke('agent:turn', turn),
  agentTitleForMessage: (text) => ipcRenderer.invoke('agent:title-for-message', { text }),
  agentCancel: (taskId) => ipcRenderer.invoke('agent:cancel', { taskId }),
  agentRemoveConversationTurn: (turnId) => ipcRenderer.invoke('agent:remove-conversation-turn', { turnId }),
  agentFeedback: (type, details = {}) => ipcRenderer.invoke('agent:feedback', { type, details }),
  agentConfigure: (config) => ipcRenderer.invoke('agent:config', { config }),
  agentTestLLM: (config) => ipcRenderer.invoke('agent:test-llm', { config }),
  agentGetConfig: () => ipcRenderer.invoke('agent:get-config'),
  agentStatus: () => ipcRenderer.invoke('agent:status'),
  agentWorkflowDir: (dir) => ipcRenderer.invoke('agent:workflow-dir', { dir }),
  agentSetPromptMode: (mode) => ipcRenderer.invoke('agent:prompt-mode', { mode }),
  projectUpdateState: (patch) => ipcRenderer.invoke('project:update-state', patch),
  agentDetectWorkflow: (workflowName) => ipcRenderer.invoke('agent:detect-workflow', { workflowName }),
  agentInspectWorkflow: (workflowName) => ipcRenderer.invoke('agent:inspect-workflow', { workflowName }),
  agentGetArtifacts: (opts) => ipcRenderer.invoke('agent:artifacts', opts),
  agentClearConversation: () => ipcRenderer.invoke('agent:clear-conversation'),
  agentRewindConversation: (index) => ipcRenderer.invoke('agent:rewind-conversation', { index }),
  agentListTasks: () => ipcRenderer.invoke('agent:list-tasks'),
  agentGetTrace: (taskId) => ipcRenderer.invoke('agent:get-trace', { taskId }),
  agentGetRequestStatus: (requestId) => ipcRenderer.invoke('agent:get-request-status', { requestId }),
  agentRecoverTasks: () => ipcRenderer.invoke('agent:recover-tasks'),
  agentRetryRecovery: (taskId) => ipcRenderer.invoke('agent:retry-recovery', { taskId }),
  projectsList: () => ipcRenderer.invoke('projects:list'),
  projectCreate: (input) => ipcRenderer.invoke('projects:create', input),
  projectRename: (projectId, name) => ipcRenderer.invoke('projects:rename', { projectId, name }),
  projectDelete: (projectId) => ipcRenderer.invoke('projects:delete', { projectId }),
  sessionsList: (projectId) => ipcRenderer.invoke('sessions:list', { projectId }),
  sessionCreate: (title, projectId) => ipcRenderer.invoke('sessions:create', { title, projectId }),
  sessionDelete: (sessionId, projectId) => ipcRenderer.invoke('sessions:delete', { sessionId, projectId }),
  sessionRename: (sessionId, title, projectId) => ipcRenderer.invoke('sessions:rename', { sessionId, title, projectId }),
  sessionActivate: (projectId, sessionId) => ipcRenderer.invoke('session:activate', { projectId, sessionId }),
  projectAssets: (projectId) => ipcRenderer.invoke('project:assets', projectId),
  projectDeleteAsset: (image) => ipcRenderer.invoke('project:delete-asset', image),
  uiPreferences: () => ipcRenderer.invoke('ui:preferences'),
  uiSavePreferences: (preferences) => ipcRenderer.invoke('ui:save-preferences', preferences),
  researchSettings: () => ipcRenderer.invoke('research:settings'),
  researchSaveSettings: (settings) => ipcRenderer.invoke('research:save-settings', settings),
  llmProviders: () => ipcRenderer.invoke('llm:providers'),
  llmSaveProvider: (provider) => ipcRenderer.invoke('llm:save-provider', { provider }),
  llmDeleteProvider: (providerId) => ipcRenderer.invoke('llm:delete-provider', { providerId }),
  llmSelect: (selection) => ipcRenderer.invoke('llm:select', selection),
  llmTest: (providerId, modelId) => ipcRenderer.invoke('llm:test', { providerId, modelId }),
  skillsList: () => ipcRenderer.invoke('skills:list'),
  skillSetEnabled: (id, enabled, custom = false) => ipcRenderer.invoke('skills:set-enabled', { id, enabled, custom }),
  skillAddCustom: (skill) => ipcRenderer.invoke('skills:add-custom', { skill }),
  skillDeleteCustom: (id) => ipcRenderer.invoke('skills:delete-custom', { id }),
  comfyUIStatus: () => ipcRenderer.invoke('comfyui:status'),
  comfyUIStart: () => ipcRenderer.invoke('comfyui:start'),
  comfyUISelectRoot: () => ipcRenderer.invoke('comfyui:select-root'),
  comfyUISetBaseUrl: (baseUrl) => ipcRenderer.invoke('comfyui:set-base-url', { baseUrl }),
  comfyUIReset: () => ipcRenderer.invoke('comfyui:reset'),
  comfyUIDownloadPortable: (kind) => ipcRenderer.invoke('comfyui:download-portable', { kind }),
  comfyUIImageData: (image) => ipcRenderer.invoke('comfyui:image-data', image),
  comfyUISaveImage: (image) => ipcRenderer.invoke('comfyui:save-image', image),
  comfyUIShowImage: (image) => ipcRenderer.invoke('comfyui:show-image', image),
  comfyUIRecentImages: () => ipcRenderer.invoke('comfyui:recent-images'),

  onComfyUIStatus: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('comfyui:status', handler);
    return () => ipcRenderer.removeListener('comfyui:status', handler);
  },

  onComfyUIDownloadProgress: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('comfyui:download-progress', handler);
    return () => ipcRenderer.removeListener('comfyui:download-progress', handler);
  },

  // Agent event listeners
  onAgentStatus: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('agent:status', handler);
    return () => ipcRenderer.removeListener('agent:status', handler);
  },
  onAgentStep: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('agent:step', handler);
    return () => ipcRenderer.removeListener('agent:step', handler);
  },
  onAgentToolCall: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('agent:tool-call', handler);
    return () => ipcRenderer.removeListener('agent:tool-call', handler);
  },
  onAgentToolResult: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('agent:tool-result', handler);
    return () => ipcRenderer.removeListener('agent:tool-result', handler);
  },
  onAgentMessage: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('agent:message', handler);
    return () => ipcRenderer.removeListener('agent:message', handler);
  },
  onAgentError: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('agent:error', handler);
    return () => ipcRenderer.removeListener('agent:error', handler);
  },
  onAgentPlan: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('agent:plan', handler);
    return () => ipcRenderer.removeListener('agent:plan', handler);
  },
  onAgentTask: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('agent:task', handler);
    return () => ipcRenderer.removeListener('agent:task', handler);
  },
  onAgentTrace: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('agent:trace', handler);
    return () => ipcRenderer.removeListener('agent:trace', handler);
  },
  onAgentProgress: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('agent:progress', handler);
    return () => ipcRenderer.removeListener('agent:progress', handler);
  },
  onDirectStatus: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('direct:status', handler);
    return () => ipcRenderer.removeListener('direct:status', handler);
  },
  onDirectProgress: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('direct:progress', handler);
    return () => ipcRenderer.removeListener('direct:progress', handler);
  },
  onAgentFeedback: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('agent:feedback', handler);
    return () => ipcRenderer.removeListener('agent:feedback', handler);
  },
});
