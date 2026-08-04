import { extractAppearanceFacts } from '../research/appearance.mjs';
import { normalizeResearchSettings } from '../research/settings.mjs';
import { WebTool, openResultPages } from '../tools/web/index.mjs';

const MCP_PROTOCOL_VERSION = '2024-11-05';

const TOOL_DEFINITIONS = [
  {
    name: 'web_search',
    description: 'Search public web pages with the configured domain and source policy.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, maxResults: { type: 'number' }, timeoutMs: { type: 'number' }, allowedDomains: { type: 'array' }, sourcePolicy: { type: 'object' } }, required: ['query'] },
  },
  {
    name: 'web_open',
    description: 'Open one public web page with SSRF and domain-policy checks.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' }, timeoutMs: { type: 'number' }, allowedDomains: { type: 'array' }, sourcePolicy: { type: 'object' } }, required: ['url'] },
  },
  {
    name: 'character_research',
    description: 'Search and extract cited character appearance facts.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, maxResults: { type: 'number' }, maxOpenPages: { type: 'number' }, timeoutMs: { type: 'number' }, cacheTtlMs: { type: 'number' }, allowedDomains: { type: 'array' }, officialDomains: { type: 'array' }, verifiedDomains: { type: 'array' }, communityDomains: { type: 'array' } }, required: ['query'] },
  },
];

function mcpResult(value, isError = Boolean(value?.error)) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) };
}

function researchHandler(webTool, llmProvider) {
  return async input => {
    const settings = normalizeResearchSettings(input);
    const query = String(input.query || '').trim();
    const search = await webTool.execute({ action: 'search', query, ...settings, sourcePolicy: settings });
    if (search.error) return { query, sources: [], researchStatus: search.researchStatus || 'search_failed', researchMessage: search.error };
    const pages = await openResultPages(webTool, search.results, settings);
    const sources = (search.results || []).map((item, index) => ({
      title: item.title,
      url: item.url,
      snippet: item.snippet || '',
      trustLevel: item.trustLevel || 'unknown',
      content: pages[index]?.page?.content || '',
    })).filter(source => source.snippet || source.content);
    if (!llmProvider) {
      return { query, hair: '', eyes: '', outfit: '', accessories: '', silhouette: '', evidence: [], sources: sources.map(({ title, url, trustLevel }) => ({ title, url, trustLevel })), researchStatus: 'extraction_failed', researchMessage: 'Appearance extraction is unavailable' };
    }
    try {
      const facts = await extractAppearanceFacts(llmProvider, sources);
      return { query, ...facts, sources: sources.map(({ title, url, trustLevel }) => ({ title, url, trustLevel })), researchStatus: sources.length > 0 ? 'complete' : 'no_sources' };
    } catch (error) {
      return { query, hair: '', eyes: '', outfit: '', accessories: '', silhouette: '', evidence: [], sources: sources.map(({ title, url, trustLevel }) => ({ title, url, trustLevel })), researchStatus: 'extraction_failed', researchMessage: error.message };
    }
  };
}

export function createWebMcpServer({ webTool = WebTool, llmProvider } = {}) {
  const characterResearch = researchHandler(webTool, llmProvider);
  return {
    tools: TOOL_DEFINITIONS,
    async handle(request = {}) {
      if (request.method === 'initialize') {
        return { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'comfy-agent-web', version: '0.2.0' } };
      }
      if (request.method === 'notifications/initialized' || request.method === 'ping') return {};
      if (request.method === 'tools/list') return { tools: TOOL_DEFINITIONS };
      if (request.method !== 'tools/call') throw new Error(`Unsupported MCP method: ${request.method}`);
      const name = request.params?.name;
      const input = request.params?.arguments || {};
      if (name === 'web_search') return mcpResult(await webTool.execute({ action: 'search', ...input }));
      if (name === 'web_open') return mcpResult(await webTool.execute({ action: 'open', ...input }));
      if (name === 'character_research') return mcpResult(await characterResearch(input));
      return mcpResult({ error: `Unknown MCP tool: ${name}` }, true);
    },
  };
}

export async function runMcpStdio(server, input = process.stdin, output = process.stdout) {
  let buffer = '';
  for await (const chunk of input) {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines.filter(Boolean)) {
      const request = JSON.parse(line);
      try {
        const result = await server.handle(request);
        if (request.id !== undefined) output.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
      } catch (error) {
        if (request.id !== undefined) output.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: error.message } })}\n`);
      }
    }
  }
}
