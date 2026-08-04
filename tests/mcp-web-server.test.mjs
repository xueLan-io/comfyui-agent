import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebMcpServer } from '../src/agent/mcp/web-server.mjs';

test('MCP web adapter exposes the three research tools', async () => {
  const server = createWebMcpServer({ webTool: { execute: async () => ({}) } });
  const result = await server.handle({ method: 'tools/list' });
  assert.deepEqual(result.tools.map(tool => tool.name), ['web_search', 'web_open', 'character_research']);
});

test('MCP web calls reuse the WebTool contract', async () => {
  const calls = [];
  const server = createWebMcpServer({ webTool: { async execute(input) { calls.push(input); return { action: input.action, results: [] }; } } });
  const result = await server.handle({ id: 1, method: 'tools/call', params: { name: 'web_search', arguments: { query: 'Hero' } } });
  assert.equal(JSON.parse(result.content[0].text).action, 'search');
  assert.deepEqual(calls, [{ action: 'search', query: 'Hero' }]);
});

test('MCP initialize is transport-only and does not alter Agent behavior', async () => {
  const server = createWebMcpServer({ webTool: { execute: async () => ({}) } });
  const result = await server.handle({ id: 1, method: 'initialize' });
  assert.equal(result.serverInfo.name, 'comfy-agent-web');
  assert.deepEqual(await server.handle({ method: 'notifications/initialized' }), {});
});
