import { createServer } from 'node:http';
import { extractAppearanceFacts } from '../research/appearance.mjs';
import { normalizeResearchSettings } from '../research/settings.mjs';
import { matchSkill, SKILLS, skillManifest, SKILL_CONTRACT_VERSION } from '../skills/index.mjs';
import { validateToolInput } from '../schemas/tool-schema.mjs';
import { ComfyUITool } from '../tools/comfyui/index.mjs';
import { FilesystemTool } from '../tools/filesystem/index.mjs';
import { PromptLibraryTool } from '../tools/prompt-library/index.mjs';
import { SystemTool } from '../tools/system/index.mjs';
import { WebTool, openResultPages } from '../tools/web/index.mjs';
import { registryFromTools } from '../tools/registry.mjs';
import { RuntimeReadTools, RuntimeMutationTools } from '../tools/comfyui/runtime.mjs';
import { WorkflowReadTools } from '../tools/comfyui/workflow-read.mjs';
import { WorkflowMutationPreviewTool, WorkflowRevisionListTool, WorkflowMutationCommitTool, WorkflowRollbackTool } from '../tools/comfyui/workflow-mutation-tools.mjs';
import { ComfyUIRuntimeParametersTool } from '../tools/comfyui/runtime-parameters.mjs';
import { InspectImageTool } from '../tools/comfyui/image-inspect.mjs';
import { createServiceTools } from '../../runtime/service-tools.mjs';
import { createMediaTools } from '../../runtime/media/media-tools.mjs';
import { createConfiguredSkillRegistry } from '../skills/index.mjs';
import { normalizePlan, validatePlan } from '../schemas/plan-schema.mjs';

export const MCP_PROTOCOL_VERSION = '2025-11-25';
const SERVER_VERSION = '0.2.1';
const JSON_RPC_VERSION = '2.0';
const REQUEST_METHODS_BEFORE_INITIALIZE = new Set(['initialize', 'ping']);

function cloneSchema(schema) {
  return schema ? structuredClone(schema) : { type: 'object', properties: {}, additionalProperties: false };
}

export function toMcpTool(tool, overrides = {}) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: cloneSchema(overrides.inputSchema || tool.input_schema),
    ...(tool.output_schema ? { outputSchema: cloneSchema(tool.output_schema) } : {}),
  };
}

function mcpResult(value, isError = Boolean(value?.error)) {
  const safeValue = value === undefined ? null : value;
  return {
    content: [{ type: 'text', text: typeof safeValue === 'string' ? safeValue : JSON.stringify(safeValue) }],
    structuredContent: typeof safeValue === 'object' && safeValue !== null ? safeValue : undefined,
    ...(isError ? { isError: true } : {}),
  };
}

function rpcError(code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return error;
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
    if (!llmProvider) return { query, hair: '', eyes: '', outfit: '', accessories: '', silhouette: '', evidence: [], sources: sources.map(({ title, url, trustLevel }) => ({ title, url, trustLevel })), researchStatus: 'extraction_failed', researchMessage: 'Appearance extraction is unavailable' };
    try {
      const facts = await extractAppearanceFacts(llmProvider, sources);
      return { query, ...facts, sources: sources.map(({ title, url, trustLevel }) => ({ title, url, trustLevel })), researchStatus: sources.length > 0 ? 'complete' : 'no_sources' };
    } catch (error) {
      return { query, hair: '', eyes: '', outfit: '', accessories: '', silhouette: '', evidence: [], sources: sources.map(({ title, url, trustLevel }) => ({ title, url, trustLevel })), researchStatus: 'extraction_failed', researchMessage: error.message };
    }
  };
}

