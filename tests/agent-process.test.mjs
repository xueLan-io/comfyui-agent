import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentProcessClient } from '../electron/agent-process.mjs';

test('agent process exposes only the allowlisted RPC surface', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'comfy-agent-process-'));
  const client = new AgentProcessClient({ useJobObject: false, rpcTimeoutMs: 30000 });
  t.after(async () => {
    await client.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  await client.start({
    llm: { provider: 'openai-compatible', model: '' },
    research: { allowNetwork: false },
    workflowDir: dataDir,
    userDataPath: dataDir,
    comfyRoot: dataDir,
    comfyBaseUrl: 'http://127.0.0.1:8188',
    skills: {},
  });

  assert.equal(client.state, 'idle');
  assert.equal(client.sessionManager.projects.length, 1);
  const project = await client.createProject({ name: 'Isolated' });
  assert.equal(project.project.name, 'Isolated');
  assert.equal(client.sessionManager.getActiveProject().name, 'Isolated');

  await assert.rejects(
    () => client.call('process.exit', []),
    error => error.code === 'AGENT_RPC_FAILED' && /not allowed/i.test(error.message),
  );
});

test('agent RPC waits for a concurrently starting worker', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'comfy-agent-process-start-'));
  const client = new AgentProcessClient({ useJobObject: false, rpcTimeoutMs: 3000 });
  t.after(async () => {
    await client.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  const starts = [client.start({ workflowDir: dataDir, userDataPath: dataDir, comfyRoot: dataDir, skills: {} }), client.start({ workflowDir: dataDir, userDataPath: dataDir, comfyRoot: dataDir, skills: {} })];
  await Promise.all([starts[0], starts[1], client.setPromptMode('raw')]);
  assert.equal(client.state, 'idle');
});

test('agent process forwards events and stops cleanly', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'comfy-agent-process-events-'));
  const client = new AgentProcessClient({ useJobObject: false, rpcTimeoutMs: 30000 });
  t.after(async () => {
    await client.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  await client.start({
    llm: { provider: 'openai-compatible', model: '' },
    workflowDir: dataDir,
    userDataPath: dataDir,
    comfyRoot: dataDir,
    comfyBaseUrl: 'http://127.0.0.1:8188',
    skills: {},
  });
  await client.setPromptMode('raw');
  assert.equal(client.child?.connected, true);
  await client.stop();
  assert.equal(client.child, null);
});

test('Windows Job Object host can attach to the agent process', async t => {
  if (process.platform !== 'win32') {
    t.skip('Windows Job Object is only available on Windows');
    return;
  }
  const dataDir = await mkdtemp(join(tmpdir(), 'comfy-agent-job-'));
  const client = new AgentProcessClient({ rpcTimeoutMs: 30000 });
  t.after(async () => {
    await client.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  await client.start({
    llm: { provider: 'openai-compatible', model: '' },
    research: { allowNetwork: false },
    workflowDir: dataDir,
    userDataPath: dataDir,
    comfyRoot: dataDir,
    comfyBaseUrl: 'http://127.0.0.1:8188',
    skills: {},
  });
  assert.equal(client.jobHost?.killed, false);
});
