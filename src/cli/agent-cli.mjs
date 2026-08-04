import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { ComfyUIClient } from '../agent/tools/comfyui/client.mjs';
import { ComfyUITool } from '../agent/tools/comfyui/index.mjs';
import { WorkflowInspectTool } from '../agent/tools/comfyui/workflow-inspect.mjs';
import { WorkflowPatchTool } from '../agent/tools/comfyui/workflow-patch.mjs';
import { InspectImageTool } from '../agent/tools/comfyui/image-inspect.mjs';
import { FilesystemMutateTool } from '../agent/tools/filesystem/mutate.mjs';
import { FilesystemTool } from '../agent/tools/filesystem/index.mjs';
import { SystemTool } from '../agent/tools/system/index.mjs';
import { classifyFailure } from '../agent/optimizer/retry-policy.mjs';
import { assessPromptReadiness } from '../agent/tools/prompt/readiness.mjs';
import { applyGuard } from '../agent/optimizer/prompt-guard.mjs';
import { ComfyExecutor } from '../runtime/executor/comfy-executor.mjs';
import { DirectService } from '../runtime/direct/direct-service.mjs';
import { createPathContext } from '../runtime/path-context.mjs';

const BOOLEAN_OPTIONS = new Set([
  'dry-run',
  'execute',
  'json',
  'help',
  'no-retry',
  'no-evaluate',
  'with-data-url',
]);

const SETTING_OPTIONS = {
  seed: 'seed',
  steps: 'steps',
  cfg: 'cfg',
  denoise: 'denoise',
  width: 'width',
  height: 'height',
  batch: 'batch',
  sampler: 'sampler_name',
  scheduler: 'scheduler',
};

const EXIT = {
  ok: 0,
  usage: 2,
  preflight: 3,
  execution: 4,
};

export function helpText() {
  return [
    'Usage:',
    '  npm run agent -- workflow inspect --workflow image.json --workflow-dir <dir>',
    '  npm run agent -- workflow validate --workflow image.json --workflow-dir <dir>',
    '  npm run agent -- workflow patch --workflow image.json --positive "a cat" --steps 30',
    '  npm run agent -- workflow list --workflow-dir <dir>',
    '  npm run agent -- file read --root project --path src/main.mjs',
    '  npm run agent -- file write --root project --path notes.txt --content-file notes.txt',
    '  npm run agent -- file edit --root project --path src/main.mjs --old "old" --new "new"',
    '  npm run agent -- file patch --root project --patch-file change.diff --execute',
    '  npm run agent -- generate --workflow image.json --positive "a cat"',
    '  npm run agent -- generate --workflow image.json --positive "a cat" --execute',
    '  npm run agent -- batch --workflow image.json --prompts prompts.txt --execute',
    '  npm run agent -- image inspect --image result.png --image-root <dir>',
    '  npm run agent -- image compare --image a.png --other b.png --image-root <dir>',
    '  npm run agent -- model search --query flux',
    '  npm run agent -- queue monitor --prompt-id <id>',
    '  npm run agent -- queue cancel --prompt-id <id> --execute',
    '  npm run agent -- queue clear --execute',
    '  npm run agent -- prompt check --text "a red cat" --intent generate',
    '  npm run agent -- prompt guard --positive "a red cat" --negative "blurry"',
    '  npm run agent -- prompt check --text "a red cat" --intent generate',
    '  npm run agent -- prompt guard --positive "a red cat" --negative "blurry"',
    '  npm run agent -- diagnose --prompt-id <id>',
    '  npm run agent -- status [queue|models|device|log]',
    '',
    'Options:',
    '  --workflow-dir <dir>  Trusted directory containing workflow files',
    '  --base-url <url>      ComfyUI URL (default: http://127.0.0.1:8188)',
    '  --json                Emit machine-readable JSON',
    '  --execute             Queue generation; otherwise only preview',
    '  --dry-run             Explicitly request preview-only mode',
    '  --settings <json>     Common settings object',
    '  --node-overrides <json>  Exact editable node inputs',
    '  --image/--mask/--video <path>  Attach media; repeatable',
    '  --image-root <dir>    Trusted directory for local image inspection',
    '  --root <name>         Trusted root: workflow, project, input, output, or temp',
    '  --project-dir <dir>   Trusted project root for file operations',
    '  --input-dir/--output-dir/--temp-dir <dir>  Trusted ComfyUI roots',
    '  --path <path>         Relative file path inside the selected root',
    '  --content/--content-file <value>  File contents, or use - for stdin',
    '  --patch/--patch-file <value>      Unified patch, or use - for stdin',
    '  --expected-hash <sha256>  Refuse to overwrite a changed file',
  ].join('\n');
}