export function createSkillMcpTools(skills = SKILLS) {
  const registry = skills?.all && skills?.get ? skills : createConfiguredSkillRegistry({ builtin: skills });
  return registry.all().map(skill => ({
    id: skill.id,
    name: `plan_${skill.id}`,
    description: `Create an execution plan for the ${skill.name || skill.id} workflow without executing side effects. ${skill.description || ''}`.trim(),
    input_schema: {
      type: 'object',
      properties: {
        userIntent: { type: 'string', minLength: 1, description: 'The user request to plan' },
        context: { type: 'object', description: 'Optional trusted runtime context' },
      },
      required: ['userIntent'],
      additionalProperties: false,
    },
    output_schema: { type: 'object', properties: { skill: { type: 'string' }, status: { type: 'string' }, steps: { type: 'array' }, metadata: { type: 'object' }, clarification: { type: 'object' } }, required: ['skill', 'status', 'steps'] },
    side_effects: [], requires_confirmation: false, idempotent: true, retry: { mode: 'never' },
    version: skill.version || SKILL_CONTRACT_VERSION,
    category: 'generation',
    tags: ['skill', skill.id, skill.external ? 'external' : 'builtin', 'plan'],
    execute: async ({ userIntent, context = {} }) => {
      const match = skill.canHandle(userIntent, context);
      const plan = skill.plan(userIntent, context);
      const normalized = normalizePlan({ goal: userIntent, ...plan, metadata: { ...(plan.metadata || {}), skillId: skill.id, skillVersion: skill.version, status: match?.missing?.length ? 'clarify' : 'ready' } });
      if (match?.missing?.length) return { skill: skill.id, status: 'clarify', steps: [], metadata: normalized.metadata, clarification: { action: 'clarify', skillId: skill.id, missing: match.missing, confidence: match.confidence || 0 } };
      const validation = validatePlan(normalized, { tools: {
        prompt_enhance: { name: 'prompt_enhance', output_types: ['prompt'], input_schema: { type: 'object', properties: {} } },
        comfyui: { name: 'comfyui', output_types: ['images', 'videos'], input_schema: { type: 'object', properties: {} } },
      }, context });
      if (validation.errors.some(error => error.includes('tool is not registered'))) return { skill: skill.id, steps: skill.steps ? await skill.steps(userIntent, context) : normalized.steps };
      return validation.valid ? { skill: skill.id, status: 'ready', steps: normalized.steps, metadata: normalized.metadata, clarification: null } : { skill: skill.id, status: 'invalid', steps: normalized.steps, metadata: normalized.metadata, errors: validation.errors };
    },
  }));
}

export function createGenerationTools({ generation } = {}) {
  if (!generation) return [];
  return [
    {
      name: 'generation_prepare',
      description: 'Prepare a ComfyUI generation preview. This never submits a job.',
      input_schema: { type: 'object', properties: { request: { type: 'object' } }, required: ['request'], additionalProperties: false },
      output_schema: { type: 'object' }, side_effects: [], requires_confirmation: false, idempotent: true, retry: { mode: 'never' },
      execute: (input, context) => generation.prepare({ ...input.request, owner: context?.owner }),
    },
    {
      name: 'generation_run_prepared',
      description: 'Run a previously prepared and explicitly confirmed generation preview.',
       input_schema: { type: 'object', properties: { previewId: { type: 'string' }, confirmation: { type: 'object', properties: { accepted: { type: 'boolean' }, digest: { type: 'string' }, requestId: { type: 'string' }, previewId: { type: 'string' } }, required: ['accepted', 'digest', 'requestId', 'previewId'], additionalProperties: false }, edits: { type: 'object' } }, required: ['previewId', 'confirmation'], additionalProperties: false },
      output_schema: { type: 'object' }, side_effects: ['comfyui_generation'], requires_confirmation: true, idempotent: false, retry: { mode: 'never' },
       execute: (input, context) => {
         if (input.confirmation?.accepted !== true) return { error: 'Explicit confirmation is required' };
         return generation.runPrepared(input.previewId, input.edits || {}, context?.owner, input.confirmation);
      },
    },
    {
      name: 'generation_status',
      description: 'Read the status of a prepared or submitted generation request.',
      input_schema: { type: 'object', properties: { requestId: { type: 'string' }, taskId: { type: 'string' } }, additionalProperties: false },
      output_schema: { type: 'object' }, side_effects: [], requires_confirmation: false, idempotent: true, retry: { mode: 'limited', max_attempts: 1 },
       execute: (input, context) => generation.status({ ...input, owner: context?.owner }),
    },
    {
      name: 'generation_cancel',
      description: 'Cancel a prepared or running generation owned by the current MCP session.',
      input_schema: { type: 'object', properties: { previewId: { type: 'string' }, taskId: { type: 'string' } }, additionalProperties: false },
      output_schema: { type: 'object' }, side_effects: ['comfyui_generation'], requires_confirmation: true, idempotent: true, retry: { mode: 'never' },
       execute: (input, context) => generation.cancel({ ...input, owner: context?.owner }),
    },
  ];
}

