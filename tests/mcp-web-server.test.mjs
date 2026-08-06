import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';
import { createMcpHttpServer, createSkillMcpTools, createWebMcpServer, runMcpStdio } from '../src/agent/mcp/web-server.mjs';

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
