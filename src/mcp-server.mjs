import { createMcpHttpServer, createWebMcpServer, runMcpStdio } from './agent/mcp/web-server.mjs';

const server = createWebMcpServer();

if (process.env.COMFY_AGENT_MCP_TRANSPORT === 'http') {
  const port = Number(process.env.COMFY_AGENT_MCP_PORT || 3000);
  const host = process.env.COMFY_AGENT_MCP_HOST || '127.0.0.1';
  const transport = createMcpHttpServer(server, { host, port, authToken: process.env.COMFY_AGENT_MCP_TOKEN || '' });
  const address = await transport.listen();
  console.error(`Comfy Agent MCP listening on http://${address.address}:${address.port}/mcp`);
} else {
  await runMcpStdio(server);
}
