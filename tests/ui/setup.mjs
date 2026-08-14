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
