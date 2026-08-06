import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionManager } from '../src/agent/runtime/session-manager.mjs';

test('session manager isolates conversations and shares project state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'comfy-session-'));
  try {
    const manager = new SessionManager(dir);
    await manager.init();
    assert.equal(manager.getProject(manager.activeProjectId).isDefault, true);
    const projectId = manager.activeProjectId;
    const firstSession = manager.activeSessionId;
    manager.conversation.add('user', 'first');
    manager.project.set('workflow', 'shared.json');
    manager.setSessionState({ phase: 'awaiting_clarification', lastIntent: 'generate', pending: { request: '生成一张图' } });

    const second = await manager.createSession('Second');
    assert.equal(manager.conversation.length, 0);
    assert.equal(manager.project.get('workflow'), 'shared.json');
    manager.conversation.add('user', 'second');

    await manager.activate(projectId, firstSession);
    assert.equal(manager.conversation.messages[0].content, 'first');
    assert.equal(manager.getSessionState().phase, 'awaiting_clarification');
    await manager.activate(projectId, second.id);
    assert.equal(manager.conversation.messages[0].content, 'second');

    const restored = new SessionManager(dir);
    await restored.init();
    assert.equal(restored.activeSessionId, second.id);
    assert.equal(restored.project.get('workflow'), 'shared.json');
    assert.equal(restored.conversation.messages[0].content, 'second');
    assert.equal(restored.getSessionState().phase, 'idle');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('migrates legacy project and conversation files into default slots', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'comfy-session-migrate-'));
  try {
    await writeFile(join(dir, 'projects.json'), JSON.stringify({ project: { current: {
      workflow: 'legacy.json',
      lastPrompt: 'legacy prompt',
      lastGenerationSource: 'direct',
    } } }));
    await writeFile(join(dir, 'conversations.json'), JSON.stringify({ messages: [{ role: 'user', content: 'legacy', ts: 1 }] }));
    const manager = new SessionManager(dir);
    await manager.init();
    assert.equal(manager.projects.length, 1);
    assert.equal(manager.project.get('workflow'), 'legacy.json');
    assert.equal(manager.project.get('lastPrompt'), 'legacy prompt');
    assert.equal(manager.getSessionState().lastGenerationSource, 'direct');
    assert.equal(manager.conversation.messages[0].content, 'legacy');
    const stored = JSON.parse(await readFile(join(dir, 'conversations.json'), 'utf8'));
    assert.ok(stored.conversations[manager.activeProjectId][manager.activeSessionId]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('renames sessions and persists project assets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'comfy-session-assets-'));
  try {
    const manager = new SessionManager(dir);
    await manager.init();
    const projectId = manager.activeProjectId;
    const sessionId = manager.activeSessionId;
    await manager.renameSession(sessionId, 'Renamed');
    manager.project.set('assets', [{ filename: 'one.png', type: 'project', projectId }]);
    await manager._persistAll();

    const restored = new SessionManager(dir);
    await restored.init();
    assert.equal(restored.getProject(projectId).sessions[0].title, 'Renamed');
    assert.equal(restored.project.get('assets')[0].filename, 'one.png');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('keeps recent generation state with its session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'comfy-session-generation-'));
  try {
    const manager = new SessionManager(dir);
    await manager.init();
    const projectId = manager.activeProjectId;
    const firstSessionId = manager.activeSessionId;
    manager.project.set('lastPrompt', 'first prompt');
    manager.project.set('lastCompiledPrompt', { positive: 'first prompt', negative: 'bad anatomy' });
    manager.project.set('lastImages', [{ filename: 'first.png', sessionId: firstSessionId }]);
    manager.project.set('lastGenerationSource', 'direct');

    const second = await manager.createSession('Second');
    assert.equal(manager.project.get('lastPrompt'), '');
    assert.equal(manager.getSessionState().lastGenerationSource, '');

    await manager.activate(projectId, firstSessionId);
    assert.equal(manager.project.get('lastPrompt'), 'first prompt');
    assert.equal(manager.project.get('lastCompiledPrompt').negative, 'bad anatomy');
    assert.equal(manager.getSessionState().lastGenerationSource, 'direct');

    await manager.activate(projectId, second.id);
    const restored = new SessionManager(dir);
    await restored.init();
    assert.equal(restored.activeSessionId, second.id);
    assert.equal(restored.project.get('lastPrompt'), '');
    assert.equal(restored.getSessionState().lastGenerationSource, '');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('migrates legacy recent generation state into the active session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'comfy-session-generation-migrate-'));
  try {
    const projectId = 'project_legacy';
    const sessionId = 'session_legacy';
    await writeFile(join(dir, 'projects.json'), JSON.stringify({
      projects: [{
        id: projectId,
        name: 'Legacy',
        dir: '',
        workflow: '',
        lastPrompt: 'legacy prompt',
        lastCompiledPrompt: { positive: 'legacy prompt', negative: 'bad anatomy' },
        lastImages: [{ filename: 'legacy.png', sessionId }],
        lastGenerationSource: 'direct',
        assets: [],
        sessions: [{ id: sessionId, title: 'Legacy session' }],
      }],
      activeProjectId: projectId,
      activeSessionId: sessionId,
    }));
    await writeFile(join(dir, 'conversations.json'), JSON.stringify({ conversations: {}, sessionStates: {} }));

    const manager = new SessionManager(dir);
    await manager.init();
    assert.equal(manager.project.get('lastPrompt'), 'legacy prompt');
    assert.equal(manager.getSessionState().lastGenerationSource, 'direct');
    assert.equal(manager.getProject(projectId).lastPrompt, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('removes deleted session assets from the project asset index', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'comfy-session-delete-assets-'));
  try {
    const manager = new SessionManager(dir);
    await manager.init();
    const projectId = manager.activeProjectId;
    const firstSessionId = manager.activeSessionId;
    const second = await manager.createSession('Second');
    manager.getProject(projectId).assets = [
      { filename: 'first.png', sessionId: firstSessionId },
      { filename: 'second.png', sessionId: second.id },
    ];

    await manager.deleteSession(firstSessionId, projectId);

    assert.deepEqual(manager.getProject(projectId).assets, [{ filename: 'second.png', sessionId: second.id }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