function optionValue(options, name, fallback = '') {
  const value = options[name];
  if (Array.isArray(value)) return value.at(-1) ?? fallback;
  return value === undefined ? fallback : value;
}

function optionValues(options, name) {
  const value = options[name];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function booleanOption(options, name) {
  const value = optionValue(options, name, false);
  if (typeof value === 'boolean') return value;
  return !['false', '0', 'no', 'off'].includes(String(value).toLowerCase());
}

function pushOption(options, key, value) {
  if (options[key] === undefined) {
    options[key] = value;
  } else if (Array.isArray(options[key])) {
    options[key].push(value);
  } else {
    options[key] = [options[key], value];
  }
}

export function parseArgs(argv = []) {
  const positionals = [];
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }

    const assignment = token.slice(2).split('=');
    const key = assignment.shift();
    if (!key) throw new Error('Option name cannot be empty');
    if (assignment.length > 0) {
      pushOption(options, key, assignment.join('='));
      continue;
    }

    const next = argv[index + 1];
    if (BOOLEAN_OPTIONS.has(key) || next === undefined || next.startsWith('--')) {
      pushOption(options, key, true);
    } else {
      pushOption(options, key, next);
      index++;
    }
  }
  return { positionals, options };
}

function requiredOption(options, name) {
  const value = String(optionValue(options, name, '')).trim();
  if (!value) throw new Error(`Missing required option --${name}`);
  return value;
}

function parseJsonOption(options, name, fallback) {
  const raw = optionValue(options, name, '');
  if (!raw) return fallback;
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON for --${name}: ${error.message}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`--${name} must contain a JSON object`);
  }
  return value;
}

function numberOption(options, name) {
  const raw = optionValue(options, name, '');
  if (raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`--${name} must be a number`);
  return value;
}

function pathValue(value, base) {
  const root = base || process.cwd();
  return isAbsolute(value) ? value : resolve(root, value);
}

function pathContext(options) {
  return options.__pathContext || createPathContext();
}

function pathBase(options) {
  return pathContext(options).baseDir;
}

function workflowDir(options) {
  return pathValue(optionValue(options, 'workflow-dir', pathContext(options).workflowDir), pathBase(options));
}

function buildSettings(options) {
  const settings = { ...parseJsonOption(options, 'settings', {}) };
  for (const [option, setting] of Object.entries(SETTING_OPTIONS)) {
    const value = option === 'sampler' || option === 'scheduler'
      ? optionValue(options, option, '')
      : numberOption(options, option);
    if (value !== undefined && value !== '') settings[setting] = value;
  }
  return settings;
}

function buildMedia(options) {
  const base = pathValue(optionValue(options, 'image-root', ''), pathBase(options)) || pathBase(options);
  return {
    images: optionValues(options, 'image').map(value => pathValue(value, base)),
    masks: optionValues(options, 'mask').map(value => pathValue(value, base)),
    videos: optionValues(options, 'video').map(value => pathValue(value, base)),
  };
}

function outputNodeIds(options) {
  const values = optionValues(options, 'output-node').map(String);
  return values.length > 0 ? values : null;
}

function positivePrompt(options) {
  return String(optionValue(options, 'positive', optionValue(options, 'prompt', '')));
}

function generationInput(options, dir, positive = positivePrompt(options)) {
  return {
    workflowName: requiredOption(options, 'workflow'),
    workflowDir: dir,
    positive,
    negative: String(optionValue(options, 'negative', '')),
    settings: buildSettings(options),
    nodeOverrides: parseJsonOption(options, 'node-overrides', {}),
    outputNodeIds: outputNodeIds(options),
    media: buildMedia(options),
    origin: 'cli',
    executionPolicy: {
      retry: !booleanOption(options, 'no-retry'),
      evaluate: !booleanOption(options, 'no-evaluate'),
      mutatePrompt: false,
    },
  };
}

function patchInput(input) {
  return {
    action: 'preview',
    workflow: input.workflowName,
    workflowDir: input.workflowDir,
    settings: input.settings,
    nodeOverrides: input.nodeOverrides,
    positivePrompts: input.positive ? [input.positive] : [],
    negative: input.negative,
    media: input.media,
  };
}

