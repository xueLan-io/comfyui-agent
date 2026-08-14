// Renderer test environment: stub the Electron bridge so components can mount
// in jsdom without a real main process.

// React 18: mark the environment as act-aware so createRoot renders under act()
// do not emit "not configured to support act(...)" warnings.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const projectState = {
  projects: [{ id: 'project-a', name: 'Project A' }],
  activeProjectId: 'project-a',
  activeSessionId: 'session-1',
  messages: [],
  project: { id: 'project-a' },
  sessionState: {},
};

// Every electronAPI method resolves by default; targeted stubs below return
// the shapes the tested providers/components depend on.
const electronAPI = {
  projectsList: async () => projectState,
  projectCreate: async () => projectState,
  projectRename: async () => projectState,
  projectDelete: async () => projectState,
  sessionCreate: async () => projectState,
  sessionDelete: async () => projectState,
  sessionRename: async () => projectState,
  sessionActivate: async () => projectState,
  onProjectState: () => () => {},
  promptSettings: async () => ({ enabled: false, strategy: 'append', text: '' }),
  promptSaveSettings: async () => ({}),
  uiPreferences: async () => ({ language: 'zh-CN' }),
  memoryGetState: async () => ({
    profile: { styles: ['冷色系'], disliked: [], notes: [], workflows: { 'anima.json': 3 } },
    characterCards: [{ name: 'Alice', description: '蓝发双马尾', appearance: '蓝发', outfit: '校服', pose: '', tags: ['anime'], notes: '', updatedAt: 1 }],
    segments: [{ id: 'm1', createdAt: Date.now(), workflowName: 'anima.json', summary: { objective: '生成夜色车站插画', facts: ['用户偏好冷色系'] } }],
    segmentCount: 1,
  }),
  memorySetProfile: async () => ({ profile: { styles: ['冷色系'], disliked: [], notes: [], workflows: {} } }),
  memoryUpsertCharacterCard: async () => ({}),
  memoryDeleteCharacterCard: async () => true,
  memoryClear: async () => null,
  memoryExport: async () => '{}',
  appSaveTextFile: async () => true,
  listWorkflows: async () => ['anima.json', 'flux.json'],
  batchList: async () => [
    {
      id: 'batch_1', title: '夜晚车站系列', projectId: 'project-a', workflowName: 'anima.json',
      status: 'completed', progress: { total: 2, done: 2, completed: 2, failed: 0, cancelled: 0 },
      jobs: [
        { index: 0, id: 'job_1', status: 'completed', seed: 42, score: 95, result: { images: [{ path: 'out_1.png', name: 'out_1.png' }] } },
        { index: 1, id: 'job_2', status: 'completed', seed: 1337, score: 60, result: { images: [{ path: 'out_2.png', name: 'out_2.png' }] } },
      ],
    },
  ],
  batchCreate: async () => ({ id: 'batch_new', jobs: [] }),
  batchStart: async () => ({}),
  batchResume: async () => ({}),
  batchPause: async () => ({}),
  batchCancel: async () => ({}),
  batchRetryJob: async () => ({}),
  batchCurate: async () => ({ scored: 2, top: [{ index: 0, score: 95 }] }),
  onBatchEvent: () => () => {},
  pluginsList: async () => ({
    plugins: [
      { pluginId: 'hello', name: 'Hello', version: '1.0.0', capabilities: ['tools'], state: 'started', enabled: true, signed: true },
    ],
    errors: [{ pluginId: 'bad', error: 'Missing manifest field: version' }],
  }),
  pluginsEnable: async () => ({}),
  pluginsRemove: async () => ({}),
};

window.electronAPI = new Proxy(electronAPI, {
  get(target, prop) {
    if (prop in target) return target[prop];
    if (typeof prop === 'string') return async () => ({});
    return undefined;
  },
});

if (!window.matchMedia) {
  window.matchMedia = query => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}