export function createWebMcpServer({ webTool = WebTool, llmProvider, tools = [], toolRegistry = null, generation, serviceRegistry = null, serviceInvoker = null, includeReadOnlyTools = true, includeServiceTools = false, includeMediaTools = false, includeRuntimeMutationTools = false, includeWorkflowMutationTools = false, includeSkillTools = true, skills = SKILLS, surface = 'mcp', modules = null, include, exclude } = {}) {
  const moduleFlags = { web: true, files: true, comfyui: true, skills: true, ...(modules && typeof modules === 'object' ? modules : {}) };
  const characterResearch = researchHandler(webTool, llmProvider);
  const baseTools = moduleFlags.web ? [
    { name: 'web_search', description: 'Search public web pages with the configured domain and source policy.', input_schema: { type: 'object', properties: { query: { type: 'string' }, maxResults: { type: 'number' }, timeoutMs: { type: 'number' }, allowedDomains: { type: 'array' }, sourcePolicy: { type: 'object' } }, required: ['query'], additionalProperties: false }, execute: input => webTool.execute({ action: 'search', ...input }) },
    { name: 'web_open', description: 'Open one public web page with SSRF and domain-policy checks.', input_schema: { type: 'object', properties: { url: { type: 'string' }, timeoutMs: { type: 'number' }, allowedDomains: { type: 'array' }, sourcePolicy: { type: 'object' } }, required: ['url'], additionalProperties: false }, execute: input => webTool.execute({ action: 'open', ...input }) },
    { name: 'character_research', description: 'Search and extract cited character appearance facts.', input_schema: { type: 'object', properties: { query: { type: 'string' }, maxResults: { type: 'number' }, maxOpenPages: { type: 'number' }, timeoutMs: { type: 'number' }, allowedDomains: { type: 'array' }, officialDomains: { type: 'array' }, verifiedDomains: { type: 'array' }, communityDomains: { type: 'array' } }, required: ['query'], additionalProperties: false }, execute: characterResearch },
  ] : [];
   const filesTools = includeReadOnlyTools && moduleFlags.files ? [FilesystemTool, PromptLibraryTool, SystemTool] : [];
   const comfyuiReadTools = includeReadOnlyTools && moduleFlags.comfyui ? [InspectImageTool, ...RuntimeReadTools, ...WorkflowReadTools, ComfyUIRuntimeParametersTool] : [];
  const runtimeMutationTools = includeRuntimeMutationTools && moduleFlags.comfyui ? RuntimeMutationTools : [];
  const workflowMutationTools = moduleFlags.comfyui ? (includeWorkflowMutationTools ? [WorkflowMutationPreviewTool, WorkflowRevisionListTool, WorkflowMutationCommitTool, WorkflowRollbackTool] : [WorkflowMutationPreviewTool, WorkflowRevisionListTool]) : [];
  const plannerTools = includeSkillTools && moduleFlags.skills ? createSkillMcpTools(skills) : [];
   const serviceTools = includeServiceTools && serviceRegistry && serviceInvoker ? createServiceTools({ registry: serviceRegistry, invoker: serviceInvoker }) : [];
   const mediaTools = includeMediaTools ? createMediaTools() : [];
   const generationTools = moduleFlags.comfyui ? createGenerationTools({ generation }) : [];
   const rawTools = [...baseTools, ...filesTools, ...comfyuiReadTools, ...runtimeMutationTools, ...workflowMutationTools, ...serviceTools, ...mediaTools, ...plannerTools, ...generationTools, ...tools];
   const skillRegistryTool = moduleFlags.skills ? {
    name: 'skills_list',
    description: 'List the normalized Skill registry and capabilities available to this MCP server.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    output_schema: { type: 'object', properties: { version: { type: 'string' }, skills: { type: 'array' } }, required: ['version', 'skills'] },
    side_effects: [], requires_confirmation: false, idempotent: true, retry: { mode: 'never' },
    category: 'management',
    execute: async () => ({ version: SKILL_CONTRACT_VERSION, skills: skillManifest(skills) }),
   } : null;
   const skillPlanningTools = includeSkillTools && moduleFlags.skills ? [
     {
       name: 'skills_match', description: 'Match a user request to Skill candidates without executing side effects.', input_schema: { type: 'object', properties: { userIntent: { type: 'string' }, context: { type: 'object' }, skillId: { type: 'string' } }, required: ['userIntent'], additionalProperties: false }, output_schema: { type: 'object' }, side_effects: [], requires_confirmation: false, idempotent: true, retry: { mode: 'never' }, category: 'generation', execute: ({ userIntent, context = {}, skillId }) => createConfiguredSkillRegistry({ builtin: skills }).match(userIntent, { ...context, skillId }),
     },
     {
       name: 'skill_requirements', description: 'Inspect Skill requirements without executing side effects.', input_schema: { type: 'object', properties: { skillId: { type: 'string' }, context: { type: 'object' } }, required: ['skillId'], additionalProperties: false }, output_schema: { type: 'object' }, side_effects: [], requires_confirmation: false, idempotent: true, retry: { mode: 'never' }, category: 'generation', execute: ({ skillId, context = {} }) => { const skill = createConfiguredSkillRegistry({ builtin: skills }).get(skillId); if (!skill) return { code: 'SKILL_NOT_FOUND' }; return { skillId, requirements: skill.requirements, capabilities: skill.capabilities, context }; },
     },
   ] : [];
    const localRegistry = registryFromTools([...rawTools, ...(skillRegistryTool ? [skillRegistryTool] : []), ...skillPlanningTools].map(tool => ({
     category: tool.category || 'management',
     permission: tool.permission || (tool.requires_confirmation ? 'execute' : 'read'),
     risk_level: tool.risk_level || (tool.requires_confirmation ? 'medium' : 'none'),
     side_effects: tool.side_effects || [],
     requires_confirmation: tool.requires_confirmation === true,
     idempotent: tool.idempotent !== false,
     retry: tool.retry || { mode: 'never' },
     input_schema: tool.input_schema || { type: 'object', properties: {}, additionalProperties: false },
     output_schema: tool.output_schema || { type: 'object' },
     ...tool,
   })));
   const registry = toolRegistry?.list ? toolRegistry : localRegistry;
   const exposedTools = registry.list({ surface, include, exclude });
   const byName = new Map(exposedTools.map(tool => [tool.name, tool]));
  let initialized = false;
  let multiSession = false;
  const server = {
     tools: exposedTools.map(toMcpTool),
    async handle(request = {}, context = {}) {
      if (request.jsonrpc !== undefined && request.jsonrpc !== JSON_RPC_VERSION) throw Object.assign(new Error('Invalid JSON-RPC version'), { code: -32600 });
      const method = request.method;
      if (method === 'initialize') {
        if (initialized && !multiSession) throw Object.assign(new Error('Server is already initialized'), { code: -32600 });
        initialized = true;
        return { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'comfy-agent', version: SERVER_VERSION, title: 'ComfyMuse MCP' } };
      }
      if (method === 'notifications/initialized' || method === 'ping') return {};
      // Embedded callers may inspect a server before transport startup; the stdio/HTTP
      // clients still follow the normal initialize lifecycle.
      if (method === 'tools/list') return { tools: server.tools };
      if (method !== 'tools/call') throw Object.assign(new Error(`Unsupported MCP method: ${method}`), { code: -32601 });
      const name = request.params?.name;
      const input = request.params?.arguments;
      if (typeof name !== 'string' || !byName.has(name)) throw Object.assign(new Error(`Unknown MCP tool: ${name || '(missing)'}`), { code: -32602 });
      if (input !== undefined && (!input || typeof input !== 'object' || Array.isArray(input))) throw Object.assign(new Error('Tool arguments must be an object'), { code: -32602 });
      const tool = byName.get(name);
      const validation = validateToolInput(tool, input || {});
      if (!validation.valid) throw Object.assign(new Error('Invalid tool arguments'), { code: -32602, data: validation.errors });
       try { return mcpResult(await tool.execute(input || {}, context)); } catch (error) { return mcpResult({ error: error.message }, true); }
    },
    enableMultiSession() { multiSession = true; },
  };
  return server;
}