function runtimeFor(options, dependencies = {}) {
  const client = dependencies.client || new ComfyUIClient({
    baseUrl: optionValue(options, 'base-url', process.env.COMFYUI_BASE_URL || 'http://127.0.0.1:8188'),
  });
  ComfyUITool.setClient(client);
  return {
    client,
    comfy: dependencies.comfy || ComfyUITool,
    inspect: dependencies.inspect || WorkflowInspectTool,
    patch: dependencies.patch || WorkflowPatchTool,
    filesystem: dependencies.filesystem || FilesystemTool,
    mutate: dependencies.mutate || FilesystemMutateTool,
    image: dependencies.image || InspectImageTool,
    system: dependencies.system || SystemTool,
    direct: dependencies.direct || new DirectService({
      executor: dependencies.executor || new ComfyExecutor(),
      workflowDir: workflowDir(options),
    }),
  };
}

function trustedFileRoots(options) {
  const entries = [{ name: 'workflow', path: workflowDir(options) }];
  const project = optionValue(options, 'project-dir', '');
  if (project) entries.push({ name: 'project', path: pathValue(project, pathBase(options)) });
  const configuredComfyRoot = optionValue(options, 'comfy-root', '');
  const comfyRoot = configuredComfyRoot
    ? pathValue(configuredComfyRoot, pathBase(options))
    : pathContext(options).portableRoot
      ? resolve(pathContext(options).portableRoot, 'ComfyUI')
      : '';
  for (const name of ['input', 'output', 'temp']) {
    const explicit = optionValue(options, `${name}-dir`, '');
    if (explicit) entries.push({ name, path: pathValue(explicit, pathBase(options)) });
    else if (comfyRoot) entries.push({ name, path: resolve(comfyRoot, name) });
  }
  return entries;
}

function fileInput(options) {
  const root = optionValue(options, 'root', 'workflow');
  const roots = trustedFileRoots(options);
  const configuredComfyRoot = optionValue(options, 'comfy-root', '');
  const comfyRoot = configuredComfyRoot
    ? pathValue(configuredComfyRoot, pathBase(options))
    : pathContext(options).portableRoot
      ? resolve(pathContext(options).portableRoot, 'ComfyUI')
      : '';
  const selected = roots.find(entry => entry.name === root);
  if (!selected) throw new Error(`Missing trusted directory for --root ${root}; provide --${root}-dir`);
  return {
    root,
    workflowDir: roots.find(entry => entry.name === 'workflow')?.path || selected.path,
    allowedRoots: roots,
    comfyRoot,
  };
}

async function readInput(dependencies = {}) {
  if (typeof dependencies.stdin === 'string') return dependencies.stdin;
  if (dependencies.stdin && typeof dependencies.stdin[Symbol.asyncIterator] === 'function') {
    let content = '';
    for await (const chunk of dependencies.stdin) content += String(chunk);
    return content;
  }
  return readFile(0, 'utf8');
}

async function runFile(positionals, options, runtime, dependencies) {
  const action = positionals[1] || 'read';
  const base = fileInput(options);
  if (action === 'read') {
    const path = requiredOption(options, 'path');
    return runtime.filesystem.execute({ action, ...base, path });
  }
  if (!['write', 'edit', 'patch'].includes(action)) throw new Error(`Unknown file action: ${action}`);
  const input = { action: action === 'patch' ? 'apply_patch' : action, ...base, execute: booleanOption(options, 'execute') && !booleanOption(options, 'dry-run') };
  if (action === 'write') {
    const content = optionValue(options, 'content', undefined);
    const contentFile = optionValue(options, 'content-file', '');
    if (content !== undefined && contentFile) throw new Error('Use --content or --content-file, not both');
    if (content === '-') input.content = await readInput(dependencies);
    else if (content !== undefined) input.content = String(content);
    else if (contentFile) input.contentFile = contentFile;
    else throw new Error('Missing --content or --content-file');
    input.path = requiredOption(options, 'path');
  }
  if (action === 'edit') {
    input.path = requiredOption(options, 'path');
    input.old = requiredOption(options, 'old');
    input.new = requiredOption(options, 'new');
  }
  if (action === 'patch') {
    const patch = optionValue(options, 'patch', undefined);
    const patchFile = optionValue(options, 'patch-file', '');
    if (patch !== undefined && patchFile) throw new Error('Use --patch or --patch-file, not both');
    if (patch === '-') input.patch = await readInput(dependencies);
    else if (patch !== undefined) input.patch = String(patch);
    else if (patchFile) input.patchFile = patchFile;
    else throw new Error('Missing --patch or --patch-file');
    if (optionValue(options, 'expected-hashes', '')) input.expectedHashes = parseJsonOption(options, 'expected-hashes', {});
  }
  const expectedHash = optionValue(options, 'expected-hash', '');
  if (expectedHash) input.expectedHash = expectedHash;
  return runtime.mutate.execute(input);
}

