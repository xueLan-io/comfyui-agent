import { createMcpHttpServer, createWebMcpServer, runMcpStdio } from './agent/mcp/web-server.mjs';

const server = createWebMcpServer();

if (process.env.COMFY_AGENT_MCP_TRANSPORT === 'http') {
  const authToken = process.env.COMFY_AGENT_MCP_TOKEN || '';
  if (!authToken) {
    // With requireAuth and no token every request would be rejected with 401,
    // making the server a silent black hole — fail loudly instead.
    console.error('HTTP 传输需要在环境变量 COMFY_AGENT_MCP_TOKEN 中配置 Bearer 令牌后再启动。');
    process.exit(1);
  }
  const port = Number(process.env.COMFY_AGENT_MCP_PORT || 3000);
  const host = process.env.COMFY_AGENT_MCP_HOST || '127.0.0.1';
  const transport = createMcpHttpServer(server, { host, port, authToken });
  const address = await transport.listen();
  console.error(`Comfy Agent MCP listening on http://${address.address}:${address.port}/mcp`);
} else {
  await runMcpStdio(server);
}
