import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';
import { createGenerationTools, createMcpHttpServer, createSkillMcpTools, createWebMcpServer, runMcpStdio } from '../src/agent/mcp/web-server.mjs';

async function initialized(server) {
  await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
}

test('MCP exposes standard tools and normalized inputSchema', async () => {
  const server = createWebMcpServer({ webTool: { execute: async () => ({}) } });
  const result = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.ok(result.tools.some(tool => tool.name === 'web_search'));
  assert.ok(result.tools.some(tool => tool.name === 'filesystem'));
  assert.ok(result.tools.some(tool => tool.name === 'plan_txt2img'));
  assert.equal(result.tools.find(tool => tool.name === 'web_search').inputSchema.type, 'object');
  assert.equal('input_schema' in result.tools.find(tool => tool.name === 'web_search'), false);
});

test('MCP web calls reuse the WebTool contract', async () => {
  const calls = [];
  const server = createWebMcpServer({ webTool: { async execute(input) { calls.push(input); return { action: input.action, results: [] }; } } });
  const result = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'web_search', arguments: { query: 'Hero' } } });
  assert.equal(JSON.parse(result.content[0].text).action, 'search');
  assert.deepEqual(calls, [{ action: 'search', query: 'Hero' }]);
});

test('MCP initialize advertises current protocol and lifecycle', async () => {
  const server = createWebMcpServer({ webTool: { execute: async () => ({}) } });
  const result = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  assert.equal(result.protocolVersion, '2025-11-25');
  assert.equal(result.serverInfo.name, 'comfy-agent');
  assert.deepEqual(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), {});
});

test('MCP returns protocol errors for unknown methods and invalid arguments', async () => {
  const server = createWebMcpServer({ webTool: { execute: async () => ({}) } });
  await assert.rejects(() => server.handle({ jsonrpc: '2.0', id: 1, method: 'unknown' }), error => error.code === -32601);
  await assert.rejects(() => server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'web_search', arguments: {} } }), error => error.code === -32602);
});

test('skill tools only create plans and do not execute side effects', async () => {
  const [tool] = createSkillMcpTools({ demo: { name: 'demo', description: 'Demo', steps: (intent, context) => [{ tool: 'noop', input: { intent, context } }] } });
  const result = await tool.execute({ userIntent: 'make a plan', context: { safe: true } });
  assert.deepEqual(result, { skill: 'demo', steps: [{ tool: 'noop', input: { intent: 'make a plan', context: { safe: true } } }] });
});

test('MCP exposes external Skills as versioned planning targets', async () => {
  const external = {
    comic: {
      id: 'comic', external: true, name: 'Comic', description: 'External comic skill', version: '2.0',
      steps: intent => [{ tool: 'comfyui', input: { prompt: intent } }],
    },
  };
  const server = createWebMcpServer({ webTool: { execute: async () => ({}) }, skills: external, includeReadOnlyTools: false });
  const listed = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.ok(listed.tools.some(tool => tool.name === 'plan_comic'));
  const registry = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'skills_list', arguments: {} } });
  const value = JSON.parse(registry.content[0].text);
  assert.equal(value.skills[0].external, true);
  assert.equal(value.skills[0].version, '2.0');
});

test('stdio transport emits JSON-RPC responses and survives parse errors', async () => {
  const server = createWebMcpServer({ webTool: { execute: async () => ({}) }, includeReadOnlyTools: false, includeSkillTools: false });
  const chunks = [];
  const output = new Writable({ write(chunk, encoding, callback) { chunks.push(chunk.toString()); callback(); } });
  const input = Readable.from([
    '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n',
    'not-json\n',
    '{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n',
  ]);
  await runMcpStdio(server, input, output);
  const responses = chunks.map(line => JSON.parse(line));
  assert.equal(responses[0].result.serverInfo.name, 'comfy-agent');
  assert.equal(responses[1].error.code, -32700);
  assert.equal(responses[2].result.tools[0].name, 'web_search');
});

test('HTTP transport supports MCP initialize headers and bearer authentication', async () => {
  const server = createWebMcpServer({ webTool: { execute: async () => ({}) }, includeReadOnlyTools: false, includeSkillTools: false });
  const transport = createMcpHttpServer(server, { port: 0, authToken: 'secret' });
  const address = await transport.listen();
  const endpoint = `http://127.0.0.1:${address.port}/mcp`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { authorization: 'Bearer secret', accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('mcp-session-id') || '', /^mcp_/);
  assert.equal((await response.json()).result.serverInfo.name, 'comfy-agent');
  const unauthorized = await fetch(endpoint, { method: 'POST', body: '{}' });
  assert.equal(unauthorized.status, 401);
  await transport.close();
});