async function runWorkflow(positionals, options, runtime) {
  const action = positionals[1] || 'inspect';
  const dir = workflowDir(options);
  if (action === 'list') return runtime.comfy.discover(dir);
  const workflowName = requiredOption(options, 'workflow');
  if (action === 'patch') {
    const input = generationInput(options, dir);
    return runtime.patch.execute(patchInput(input));
  }
  if (!['inspect', 'snapshot', 'validate', 'find', 'node'].includes(action)) {
    throw new Error(`Unknown workflow action: ${action}`);
  }
  return runtime.inspect.execute({
    action: action === 'inspect' ? 'snapshot' : action,
    workflowName,
    workflowDir: dir,
    nodeId: optionValue(options, 'node-id', ''),
    type: optionValue(options, 'type', ''),
    input: optionValue(options, 'input', ''),
    value: optionValue(options, 'value', ''),
    limit: numberOption(options, 'limit'),
  });
}

function imageRoot(options) {
  return pathValue(optionValue(options, 'image-root', optionValue(options, 'workflow-dir', pathContext(options).workflowDir)), pathBase(options));
}

function imageReference(options, name) {
  const path = optionValue(options, name, '');
  if (path) return { path: pathValue(path, imageRoot(options)) };
  const filename = optionValue(options, `${name}-filename`, '');
  if (!filename) throw new Error(`Missing --${name} or --${name}-filename`);
  return {
    filename,
    subfolder: optionValue(options, `${name}-subfolder`, ''),
    type: optionValue(options, `${name}-type`, 'output'),
  };
}

async function runImage(positionals, options, runtime) {
  const action = positionals[1] || 'inspect';
  if (!['inspect', 'compare'].includes(action)) throw new Error(`Unknown image action: ${action}`);
  const input = {
    action,
    image: imageReference(options, 'image'),
    workflowDir: imageRoot(options),
    comfyRoot: optionValue(options, 'comfy-root', ''),
    withDataUrl: booleanOption(options, 'with-data-url'),
  };
  if (action === 'compare') input.other = imageReference(options, 'other');
  return runtime.image.execute(input);
}

async function runModel(positionals, options, runtime) {
  const action = positionals[1] || 'list';
  if (action === 'list') return runtime.system.execute({ action: 'models' });
  if (action === 'search') {
    return runtime.system.execute({
      action: 'search_models',
      query: optionValue(options, 'query', ''),
      kind: optionValue(options, 'kind', ''),
      family: optionValue(options, 'family', ''),
    });
  }
  throw new Error(`Unknown model action: ${action}`);
}

async function runQueue(positionals, options, runtime) {
  const action = positionals[1] || 'status';
  if (action === 'status') return runtime.system.execute({ action: 'queue' });
  if (action === 'monitor') {
    return runtime.comfy.monitor(requiredOption(options, 'prompt-id'));
  }
  if (action === 'cancel') {
    const promptId = requiredOption(options, 'prompt-id');
    if (!booleanOption(options, 'execute')) return { mode: 'preview', action, promptId };
    return runtime.comfy.cancel(promptId);
  }
  if (action === 'clear') {
    const queue = await runtime.client.queue();
    const pendingPromptIds = (queue.queue_pending || []).map(item => item?.[1]).filter(Boolean);
    if (!booleanOption(options, 'execute')) return { mode: 'preview', action, pendingPromptIds };
    await runtime.client.queueDelete(pendingPromptIds);
    await runtime.client.interrupt();
    return { mode: 'execute', action, cleared: pendingPromptIds.length };
  }
  throw new Error(`Unknown queue action: ${action}`);
}