function parseRpcLine(line) {
  let message;
  try { message = JSON.parse(line); } catch { throw Object.assign(new Error('Parse error'), { code: -32700 }); }
  if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== JSON_RPC_VERSION || typeof message.method !== 'string') {
    throw Object.assign(new Error('Invalid Request'), { code: -32600 });
  }
  return message;
}

export async function runMcpStdio(server, input = process.stdin, output = process.stdout) {
  let buffer = '';
  for await (const chunk of input) {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let request;
      try { request = parseRpcLine(line); } catch (error) {
        output.write(`${JSON.stringify({ jsonrpc: JSON_RPC_VERSION, id: null, error: rpcError(error.code || -32700, error.message) })}\n`);
        continue;
      }
      if (request.id === undefined) {
        await server.handle(request).catch(() => {});
        continue;
      }
      try {
        const result = await server.handle(request);
        output.write(`${JSON.stringify({ jsonrpc: JSON_RPC_VERSION, id: request.id, result })}\n`);
      } catch (error) {
        output.write(`${JSON.stringify({ jsonrpc: JSON_RPC_VERSION, id: request.id, error: rpcError(error.code || -32603, error.message, error.data) })}\n`);
      }
    }
  }
}

export function createMcpHttpServer(server, { host = '127.0.0.1', port = 0, authToken = '', requireAuth = true, sessionRegistry = null, principalResolver = null } = {}) {
  const sessions = new Map();
  server.enableMultiSession?.();
  const httpServer = createServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', 'null');
    response.setHeader('Access-Control-Allow-Headers', 'content-type, accept, authorization, mcp-session-id');
    response.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');
    if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
    if (request.method !== 'POST' || request.url !== '/mcp') { response.writeHead(404); response.end('Not found'); return; }
    if (requireAuth && (!authToken || request.headers.authorization !== `Bearer ${authToken}`)) { response.writeHead(401); response.end('Unauthorized'); return; }
    const accepts = String(request.headers.accept || 'application/json');
    if (!accepts.includes('application/json') && !accepts.includes('text/event-stream')) { response.writeHead(406); response.end('Unsupported Accept'); return; }
    let body = '';
    for await (const chunk of request) { body += chunk; if (Buffer.byteLength(body) > 1024 * 1024) { response.writeHead(413); response.end('Payload too large'); return; } }
    let rpc;
    try { rpc = parseRpcLine(body.trim()); } catch (error) { response.writeHead(400, { 'content-type': 'application/json' }); response.end(JSON.stringify({ jsonrpc: JSON_RPC_VERSION, id: null, error: rpcError(error.code || -32700, error.message) })); return; }
    const requestedSession = String(request.headers['mcp-session-id'] || '');
    if (rpc.method !== 'initialize' && (!requestedSession || !sessions.has(requestedSession))) {
      response.writeHead(404); response.end('Unknown MCP session'); return;
    }
    if (rpc.method !== 'initialize' && sessionRegistry) {
      try {
        const principal = principalResolver?.(request);
        sessionRegistry.assertSession(requestedSession, {
          principalId: principal?.id,
          tenantId: principal?.tenantId,
        });
      } catch (error) { response.writeHead(401, { 'content-type': 'application/json' }); response.end(JSON.stringify({ jsonrpc: JSON_RPC_VERSION, id: rpc.id ?? null, error: rpcError(error.code, error.message) })); return; }
    }
      try {
        const principal = principalResolver?.(request);
        const registeredSession = sessionRegistry?.getSession(requestedSession);
        const result = await server.handle(rpc, { sessionId: requestedSession, owner: { principalId: principal?.id, tenantId: principal?.tenantId, projectId: registeredSession?.projectId || '', sessionId: requestedSession, permissions: ['read', 'execute', 'mutate'] } });
      if (rpc.id === undefined) { response.writeHead(202); response.end(); return; }
      const headers = { 'content-type': accepts.includes('text/event-stream') ? 'text/event-stream' : 'application/json' };
      if (rpc.method === 'initialize') {
        const sessionId = `mcp_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
        sessions.set(sessionId, { createdAt: Date.now(), principal: principalResolver?.(request) || null });
        if (sessionRegistry) {
          const principal = principalResolver?.(request);
          if (!principal) { response.writeHead(401); response.end('Unauthorized'); return; }
          const registered = sessionRegistry.createSession(principal, { sessionId, source: 'mcp' });
          sessions.set(sessionId, { ...sessions.get(sessionId), registered });
        }
        headers['mcp-session-id'] = sessionId;
      }
      response.writeHead(200, headers);
      const payload = JSON.stringify({ jsonrpc: JSON_RPC_VERSION, id: rpc.id, result });
      response.end(headers['content-type'] === 'text/event-stream' ? `event: message\ndata: ${payload}\n\n` : payload);
    } catch (error) {
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ jsonrpc: JSON_RPC_VERSION, id: rpc.id ?? null, error: rpcError(error.code || -32603, error.message, error.data) }));
    }
  });
  return { server: httpServer, listen: () => new Promise(resolve => httpServer.listen(port, host, () => resolve(httpServer.address()))), close: () => new Promise(resolve => httpServer.close(resolve)) };
}

export { mcpResult };
