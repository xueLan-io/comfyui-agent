import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionManager } from '../src/agent/runtime/session-manager.mjs';
import { assetRecipePath, scanProjectAssets } from '../src/runtime/project-assets.mjs';

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

test('session manager can create a session without activating it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'comfy-session-'));
  try {
    const manager = new SessionManager(dir);
    await manager.init();
    const projectId = manager.activeProjectId;
    const activeSessionId = manager.activeSessionId;
    const created = await manager.createSession('Background session', projectId, { activate: false });
    assert.equal(manager.activeProjectId, projectId);
    assert.equal(manager.activeSessionId, activeSessionId);
    assert.ok(manager.getProject(projectId).sessions.some(session => session.id === created.id));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('session state uses a monotonic revision for snapshot synchronization', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'comfy-session-revision-'));
  try {
    const manager = new SessionManager(dir);
    await manager.init();
    const initial = manager.getSessionState();
    const next = manager.setSessionState({ requestId: 'request-1', taskStatus: 'executing' });
    assert.ok(next.revision > initial.revision);
    assert.ok(next.updatedAt >= initial.updatedAt);
    assert.equal(next.requestId, 'request-1');
    await manager.flush();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('execution events persist with their conversation turn', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'comfy-session-execution-'));
  try {
    const manager = new SessionManager(dir);
    await manager.init();
    manager.appendExecutionEvent({ turnId: 'turn_1', type: 'agent:step', stepId: 'plan', status: 'completed', description: 'Created plan' });
    await manager.flush();

    const restored = new SessionManager(dir);
    await restored.init();
    assert.equal(restored.getSessionState().executionRecords.turn_1[0].description, 'Created plan');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('flush preserves rapid conversation and execution updates before restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'comfy-session-flush-'));
  try {
    const manager = new SessionManager(dir);
    await manager.init();
    const projectId = manager.activeProjectId;
    const sessionId = manager.activeSessionId;

    for (let index = 1; index <= 12; index++) {
      manager.conversation.add('user', `message ${index}`, { turnId: `turn_${index}`, messageId: `turn_${index}:user` });
      manager.appendExecutionEvent({ turnId: `turn_${index}`, type: 'agent:step', stepId: `step_${index}`, status: 'completed', description: `Completed ${index}` });
    }
    await manager.flush();

    const restored = new SessionManager(dir);
    await restored.init();
    assert.equal(restored.activeProjectId, projectId);
    assert.equal(restored.activeSessionId, sessionId);
    assert.equal(restored.conversation.messages.length, 12);
    assert.equal(restored.conversation.messages.at(-1).content, 'message 12');
    assert.equal(restored.getSessionState().executionRecords.turn_12[0].description, 'Completed 12');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('execution history ignores empty and duplicate plan events', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'comfy-session-execution-filter-'));
  try {
    const manager = new SessionManager(dir);
    await manager.init();
    manager.appendExecutionEvent({ turnId: 'turn_1', type: 'agent:plan', plan: { steps: [] } });
    manager.appendExecutionEvent({ turnId: 'turn_1', taskId: 'task_1', type: 'agent:plan', plan: { steps: [{ id: 'step_1' }] } });
    manager.appendExecutionEvent({ turnId: 'turn_1', taskId: 'task_1', type: 'agent:plan', plan: { steps: [{ id: 'step_1' }] } });
    assert.equal(manager.getSessionState().executionRecords.turn_1.length, 1);
    await manager.flush();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('execution history retains distinct retry attempts after restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'comfy-session-execution-retry-'));
  try {
    const manager = new SessionManager(dir);
    await manager.init();
    const base = { turnId: 'turn_retry', taskId: 'task_retry', traceId: 'trace_retry', type: 'agent:step', stepId: 'generate', tool: 'comfyui', status: 'running' };
    manager.appendExecutionEvent({ ...base, attemptId: 'task_retry_attempt_1', attempt: 1, description: 'First attempt' });
    manager.appendExecutionEvent({ ...base, attemptId: 'task_retry_attempt_2', attempt: 2, description: 'Second attempt' });
    await manager.flush();

    const restored = new SessionManager(dir);
    await restored.init();
    const events = restored.getSessionState().executionRecords.turn_retry;
    assert.equal(events.length, 2);
    assert.deepEqual(events.map(event => event.attempt), [1, 2]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('execution history retains a long task chain after restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'comfy-session-execution-long-'));
  try {
    const manager = new SessionManager(dir);
    await manager.init();
    for (let index = 0; index < 60; index++) {
      manager.appendExecutionEvent({
        turnId: 'turn_long',
        taskId: 'task_long',
        traceId: 'trace_long',
        type: 'agent:step',
        stepId: `step_${index}`,
        tool: 'comfyui',
        status: 'completed',
      });
    }
    await manager.flush();

    const restored = new SessionManager(dir);
    await restored.init();
    assert.equal(restored.getSessionState().executionRecords.turn_long.length, 60);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('project generation writes also advance the active session revision', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'comfy-session-project-revision-'));
  try {
    const manager = new SessionManager(dir);
    await manager.init();
    const before = manager.getSessionState().revision;
    await manager.project.set('lastPrompt', 'revision-bound prompt');
    assert.ok(manager.getSessionState().revision > before);
    await manager.flush();
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
    await manager.flush();
    await restored.flush();
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

test('preserves generation metadata when an empty completion patch arrives', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'comfy-session-generation-merge-'));
  try {
    const manager = new SessionManager(dir);
    await manager.init();
    const requestId = 'request-generation-merge';
    manager.upsertGenerationRecord({
      requestId,
      prompt: 'complete prompt',
      negative: 'bad anatomy',
      workflowName: 'workflow.json',
      parameters: { seed: 12, steps: 20 },
    });
    const merged = manager.upsertGenerationRecord({
      requestId,
      prompt: '',
      negative: '',
      workflowName: '',
      parameters: {},
      status: 'completed',
    });

    assert.equal(merged.prompt, 'complete prompt');
    assert.equal(merged.negative, 'bad anatomy');
    assert.equal(merged.workflowName, 'workflow.json');
    assert.deepEqual(merged.parameters, { seed: 12, steps: 20 });
    assert.equal(merged.status, 'completed');
    await manager.flush();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('keeps recipe metadata available after deleting its session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'comfy-session-delete-assets-recipe-'));
  try {
    const projectDir = join(dir, 'project');
    const manager = new SessionManager(dir, { defaultProjectDir: projectDir });
    await manager.init();
    const projectId = manager.activeProjectId;
    const sessionId = manager.activeSessionId;
    await manager.createSession('Keep');
    const project = manager.getProject(projectId);
    const image = join(project.dir, 'images', 'task-persisted', 'portrait.png');
    await mkdir(join(project.dir, 'images', 'task-persisted'), { recursive: true });
    await writeFile(image, 'image');
    await writeFile(assetRecipePath(image), JSON.stringify({
      positive: 'persistent portrait',
      negative: 'blurry',
      workflowName: 'anima.json',
      parameters: { seed: 12, steps: 20 },
      source: 'ai',
    }));
    project.assets = [{
      filename: 'portrait.png',
      subfolder: 'images/task-persisted',
      taskId: 'task-persisted',
      sessionId,
      positive: 'persistent portrait',
      negative: 'blurry',
      workflowName: 'anima.json',
      parameters: { seed: 12, steps: 20 },
    }];

    await manager.deleteSession(sessionId, projectId);

    const assets = await scanProjectAssets({ project: manager.getProject(projectId) });
    assert.equal(assets.length, 1);
    assert.equal(assets[0].positive, 'persistent portrait');
    assert.equal(assets[0].negative, 'blurry');
    assert.equal(assets[0].workflowName, 'anima.json');
    assert.deepEqual(assets[0].parameters, { seed: 12, steps: 20 });
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