async function runPrompt(positionals, options) {
  const action = positionals[1] || 'check';
  if (action === 'check') {
    const text = String(optionValue(options, 'text', optionValue(options, 'prompt', ''))).trim();
    if (!text) throw new Error('Missing required option --text');
    return assessPromptReadiness({
      request: text,
      intent: optionValue(options, 'intent', 'generate'),
      media: buildMedia(options),
      lastPrompt: optionValue(options, 'last-prompt', ''),
      conversation: [],
    });
  }
  if (action === 'guard') {
    const positive = String(optionValue(options, 'positive', '')).trim();
    if (!positive) throw new Error('Missing required option --positive');
    const positiveTokens = numberOption(options, 'positive-budget');
    const negativeTokens = numberOption(options, 'negative-budget');
    const budgets = positiveTokens === undefined && negativeTokens === undefined
      ? undefined
      : { positiveTokens, negativeTokens };
    return applyGuard({
      positive,
      negative: String(optionValue(options, 'negative', '')),
    }, {
      userPrompt: optionValue(options, 'user-prompt', positive),
      budgets,
    });
  }
  throw new Error(`Unknown prompt action: ${action}`);
}

async function runGenerate(options, runtime, onProgress) {
  const input = generationInput(options, workflowDir(options));
  const patch = await runtime.patch.execute(patchInput(input));
  const preview = await runtime.direct.prepare(input);
  const result = { mode: 'preview', preview, patch };
  if (patch.error || patch.ignored?.length > 0 || preview.issues?.length > 0) {
    runtime.direct.discardPreview?.(preview.previewId);
    return result;
  }
  if (!booleanOption(options, 'execute') || booleanOption(options, 'dry-run')) return result;
  result.mode = 'execute';
  result.result = await runtime.direct.run(preview.previewId, {}, { onProgress });
  return result;
}

async function readPrompts(filePath, options) {
  const content = await readFile(pathValue(filePath, pathBase(options)), 'utf8');
  try {
    const parsed = JSON.parse(content);
    const values = Array.isArray(parsed) ? parsed : parsed.prompts;
    if (Array.isArray(values)) return values.map(String).map(value => value.trim()).filter(Boolean);
  } catch {}
  return content.split(/\r?\n/).map(value => value.trim()).filter(value => value && !value.startsWith('#'));
}

async function runBatch(options, runtime, onProgress) {
  const prompts = await readPrompts(requiredOption(options, 'prompts'), options);
  if (prompts.length === 0) throw new Error('Prompt file contains no usable prompts');
  const limit = Math.min(Math.max(numberOption(options, 'limit') || prompts.length, 1), 100);
  const selected = prompts.slice(0, limit);
  const dir = workflowDir(options);
  const base = generationInput(options, dir, selected[0] || '');
  const patch = await runtime.patch.execute(patchInput(base));
  const result = { mode: 'preview', workflow: base.workflowName, count: selected.length, prompts: selected, patch };
  if (patch.error || patch.ignored?.length > 0 || !booleanOption(options, 'execute') || booleanOption(options, 'dry-run')) return result;

  result.mode = 'execute';
  result.results = [];
  for (const prompt of selected) {
    try {
      const input = generationInput(options, dir, prompt);
      const preview = await runtime.direct.prepare(input);
      if (preview.issues?.length > 0) {
        runtime.direct.discardPreview?.(preview.previewId);
        result.results.push({ prompt, mode: 'preview', preview });
        continue;
      }
      const execution = await runtime.direct.run(preview.previewId, {}, { onProgress });
      result.results.push({ prompt, result: execution });
    } catch (error) {
      result.results.push({ prompt, ...errorResult(error) });
    }
  }
  return result;
}

function errorResult(error) {
  const failure = classifyFailure(error, { tool: 'comfyui' });
  return {
    error: error instanceof Error ? error.message : String(error),
    failure,
  };
}

async function runDiagnose(positionals, options, runtime) {
  const promptId = optionValue(options, 'prompt-id', '');
  const message = optionValue(options, 'error', '');
  if (message) {
    return { source: 'error', message, failure: classifyFailure(new Error(message), { tool: 'comfyui' }) };
  }
  if (promptId) {
    const history = await runtime.client.history(promptId);
    const status = history?.[promptId]?.status || {};
    const errorMessage = status.messages?.find(item => item?.[0] === 'execution_error')?.[1]?.exception_message
      || status.status_str;
    return {
      source: 'history',
      promptId,
      status: status.status_str || (status.completed ? 'success' : 'unknown'),
      outputs: Object.keys(history?.[promptId]?.outputs || {}),
      failure: errorMessage ? classifyFailure(new Error(errorMessage), { tool: 'comfyui' }) : null,
      error: errorMessage || null,
    };
  }
  return runtime.system.execute({ action: 'log', limit: numberOption(options, 'limit') || 5 });
}