test('MCP generation lifecycle forwards owner and confirmation binding', async () => {
  const owner = { principalId: 'principal-1', tenantId: 'tenant-1', projectId: 'project-1', sessionId: 'session-1' };
  const calls = [];
  const generation = {
    async prepare(request) {
      calls.push(['prepare', request]);
      return { previewId: 'preview-1', requestId: request.requestId || 'request-1', requestDigest: 'sha256:digest', owner: request.owner };
    },
    async runPrepared(previewId, edits, runOwner, confirmation) {
      calls.push(['run', previewId, edits, runOwner, confirmation]);
      if (runOwner.sessionId !== owner.sessionId) throw Object.assign(new Error('owner mismatch'), { code: 'GENERATION_OWNER_MISMATCH' });
      if (confirmation.digest !== 'sha256:digest') throw Object.assign(new Error('digest mismatch'), { code: 'CONFIRMATION_DIGEST_MISMATCH' });
      return { state: 'completed', requestId: confirmation.requestId };
    },
    status: async ({ requestId, owner: statusOwner }) => ({ requestId, owner: statusOwner, state: 'completed' }),
    cancel: async ({ previewId, taskId, owner: cancelOwner }) => {
      if (!previewId && !taskId) throw Object.assign(new Error('resource required'), { code: 'RESOURCE_ID_REQUIRED' });
      return { cancelled: true, previewId, taskId, owner: cancelOwner, state: 'cancelled' };
    },
  };
  const server = createWebMcpServer({ generation, includeReadOnlyTools: false, includeSkillTools: false });
  const result = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'generation_prepare', arguments: { request: { requestId: 'request-1', positive: 'cat' } } } }, { owner });
  assert.deepEqual(JSON.parse(result.content[0].text).owner, owner);
  const run = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'generation_run_prepared', arguments: { previewId: 'preview-1', confirmation: { accepted: true, digest: 'sha256:digest', requestId: 'request-1', previewId: 'preview-1' } } } }, { owner });
  assert.equal(JSON.parse(run.content[0].text).state, 'completed');
  assert.equal(calls[0][1].owner.sessionId, 'session-1');
  assert.equal(calls[1][3].sessionId, 'session-1');
});

test('MCP generation rejects foreign owner, wrong digest, missing cancel resource, duplicate request, and busy coordinator', async () => {
  const owner = { principalId: 'p', tenantId: 't', projectId: 'project', sessionId: 'session' };
  let prepared = 0;
  let busy = false;
  const previews = new Map();
  const generation = {
    async prepare(request) {
      if (previews.has(request.requestId)) return previews.get(request.requestId);
      if (busy) throw Object.assign(new Error('busy'), { code: 'GENERATION_BUSY' });
      busy = true; prepared += 1;
      const preview = { previewId: 'preview-1', requestId: request.requestId, requestDigest: 'sha256:ok', owner: request.owner };
      previews.set(request.requestId, preview);
      return preview;
    },
    runPrepared(previewId, edits, runOwner, confirmation) {
      if (runOwner.sessionId !== owner.sessionId) throw Object.assign(new Error('foreign'), { code: 'GENERATION_OWNER_MISMATCH' });
      if (confirmation.digest !== 'sha256:ok') throw Object.assign(new Error('wrong digest'), { code: 'CONFIRMATION_DIGEST_MISMATCH' });
      return { state: 'completed' };
    },
    cancel({ previewId, taskId }) {
      if (!previewId && !taskId) throw Object.assign(new Error('missing'), { code: 'RESOURCE_ID_REQUIRED' });
      return { state: 'cancelled', cancelled: true };
    },
  };
  const server = createWebMcpServer({ generation, includeReadOnlyTools: false, includeSkillTools: false });
  const prepare = requestId => server.handle({ jsonrpc: '2.0', id: requestId, method: 'tools/call', params: { name: 'generation_prepare', arguments: { request: { requestId: 'same-request' } } } }, { owner });
  await prepare(1);
  assert.equal(JSON.parse((await prepare(2)).content[0].text).previewId, 'preview-1');
  assert.equal(prepared, 1, 'duplicate requestId is idempotent at the generation bridge');
  const foreign = await server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'generation_run_prepared', arguments: { previewId: 'preview-1', confirmation: { accepted: true, digest: 'sha256:ok', requestId: 'same-request', previewId: 'preview-1' } } } }, { owner: { ...owner, sessionId: 'other-session' } });
  assert.equal(foreign.isError, true);
  const wrongDigest = await server.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'generation_run_prepared', arguments: { previewId: 'preview-1', confirmation: { accepted: true, digest: 'sha256:bad', requestId: 'same-request', previewId: 'preview-1' } } } }, { owner });
  assert.equal(wrongDigest.isError, true);
  const missing = await server.handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'generation_cancel', arguments: {} } }, { owner });
  assert.equal(missing.isError, true);
  const busyResult = await server.handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'generation_prepare', arguments: { request: { requestId: 'another' } } } }, { owner });
  assert.equal(busyResult.isError, true);
});
