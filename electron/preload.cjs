const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  windowMinimize: () => ipcRenderer.invoke('window:minimize'),
  windowToggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
  windowIsMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  windowClose: () => ipcRenderer.invoke('window:close'),
  windowHide: () => ipcRenderer.invoke('window:hide'),
  appVersion: () => ipcRenderer.invoke('app:version'),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', { url }),
  updateCheck: () => ipcRenderer.invoke('app:update-check'),
  updateDownload: (manifest) => ipcRenderer.invoke('app:update-download', manifest),
  updateInstall: () => ipcRenderer.invoke('app:update-install'),
  updateState: () => ipcRenderer.invoke('app:update-state'),
  floatingShow: () => ipcRenderer.invoke('floating:show'),
  floatingHide: () => ipcRenderer.invoke('floating:hide'),
  floatingClose: () => ipcRenderer.invoke('floating:close'),
  floatingShowMain: () => ipcRenderer.invoke('floating:show-main'),
  floatingResize: (collapsed) => ipcRenderer.invoke('floating:resize', { collapsed }),
  floatingPosition: () => ipcRenderer.invoke('floating:position'),
  floatingMove: (deltaX, deltaY) => ipcRenderer.invoke('floating:move', { deltaX, deltaY }),
  floatingMoveStart: (clientX, clientY, token) => ipcRenderer.invoke('floating:move-start', { clientX, clientY, token }),
  floatingMoveAt: (clientX, clientY, token) => ipcRenderer.invoke('floating:move-at', { clientX, clientY, token }),
  floatingMoveEnd: (token) => ipcRenderer.invoke('floating:move-end', { token }),
  floatingDragStart: (payload) => ipcRenderer.invoke('floating:drag-start', payload),
  floatingDragMove: (point) => ipcRenderer.invoke('floating:drag-move', point),
  floatingDragEnd: (point) => ipcRenderer.invoke('floating:drag-end', point),
  floatingDragCancel: (dragId) => ipcRenderer.invoke('floating:drag-cancel', { dragId }),

  // Legacy ComfyUI workflow API
  listWorkflows: () => ipcRenderer.invoke('list-workflows'),
  selectWorkflowDir: () => ipcRenderer.invoke('select-workflow-dir'),
  showWorkflowDir: (workflowName) => ipcRenderer.invoke('show-workflow-dir', { workflowName }),
  importWorkflows: (paths) => ipcRenderer.invoke('import-workflows', { paths }),
  selectWorkflowFiles: () => ipcRenderer.invoke('select-workflow-files'),
  workflowDelete: (name) => ipcRenderer.invoke('workflow:delete', { name }),
  workflowRename: (name, nextName) => ipcRenderer.invoke('workflow:rename', { name, nextName }),
  getPathForFile: (file) => webUtils.getPathForFile(file),
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
  agentListRequestStatus: (options = {}) => ipcRenderer.invoke('agent:list-request-status', options),
  agentRecoverTasks: () => ipcRenderer.invoke('agent:recover-tasks'),
  agentMonitorTask: (taskId) => ipcRenderer.invoke('agent:monitor-task', { taskId }),
  agentRetryRecovery: (taskId) => ipcRenderer.invoke('agent:retry-recovery', { taskId }),
  agentArchiveTask: (taskId) => ipcRenderer.invoke('agent:archive-task', { taskId }),
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
  globalPresetsList: () => ipcRenderer.invoke('global-presets:list'),
  globalPresetCreate: (input) => ipcRenderer.invoke('global-presets:create', input),
  globalPresetUpdate: (id, patch) => ipcRenderer.invoke('global-presets:update', { id, patch }),
  globalPresetDelete: (id) => ipcRenderer.invoke('global-presets:delete', { id }),
  globalPresetCopy: (id) => ipcRenderer.invoke('global-presets:copy', { id }),
  globalPresetMarkUsed: (id, generated = false) => ipcRenderer.invoke('global-presets:mark-used', { id, generated }),
  globalPresetRate: (id, rating) => ipcRenderer.invoke('global-presets:rate', { id, rating }),
  globalPresetReplaceModel: (id, from, to) => ipcRenderer.invoke('global-presets:replace-model', { id, from, to }),
  globalPresetCompose: (ids, title = '') => ipcRenderer.invoke('global-presets:compose', { ids, title }),
  globalPresetMatchWorkflow: (workflowName) => ipcRenderer.invoke('global-presets:match-workflow', { workflowName }),
  globalPresetSelectCover: () => ipcRenderer.invoke('global-presets:select-cover'),
  globalPresetSelectImport: () => ipcRenderer.invoke('global-presets:select-import'),
  globalPresetCopyCover: (id, sourcePath) => ipcRenderer.invoke('global-presets:copy-cover', { id, sourcePath }),
  globalPresetImageData: (cover) => ipcRenderer.invoke('global-presets:image-data', cover),
  globalPresetImport: (sourcePath) => ipcRenderer.invoke('global-presets:import', { sourcePath }),
  globalPresetExport: (id) => ipcRenderer.invoke('global-presets:export', { id }),
  globalPresetResolveResources: (preset) => ipcRenderer.invoke('global-presets:resolve-resources', { preset }),
  globalPresetCheckDependencies: (id) => ipcRenderer.invoke('global-presets:check-dependencies', { id }),
  uiPreferences: () => ipcRenderer.invoke('ui:preferences'),
  reportRendererError: details => ipcRenderer.send('renderer:error', details),
  uiSavePreferences: (preferences) => ipcRenderer.invoke('ui:save-preferences', preferences),
  researchSettings: () => ipcRenderer.invoke('research:settings'),
  researchSaveSettings: (settings) => ipcRenderer.invoke('research:save-settings', settings),
  mcpSettings: () => ipcRenderer.invoke('mcp:settings'),
  mcpSaveSettings: (settings) => ipcRenderer.invoke('mcp:save-settings', settings),
  llmProviders: () => ipcRenderer.invoke('llm:providers'),
  llmSaveProvider: (provider) => ipcRenderer.invoke('llm:save-provider', { provider }),
  llmDeleteProvider: (providerId) => ipcRenderer.invoke('llm:delete-provider', { providerId }),
  llmSelect: (selection) => ipcRenderer.invoke('llm:select', selection),
  llmMediaPolicy: (allowMediaToCloud) => ipcRenderer.invoke('llm:media-policy', { allowMediaToCloud }),
  llmTest: (provider, modelId) => ipcRenderer.invoke('llm:test', { provider, modelId }),
  imageGenerate: (prompt, options = {}) => ipcRenderer.invoke('image:generate', { prompt, ...options }),
  imageCancel: (requestId) => ipcRenderer.invoke('image:cancel', { requestId }),
  skillsList: () => ipcRenderer.invoke('skills:list'),
  skillSetEnabled: (id, enabled, custom = false, external = false) => ipcRenderer.invoke('skills:set-enabled', { id, enabled, custom, external }),
  skillAddCustom: (skill) => ipcRenderer.invoke('skills:add-custom', { skill }),
  skillDeleteCustom: (id) => ipcRenderer.invoke('skills:delete-custom', { id }),
  skillImportExternal: () => ipcRenderer.invoke('skills:import-external'),
  skillDeleteExternal: (id) => ipcRenderer.invoke('skills:delete-external', { id }),
  comfyUIStatus: () => ipcRenderer.invoke('comfyui:status'),
  h3Readiness: () => ipcRenderer.invoke('h3:readiness'),
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
  onUpdateProgress: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('app:update-progress', handler);
    return () => ipcRenderer.removeListener('app:update-progress', handler);
  },

  onProjectState: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('project:state', handler);
    return () => ipcRenderer.removeListener('project:state', handler);
  },

  onFloatingDrag: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('floating:drag', handler);
    return () => ipcRenderer.removeListener('floating:drag', handler);
  },

  // Agent event listeners
  onAgentStatus: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('agent:status', handler);
    return () => ipcRenderer.removeListener('agent:status', handler);
  },
  onAgentContextUsage: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('agent:context-usage', handler);
    return () => ipcRenderer.removeListener('agent:context-usage', handler);
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