function exitCodeFor(command, result, options) {
  if (command === 'diagnose') return EXIT.ok;
  if (result?.error || result?.patch?.error) return EXIT.preflight;
  if (['generate', 'batch'].includes(command) && result?.patch?.ignored?.length > 0) return EXIT.preflight;
  if (command === 'image' && result?.image?.exists === false) return EXIT.preflight;
  if (command === 'image' && result?.images?.some(image => image?.exists === false)) return EXIT.preflight;
  if (command === 'prompt' && result?.readiness === 'clarify') return EXIT.preflight;
  if (command === 'prompt' && result?.issues?.some(issue => issue.severity === 'high')) return EXIT.preflight;
  if (result?.preview?.issues?.some(issue => issue.level === 'error')) return EXIT.preflight;
  if (result?.valid === false) return EXIT.preflight;
  if (result?.reachable === false) return EXIT.execution;
  if (booleanOption(options, 'execute') && !booleanOption(options, 'dry-run')) {
    if (result?.result?.error || result?.results?.some(item => item?.error)) return EXIT.execution;
  }
  return EXIT.ok;
}

async function dispatch(parsed, dependencies = {}) {
  const { positionals, options } = parsed;
  options.__pathContext = dependencies.pathContext || createPathContext(dependencies.cwd || process.cwd());
  if (booleanOption(options, 'help') || positionals.length === 0) {
    return { exitCode: EXIT.ok, result: { help: helpText() }, json: booleanOption(options, 'json') };
  }

  const runtime = runtimeFor(options, dependencies);
  const command = positionals[0];
  if (command === 'file') {
    const result = await runFile(positionals, options, runtime, dependencies);
    return { exitCode: exitCodeFor(command, result, options), result, json: booleanOption(options, 'json') };
  }
  if (command === 'workflow') {
    const result = await runWorkflow(positionals, options, runtime);
    return { exitCode: exitCodeFor(command, result, options), result, json: booleanOption(options, 'json') };
  }
  if (command === 'generate') {
    const result = await runGenerate(options, runtime, dependencies.onProgress);
    return { exitCode: exitCodeFor(command, result, options), result, json: booleanOption(options, 'json') };
  }
  if (command === 'batch') {
    const result = await runBatch(options, runtime, dependencies.onProgress);
    return { exitCode: exitCodeFor(command, result, options), result, json: booleanOption(options, 'json') };
  }
  if (command === 'image') {
    const result = await runImage(positionals, options, runtime);
    return { exitCode: exitCodeFor(command, result, options), result, json: booleanOption(options, 'json') };
  }
  if (command === 'model') {
    const result = await runModel(positionals, options, runtime);
    return { exitCode: exitCodeFor(command, result, options), result, json: booleanOption(options, 'json') };
  }
  if (command === 'queue') {
    const result = await runQueue(positionals, options, runtime);
    return { exitCode: exitCodeFor(command, result, options), result, json: booleanOption(options, 'json') };
  }
  if (command === 'prompt') {
    const result = await runPrompt(positionals, options);
    return { exitCode: exitCodeFor(command, result, options), result, json: booleanOption(options, 'json') };
  }
  if (command === 'diagnose') {
    const result = await runDiagnose(positionals, options, runtime);
    return { exitCode: EXIT.ok, result, json: booleanOption(options, 'json') };
  }
  if (command === 'status') {
    const action = positionals[1] || 'status';
    const result = await runtime.system.execute({ action, query: optionValue(options, 'query', ''), kind: optionValue(options, 'kind', ''), family: optionValue(options, 'family', ''), limit: numberOption(options, 'limit') });
    return {
      exitCode: exitCodeFor(command, result, options),
      result,
      json: booleanOption(options, 'json'),
    };
  }
  throw new Error(`Unknown command: ${command}`);
}

export async function runCli(argv = [], dependencies = {}) {
  const parsed = parseArgs(argv);
  try {
    return await dispatch(parsed, dependencies);
  } catch (error) {
    const { options } = parsed;
    const executing = booleanOption(options, 'execute') && !booleanOption(options, 'dry-run');
    return {
      exitCode: executing ? EXIT.execution : EXIT.preflight,
      result: errorResult(error),
      json: booleanOption(options, 'json'),
    };
  }
}

export { EXIT };
