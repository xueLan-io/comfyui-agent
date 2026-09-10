import assert from 'node:assert/strict';
import test from 'node:test';
import { validateExternalSkill, normalizeExternalSkill } from '../src/agent/skills/external.mjs';
import { registerSkillsIpc } from '../electron/ipc/skills.mjs';
import { registerMcpIpc } from '../electron/ipc/mcp.mjs';

const baseSkill = {
  id: 'comic-panel',
  name: '漫画分镜',
  description: '分镜式漫画生成',
  keywords: ['comic', '漫画分镜'],
};

// The settings form initializes workflowName to '' (it is optional: empty
// means "use the currently selected workflow"); validation must accept it.
test('external skill accepts an empty optional workflowName', () => {
  const result = validateExternalSkill({ ...baseSkill, target: { tool: 'comfyui', workflowName: '', promptMode: 'anime' } });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  const normalized = normalizeExternalSkill({ ...baseSkill, target: { workflowName: '' } });
  assert.equal(normalized.target.workflowName, '');
});

test('external skill still rejects unsafe workflow names', () => {
  for (const bad of ['..\\..\\evil.json', '/etc/passwd', 'a/b.json', 'x:y.json']) {
    const result = validateExternalSkill({ ...baseSkill, target: { workflowName: bad } });
    assert.equal(result.valid, false, `expected rejection for ${bad}`);
  }
});

// The IPC domains register at module load while prefStore is only created in
// app.whenReady(); they must resolve the store lazily through getPrefStore.
function captureHandlers() {
  const handlers = new Map();
  return { ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) }, handlers };
}

function stubPrefStore(data) {
  return {
    get: key => data[key],
    set: (key, value) => { data[key] = value; },
  };
}

test('skills IPC resolves prefStore lazily via getPrefStore', async () => {
  const { ipcMain, handlers } = captureHandlers();
  let store = null; // assigned "later", like app.whenReady()
  registerSkillsIpc({
    ipcMain,
    getPrefStore: () => store,
    configureSkills: () => {},
    skillManifest: () => [],
    BUILTIN_SKILLS: { txt2img: {} },
    createCustomSkill: item => item,
    normalizeExternalSkill,
    externalSkillConfig: skill => ({ ...skill }),
    loadExternalSkillFile: async () => ({}),
    dialog: {},
    getMainWindow: () => ({}),
  });
  const invoke = (channel, payload) => handlers.get(channel)({}, payload);

  store = stubPrefStore({ skills: { system: {}, custom: [], external: [] } });
  const list = await invoke('skills:list');
  assert.ok(Array.isArray(list.registry));
  assert.equal(list.external.length, 0);

  await invoke('skills:add-external', { ...baseSkill, target: { workflowName: '' } });
  assert.equal(store.get('skills').external.length, 1);
});

test('mcp IPC resolves prefStore lazily via getPrefStore', async () => {
  const { ipcMain, handlers } = captureHandlers();
  let store = null;
  registerMcpIpc({
    ipcMain,
    getPrefStore: () => store,
    mcpModuleFlags: modules => ({ web: true, files: true, comfyui: true, skills: true, ...modules }),
    restartEmbeddedMcp: async () => {},
  });
  const invoke = (channel, payload) => handlers.get(channel)({}, payload);

  store = stubPrefStore({ mcp: { enabled: true, host: '127.0.0.1', port: 3333 } });
  const settings = await invoke('mcp:settings');
  assert.equal(settings.enabled, true);
  assert.equal(settings.port, 3333);
});
