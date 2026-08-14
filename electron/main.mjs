import pkg from 'electron';
import { spawn, spawnSync } from 'child_process';
import { get as httpGet } from 'http';
import { get as httpsGet } from 'https';
import { join, dirname, extname, isAbsolute, relative, resolve, basename } from 'path';
import { fileURLToPath } from 'url';
import { readFile, readdir, stat, writeFile, mkdir, copyFile, unlink, rename, rm, realpath, lstat, mkdtemp } from 'fs/promises';
import { createWriteStream, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { createHash, randomUUID } from 'crypto';
import { ComfyUITool, on, AgentEventTypes, configureSkills, skillManifest, createCustomSkill, SKILLS, BUILTIN_SKILLS, CloudPolicyBlockedError, CloudPolicyRouter, createMcpHttpServer, createWebMcpServer } from '../src/agent/index.mjs';
import { externalSkillConfig, loadExternalSkillFile, normalizeExternalSkill } from '../src/agent/skills/external.mjs';
import { LLMProvider, resolveLLMRouting } from '../src/agent/llm/provider.mjs';
import { OpenAIImageProvider } from '../src/agent/llm/openai-image.mjs';
import { PreferenceMemory } from '../src/agent/memory/preference.mjs';
import { ComfyUIClient } from '../src/agent/tools/comfyui/client.mjs';
import { ComfyUIManager, hasPortableLayout, findPortableRoot } from './comfyui-manager.mjs';
import { sanitizeContextValue } from '../src/agent/schemas/context-sanitizer.mjs';
import { normalizeUIPreferences } from '../src/ui-preferences.mjs';
import { DirectService } from '../src/runtime/direct/direct-service.mjs';
import { ComfyExecutor } from '../src/runtime/executor/comfy-executor.mjs';
import { AgentProcessClient } from './agent-process.mjs';
import { ExecutionCoordinator } from './execution-coordinator.mjs';
import { SANDBOX_AUTHORIZED_FILES, createSandboxPolicy, resolveSandboxPath } from '../src/agent/security/sandbox.mjs';
import { assetRecipePath, normalizeAssetPath, projectAssetRoot, removeEmptyAssetDirectories, scanProjectAssets } from '../src/runtime/project-assets.mjs';
import { displayPath } from '../src/runtime/path-display.mjs';
import { importWorkflowFiles, collectWorkflowFiles, deleteWorkflowFile, renameWorkflowFile } from '../src/runtime/workflow-import.mjs';
import { directGenerationRequest, normalizeGenerationResult } from '../src/runtime/generation-contract.mjs';
import { traceError, validateTaskTrace, assertTraceOwner } from '../src/runtime/trace-contract.mjs';
import { verifyUpdateManifest } from '../src/runtime/update-signature.mjs';
import { RequestLedger, RequestStates } from './request-ledger.mjs';
import { listGlobalPresets, createGlobalPreset, updateGlobalPreset, deleteGlobalPreset, copyGlobalPreset, markPresetUsed, rateGlobalPreset, composeGlobalPresets, replacePresetModel, copyPresetCover, importGlobalPreset, FORMAT, VERSION, assertInside } from '../src/runtime/global-presets.mjs';
import { createPolicyEngine } from '../src/runtime/governance/policy-engine.mjs';
import { AdmissionController } from '../src/runtime/governance/admission-controller.mjs';
import { RateLimiter } from '../src/runtime/governance/rate-limiter.mjs';
import { QuotaManager } from '../src/runtime/governance/quota-manager.mjs';
import { AuditSink } from '../src/runtime/governance/audit-sink.mjs';
import { OperationGateway, confirmationDigest, assertConfirmationBinding } from '../src/runtime/governance/operation-gateway.mjs';
import { createGovernanceContext } from '../src/runtime/governance/context.mjs';
import { createWindowRegistry } from '../src/runtime/window-registry.mjs';
import { BatchScheduler } from '../src/runtime/batch/batch-scheduler.mjs';
import { expandQueueItems } from '../src/runtime/batch/seed-strategy.mjs';
import { JSONFileStore } from '../src/agent/memory/store.mjs';
import { createMetrics } from '../src/runtime/metrics.mjs';

for (const stream of [process.stdout, process.stderr]) {
  stream?.on('error', error => {
    if (error?.code !== 'EPIPE') throw error;
  });
}

const { app, BrowserWindow, ipcMain, dialog, Menu, shell, Tray, nativeImage, globalShortcut, screen, Notification, clipboard } = pkg;

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_NAME = 'ComfyMuse';
const APP_ID = 'com.comfyui.agent';
const USER_DATA_DIR_NAME = 'comfy-agent';
const APP_ICON_PATH = join(__dirname, 'icon.ico');
const DEFAULT_BASE_URL = 'http://127.0.0.1:8188';
const portableRootPath = join(__dirname, '..', 'comfyui-root.txt');
const appRoot = dirname(__dirname);
const FLOATING_WINDOW_SIZE = { width: 420, height: 680 };
const FLOATING_ORB_SIZE = { width: 72, height: 72 };
const FLOATING_MIN_SIZE = { width: 360, height: 430 };
const FLOATING_EDGE_GUTTER = 2;
let floatingPosition = null;
let floatingExpandedSize = { ...FLOATING_WINDOW_SIZE };
let floatingBoundsGuard = false;
let pendingFloatingDrag = null;
let floatingWindowPointerGrab = null;
let floatingMoveToken = 0;
let floatingResizeTimer = null;
let floatingAnimationReleaseTimer = null;
let floatingAnimating = false;

function floatingPositionPath() { return join(app.getPath('userData'), 'floating-position.json'); }

function clampFloatingPosition(x, y, width, height) {
  const display = screen.getDisplayNearestPoint({ x, y });
  const area = display.workArea;
  const safeWidth = Math.min(width, area.width);
  const safeHeight = Math.min(height, area.height);
  const horizontalGutter = area.width > safeWidth + FLOATING_EDGE_GUTTER * 2 ? FLOATING_EDGE_GUTTER : 0;
  const verticalGutter = area.height > safeHeight + FLOATING_EDGE_GUTTER * 2 ? FLOATING_EDGE_GUTTER : 0;
  return {
    x: Math.max(area.x + horizontalGutter, Math.min(Math.round(x), area.x + area.width - safeWidth - horizontalGutter)),
    y: Math.max(area.y + verticalGutter, Math.min(Math.round(y), area.y + area.height - safeHeight - verticalGutter)),
  };
}

function clampFloatingBounds(x, y, width, height) {
  const display = screen.getDisplayNearestPoint({ x, y });
  const area = display.workArea;
  const minWidth = Math.min(FLOATING_MIN_SIZE.width, area.width);
  const minHeight = Math.min(FLOATING_MIN_SIZE.height, area.height);
  const safeWidth = Math.max(minWidth, Math.min(Math.round(width), area.width));
  const safeHeight = Math.max(minHeight, Math.min(Math.round(height), area.height));
  const position = clampFloatingPosition(x, y, safeWidth, safeHeight);
  return { ...position, width: safeWidth, height: safeHeight };
}

function readFloatingPosition() {
  if (floatingPosition) return floatingPosition;
  try { floatingPosition = JSON.parse(readFileSync(floatingPositionPath(), 'utf8')); } catch { floatingPosition = null; }
  if (floatingPosition?.width > FLOATING_ORB_SIZE.width && floatingPosition?.height > FLOATING_ORB_SIZE.height) {
    floatingExpandedSize = { width: Number(floatingPosition.width), height: Number(floatingPosition.height) };
  }
  return floatingPosition;
}

function saveFloatingPosition(x, y, size = {}) {
  floatingPosition = { ...(floatingPosition || {}), x, y, ...size };
  try { writeFileSync(floatingPositionPath(), JSON.stringify(floatingPosition)); } catch { /* persistence is best effort */ }
}

function resolveAppPath(value) {
  return value && isAbsolute(value) ? resolve(value) : value ? resolve(appRoot, value) : '';
}

const packagedPortableRoot = existsSync(portableRootPath)
  ? resolveAppPath(readFileSync(portableRootPath, 'utf-8').trim())
  : '';

function loadEnvFile() {
  for (const dir of [appRoot, dirname(process.execPath)]) {
    const filePath = join(dir, '.env');
    if (!existsSync(filePath)) continue;
    const env = {};
    for (const line of readFileSync(filePath, 'utf-8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
      if (!match) continue;
      env[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
    return env;
  }
  return {};
}

const envConfig = loadEnvFile();
const COMFY_START_DIRS = [packagedPortableRoot, appRoot, dirname(process.execPath)];

let mainWindow;
let floatingWindow;
let tray;
let agent;
let agentReadyPromise;
let agentEventUnsubscribers = [];
let directService;
let prefStore;
const authorizedMediaPaths = new Set();
const executionCoordinator = new ExecutionCoordinator();
const rawCoordinatorExecute = executionCoordinator.execute.bind(executionCoordinator);
const runtimeMetrics = createMetrics();
const windowRegistry = createWindowRegistry();
const requestLedger = new RequestLedger({ metrics: runtimeMetrics });
const localPrincipal = { id: 'principal_local_user', type: 'local_user', tenantId: 'tenant_local', roles: ['admin'], disabled: false };
const governancePolicy = createPolicyEngine({ principals: new Map([[localPrincipal.id, localPrincipal]]) });
const governanceAdmission = new AdmissionController({
  policyEngine: governancePolicy,
  rateLimiter: new RateLimiter({ limit: 120, intervalMs: 60_000, burst: 20 }),
  quotaManager: new QuotaManager(),
  limits: { 'session:*': 1 },
});
let governanceGateway;
let projectWriteQueue = Promise.resolve();
let recoveryPromise;
const activeImageRequests = new Map();
let globalPresetsRoot = '';
let embeddedMcpTransport;
const workflowInspectionRequests = new Map();
let updateState = { status: 'idle', progress: 0, version: '', error: '' };
let downloadedUpdate = null;
// The only manifest the download/install chain may trust: set exclusively by
// checkForUpdate() after verifyUpdateManifest() succeeds. The renderer can
// never influence it, so a renderer compromise cannot steer downloads.
let verifiedManifest = null;

const comfyManager = new ComfyUIManager({
  baseUrl: envConfig.COMFYUI_BASE_URL || DEFAULT_BASE_URL,
  startDirs: COMFY_START_DIRS,
  onStatus: state => sendToRenderer('comfyui:status', state),
});

function getDefaultWorkflowDir() {
  if (comfyManager.workflowDir && isDirectoryPath(comfyManager.workflowDir)) {
    return comfyManager.workflowDir;
  }
  return '';
}

function isDirectoryPath(filePath) {
  try {
    return statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function getWorkflowDir(config = {}) {
  const configured = config.workflowDir || '';
  const normalized = configured.toLowerCase().replaceAll('/', '\\');
  const isBundledDependencyPath = normalized.includes('node_modules\\wait-on\\.github\\workflows');
  if (configured && isDirectoryPath(configured) && !isBundledDependencyPath) return configured;
  return getDefaultWorkflowDir();
}

function getDisplayPath(filePath) {
  if (!filePath || !app.isReady()) return filePath || '';
  return displayPath(filePath, [
    { path: app.getPath('desktop'), label: '桌面' },
    { path: app.getPath('documents'), label: '文档' },
    { path: app.getPath('downloads'), label: '下载' },
    { path: app.getPath('pictures'), label: '图片' },
    { path: app.getPath('videos'), label: '视频' },
    { path: app.getPath('music'), label: '音乐' },
  ]);
}

function ensureDirectService() {
  if (!directService) {
    directService = new DirectService({
      executor: new ComfyExecutor(ComfyUITool),
      workflowDir: getWorkflowDir({ workflowDir: agent?.workflowDir }),
    });
  }
  return directService;
}

function executionOwner(input = {}) {
  const projectId = input.projectId || agent?.sessionManager.activeProjectId || '';
  const sessionId = input.sessionId || agent?.sessionManager.activeSessionId || '';
  const project = agent?.sessionManager.getProject(projectId);
  return {
    principalId: input.principalId || localPrincipal.id,
    tenantId: input.tenantId || localPrincipal.tenantId,
    projectId: projectId || 'project_local',
    sessionId: sessionId || 'session_local',
    projectDir: project?.dir || '',
    workflowDir: input.workflowDir || agent?.workflowDir || getDefaultWorkflowDir(),
  };
}

function assertExecutionAvailable() {
  executionCoordinator.assertAvailable();
}

async function runGovernedIpcMutation({ action, input = {}, resource = {}, projectId = '', sessionId = '', quota = {}, operation = action, execute, confirmation } = {}) {
  const owner = executionOwner({ projectId, sessionId });
  const context = getGovernanceGateway().context({
    ...owner,
    requestId: input.requestId,
    taskId: input.taskId,
    traceId: input.traceId,
  }, { source: 'ipc' });
  const run = () => getGovernanceGateway().run({ context, action, resource, input, quota, operation, execute, confirmation });
  if (action !== 'project.write') return run();
  const result = projectWriteQueue.then(run, run);
  projectWriteQueue = result.catch(() => {});
  return result;
}

function listWorkflowFiles(dir) {
  return collectWorkflowFiles(dir);
}

function directSandboxInput() {
  const project = agent?.sessionManager.getActiveProject?.();
  const allowedRoots = project?.dir ? [{ name: 'project', path: project.dir }] : [];
  allowedRoots.push({ name: 'preset', path: presetRoot() });
  return {
    workflowDir: agent?.workflowDir || getDefaultWorkflowDir(),
    allowedRoots,
    comfyRoot: comfyManager.portableRoot ? join(comfyManager.portableRoot, 'ComfyUI') : '',
    [SANDBOX_AUTHORIZED_FILES]: [...authorizedMediaPaths],
  };
}

function resolveImagePath(image = {}) {
  if (!image.filename) throw new Error('图片路径无效');
  let rootName;
  let baseDir;
  if (image.type === 'project' || image.projectId) {
    const project = agent?.sessionManager.getProject(image.projectId || agent.sessionManager.activeProjectId);
    if (!project?.dir) throw new Error('项目目录无效');
    rootName = 'project';
    baseDir = resolve(project.dir);
  } else {
    if (!comfyManager.portableRoot) throw new Error('图片路径无效');
    const directoryType = ['input', 'output', 'temp'].includes(image.type) ? image.type : 'output';
    rootName = directoryType;
    baseDir = resolve(comfyManager.portableRoot, 'ComfyUI', directoryType);
  }
  return resolveSandboxPath({
    workflowDir: agent?.workflowDir || getDefaultWorkflowDir(),
    allowedRoots: rootName === 'project' ? [{ name: 'project', path: baseDir }] : [],
    comfyRoot: rootName === 'project' ? '' : join(comfyManager.portableRoot, 'ComfyUI'),
  }, join(image.subfolder || '', image.filename), { root: rootName });
}

async function getImageDataUrl(image = {}) {
  const filePath = resolveImagePath(image);

  const mimeTypes = {
    '.gif': 'image/gif',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
  };
  const mimeType = mimeTypes[extname(filePath).toLowerCase()];
  if (!mimeType) throw new Error('不支持的图片格式');

  const data = await readFile(filePath);
  return `data:${mimeType};base64,${data.toString('base64')}`;
}

async function getAuthorizedMediaDataUrl(media = {}) {
  if (!media.path) throw new Error('Invalid media path');
  const filePath = resolve(media.path);
  if (!authorizedMediaPaths.has(filePath)) throw new Error('Media path is not authorized');

  const mimeTypes = {
    '.gif': 'image/gif',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
  };
  const mimeType = mimeTypes[extname(filePath).toLowerCase()];
  if (!mimeType) throw new Error('Unsupported media preview format');

  const data = await readFile(filePath);
  return `data:${mimeType};base64,${data.toString('base64')}`;
}

async function getRecentImages() {
  const historyImages = await ComfyUITool.recentImages(1).catch(() => []);
  if (historyImages.length > 0) return historyImages;
  if (!comfyManager.portableRoot) return [];

  const outputDir = join(comfyManager.portableRoot, 'ComfyUI', 'output');
  const files = [];

  async function collect(subfolder = '') {
    const currentDir = join(outputDir, subfolder);
    for (const entry of await readdir(currentDir, { withFileTypes: true })) {
      const relativeName = join(subfolder, entry.name);
      if (entry.isDirectory()) {
        await collect(relativeName);
      } else if (/\.(gif|jpe?g|png|webp)$/i.test(entry.name)) {
        const info = await stat(join(outputDir, relativeName));
        files.push({ filename: entry.name, subfolder, type: 'output', mtimeMs: info.mtimeMs });
      }
    }
  }

  await collect();
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const newest = files[0]?.mtimeMs || 0;
  return files
    .filter(file => newest - file.mtimeMs <= 10000)
    .slice(0, 50)
    .map(({ mtimeMs, ...image }) => image);
}

async function getProjectAssets(projectId = '') {
  const project = agent?.sessionManager.getProject(projectId || agent.sessionManager.activeProjectId);
  return scanProjectAssets({
    project,
    readTrace: async taskId => {
      const tracePath = join(project.dir, 'traces', `${taskId}.json`);
      if (!existsSync(tracePath)) return null;
      return JSON.parse(await readFile(tracePath, 'utf-8'));
    },
  });
}

async function deleteProjectAsset(image = {}) {
  const projectId = image.projectId || agent?.sessionManager.activeProjectId;
  const project = agent?.sessionManager.getProject(projectId);
  if (!project?.dir || project.id !== agent?.sessionManager.activeProjectId || !['project', 'video'].includes(image.type) || image.projectId !== project.id) {
    throw new Error('只能删除当前项目中的归档资产');
  }

  const filePath = resolveImagePath(image);
  const assetRoot = projectAssetRoot(project.dir, filePath);
  if (!assetRoot) {
    throw new Error('资产路径无效');
  }

  await unlink(filePath);
  await unlink(assetRecipePath(filePath)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  await removeEmptyAssetDirectories(filePath, assetRoot);
  const key = `${normalizeAssetPath(image.subfolder)}:${image.filename || ''}`;
  const assets = (agent.project.get('assets') || []).filter(item => `${normalizeAssetPath(item.subfolder)}:${item.filename || ''}` !== key);
  await agent.project.set('assets', assets);
  await agent.project.set('lastImages', (agent.project.get('lastImages') || []).filter(item => `${normalizeAssetPath(item.subfolder)}:${item.filename || ''}` !== key));
  return getProjectAssets(project.id);
}

function getStoredConfig() {
  return prefStore.getAll();
}

function publicProvider(provider) {
  const { apiKey, _encryptedApiKey, apiKeyError, ...safe } = provider || {};
  return { ...safe, hasApiKey: Boolean(apiKey || _encryptedApiKey), apiKeyError: apiKeyError || '' };
}

function publicLLM(llm) {
  return {
    ...llm,
    providers: (llm.providers || []).map(publicProvider),
    resolved: resolveLLMRouting(llm),
  };
}

function normalizeHttpUrl(value, label) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { throw new Error(`${label}必须是有效的 HTTP/HTTPS 地址`); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`${label}仅支持 HTTP/HTTPS 协议`);
  if (url.username || url.password) throw new Error(`${label}不能包含账号密码`);
  return url.toString().replace(/\/$/, '');
}

function normalizeHeaders(headers = {}) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return {};
  const result = {};
  for (const [key, value] of Object.entries(headers).slice(0, 32)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,80}$/.test(key) || /[\r\n]/.test(String(value)) || String(value).length > 4096) throw new Error('请求头名称或值无效');
    if (/^(authorization|cookie|proxy-authorization|host|content-length)$/i.test(key)) throw new Error(`不允许自定义请求头：${key}`);
    result[key] = String(value);
  }
  return result;
}

function syncProjectPreferences() {
  if (!agent) return;
  const mappings = Object.fromEntries(agent.sessionManager.projects.map(project => [project.id, {
    dir: project.dir,
    name: project.name,
  }]));
  prefStore.set('projects', mappings);
}

async function commitCopies(comfyRoot, files, finalDir, subfolder) {
  const staged = [];
  const usedNames = new Set();
  for (const file of files) {
    if (!file.filename || file.type === 'project') continue;
    const sourceBase = resolve(comfyRoot, ['input', 'temp'].includes(file.type) ? file.type : 'output');
    const source = resolve(sourceBase, file.subfolder || '', file.filename);
    const sourceRelative = relative(sourceBase, source);
    if (sourceRelative.startsWith('..') || isAbsolute(sourceRelative)) continue;
    const sourceRoot = await realpath(sourceBase);
    const sourcePath = await realpath(source);
    const canonicalRelative = relative(sourceRoot, sourcePath);
    if (canonicalRelative.startsWith('..') || isAbsolute(canonicalRelative)) continue;
    if ((await lstat(source)).isSymbolicLink()) continue;
    const originalName = basename(file.filename);
    const extension = extname(originalName);
    const stem = originalName.slice(0, originalName.length - extension.length);
    let filename = originalName;
    let suffix = 1;
    while (usedNames.has(filename)) filename = `${stem}_${suffix++}${extension}`;
    usedNames.add(filename);
    staged.push({ filename, source: sourcePath });
  }
  if (staged.length === 0) return [];
  if (existsSync(finalDir) && staged.every(entry => existsSync(join(finalDir, entry.filename)))) {
    return staged.map(entry => ({ filename: entry.filename, subfolder, type: 'project' }));
  }
  const stageDir = `${finalDir}.tmp`;
  await rm(stageDir, { recursive: true, force: true });
  await mkdir(stageDir, { recursive: true });
  try {
    for (const entry of staged) await copyFile(entry.source, join(stageDir, entry.filename));
    await rm(finalDir, { recursive: true, force: true });
    await rename(stageDir, finalDir);
  } catch (error) {
    await rm(stageDir, { recursive: true, force: true });
    throw error;
  }
  return staged.map(entry => ({ filename: entry.filename, subfolder, type: 'project' }));
}

async function archiveProjectResult(result, owner = {}) {
  const mediaKey = item => JSON.stringify([
    item?.path || item?.url || item?.filename || item?.name || '',
    item?.subfolder || '',
    item?.type || '',
    item?.mediaType || item?.kind || '',
    item?.assetId || '',
  ]);
  const uniqueMedia = items => [...new Map((items || []).map(item => [mediaKey(item), item])).values()];
  result = {
    ...result,
    images: uniqueMedia(result?.images),
    videos: uniqueMedia(result?.videos),
  };
  const existingTask = result.taskId ? agent?.taskManager?.get(result.taskId) : null;
  if (existingTask?.archiveStatus === 'archived' && existingTask.result?.archiveStatus === 'archived') {
    return existingTask.result;
  }
  const sessionManager = agent?.sessionManager;
  const project = sessionManager?.getProject(owner.projectId || sessionManager?.activeProjectId);
  if (!project?.dir) {
    return { ...result, archiveStatus: 'archive_failed', rawResultAvailable: true, retryable: true, archiveError: 'Project directory is unavailable' };
  }
  const projectMemory = owner.projectId && owner.projectId === sessionManager?.activeProjectId
    ? agent.project
    : null;
  if (result?.source === 'direct' && projectMemory && result.compiledPrompt) {
    await projectMemory.set('lastPrompt', result.compiledPrompt.positive || '');
    await projectMemory.set('lastCompiledPrompt', {
      positive: result.compiledPrompt.positive || '',
      negative: result.compiledPrompt.negative || '',
      tags: [],
      narrative: '',
      constraints: {},
    });
    await projectMemory.set('lastGenerationSource', result.source);
  }
  if (!result?.images?.length && !result?.videos?.length) {
    const settled = { ...result, archiveStatus: 'skipped', media: [] };
    if (existingTask) {
      agent.taskManager.settleComplete(result.taskId, { result: settled });
      await agent.taskManager.persist();
    }
    return settled;
  }
  if (!comfyManager.portableRoot) {
    return { ...result, archiveStatus: 'archive_failed', rawResultAvailable: true, retryable: true, archiveError: 'ComfyUI portable root is unavailable' };
  }
  const ownerSessionId = owner.sessionId || agent?.sessionManager.activeSessionId;
  const taskId = result.taskId || '';
  const imageDir = join(project.dir, 'images', taskId);
  const imageEntries = await commitCopies(
    resolve(comfyManager.portableRoot, 'ComfyUI'),
    result.images || [],
    imageDir,
    join('images', taskId),
  );
  const archived = imageEntries.map(entry => ({
    ...entry,
    mediaType: 'image',
    assetId: entry.assetId || `asset_${result.taskId || taskId || Date.now()}_${entry.filename}`,
    projectId: project.id,
    sessionId: ownerSessionId,
    source: result.source || 'direct',
    positive: result.compiledPrompt?.positive || result.positive || '',
    negative: result.compiledPrompt?.negative || result.negative || '',
    workflowName: result.workflowName || result.workflow?.name || '',
    parameters: result.settings || result.parameters || {},
  }));
  const videoDir = join(project.dir, 'videos', taskId);
  const videoEntries = await commitCopies(
    resolve(comfyManager.portableRoot, 'ComfyUI'),
    result.videos || [],
    videoDir,
    join('videos', taskId),
  );
  const archivedVideos = videoEntries.map(entry => ({
    ...entry,
    mediaType: 'video',
    assetId: entry.assetId || `asset_${result.taskId || taskId || Date.now()}_${entry.filename}`,
    projectId: project.id,
    sessionId: ownerSessionId,
    source: result.source || 'direct',
    positive: result.compiledPrompt?.positive || result.positive || '',
    negative: result.compiledPrompt?.negative || result.negative || '',
    workflowName: result.workflowName || result.workflow?.name || '',
    parameters: result.settings || result.parameters || {},
  }));
  if (result.isVideoWorkflow && (result.videos?.length || 0) === 0 && (result.images?.length || 0) > 1) {
    try {
      await mkdir(videoDir, { recursive: true });
      const { composeVideo } = await import('../src/agent/video/video-compose.mjs');
      const frameFiles = readdirSync(imageDir)
        .filter(name => /\.(png|jpe?g|webp)$/i.test(name))
         .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
      if (frameFiles.length > 1) {
        const videoFilename = `${taskId}.mp4`;
        await composeVideo({
          frames: frameFiles.map(file => ({ path: join(imageDir, file) })),
          outputPath: join(videoDir, videoFilename),
           fps: result.settings?.fps || result.parameters?.fps || result.fps || 24,
         });
        archivedVideos.push({
          filename: videoFilename,
          subfolder: join('videos', taskId),
          type: 'project',
          mediaType: 'video',
          assetId: `asset_${taskId}_${videoFilename}`,
          projectId: project.id,
          sessionId: ownerSessionId,
           source: result.source || 'direct',
           positive: result.compiledPrompt?.positive || result.positive || '',
           negative: result.compiledPrompt?.negative || result.negative || '',
           workflowName: result.workflowName || result.workflow?.name || '',
           parameters: result.settings || result.parameters || {},
         });
      }
     } catch (error) {
       const failure = new Error(`帧序列合成失败：${error.message}`, { cause: error });
       failure.failureType = 'video_compose';
       throw failure;
     }
  }
  if (archived.length === 0 && archivedVideos.length === 0) return result;
  await Promise.all([...archived, ...archivedVideos].map(asset => {
    const filePath = join(project.dir, asset.subfolder, asset.filename);
    return writeFile(assetRecipePath(filePath), JSON.stringify({
      positive: asset.positive || '',
      negative: asset.negative || '',
      workflowName: asset.workflowName || '',
      parameters: asset.parameters || {},
      source: asset.source || '',
    }));
  }));
   if (projectMemory && archived.length > 0) await projectMemory.set('lastImages', archived);
   if (projectMemory && archivedVideos.length > 0) await projectMemory.set('lastVideos', archivedVideos);
   const existingAssets = (project.assets || []).filter(asset => asset.taskId !== taskId);
  const assets = [...existingAssets, ...archived.map(image => ({
    ...image,
    taskId,
    createdAt: Date.now(),
  })), ...archivedVideos.map(video => ({
    ...video,
    type: 'video',
    taskId,
    createdAt: Date.now(),
  }))];
   project.assets = assets;
   if (projectMemory) await projectMemory.set('assets', assets);
  const archivedResult = {
    ...result,
    images: archived,
    videos: archivedVideos,
    media: [...archived, ...archivedVideos],
  };
  if (projectMemory) {
    await projectMemory.set('lastResult', archivedResult);
    await projectMemory.set('lastImages', archived);
  }
  if (existingTask) {
    agent.taskManager.update(result.taskId, { archiveStatus: 'archived', result: archivedResult });
    await agent.taskManager.persist();
  }
  if (sessionManager?.activeProjectId === project.id && sessionManager?.activeSessionId === ownerSessionId) {
    sessionManager.setSessionState({ lastTaskId: result.taskId, taskStatus: 'completed', currentArtifactId: archived[0]?.assetId || archivedVideos[0]?.assetId || '', lastResult: archivedResult });
    const recordRequestId = result.requestId || owner.requestId || '';
    if (recordRequestId) {
      sessionManager.upsertGenerationRecord({
        requestId: recordRequestId,
        turnId: result.turnId || owner.turnId || recordRequestId,
        taskId,
        projectId: project.id,
        sessionId: ownerSessionId,
        source: result.source || owner.source || 'direct',
        status: 'completed',
        prompt: result.compiledPrompt?.positive || result.positive || '',
        negative: result.compiledPrompt?.negative || result.negative || '',
        workflowName: result.workflowName || result.workflow?.name || '',
        parameters: result.parameters || result.settings || {},
        nodeOverrides: result.nodeOverrides || {},
        outputNodeIds: Array.isArray(result.outputNodeIds) ? result.outputNodeIds : null,
        media: [...archived, ...archivedVideos],
        durationMs: result.durationMs || result.duration_ms || 0,
        completedAt: Date.now(),
        progressPercent: 100,
        progressNodePercent: 100,
        progressMessage: '生成完成',
        progressStage: 'completed',
        error: null,
      });
    }
    await sessionManager.flush();
  }
  await persistTaskTrace(result.taskId, archivedResult);
  sendToRenderer('project:state', sessionManager.getState());
  return archivedResult;
}

function validTaskId(taskId) {
  return typeof taskId === 'string' && /^[a-zA-Z0-9_-]+$/.test(taskId);
}

async function persistTaskTrace(taskId, resultOverride) {
  if (!agent || !validTaskId(taskId)) return null;
  const task = agent.taskManager.get(taskId);
  const project = task?.projectId ? agent.sessionManager.getProject(task.projectId) : null;
  const trace = await agent.getTrace(taskId);
  if (!project?.dir || !trace?.completedAt) return null;
  const traceDir = join(project.dir, 'traces');
  await mkdir(traceDir, { recursive: true });
  const persisted = sanitizeContextValue({
    ...trace,
    ...(resultOverride ? { result: resultOverride } : {}),
  });
  validateTaskTrace(persisted, taskId, project.id);
  const traceFile = join(traceDir, `${taskId}.json`);
  const tmpFile = `${traceFile}.tmp`;
  await writeFile(tmpFile, JSON.stringify(persisted, null, 2));
  await rename(tmpFile, traceFile);
  return persisted;
}

async function readTaskTrace(taskId) {
  if (!agent || !validTaskId(taskId)) throw traceError('task_not_found', 'Task not found');
  const task = agent.taskManager.get(taskId);
  if (!task) throw traceError('task_not_found', 'Task not found');
  if (!task.projectId) throw traceError('task_owner_missing', 'Task project owner is missing');
  const project = agent.sessionManager.getProject(task.projectId);
  if (!project?.dir) throw traceError('task_owner_project_not_found', 'Task owner project not found');
  const filePath = join(project.dir, 'traces', `${taskId}.json`);
  if (existsSync(filePath)) {
    let trace;
    try {
      trace = JSON.parse(await readFile(filePath, 'utf-8'));
    } catch {
      throw traceError('trace_invalid', 'Trace file is not valid JSON');
    }
    return assertTraceOwner(validateTaskTrace(trace, taskId, project.id), { projectId: task.projectId, sessionId: task.sessionId, tenantId: task.tenantId });
  }
  const trace = await agent.getTrace(taskId);
  if (!trace) throw traceError('trace_not_found', 'Trace not found');
  return assertTraceOwner(validateTaskTrace(trace, taskId, project.id), { projectId: task.projectId, sessionId: task.sessionId, tenantId: task.tenantId });
}

function mcpGenerationBridge() {
  return {
    prepare: async request => {
      await startAgent(getStoredConfig());
      assertExecutionAvailable();
      const owner = executionOwner({ ...(request.owner || {}), projectId: request.owner?.projectId || request.projectId, sessionId: request.owner?.sessionId || request.sessionId, workflowDir: request.workflowDir });
      const requestId = request.requestId || `mcp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const fingerprint = JSON.stringify({ workflowName: request.workflowName, positive: request.positive, negative: request.negative, settings: request.settings, media: request.media });
      const existing = requestLedger.begin(requestId, { source: 'mcp', fingerprint, ...owner });
      if (existing.state === 'completed') return existing.result;
      if (existing.preview) return existing.preview;
      return executionCoordinator.execute({
        source: 'mcp', taskId: requestId, owner,
        work: async entry => {
          const preview = await ensureDirectService().prepare(directGenerationRequest({
            ...request, requestId, projectId: owner.projectId, sessionId: owner.sessionId, principalId: owner.principalId, tenantId: owner.tenantId,
          }), { sandboxInput: directSandboxInput() });
          Object.assign(preview, owner);
          requestLedger.update(requestId, { state: 'prepared', previewId: preview.previewId, preview });
          executionCoordinator.registerPreview({ source: 'mcp', previewId: preview.previewId, taskId: requestId, requestId, owner, entry });
          return preview;
        },
      });
    },
    runPrepared: async (previewId, edits, owner = {}, confirmation = {}) => {
      const preview = ensureDirectService().getPreview(previewId);
      const resolvedOwner = executionOwner({ ...preview, ...owner });
      assertOwnerMatch(preview, resolvedOwner);
      assertConfirmationBinding({ confirmation, expectedDigest: preview.requestDigest, requestId: preview.requestId, previewId });
      const abortController = new AbortController();
      return executionCoordinator.execute({
        source: 'mcp', taskId: preview.requestId, owner: resolvedOwner, previewId,
        cancel: async () => { abortController.abort(); await ensureDirectService().cancel(); },
        work: async () => {
          requestLedger.update(preview.requestId, { state: 'executing' });
          try {
            const result = await ensureDirectService().run(previewId, edits, { source: 'mcp', signal: abortController.signal });
            const archived = await archiveProjectResult(result, resolvedOwner);
            requestLedger.complete(preview.requestId, archived);
            return archived;
          } catch (error) {
            requestLedger.fail(preview.requestId, error);
            throw error;
          }
        },
      });
    },
    status: async ({ requestId = '', taskId = '', owner = {} } = {}) => {
      if (requestId) { const entry = requestLedger.snapshot(requestId); assertOwnerMatch(entry, owner); return entry; }
      if (taskId && agent) { const task = agent.taskManager.get(taskId); assertOwnerMatch(task, owner); return agent.getTrace(taskId) || task || { taskId, status: 'unknown' }; }
      return { status: 'unknown' };
    },
    cancel: async ({ previewId = '', taskId = '', owner = {} } = {}) => {
      if (previewId) {
        const preview = ensureDirectService().getPreview(previewId);
        assertOwnerMatch(preview, owner);
        const discarded = ensureDirectService().discardPreview(previewId);
        if (!discarded) throw Object.assign(new Error('Generation preview not found'), { code: 'PREVIEW_NOT_FOUND' });
        if (preview.requestId) requestLedger.update(preview.requestId, { state: 'cancelled', result: { cancelled: true, requestId: preview.requestId, previewId } });
        executionCoordinator.discardPreview(previewId);
        return { cancelled: true, previewId, requestId: preview.requestId || '' };
      }
      if (taskId) {
        const active = executionCoordinator.active;
        if (active?.taskId === taskId && active.source === 'mcp') {
          assertOwnerMatch(active.owner, owner);
          const result = await executionCoordinator.cancel({ source: 'mcp', taskId });
          requestLedger.update(active.requestId || taskId, { state: 'cancelled', result });
          return result;
        }
        if (agent) {
          const task = agent.taskManager.get(taskId);
          assertOwnerMatch(task, owner);
          return agent.cancel(taskId);
        }
        throw Object.assign(new Error('Generation task not found'), { code: 'TASK_NOT_FOUND' });
      }
      throw Object.assign(new Error('A previewId or taskId is required to cancel a generation'), { code: 'RESOURCE_ID_REQUIRED' });
    },
  };
}

function mcpModuleFlags(value = {}) {
  return {
    web: value.web !== false,
    files: value.files !== false,
    comfyui: value.comfyui !== false,
    skills: value.skills !== false,
  };
}

async function startEmbeddedMcp(config = {}) {
  if (embeddedMcpTransport || !(config.mcp?.enabled || envConfig.COMFY_AGENT_MCP_ENABLED === 'true')) return;
  const enabledSkills = config.skills?.system || {};
  const activeSkills = Object.fromEntries(Object.entries(BUILTIN_SKILLS).filter(([id]) => enabledSkills[id] !== false));
  for (const custom of config.skills?.custom || []) {
    if (custom?.id && custom.enabled !== false) activeSkills[custom.id] = createCustomSkill(custom);
  }
  for (const external of config.skills?.external || []) {
    if (external?.id && external.enabled !== false) {
      try { activeSkills[external.id] = normalizeExternalSkill(external, external.source || 'config'); } catch (error) { console.warn(`Skipping external Skill ${external.id}: ${error.message}`); }
    }
  }
  const modules = mcpModuleFlags(config.mcp?.modules || {});
  const server = createWebMcpServer({
    generation: mcpGenerationBridge(),
    skills: activeSkills,
    modules,
    includeReadOnlyTools: true,
    includeRuntimeMutationTools: modules.comfyui,
    includeWorkflowMutationTools: modules.comfyui,
    includeSkillTools: modules.skills,
    // MCP tools run under the same sandbox policy as the agent executor:
    // web tools honor the research network switch, media paths are checked.
    sandbox: createSandboxPolicy({ allowNetwork: (prefStore.get('research') || {}).allowNetwork !== false }),
  });
  const mcpHost = config.mcp?.host || envConfig.COMFY_AGENT_MCP_HOST || '127.0.0.1';
  const mcpPort = Number(config.mcp?.port || envConfig.COMFY_AGENT_MCP_PORT || 3333);
  const mcpToken = config.mcp?.token || envConfig.COMFY_AGENT_MCP_TOKEN || '';
  if (mcpHost !== '127.0.0.1' && mcpHost !== 'localhost' && !mcpToken) {
    throw new Error('MCP 监听局域网地址时必须设置访问令牌');
  }
  embeddedMcpTransport = createMcpHttpServer(server, {
    host: mcpHost,
    port: mcpPort,
    authToken: mcpToken,
  });
  const address = await embeddedMcpTransport.listen();
  console.error(`Embedded MCP listening on http://${address.address}:${address.port}/mcp`);
}

async function restartEmbeddedMcp() {
  try { await embeddedMcpTransport?.close?.(); } catch {}
  embeddedMcpTransport = undefined;
  await startEmbeddedMcp(getStoredConfig());
}

function directTaskId(requestId = '') {
  return `direct_task_${requestId}_${randomUUID()}`;
}

async function createDirectTask(preview) {
  const taskId = directTaskId(preview.requestId);
  if (!agent?.taskManager) return taskId;
  await agent.taskManager.create({
    id: taskId,
    requestId: preview.requestId,
    turnId: preview.turnId || '',
    kind: 'direct_run',
    message: preview.positive || '',
    workflowName: preview.workflow?.name || '',
    traceId: `trace_${taskId}`,
    intent: 'generate',
    projectId: preview.projectId || '',
    sessionId: preview.sessionId || '',
  });
  await agent.taskManager.transition(taskId, 'classifying');
  await agent.taskManager.transition(taskId, 'awaiting_confirmation');
  await agent.taskManager.persist();
  return taskId;
}

async function updateDirectTask(taskId, state, patch = {}) {
  if (!taskId || !agent?.taskManager?.get(taskId)) return;
  const task = agent.taskManager.get(taskId);
  if (state === 'executing' && ['failed', 'cancelled'].includes(task.state)) {
    agent.taskManager.transition(taskId, 'classifying');
  }
  agent.taskManager.transition(taskId, state, patch);
  await agent.taskManager.persist();
}

async function recordDirectExecutionEvent({ taskId, turnId = '', projectId = '', sessionId = '', traceId = '', type = 'agent:step', stage = '', stepId = 'comfyui', tool = 'comfyui', status = '', description = '', error = '', plan = null } = {}) {
  if (!agent?.sessionManager?.appendExecutionEvent || !turnId) return;
  await agent.sessionManager.appendExecutionEvent({ taskId, turnId, projectId, sessionId, traceId, type, stage, stepId, tool, status, description, error, ...(plan ? { plan } : {}) });
}

async function completeDirectTask(taskId, result = {}, error = null) {
  if (!taskId || !agent?.taskManager?.get(taskId)) return;
  const task = agent.taskManager.get(taskId);
  const state = error ? (error.stage === 'archive' ? 'archive_failed' : 'failed') : result.cancelled ? 'cancelled' : 'completed';
  if (!error && !result.cancelled && task.state === 'executing') await updateDirectTask(taskId, 'observing', { promptId: result.promptId || task.promptId || '' });
  if (task.state !== state) await updateDirectTask(taskId, state, { promptId: result.promptId || task.promptId || '' });
  if (error?.stage === 'archive') {
    agent.taskManager.update(taskId, { archiveStatus: 'archive_failed', status: 'archive_failed', state: 'archive_failed', result, error, lastError: error.message || 'Archive failed' });
  } else if (!error && !result.cancelled) {
    agent.taskManager.settleComplete(taskId, { result });
  } else {
    agent.taskManager.complete(taskId, { result, error });
  }
  await agent.taskManager.persist();
  await persistTaskTrace(taskId, result);
}

function animateFloatingBounds(target, finalMinSize = null, duration = 260) {
  if (!floatingWindow || floatingWindow.isDestroyed()) return;
  if (floatingResizeTimer) clearInterval(floatingResizeTimer);
  if (floatingAnimationReleaseTimer) clearTimeout(floatingAnimationReleaseTimer);

  const start = floatingWindow.getBounds();
  const startedAt = Date.now();
  const easeOut = progress => 1 - ((1 - progress) ** 3);
  floatingAnimating = true;
  floatingBoundsGuard = true;
  floatingResizeTimer = setInterval(() => {
    if (!floatingWindow || floatingWindow.isDestroyed()) {
      clearInterval(floatingResizeTimer);
      floatingResizeTimer = null;
      floatingAnimating = false;
      floatingBoundsGuard = false;
      return;
    }
    const progress = Math.min(1, (Date.now() - startedAt) / duration);
    const eased = easeOut(progress);
    const bounds = {
      x: Math.round(start.x + (target.x - start.x) * eased),
      y: Math.round(start.y + (target.y - start.y) * eased),
      width: Math.round(start.width + (target.width - start.width) * eased),
      height: Math.round(start.height + (target.height - start.height) * eased),
    };
    floatingWindow.setBounds(bounds);
    if (progress < 1) return;
    clearInterval(floatingResizeTimer);
    floatingResizeTimer = null;
    floatingWindow.setBounds(target);
    if (finalMinSize) floatingWindow.setMinimumSize(finalMinSize.width, finalMinSize.height);
    // Electron can emit the final resize event on the next turn; keep the guard
    // active until that event has settled instead of allowing a last edge jump.
    floatingAnimationReleaseTimer = setTimeout(() => {
      floatingAnimationReleaseTimer = null;
      floatingAnimating = false;
      floatingBoundsGuard = false;
    }, 50);
  }, 16);
}

function floatingDragHit(x, y) {
  if (!floatingWindow || floatingWindow.isDestroyed() || !floatingWindow.isVisible()) return false;
  const bounds = floatingWindow.getBounds();
  return x >= bounds.x && x <= bounds.x + bounds.width && y >= bounds.y && y <= bounds.y + bounds.height;
}

function floatingLocalPoint(point) {
  if (!point || !floatingWindow || floatingWindow.isDestroyed()) return null;
  const bounds = floatingWindow.getBounds();
  return { x: point.x - bounds.x, y: point.y - bounds.y };
}

function sendFloatingDrag(data) {
  if (floatingWindow && !floatingWindow.isDestroyed() && !floatingWindow.webContents.isLoading()) {
    floatingWindow.webContents.send('floating:drag', data);
    return true;
  }
  return false;
}

function flushPendingFloatingDrag() {
  if (!pendingFloatingDrag) return;
  if (sendFloatingDrag({ phase: 'start', payload: pendingFloatingDrag })) pendingFloatingDrag = null;
}

function settleRecoveredTask(taskId, result) {
  const manager = agent?.taskManager;
  if (!manager) return null;
  if (typeof manager.settleComplete === 'function') {
    return manager.settleComplete(taskId, { result });
  }
  // Keep recovery usable with an older worker proxy that lacks settleComplete.
  manager.complete?.(taskId, { result, error: null });
  manager.update?.(taskId, {
    status: 'completed',
    state: 'completed',
    error: null,
    lastError: '',
    traceError: null,
  });
  return manager.get?.(taskId);
}

function sendToRenderer(channel, data) {
  const owner = data && typeof data === 'object' ? data : {};
  const active = executionOwner();
  windowRegistry.send(channel, data, metadata => {
    // Direct tasks can be owned by the floating window while the main
    // renderer is still hydrating its session. Let each renderer apply its
    // project/session/task filter instead of dropping the event here.
    if (channel === 'direct:status' || channel === 'direct:progress') return true;
    if (owner.tenantId && owner.tenantId !== active.tenantId) return false;
    if (owner.projectId && active.projectId && owner.projectId !== active.projectId) return false;
    if (owner.sessionId && active.sessionId && owner.sessionId !== active.sessionId) return false;
    return true;
  });
}

function rendererKind(window) {
  return window === floatingWindow ? 'floating' : 'main';
}

function attachRendererDiagnostics(window, kind) {
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3 || String(validatedURL || '').startsWith('data:text/html')) return;
    console.error(`[renderer:${kind}] load failed ${errorCode}: ${errorDescription} (${validatedURL})`);
    window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<h1>ComfyUI Agent ${kind} window failed to load</h1><p>${errorDescription || '资源加载失败'}</p><p>请检查应用资源或开发服务器，然后重新打开窗口。</p>`)}`);
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[renderer:${kind}] process gone`, details);
  });
  window.webContents.on('unresponsive', () => {
    console.error(`[renderer:${kind}] unresponsive`);
  });
}

ipcMain.on('renderer:error', (event, details = {}) => {
  const source = BrowserWindow.fromWebContents(event.sender);
  const sanitize = value => String(value || '').replace(/[\r\n]+/g, ' ').slice(0, 2000);
  console.error(`[renderer:${rendererKind(source)}]`, {
    message: sanitize(details.message) || 'unknown renderer error',
    stack: sanitize(details.stack),
    componentStack: sanitize(details.componentStack),
    reportedKind: sanitize(details.kind),
  });
});

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  else { mainWindow.show(); mainWindow.focus(); }
}

function notifyGeneration(ok, label = '') {
  if (!Notification.isSupported()) return;
  const ui = prefStore.get('ui') || {};
  const enabled = ok ? ui.notifyOnComplete !== false : ui.notifyOnFail !== false;
  if (!enabled) return;
  const detail = label ? `（${label}）` : '';
  const title = ok ? `生成完成${detail}` : `生成失败${detail}`;
  const body = ok ? '生成结果已就绪，点击查看。' : '生成过程中出现问题，点击查看详情。';
  try {
    const notification = new Notification({ title, body, silent: true, icon: APP_ICON_PATH });
    notification.on('click', () => showMainWindow());
    notification.show();
  } catch (error) {
    console.error('[notification]', error?.message || error);
  }
}

function showFloatingWindow({ focus = true } = {}) {
  if (floatingWindow && !floatingWindow.isDestroyed()) {
    if (focus) floatingWindow.show();
    else floatingWindow.showInactive();
    if (focus) floatingWindow.focus();
    return;
  }
  const saved = readFloatingPosition();
  const display = screen.getPrimaryDisplay();
  const area = display.workArea;
  const defaultX = area.x + area.width - FLOATING_WINDOW_SIZE.width - 24;
  const defaultY = area.y + area.height - FLOATING_WINDOW_SIZE.height - 24;
  const savedSize = saved?.width > FLOATING_ORB_SIZE.width && saved?.height > FLOATING_ORB_SIZE.height
    ? { width: Number(saved.width), height: Number(saved.height) }
    : FLOATING_WINDOW_SIZE;
  floatingExpandedSize = { ...savedSize };
  const bounds = clampFloatingBounds(saved?.x ?? defaultX, saved?.y ?? defaultY, savedSize.width, savedSize.height);
  floatingWindow = new BrowserWindow({
    ...bounds,
    maximizable: false,
    fullscreenable: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    resizable: true,
    minWidth: FLOATING_MIN_SIZE.width,
    minHeight: FLOATING_MIN_SIZE.height,
    backgroundColor: '#00000000',
    title: '快速生成',
    icon: APP_ICON_PATH,
    show: focus,
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  hardenWindowNavigation(floatingWindow);
  attachRendererDiagnostics(floatingWindow, 'floating');
  windowRegistry.register('floating', floatingWindow.webContents, { kind: 'floating' });
  floatingWindow.setBackgroundColor('#00000000');
  floatingWindow.setAlwaysOnTop(true, 'floating');
  if (!focus) floatingWindow.showInactive();
  const keepFloatingInsideWorkArea = () => {
    if (!floatingWindow || floatingWindow.isDestroyed() || floatingBoundsGuard || floatingAnimating) return;
    const current = floatingWindow.getBounds();
    const isOrb = current.width <= FLOATING_ORB_SIZE.width && current.height <= FLOATING_ORB_SIZE.height;
    floatingWindow.setMinimumSize(
      isOrb ? FLOATING_ORB_SIZE.width : FLOATING_MIN_SIZE.width,
      isOrb ? FLOATING_ORB_SIZE.height : FLOATING_MIN_SIZE.height,
    );
    const next = isOrb
      ? { ...clampFloatingPosition(current.x, current.y, current.width, current.height), width: current.width, height: current.height }
      : clampFloatingBounds(current.x, current.y, current.width, current.height);
    const changed = current.x !== next.x || current.y !== next.y || current.width !== next.width || current.height !== next.height;
    floatingBoundsGuard = true;
    if (changed) floatingWindow.setBounds(next);
    const finalBounds = floatingWindow.getBounds();
    floatingBoundsGuard = false;
    const size = finalBounds.width > FLOATING_ORB_SIZE.width && finalBounds.height > FLOATING_ORB_SIZE.height
      ? { width: finalBounds.width, height: finalBounds.height }
      : {};
    if (size.width) floatingExpandedSize = size;
    saveFloatingPosition(finalBounds.x, finalBounds.y, size);
  };
  floatingWindow.on('move', keepFloatingInsideWorkArea);
  floatingWindow.on('resize', keepFloatingInsideWorkArea);
  floatingWindow.webContents.once('did-finish-load', () => {
    flushPendingFloatingDrag();
  });
  floatingWindow.on('closed', () => {
    windowRegistry.unregister('floating');
    if (floatingResizeTimer) clearInterval(floatingResizeTimer);
    if (floatingAnimationReleaseTimer) clearTimeout(floatingAnimationReleaseTimer);
    floatingResizeTimer = null;
    floatingAnimationReleaseTimer = null;
    floatingAnimating = false;
    floatingWindow = null;
  });
  const distIndex = join(__dirname, '..', 'dist', 'index.html');
  if (existsSync(distIndex)) floatingWindow.loadFile(distIndex, { query: { floating: '1' } });
  else if (!app.isPackaged) floatingWindow.loadURL('http://localhost:5173/?floating=1');
  else floatingWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<h1>ComfyUI Agent resources are missing</h1>'));
}

function showFloatingReceiver() {
  showFloatingWindow({ focus: false });
  if (!floatingWindow || floatingWindow.isDestroyed()) return;
  floatingWindowPointerGrab = null;
  const current = floatingWindow.getBounds();
  if (current.width <= FLOATING_ORB_SIZE.width && current.height <= FLOATING_ORB_SIZE.height) {
    const next = clampFloatingBounds(current.x, current.y, floatingExpandedSize.width, floatingExpandedSize.height);
    floatingWindow.setMinimumSize(FLOATING_ORB_SIZE.width, FLOATING_ORB_SIZE.height);
    // Do not animate receiver expansion while another window is sending a drag.
    // The animation changes screen bounds under the source pointer and can leave
    // the floating window with a stale move/resize cursor after the drop.
    floatingWindow.setBounds(next);
    saveFloatingPosition(next.x, next.y, { width: next.width, height: next.height });
  }
}

// Prevents renderer navigation to foreign origins: if the window ever navigated
// to a remote page, the preload bridge (including update channels) would re-run
// on the attacker's origin. Only the packaged file:// app and the dev server
// are allowed; window.open is never honored, http(s) links go to the OS.
function hardenWindowNavigation(win) {
  win.webContents.on('will-navigate', (event, url) => {
    let allowed = false;
    try {
      const target = new URL(url);
      if (target.protocol === 'file:') allowed = true;
      else if (target.protocol === 'http:' || target.protocol === 'https:') {
        allowed = target.hostname === 'localhost' && target.port === '5173';
      }
    } catch {}
    if (!allowed) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
}

function createWindow() {
  Menu.setApplicationMenu(null);
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    title: APP_NAME,
    icon: APP_ICON_PATH,
    frame: false,
    autoHideMenuBar: true,
    show: true,
    backgroundColor: '#1a1a1a',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  hardenWindowNavigation(mainWindow);
  windowRegistry.register('main', mainWindow.webContents, { kind: 'main' });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', () => {
    if (!quitRequested && floatingWindow && !floatingWindow.isDestroyed()) floatingWindow.destroy();
  });
  attachRendererDiagnostics(mainWindow, 'main');
  mainWindow.on('closed', () => {
    windowRegistry.unregister('main');
    mainWindow = null;
  });
  mainWindow.webContents.once('did-finish-load', () => {
    sendToRenderer('comfyui:status', comfyManager.getState());
  });

  const distIndex = join(__dirname, '..', 'dist', 'index.html');
  if (existsSync(distIndex)) {
    mainWindow.loadFile(distIndex);
  } else if (!app.isPackaged) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
      '<h1>ComfyUI Agent resources are missing</h1><p>Reinstall or rebuild the application.</p>',
    ));
  }
}

ipcMain.handle('window:minimize', () => {
  mainWindow?.minimize();
});

ipcMain.handle('window:toggle-maximize', () => {
  if (!mainWindow) return false;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
  return mainWindow.isMaximized();
});

ipcMain.handle('window:is-maximized', () => mainWindow?.isMaximized() || false);

ipcMain.handle('window:close', () => {
  mainWindow?.close();
});
ipcMain.handle('window:hide', () => {
  mainWindow?.hide();
  return true;
});

ipcMain.handle('floating:show', () => { showFloatingWindow(); return true; });
ipcMain.handle('floating:hide', () => { floatingWindow?.hide(); return true; });
ipcMain.handle('floating:close', () => { floatingWindow?.hide(); return true; });
ipcMain.handle('floating:show-main', () => { showMainWindow(); return true; });
ipcMain.handle('floating:resize', (_, { collapsed = false } = {}) => {
  if (!floatingWindow || floatingWindow.isDestroyed()) return false;
  const current = floatingWindow.getBounds();
  if (!collapsed && current.width > FLOATING_ORB_SIZE.width && current.height > FLOATING_ORB_SIZE.height) {
    floatingExpandedSize = { width: current.width, height: current.height };
  }
  const nextSize = collapsed ? FLOATING_ORB_SIZE : floatingExpandedSize;
  const nextX = current.x + Math.round((current.width - nextSize.width) / 2);
  const nextY = current.y + Math.round((current.height - nextSize.height) / 2);
  const next = collapsed
    ? { ...clampFloatingPosition(nextX, nextY, FLOATING_ORB_SIZE.width, FLOATING_ORB_SIZE.height), ...FLOATING_ORB_SIZE }
    : clampFloatingBounds(nextX, nextY, nextSize.width, nextSize.height);
   floatingWindow.setMinimumSize(FLOATING_ORB_SIZE.width, FLOATING_ORB_SIZE.height);
   animateFloatingBounds(next, collapsed ? FLOATING_ORB_SIZE : FLOATING_MIN_SIZE);
  saveFloatingPosition(next.x, next.y, collapsed ? {} : { width: next.width, height: next.height });
  return true;
});

ipcMain.handle('floating:position', () => {
  if (!floatingWindow || floatingWindow.isDestroyed()) return { x: 0, y: 0 };
  const [x, y] = floatingWindow.getPosition();
  return { x, y };
});

ipcMain.handle('floating:move', (_, { deltaX = 0, deltaY = 0 } = {}) => {
  if (!floatingWindow || floatingWindow.isDestroyed()) return false;
  const [x, y] = floatingWindow.getPosition();
  const bounds = floatingWindow.getBounds();
  const next = clampFloatingPosition(x + Number(deltaX), y + Number(deltaY), bounds.width, bounds.height);
  floatingWindow.setPosition(next.x, next.y);
  saveFloatingPosition(next.x, next.y);
  return next;
});
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('app:open-external', async (_, { url = '' } = {}) => {
  const target = String(url).trim();
  if (!/^https?:\/\//i.test(target)) throw new Error('仅允许打开 HTTP 或 HTTPS 链接');
  await shell.openExternal(target);
  return true;
});
ipcMain.handle('app:update-check', () => checkForUpdate());
ipcMain.handle('app:update-download', () => downloadUpdate());
ipcMain.handle('app:update-install', () => installUpdate());
ipcMain.handle('app:update-state', () => updateState);

ipcMain.handle('floating:move-start', (event, { clientX, clientY, token: requestedToken } = {}) => {
  const point = screenPointFromEvent(event, clientX, clientY);
  if (!point || !floatingWindow || floatingWindow.isDestroyed()) return false;
  const bounds = floatingWindow.getBounds();
  const token = requestedToken || ++floatingMoveToken;
  floatingWindowPointerGrab = { token, offsetX: point.x - bounds.x, offsetY: point.y - bounds.y };
  return token;
});

ipcMain.handle('floating:move-at', (event, { clientX, clientY, token } = {}) => {
  const point = screenPointFromEvent(event, clientX, clientY);
  if (!point || !floatingWindow || floatingWindow.isDestroyed() || !floatingWindowPointerGrab || token !== floatingWindowPointerGrab.token) return false;
  const bounds = floatingWindow.getBounds();
  const next = clampFloatingPosition(
    point.x - floatingWindowPointerGrab.offsetX,
    point.y - floatingWindowPointerGrab.offsetY,
    bounds.width,
    bounds.height,
  );
  floatingWindow.setPosition(next.x, next.y);
  saveFloatingPosition(next.x, next.y);
  return next;
});

ipcMain.handle('floating:move-end', (_, { token } = {}) => {
  if (!token || token === floatingWindowPointerGrab?.token) floatingWindowPointerGrab = null;
  return true;
});

ipcMain.handle('floating:drag-start', (event, payload = {}) => {
  const sourceWindow = BrowserWindow.fromWebContents(event.sender);
  if (!sourceWindow || sourceWindow === floatingWindow) return { accepted: false, reason: 'invalid_source' };
  floatingWindowPointerGrab = null;
  floatingMoveToken += 1;
  pendingFloatingDrag = { ...payload, sourceWindow: 'main', dragId: payload.dragId || `drag-${Date.now()}` };
  showFloatingReceiver();
  if (floatingWindow && !floatingWindow.webContents.isLoading()) flushPendingFloatingDrag();
  return { accepted: true, dragId: pendingFloatingDrag?.dragId || payload.dragId || '' };
});

function screenPointFromEvent(event, clientX, clientY) {
  const sourceWindow = BrowserWindow.fromWebContents(event.sender);
  if (!sourceWindow || !Number.isFinite(Number(clientX)) || !Number.isFinite(Number(clientY))) return null;
  const bounds = sourceWindow.getBounds();
  return { x: bounds.x + Number(clientX), y: bounds.y + Number(clientY) };
}

ipcMain.handle('floating:drag-move', (event, { clientX, clientY } = {}) => {
  const point = screenPointFromEvent(event, clientX, clientY);
  if (!point) return { hit: false };
  const hit = floatingDragHit(point.x, point.y);
  sendFloatingDrag({ phase: 'move', point, local: floatingLocalPoint(point), hit });
  return { hit, point };
});

ipcMain.handle('floating:drag-end', (event, { clientX, clientY, dragId } = {}) => {
  if (dragId && pendingFloatingDrag?.dragId && dragId !== pendingFloatingDrag.dragId) return { hit: false, point: null };
  const point = screenPointFromEvent(event, clientX, clientY);
  const hit = point ? floatingDragHit(point.x, point.y) : false;
  sendFloatingDrag({ phase: 'end', point, local: floatingLocalPoint(point), hit });
  pendingFloatingDrag = null;
  floatingWindowPointerGrab = null;
  return { hit, point };
});

ipcMain.handle('floating:drag-cancel', (_, { dragId } = {}) => {
  if (dragId && pendingFloatingDrag?.dragId && dragId !== pendingFloatingDrag.dragId) return false;
  pendingFloatingDrag = null;
  floatingWindowPointerGrab = null;
  floatingMoveToken += 1;
  sendFloatingDrag({ phase: 'cancel' });
  return true;
});

function initAgent(config) {
  const llmConfig = config.llm || {};
  const previousProjectId = agent?.sessionManager?.activeProjectId || '';
  const previousSessionId = agent?.sessionManager?.activeSessionId || '';
  for (const unsubscribe of agentEventUnsubscribers) unsubscribe();
  agentEventUnsubscribers = [];
    const nextAgent = new AgentProcessClient({
      workflowDir: getWorkflowDir(config),
      onStderr: message => console.error(`[agent] ${message}`),
      onExit: error => {
        if (agent?.isAlive) return;
        sendToRenderer('agent:error', {
          message: error.message,
          code: 'AGENT_PROCESS_EXITED',
          projectId: nextAgent.sessionManager.activeProjectId || previousProjectId,
          sessionId: nextAgent.sessionManager.activeSessionId || previousSessionId,
        });
      },
  });
  agent = nextAgent;
  ensureDirectService().setWorkflowDir(agent.workflowDir);
  bindAgentEvent(AgentEventTypes.STATUS, (data) => {
    sendToRenderer('agent:status', data);
    if (['completed', 'failed', 'error', 'cancelled'].includes(data.status) && data.taskId) {
      void persistTaskTrace(data.taskId).catch(() => {});
    }
    if (data.status === 'completed') notifyGeneration(true, data.kind || data.taskKind || '');
    else if (['failed', 'error'].includes(data.status)) notifyGeneration(false, data.kind || data.taskKind || '');
  });
  const forwardExecutionEvent = (channel, data) => {
    sendToRenderer(channel, data);
    sendToRenderer('project:state', agent.sessionManager.getState());
  };
  bindAgentEvent(AgentEventTypes.STEP, (data) => forwardExecutionEvent('agent:step', data));
  bindAgentEvent(AgentEventTypes.TOOL_CALL, (data) => forwardExecutionEvent('agent:tool-call', data));
  bindAgentEvent(AgentEventTypes.TOOL_RESULT, (data) => forwardExecutionEvent('agent:tool-result', data));
  bindAgentEvent(AgentEventTypes.MESSAGE, (data) => sendToRenderer('agent:message', data));
  bindAgentEvent(AgentEventTypes.ERROR, (data) => forwardExecutionEvent('agent:error', data));
  bindAgentEvent(AgentEventTypes.PLAN, (data) => forwardExecutionEvent('agent:plan', data));
  bindAgentEvent(AgentEventTypes.TASK, (data) => sendToRenderer('agent:task', data));
  bindAgentEvent(AgentEventTypes.TRACE, (data) => sendToRenderer('agent:trace', data));
  bindAgentEvent(AgentEventTypes.PROGRESS, (data) => sendToRenderer('agent:progress', data));
  bindAgentEvent(AgentEventTypes.FEEDBACK, (data) => sendToRenderer('agent:feedback', data));
  bindAgentEvent(AgentEventTypes.CONTEXT_USAGE, (data) => sendToRenderer('agent:context-usage', data));
  configureSkills({ systemEnabled: config.skills?.system, custom: config.skills?.custom, external: config.skills?.external });
  const started = agent.start({
    llm: llmConfig,
    research: config.research || {},
    prompt: promptRuntimeConfig(),
    workflowDir: getWorkflowDir(config),
    comfyRoot: comfyManager.portableRoot ? join(comfyManager.portableRoot, 'ComfyUI') : '',
    userDataPath: app.getPath('userData'),
    comfyBaseUrl: comfyManager.baseUrl,
      projectId: previousProjectId,
      sessionId: previousSessionId,
    skills: config.skills || {},
  });
  return started.then(async result => {
    await requestLedger.load(join(app.getPath('userData'), 'agent-data', 'request-ledger.json'));
    return result;
  }).catch(error => {
    error.projectId ||= nextAgent.sessionManager.activeProjectId || previousProjectId;
    error.sessionId ||= nextAgent.sessionManager.activeSessionId || previousSessionId;
    throw error;
  });
}

function bindAgentEvent(type, handler) {
  agentEventUnsubscribers.push(on(type, data => {
    const task = data?.taskId ? agent?.taskManager?.get?.(data.taskId) : null;
    // Request-scoped events must retain their original owner. Do not infer one
    // from the mutable active session, which can have changed since submission.
    const owner = {
      projectId: data?.projectId || task?.projectId || '',
      sessionId: data?.sessionId || task?.sessionId || '',
    };
    handler({ ...data, ...owner });
  }));
}

function startAgent(config) {
  if (agentReadyPromise) return agentReadyPromise;
  if (agent?.isAlive) return Promise.resolve(agent);

  const promise = initAgent(config)
    .then(() => {
      syncProjectPreferences();
      return agent;
    })
    .catch(error => {
      console.error(`Agent initialization failed: ${error.stack || error.message}`);
      const projectId = error.projectId || agent?.sessionManager?.activeProjectId || '';
      const sessionId = error.sessionId || agent?.sessionManager?.activeSessionId || '';
      void agent?.stop?.();
      sendToRenderer('agent:error', { message: error.message, code: error.code || 'AGENT_INIT_FAILED', projectId, sessionId });
      agent = null;
      throw error;
    })
    .finally(() => {
      if (agentReadyPromise === promise) agentReadyPromise = null;
    });
  agentReadyPromise = promise;
  return promise;
}

async function recoverAgentTasks() {
  if (!agent) return [];
  if (recoveryPromise) return recoveryPromise;
  recoveryPromise = (async () => {
    const recovered = await agent.recoverTasks?.() || [];
  for (const item of recovered) {
    if (item.status !== 'completed' || !item.history) continue;
    try {
      const result = await ComfyUITool.recoverResult(item.promptId, item.history);
      const task = agent.taskManager.get(item.taskId);
      if (task?.requestId) requestLedger.update(task.requestId, { state: 'observing', taskId: item.taskId, promptId: item.promptId || '', recovery: 'recovered' });
      const archived = await archiveProjectResult({ ...result, taskId: item.taskId, promptId: item.promptId, requestId: task?.requestId || '' }, {
        projectId: task?.projectId,
        sessionId: task?.sessionId,
        requestId: task?.requestId || '',
      });
      settleRecoveredTask(item.taskId, archived);
      if (task?.requestId) requestLedger.complete(task.requestId, archived);
      await agent.taskManager.persist();
    } catch (error) {
      const task = agent.taskManager.get(item.taskId);
      if (task) {
        agent.taskManager.update(item.taskId, { state: 'archive_failed', status: 'archive_failed', lastError: error.message, error: error.message });
        await agent.taskManager.persist();
        if (task.requestId) requestLedger.archiveFailed(task.requestId, task.result || null, error);
      }
    }
  }
    return recovered;
  })();
  try { return await recoveryPromise; } finally { recoveryPromise = null; }
}

function applyComfyConfig(config) {
  const baseUrl = envConfig.COMFYUI_BASE_URL || config?.comfyui?.baseUrl || DEFAULT_BASE_URL;
  ComfyUITool.setClient(new ComfyUIClient({ baseUrl }));
  comfyManager.setBaseUrl(baseUrl);
  if (agent?.isAlive) void agent.reconfigureComfy({
    baseUrl: comfyManager.baseUrl,
    comfyRoot: comfyManager.portableRoot ? join(comfyManager.portableRoot, 'ComfyUI') : '',
    workflowDir: getWorkflowDir(config),
  }).catch(error => console.warn(`Unable to reconfigure Agent ComfyUI client: ${error.message}`));
}

const COMFYUI_PORTABLE_URLS = {
  nvidia: 'https://github.com/comfyanonymous/ComfyUI/releases/latest/download/ComfyUI_windows_portable_nvidia.7z',
  amd: 'https://github.com/comfyanonymous/ComfyUI/releases/latest/download/ComfyUI_windows_portable_amd.7z',
  cpu: 'https://github.com/comfyanonymous/ComfyUI/releases/latest/download/ComfyUI_windows_portable_cpu.7z',
};

function downloadToFile(url, targetPath, onProgress) {
  return new Promise((resolvePromise, rejectPromise) => {
    const request = (currentUrl, redirects) => {
      const requestGet = currentUrl.startsWith('https:') ? httpsGet : httpGet;
      const req = requestGet(currentUrl, response => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          if (redirects >= 5) {
            rejectPromise(new Error('下载重定向次数过多'));
            return;
          }
          const next = new URL(response.headers.location, currentUrl);
          if (next.protocol !== 'https:') {
            rejectPromise(new Error('下载重定向必须使用 HTTPS'));
            return;
          }
          request(next.toString(), redirects + 1);
          return;
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          response.resume();
          rejectPromise(new Error(`下载失败：HTTP ${response.statusCode}`));
          return;
        }
        const total = Number(response.headers['content-length'] || 0);
        let received = 0;
        const file = createWriteStream(targetPath);
        response.on('data', chunk => {
          received += chunk.length;
          onProgress({ percent: total ? received / total : 0, bytes: received, total });
        });
        response.pipe(file);
        file.on('finish', () => file.close(() => resolvePromise({ bytes: received })));
        file.on('error', error => {
          req.destroy();
          rejectPromise(error);
        });
        response.on('error', error => {
          req.destroy();
          rejectPromise(error);
        });
      });
      req.once('error', rejectPromise);
      req.setTimeout(60000, () => {
        req.destroy();
        rejectPromise(new Error('下载超时'));
      });
    };
    request(url, 0);
  });
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(1)} GB`;
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`;
  return `${Math.max(0, Math.round(bytes / (1 << 10)))} KB`;
}

function findPortableRootUnder(dir) {
  const candidates = [dir];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) candidates.push(join(dir, entry.name));
  }
  return candidates.find(candidate => hasPortableLayout(candidate)) || '';
}

// ===== Legacy ComfyUI IPC (keep for backward compat) =====

ipcMain.handle('list-workflows', async () => {
  const dir = getWorkflowDir({ workflowDir: agent?.workflowDir });
  if (agent && dir !== agent.workflowDir) await agent.setWorkflowDir(dir);
  directService?.setWorkflowDir(dir);
  return { dir, displayDir: getDisplayPath(dir), files: listWorkflowFiles(dir) };
});

ipcMain.handle('workflow:delete', async (_, { name } = {}) => {
  const dir = getWorkflowDir({ workflowDir: agent?.workflowDir });
  if (!dir) throw new Error('工作流目录不存在');
  const result = await deleteWorkflowFile(name, dir);
  return { dir, displayDir: getDisplayPath(dir), ...result };
});

ipcMain.handle('workflow:rename', async (_, { name, nextName } = {}) => {
  const dir = getWorkflowDir({ workflowDir: agent?.workflowDir });
  if (!dir) throw new Error('工作流目录不存在');
  const result = await renameWorkflowFile(name, nextName, dir);
  return { dir, displayDir: getDisplayPath(dir), ...result };
});

ipcMain.handle('select-workflow-dir', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    defaultPath: getWorkflowDir({ workflowDir: agent?.workflowDir }),
    title: '选择工作流目录',
  });
  if (!result.canceled && result.filePaths.length > 0) {
    const dir = result.filePaths[0];
    prefStore.set('workflowDir', dir);
    if (agent) await agent.setWorkflowDir(dir);
    directService?.setWorkflowDir(dir);
    return { dir, displayDir: getDisplayPath(dir), files: listWorkflowFiles(dir) };
  }
  return null;
});

ipcMain.handle('show-workflow-dir', async (_, { workflowName = '' } = {}) => {
  const dir = getWorkflowDir({ workflowDir: agent?.workflowDir });
  if (!dir) throw new Error('工作流目录不存在');
  if (workflowName) {
    const filePath = resolveSandboxPath({ workflowDir: dir }, workflowName);
    await stat(filePath);
    shell.showItemInFolder(filePath);
  } else {
    await shell.openPath(dir);
  }
  return { dir };
});

ipcMain.handle('select-workflow-files', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    title: '导入工作流',
    filters: [
      { name: 'ComfyUI 工作流', extensions: ['json'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const dir = getWorkflowDir({ workflowDir: agent?.workflowDir });
  if (!dir) throw new Error('工作流目录不存在');
  const imported = await importWorkflowFiles(result.filePaths, dir);
  if (agent && dir !== agent.workflowDir) await agent.setWorkflowDir(dir);
  directService?.setWorkflowDir(dir);
  return { dir, displayDir: getDisplayPath(dir), ...imported };
});

ipcMain.handle('import-workflows', async (_, { paths = [] } = {}) => {
  const dir = getWorkflowDir({ workflowDir: agent?.workflowDir });
  if (!dir) throw new Error('工作流目录不存在');
  const result = await importWorkflowFiles(paths, dir);
  if (agent && dir !== agent.workflowDir) await agent.setWorkflowDir(dir);
  directService?.setWorkflowDir(dir);
  return { dir, displayDir: getDisplayPath(dir), ...result };
});

ipcMain.handle('select-media-files', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    title: '选择参考素材',
    filters: [
      { name: '图片、音频和视频', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'mp4', 'webm', 'mov', 'mkv', 'avi'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  if (result.canceled) return [];
  const videoExtensions = new Set(['.mp4', '.webm', '.mov', '.mkv', '.avi']);
  const audioExtensions = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac']);
  for (const filePath of result.filePaths) authorizedMediaPaths.add(filePath);
  return result.filePaths.map(filePath => ({
    path: filePath,
    name: basename(filePath),
    kind: videoExtensions.has(extname(filePath).toLowerCase()) ? 'video' : audioExtensions.has(extname(filePath).toLowerCase()) ? 'audio' : 'image',
  }));
});

ipcMain.handle('clipboard:save-paste', async (_, { buffer, name } = {}) => {
  if (!buffer || !buffer.length) throw new Error('剪贴板没有图片数据');
  const dir = app.getPath('temp');
  const fileName = `comfy-agent-paste-${Date.now()}-${Math.round(Math.random() * 0xffffff).toString(16)}.png`;
  const target = join(dir, fileName);
  await writeFile(target, Buffer.from(buffer));
  authorizedMediaPaths.add(target);
  return { path: target, name: name || fileName, kind: 'image' };
});

ipcMain.handle('clipboard:write-image', async (_, dataUrl) => {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) throw new Error('无效的图片数据');
  const image = nativeImage.createFromDataURL(dataUrl);
  if (image.isEmpty()) throw new Error('剪贴板图片数据无效');
  clipboard.writeImage(image);
  return { ok: true };
});

function presetRoot() {
  if (!globalPresetsRoot) globalPresetsRoot = join(app.getPath('userData'), 'global-presets');
  return globalPresetsRoot;
}

async function selectPresetFile(title, filters, properties = ['openFile']) {
  const dialogMethod = properties.includes('showSaveDialog') ? 'showSaveDialog' : 'showOpenDialog';
  const normalizedProperties = properties.filter(value => value !== 'showSaveDialog');
  const result = await dialog[dialogMethod](mainWindow, { properties: normalizedProperties, title, filters });
  return result.canceled ? '' : result.filePaths[0] || '';
}

ipcMain.handle('global-presets:list', async () => listGlobalPresets(presetRoot()));
ipcMain.handle('global-presets:delete', async (_, { id } = {}) => deleteGlobalPreset(presetRoot(), id));
ipcMain.handle('global-presets:copy', async (_, { id } = {}) => copyGlobalPreset(presetRoot(), id));
ipcMain.handle('global-presets:mark-used', async (_, { id, generated = false } = {}) => markPresetUsed(presetRoot(), id, generated));
ipcMain.handle('global-presets:rate', async (_, { id, rating } = {}) => rateGlobalPreset(presetRoot(), id, rating));
ipcMain.handle('global-presets:replace-model', async (_, { id, from, to } = {}) => replacePresetModel(presetRoot(), id, from, to));
ipcMain.handle('global-presets:compose', async (_, { ids = [], title = '' } = {}) => composeGlobalPresets(presetRoot(), ids, { title }));
ipcMain.handle('global-presets:match-workflow', async (_, { workflowName = '' } = {}) => {
  const dir = getWorkflowDir({ workflowDir: agent?.workflowDir });
  const files = await Promise.resolve(listWorkflowFiles(dir)).catch(() => []);
  const names = (files || []).map(item => typeof item === 'string' ? item : item.name).filter(Boolean);
  if (!workflowName) return { workflowName: '', candidates: names.slice(0, 20) };
  const exact = names.find(name => name === workflowName);
  if (exact) return { workflowName: exact, matched: true, candidates: [exact] };
  const stem = workflowName.replace(/\.json$/i, '').toLowerCase();
  const candidates = names.filter(name => name.toLowerCase().includes(stem)).slice(0, 10);
  return { workflowName: candidates[0] || '', matched: Boolean(candidates[0]), candidates };
});
function resolvePresetInput(input = {}) {
  const sourceRefs = Array.isArray(input.sourceRefs) ? input.sourceRefs : [];
  const resultRefs = Array.isArray(input.resultRefs) ? input.resultRefs : [];
  const resolveRefs = refs => refs.map(ref => {
    try { return resolveImagePath(ref); }
    catch (error) { throw new Error(`无法访问预设资源：${ref?.filename || ref?.name || '未知文件'}（${error.message}）`); }
  });
  const resolved = {
    ...input,
  };
  if (input.workflowSourcePath || input.workflow) resolved.workflowSourcePath = input.workflowSourcePath || (agent?.workflowDir ? resolve(agent.workflowDir, input.workflow) : '');
  if (Array.isArray(input.sourcePaths) || sourceRefs.length) resolved.sourcePaths = [...(Array.isArray(input.sourcePaths) ? input.sourcePaths : []), ...resolveRefs(sourceRefs)];
  if (Array.isArray(input.resultPaths) || resultRefs.length) resolved.resultPaths = [...(Array.isArray(input.resultPaths) ? input.resultPaths : []), ...resolveRefs(resultRefs)];
  if (input.coverSourcePath || input.coverRef) resolved.coverSourcePath = input.coverSourcePath || resolveRefs([input.coverRef])[0];
  return resolved;
}

function fetchJson(url) {
  return new Promise((resolvePromise, rejectPromise) => {
    const getter = url.startsWith('https:') ? httpsGet : httpGet;
    const request = getter(url, { headers: { 'User-Agent': 'ComfyUI-Agent-Updater' } }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        const next = new URL(response.headers.location, url);
        if (next.protocol !== 'https:') return rejectPromise(new Error('Update manifest redirect must use HTTPS'));
        return fetchJson(next.toString()).then(resolvePromise, rejectPromise);
      }
      if (response.statusCode !== 200) return rejectPromise(new Error(`Update manifest request failed: HTTP ${response.statusCode}`));
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => { try { resolvePromise(JSON.parse(body)); } catch { rejectPromise(new Error('Update manifest is not valid JSON')); } });
    });
    request.on('error', rejectPromise);
  });
}

function fetchBytes(url) {
  return new Promise((resolvePromise, rejectPromise) => {
    const getter = url.startsWith('https:') ? httpsGet : httpGet;
    const request = getter(url, { headers: { 'User-Agent': 'ComfyMuse-Updater' } }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        const next = new URL(response.headers.location, url);
        if (next.protocol !== 'https:') return rejectPromise(new Error('Update redirect must use HTTPS'));
        return fetchBytes(next.toString()).then(resolvePromise, rejectPromise);
      }
      if (response.statusCode !== 200) return rejectPromise(new Error(`Update signature request failed: HTTP ${response.statusCode}`));
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolvePromise(Buffer.concat(chunks)));
    });
    request.on('error', rejectPromise);
  });
}

function assertHttpsUrl(value, label = 'URL') {
  let url;
  try { url = new URL(String(value || '')); } catch { throw new Error(`${label} is not a valid URL`); }
  if (url.protocol !== 'https:') throw new Error(`${label} must use HTTPS`);
  return url.toString();
}

async function fetchSignedManifest(url) {
  const [manifestBytes, signatureBytes] = await Promise.all([fetchBytes(url), fetchBytes(`${url}.sig`)]);
  const signature = signatureBytes.toString('utf8').trim();
  if (!verifyUpdateManifest(manifestBytes, signature)) throw new Error('Update manifest signature verification failed.');
  try { return JSON.parse(manifestBytes.toString('utf8')); } catch { throw new Error('Update manifest is not valid JSON'); }
}

function semverParts(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(version || ''));
  return match ? [Number(match[1]), Number(match[2]), Number(match[3]), match[4] || ''] : null;
}
function compareVersions(left, right) {
  const a = semverParts(left); const b = semverParts(right);
  if (!a || !b) return 0;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  if (!a[3] && b[3]) return 1;
  if (a[3] && !b[3]) return -1;
  return String(a[3]).localeCompare(String(b[3]));
}

async function checkForUpdate() {
  const channel = envConfig.COMFY_AGENT_UPDATE_CHANNEL === 'preview' ? 'preview' : 'stable';
  updateState = { status: 'checking', progress: 0, version: '', error: '' };
  try {
    let manifest;
    if (envConfig.COMFY_AGENT_UPDATE_MANIFEST_URL) {
      manifest = await fetchSignedManifest(assertHttpsUrl(envConfig.COMFY_AGENT_UPDATE_MANIFEST_URL, '更新清单地址'));
    } else {
      const releases = await fetchJson('https://api.github.com/repos/xueLan-io/comfyui-agent/releases?per_page=20');
      const release = releases.find(item => channel === 'preview' ? item.prerelease : !item.prerelease);
      const asset = release?.assets?.find(item => item.name === `manifest-${channel}.json`);
      if (!asset?.browser_download_url) throw new Error('No release manifest is available for the selected channel.');
      manifest = await fetchSignedManifest(asset.browser_download_url);
    }
    verifiedManifest = manifest;
    const available = compareVersions(manifest.version, app.getVersion()) > 0;
    const runtimeCompatible = manifest.runtimeVersion === 'electron-33';
    updateState = { status: available ? (runtimeCompatible ? 'available' : 'full-required') : 'latest', progress: 0, version: manifest.version || '', error: '', manifest, runtimeCompatible };
    return updateState;
  } catch (error) {
    updateState = { status: 'error', progress: 0, version: '', error: error.message };
    throw error;
  }
}

async function downloadUpdate() {
  // Ignore any renderer-supplied manifest: only the signature-verified one
  // recorded by checkForUpdate() may drive a download (prevents the renderer
  // from steering the updater to attacker-chosen content).
  const manifest = verifiedManifest;
  if (!manifest) throw new Error('No verified update is available. Check for updates first.');
  if (manifest.runtimeVersion && manifest.runtimeVersion !== 'electron-33') throw new Error('This release changes the Electron runtime; download the full portable package instead.');
  if (!manifest?.updatePackage?.url) throw new Error('No compatible application update is available.');
  const version = String(manifest.version || '');
  if (!/^[A-Za-z0-9._-]+$/.test(version)) throw new Error('Update manifest version is not a safe file name.');
  const target = join(app.getPath('temp'), `comfy-agent-update-${version}.zip`);
  updateState = { ...updateState, status: 'downloading', progress: 0, error: '' };
  const urls = [manifest.updatePackage.url, ...(manifest.updatePackage.urls || [])].filter(Boolean).map(url => assertHttpsUrl(url, '更新包地址'));
  let lastError;
  for (const url of urls) {
    try {
      await downloadToFile(url, target, progress => {
        updateState = { ...updateState, status: 'downloading', progress: Math.round((progress.percent || 0) * 100) };
        sendToRenderer('app:update-progress', updateState);
      });
      lastError = null;
      break;
    } catch (error) { lastError = error; }
  }
  if (lastError) throw lastError;
  const digest = createHash('sha256').update(readFileSync(target)).digest('hex');
  if (digest.toLowerCase() !== String(manifest.updatePackage.sha256).toLowerCase()) {
    await unlink(target).catch(() => {});
    throw new Error('Update package integrity check failed.');
  }
  downloadedUpdate = { path: target, manifest };
  updateState = { ...updateState, status: 'ready', progress: 100 };
  return updateState;
}

function installUpdate() {
  if (!downloadedUpdate) throw new Error('Download an update before installing it.');
  const updater = join(dirname(process.execPath), 'ComfyUI-Agent-Updater.exe');
  const launcher = join(dirname(process.execPath), 'ComfyMuseLauncher.exe');
  if (!existsSync(updater) || !existsSync(launcher)) throw new Error('The portable updater is not installed.');
  spawn(updater, ['--package', downloadedUpdate.path, '--app-dir', appRoot, '--launcher', launcher, '--pid', String(process.pid)], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  updateState = { ...updateState, status: 'installing' };
  quitRequested = true;
  app.quit();
  return updateState;
}
ipcMain.handle('global-presets:create', async (_, input = {}) => createGlobalPreset(presetRoot(), resolvePresetInput(input)));
ipcMain.handle('global-presets:update', async (_, { id, patch = {} } = {}) => updateGlobalPreset(presetRoot(), id, resolvePresetInput(patch)));
ipcMain.handle('global-presets:select-cover', async () => selectPresetFile('选择预设封面', [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]));
ipcMain.handle('global-presets:select-import', async () => selectPresetFile('导入预设', [{ name: '预设文件', extensions: ['json', 'zip'] }]));
ipcMain.handle('global-presets:copy-cover', async (_, { id, sourcePath } = {}) => copyPresetCover(presetRoot(), id, sourcePath));
ipcMain.handle('global-presets:image-data', async (_, cover = {}) => {
  if (!cover.path) return '';
  const root = resolve(presetRoot());
  let file;
  try { file = assertInside(root, resolve(root, cover.path)); } catch { return ''; }
  try { const data = await readFile(file); const mime = extname(file).toLowerCase() === '.jpg' || extname(file).toLowerCase() === '.jpeg' ? 'image/jpeg' : `image/${extname(file).slice(1)}`; return `data:${mime};base64,${data.toString('base64')}`; } catch { return ''; }
});
ipcMain.handle('global-presets:resolve-resources', async (_, { preset = {} } = {}) => {
  const root = resolve(presetRoot());
  const resolveStored = ref => {
    const path = typeof ref === 'string' ? ref : ref?.path;
    if (!path) return null;
    try {
      const file = assertInside(root, resolve(root, path));
      return { path: file, name: basename(file), kind: 'image' };
    } catch { return null; }
  };
  return {
    sourceImages: (preset.sourceImages || []).map(resolveStored).filter(Boolean),
    workflow: preset.workflow || '',
  };
});
ipcMain.handle('global-presets:check-dependencies', async (_, { id } = {}) => {
  const root = resolve(presetRoot());
  const presets = await listGlobalPresets(root);
  const preset = presets.find(item => item.id === id);
  if (!preset) return { presetId: id || '', valid: false, issues: [{ code: 'preset_not_found', severity: 'error', message: '预设不存在' }] };
  const issues = [];
  const checkFile = (ref, code, label, required = true) => {
    const path = typeof ref === 'string' ? ref : ref?.path;
    if (!path) {
      if (required) issues.push({ code, severity: 'error', message: `${label}未配置` });
      return { path: '', exists: false, required };
    }
    try {
      const file = assertInside(root, resolve(root, path));
      const exists = existsSync(file) && statSync(file).isFile();
      if (!exists) issues.push({ code, severity: required ? 'error' : 'warning', message: `${label}不存在：${basename(file)}` });
      return { path, exists, required };
    } catch {
      issues.push({ code: `${code}_invalid`, severity: 'error', message: `${label}路径无效` });
      return { path, exists: false, required };
    }
  };
  // A preset may intentionally inherit the currently selected workflow.
  const workflow = checkFile(preset.workflow, 'workflow_missing', '工作流', false);
  const sourceImages = (preset.sourceImages || []).map(item => checkFile(item, 'source_missing', '参考素材'));
  const resultImages = (preset.resultImages || []).map(item => checkFile(item, 'result_missing', '结果素材', false));
  const cover = preset.cover ? checkFile(preset.cover, 'cover_missing', '封面', false) : { path: '', exists: true, required: false };
  if (workflow.exists) {
    try { JSON.parse(await readFile(assertInside(root, resolve(root, workflow.path)), 'utf8')); }
    catch { issues.push({ code: 'workflow_invalid', severity: 'error', message: '工作流不是有效 JSON' }); }
  }
  const modelRequirements = Array.isArray(preset.modelRequirements) ? preset.modelRequirements : [];
  const modelRoot = comfyManager.portableRoot ? join(comfyManager.portableRoot, 'ComfyUI', 'models') : '';
  const modelFiles = [];
  async function collectModels(dir, prefix = '') {
    if (!dir || !existsSync(dir)) return;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await collectModels(full, `${prefix}${entry.name}/`);
      else modelFiles.push(`${prefix}${entry.name}`);
    }
  }
  await collectModels(modelRoot).catch(() => {});
  const missingModels = modelRequirements.filter(item => item?.available === false || !item?.value).map(item => {
    const value = item.value || '未命名模型';
    const needle = basename(value).toLowerCase();
    const candidates = modelFiles.filter(file => file.toLowerCase().includes(needle) || needle.includes(basename(file).toLowerCase())).slice(0, 5);
    return { kind: item.kind || 'model', value, candidates };
  });
  missingModels.forEach(item => issues.push({ code: 'model_missing', severity: 'error', message: `缺失模型：${item.value}` }));
  return {
    presetId: preset.id,
    valid: !issues.some(issue => issue.severity === 'error'),
    dependencies: { workflow, sourceImages, resultImages, cover, sourceCount: sourceImages.length, missingSourceCount: sourceImages.filter(item => !item.exists).length, modelRequirements, missingModels },
    issues,
  };
});
ipcMain.handle('global-presets:import', async (_, { sourcePath } = {}) => {
  const extractZip = async zipPath => {
    const temp = await mkdtemp(join(app.getPath('temp'), 'comfy-agent-preset-'));
    try {
      const command = `Expand-Archive -LiteralPath '${zipPath.replaceAll("'", "''")}' -DestinationPath '${temp.replaceAll("'", "''")}' -Force`;
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error('无法解压预设压缩包');
      const found = [];
      async function walk(dir) {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) await walk(path); else found.push(path);
        }
      }
      await walk(temp);
      return { files: found, cleanup: () => rm(temp, { recursive: true, force: true }) };
    } finally {
      // importGlobalPreset owns cleanup after it has copied the resources.
    }
  };
  return importGlobalPreset(presetRoot(), sourcePath, extractZip);
});
ipcMain.handle('global-presets:export', async (_, { id } = {}) => {
  const preset = (await listGlobalPresets(presetRoot())).find(item => item.id === id);
  if (!preset) throw new Error('预设不存在');
  const target = await selectPresetFile('导出预设文件到', [{ name: 'ZIP', extensions: ['zip'] }], ['showSaveDialog']);
  if (!target) return null;
  const output = target.replace(/\.zip$/i, '') + '.zip';
  const temp = await mkdtemp(join(app.getPath('temp'), 'comfy-agent-preset-export-'));
  try {
    const packageRoot = join(temp, 'preset');
    await mkdir(packageRoot, { recursive: true });
    const sourceImages = [];
    for (const [index, image] of (preset.sourceImages || []).entries()) {
      const source = typeof image === 'string' ? image : image.path;
      const sourceFile = resolve(presetRoot(), source);
      assertInside(presetRoot(), sourceFile);
      const name = `reference-${String(index + 1).padStart(3, '0')}${extname(sourceFile).toLowerCase()}`;
      await mkdir(join(packageRoot, 'sources'), { recursive: true });
      await copyFile(sourceFile, join(packageRoot, 'sources', name));
      sourceImages.push(`sources/${name}`);
    }
    const resultImages = [];
    for (const [index, image] of (preset.resultImages || []).entries()) {
      const source = typeof image === 'string' ? image : image.path;
      const sourceFile = resolve(presetRoot(), source);
      assertInside(presetRoot(), sourceFile);
      const name = `image-${String(index + 1).padStart(3, '0')}${extname(sourceFile).toLowerCase()}`;
      await mkdir(join(packageRoot, 'results'), { recursive: true });
      await copyFile(sourceFile, join(packageRoot, 'results', name));
      resultImages.push(`results/${name}`);
    }
    let cover = '';
    if (preset.cover?.path) {
      const sourceFile = assertInside(presetRoot(), resolve(presetRoot(), preset.cover.path));
      const name = `cover${extname(sourceFile).toLowerCase()}`;
      await copyFile(sourceFile, join(packageRoot, name));
      cover = name;
    }
    let workflow = '';
    if (preset.workflow) {
      const sourceFile = assertInside(presetRoot(), resolve(presetRoot(), preset.workflow));
      workflow = 'workflow.json';
      await copyFile(sourceFile, join(packageRoot, workflow));
    }
    const portable = { format: FORMAT, version: VERSION, ...preset, cover, workflow, sourceImages, resultImages };
    await writeFile(join(packageRoot, 'preset.json'), JSON.stringify(portable, null, 2), 'utf8');
    const command = `Compress-Archive -Path '${packageRoot.replaceAll("'", "''")}${'\\*'}' -DestinationPath '${output.replaceAll("'", "''")}' -Force`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error('无法导出预设压缩包');
    return output;
  } finally {
    await rm(temp, { recursive: true, force: true }).catch(() => {});
  }
});

// ===== Agent IPC =====

function generationOptions(clientId, controls = {}) {
  return {
    clientId,
    settings: controls.settings || {},
    nodeOverrides: controls.nodeOverrides || {},
    outputNodeIds: controls.outputNodeIds || null,
    workflowManifest: controls.workflowManifest || null,
    media: controls.media || null,
    intent: controls.intent || '',
    effectiveRequest: controls.effectiveRequest || '',
    turnId: controls.turnId || '',
    readiness: controls.readiness || null,
    webResearch: controls.webResearch !== false,
    webResearchOptions: controls.webResearchOptions || {},
    allowPolicyOverride: controls.allowPolicyOverride === true,
    executionPolicy: controls.executionPolicy || undefined,
    projectId: controls.projectId || '',
    sessionId: controls.sessionId || '',
  };
}

function assertOwnerMatch(owner = {}, expected = {}) {
  for (const field of ['principalId', 'tenantId', 'projectId', 'sessionId']) {
    if (expected[field] && owner[field] !== expected[field]) {
      const code = field === 'tenantId' ? 'TENANT_MISMATCH' : field === 'projectId' ? 'PROJECT_ACCESS_DENIED' : 'OWNER_MISMATCH';
      throw Object.assign(new Error(`Resource owner mismatch: ${field}`), { code });
    }
  }
  return owner;
}

function currentGovernanceOwner(input = {}) {
  return executionOwner(input);
}

function assertPreviewOwner(preview, input = {}) {
  if (!preview) throw Object.assign(new Error('Preview not found'), { code: 'PREVIEW_NOT_FOUND' });
  return assertOwnerMatch(preview, currentGovernanceOwner(input));
}

function assertLedgerOwner(entry, input = {}) {
  if (!entry) throw Object.assign(new Error('Request not found'), { code: 'REQUEST_NOT_FOUND' });
  return assertOwnerMatch(entry, currentGovernanceOwner(input));
}

function getGovernanceGateway() {
  if (!governanceGateway) {
    governanceGateway = new OperationGateway({
      policyEngine: governancePolicy,
      admission: governanceAdmission,
      audit: new AuditSink({ directory: join(app.getPath('userData'), 'agent-data', 'audit') }),
    });
  }
  return governanceGateway;
}

function governedCoordinatorExecute(options = {}) {
  const originalGovernance = options.governance;
  return rawCoordinatorExecute({
    ...options,
    governance: async ({ entry, work }) => {
      if (originalGovernance) return originalGovernance({ entry, work });
      const owner = executionOwner(options.owner || {});
      const context = createGovernanceContext({
        ...owner,
        source: 'ipc',
        requestId: options.requestId || entry.requestId || `ipc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        taskId: options.taskId || entry.taskId || `task_${Date.now()}`,
        traceId: `trace_${options.taskId || entry.taskId || Date.now()}`,
      });
      const action = options.source === 'direct' ? 'comfyui.submit' : 'llm.invoke';
      const resource = { projectId: owner.projectId, sessionId: owner.sessionId, ...(options.previewId ? { previewId: options.previewId } : {}) };
      const input = { confirmation: true };
      const confirmation = { accepted: true, digest: confirmationDigest({ action, resource, input }), requestId: context.requestId, ...(options.previewId ? { previewId: options.previewId } : {}) };
      // Charge generation quota when a ComfyUI submission actually runs,
      // matching the CLI governance wiring; no-op when no quota limits are set.
      const quota = action === 'comfyui.submit' ? { generation_count: 1 } : undefined;
      return getGovernanceGateway().run({ context, action, resource, input, quota, confirmation, execute: ({ signal }) => work(Object.assign(entry, { signal })) });
    },
  });
}

// Keep the existing coordinator API and preview semantics while making every
// Agent/Direct coordinator operation pass through the governance lifecycle.
executionCoordinator.execute = governedCoordinatorExecute;

// ---- Batch pipeline (P2) ----
// The scheduler lives in the main process where the governed DirectService and
// governance gateway are available; job execution reuses the same
// executionCoordinator (and therefore policy, admission, quota, audit) as the
// interactive direct-generation path.

let batchScheduler;

function getBatchScheduler() {
  if (!batchScheduler) {
    const store = new JSONFileStore(join(app.getPath('userData'), 'agent-data'), 'batch.json');
    batchScheduler = new BatchScheduler({
      store,
      runJob: batchRunJob,
      limits: { maxConcurrency: 2, jobDelayMs: 350 },
      emit: (type, data) => sendToRenderer('batch:event', { type, ...data }),
    });
    void batchScheduler.init();
  }
  return batchScheduler;
}

async function batchRunJob(job, { signal, batchId, jobIndex, projectId, sessionId } = {}) {
  await startAgent(getStoredConfig());
  const comfyState = await comfyManager.ensureStarted();
  if (comfyState.status !== 'ready') throw new Error(comfyState.message || 'ComfyUI is not ready');
  const service = ensureDirectService();
  const owner = executionOwner({ projectId, sessionId });
  const workflowDir = job.workflowDir || getWorkflowDir({ workflowDir: agent?.workflowDir });
  const requestId = `batch_${batchId}_job_${jobIndex}`;
  const input = {
    workflowName: job.workflowName,
    workflowDir,
    positive: job.positive,
    negative: job.negative,
    settings: job.settings,
    nodeOverrides: job.nodeOverrides,
    outputNodeIds: job.outputNodeIds || [],
    media: job.media || {},
    origin: 'batch',
    requestId,
  };
  const preview = await service.prepare(input, { signal });
  const abortController = new AbortController();
  return executionCoordinator.execute({
    source: 'direct',
    requestId,
    turnId: `batch_${batchId}`,
    taskId: requestId,
    owner,
    previewId: preview.previewId,
    cancel: async () => {
      abortController.abort();
      return service.cancel(preview.previewId);
    },
    work: async () => service.run(preview.previewId, {}, {
      signal: abortController.signal,
      onProgress: progress => onProgress({ percent: progress?.percent, message: progress?.message }),
    }),
  });
}

function policyBlockResult(error, turnId = '') {  if (!(error instanceof CloudPolicyBlockedError) && error?.code !== 'CLOUD_POLICY_BLOCKED') return null;
  return {
    action: 'policy_block',
    turnId,
    code: 'CLOUD_POLICY_BLOCKED',
    message: error.message,
    policyDecision: error.policyDecision || null,
  };
}

ipcMain.handle('agent:generate', async (_, { message, workflowName, clientId, controls = {} }) => {
  await startAgent(getStoredConfig());
  const comfyState = await comfyManager.ensureStarted();
  if (comfyState.status !== 'ready') throw new Error(comfyState.message || 'ComfyUI is not ready');
  const owner = executionOwner();
  const requestId = controls.requestId || `ai_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const turnId = controls.turnId || '';
  const fingerprint = JSON.stringify({ source: 'ai', message, workflowName, controls });
  const existing = requestLedger.begin(requestId, { source: 'ai', fingerprint, turnId, ...owner });
  if (existing?.state === 'completed') return existing.result || existing.preview;
  if (existing?.state === 'executing') return requestLedger.snapshot(requestId);
  if (existing.preview) return existing.preview;
  return executionCoordinator.execute({
    source: 'ai',
    requestId,
    turnId,
    owner,
    work: async entry => {
      try {
        const preview = await agent.prepareGeneration(message, {
          ...generationOptions(clientId, controls),
          executionPolicy: controls.executionPolicy,
          projectId: owner.projectId,
          sessionId: owner.sessionId,
          requestId,
        workflowName,
      });
      if (preview?.previewId) {
        requestLedger.update(requestId, { state: 'prepared', taskId: agent.taskId, turnId, previewId: preview.previewId, preview });
        executionCoordinator.registerPreview({
          source: 'ai',
          previewId: preview.previewId,
          taskId: agent.taskId,
          requestId,
          owner,
          entry,
        });
      }
      return preview;
      } catch (error) {
        try { requestLedger.fail(requestId, error); } catch {}
        throw error;
      }
    },
  });
});

ipcMain.handle('direct:prepare', async (_, { request = {} } = {}) => {
  await startAgent(getStoredConfig());
  const normalized = directGenerationRequest({
    ...request,
    projectId: request.projectId || agent?.sessionManager.activeProjectId,
    sessionId: request.sessionId || agent?.sessionManager.activeSessionId,
    principalId: request.principalId || localPrincipal.id,
    tenantId: request.tenantId || localPrincipal.tenantId,
  });
  if (agent && normalized.projectId && normalized.sessionId
    && (normalized.projectId !== agent.sessionManager.activeProjectId
      || normalized.sessionId !== agent.sessionManager.activeSessionId)) {
    const error = new Error('生成请求所属会话已变化，请先切换到目标会话后再生成');
    error.code = 'GENERATION_OWNER_MISMATCH';
    throw error;
  }
  const owner = executionOwner(normalized);
  sendToRenderer('direct:status', {
    source: 'direct',
    requestId: normalized.requestId,
    ...owner,
    status: 'preparing',
    uiStatus: 'preparing',
    message: '正在检查 ComfyUI 和工作流...',
  });
  const comfyState = await comfyManager.ensureStarted();
  if (comfyState.status !== 'ready') {
    const message = comfyState.message || 'ComfyUI is not ready';
    sendToRenderer('direct:status', {
      source: 'direct',
      requestId: normalized.requestId,
      ...owner,
      taskId: normalized.requestId,
      phase: 'preparing',
      status: 'failed',
      uiStatus: 'error',
      message,
    });
    throw new Error(message);
  }
  const service = ensureDirectService();
  const fingerprint = JSON.stringify({
    source: 'direct',
    workflowName: normalized.workflowName,
    positive: normalized.positive,
    negative: normalized.negative,
    settings: normalized.settings,
    nodeOverrides: normalized.nodeOverrides,
    media: normalized.media,
  });
    const existing = requestLedger.begin(normalized.requestId, { source: 'direct', fingerprint, turnId: normalized.turnId || '', ...owner });
  if (existing.preview) return existing.preview;
  if (['completed', 'failed', 'cancelled'].includes(existing.state)) {
    const error = new Error('该请求已经结束，不能使用相同 requestId 重新提交');
    error.code = 'REQUEST_TERMINAL';
    error.requestId = normalized.requestId;
    throw error;
  }
    if (existing.state === 'executing' || existing.state === 'observing') {
    const error = new Error('该请求仍在执行或等待恢复，拒绝重复提交');
    error.code = 'REQUEST_IN_PROGRESS';
    error.requestId = normalized.requestId;
    throw error;
    }
   requestLedger.update(normalized.requestId, { state: RequestStates.PREPARING, ...owner });
   if (agent?.sessionManager.activeProjectId === owner.projectId && agent?.sessionManager.activeSessionId === owner.sessionId) {
     agent.sessionManager.setSessionState({ requestId: normalized.requestId, turnId: normalized.turnId || '', taskStatus: 'preparing', state: 'preparing' });
   }
   service.setWorkflowDir(owner.workflowDir);
  const prepareAbortController = new AbortController();
  return executionCoordinator.execute({
    source: 'direct',
    requestId: normalized.requestId,
    turnId: normalized.turnId || '',
    taskId: normalized.requestId,
    owner,
    cancel: async () => {
      prepareAbortController.abort();
      service.discardPreview(`direct_preview_${normalized.requestId}`);
    },
    work: async entry => {
      let preview;
      try {
        sendToRenderer('direct:status', {
          source: 'direct',
          requestId: normalized.requestId,
          ...owner,
          status: 'preparing',
          uiStatus: 'preparing',
          message: '正在读取工作流和检查节点...',
        });
        // Preparing a workflow is expected to be quick. Do not leave the UI
        // waiting forever when a worker or workflow inspection call wedges.
        let prepareTimer;
        try {
          preview = await Promise.race([
            service.prepare(normalized, { sandboxInput: directSandboxInput(), signal: prepareAbortController.signal }),
            new Promise((_, reject) => {
              prepareTimer = setTimeout(() => {
                prepareAbortController.abort();
                const error = new Error('生成准备超时（30 秒），请检查 ComfyUI 连接后重试');
                error.code = 'REQUEST_TIMEOUT';
                reject(error);
              }, 30_000);
            }),
          ]);
        } finally {
          clearTimeout(prepareTimer);
        }
        if (entry.cancelRequested || prepareAbortController.signal.aborted) {
          service.discardPreview(preview.previewId);
          throw Object.assign(new Error('Direct generation cancelled'), { code: 'GENERATION_CANCELLED' });
        }
        preview.taskId = await createDirectTask(preview);
        await recordDirectExecutionEvent({
          taskId: preview.taskId,
          turnId: normalized.turnId || '',
          projectId: owner.projectId,
          sessionId: owner.sessionId,
          traceId: `trace_${preview.taskId}`,
          type: 'agent:plan',
          stage: 'planning',
          status: 'planning',
          description: '已创建直接生成执行计划',
          plan: { steps: [{ id: 'comfyui', tool: 'comfyui', description: '执行直接生成' }] },
        });
        requestLedger.update(normalized.requestId, { state: RequestStates.PREPARED, taskId: preview.taskId, previewId: preview.previewId, preview });
        if (agent?.sessionManager.activeProjectId === owner.projectId && agent?.sessionManager.activeSessionId === owner.sessionId) {
          agent.sessionManager.setSessionState({ requestId: normalized.requestId, turnId: normalized.turnId || '', lastTaskId: preview.taskId, taskStatus: 'prepared', state: 'awaiting_confirmation' });
        }
        await agent?.recordConversationMessage?.('user', normalized.positive || '', {
          intent: 'generate',
          action: 'prepare',
          turnId: normalized.turnId || '',
           attachments: [
             ...(normalized.media?.images || []),
             ...(normalized.media?.masks || []),
             ...(normalized.media?.videos || []),
           ],
        });
        if (agent) sendToRenderer('project:state', agent.sessionManager.getState());
        executionCoordinator.registerPreview({
          source: 'direct',
          previewId: preview.previewId,
          taskId: preview.taskId,
          owner,
          entry,
        });
        sendToRenderer('direct:status', {
          source: 'direct',
          requestId: normalized.requestId,
          ...owner,
          taskId: preview.taskId,
          status: 'prepared',
          uiStatus: 'preview',
          preview: { ...preview, quickGenerate: true },
          message: '工作流检查完成，请确认生成',
        });
        return preview;
      } catch (error) {
        service.discardPreview('direct_preview_' + normalized.requestId);
        await completeDirectTask(preview?.taskId, {}, { message: error.message, stage: 'direct_prepare' });
        requestLedger.fail(normalized.requestId, error);
        sendToRenderer('direct:status', {
          source: 'direct',
          requestId: normalized.requestId,
          ...owner,
          taskId: preview?.taskId || normalized.requestId,
          phase: 'preparing',
          status: 'failed',
          uiStatus: 'error',
          message: error.message || '工作流检查失败',
        });
        throw error;
      }
    },
  });
});

ipcMain.handle('direct:get-preview', async (_, { previewId } = {}) => {
  const preview = ensureDirectService().getPreview(previewId) || null;
  if (!preview) return null;
  assertPreviewOwner(preview);
  return preview;
});

ipcMain.handle('direct:run-prepared', async (_, { previewId, edits = {}, options = {} } = {}) => {
  await startAgent(getStoredConfig());
  const comfyState = await comfyManager.ensureStarted();
  if (comfyState.status !== 'ready') throw new Error(comfyState.message || 'ComfyUI is not ready');
  const service = ensureDirectService();
  const preview = service.getPreview(previewId);
  if (!preview) throw new Error('Direct generation preview expired; prepare it again');
  assertPreviewOwner(preview);
  const owner = executionOwner();
  const requestId = preview.requestId || '';
    const taskId = preview.taskId || requestId;
  assertConfirmationBinding({ confirmation: options.confirmation, expectedDigest: preview.requestDigest, requestId, previewId });
  const ledgerEntry = requestLedger.get(requestId);
  if (ledgerEntry?.state === 'completed') return ledgerEntry.result;
  if (ledgerEntry?.state === 'executing') return requestLedger.snapshot(requestId);
    const directContext = { projectId: owner.projectId, sessionId: owner.sessionId, taskId };
  const abortController = new AbortController();
  return executionCoordinator.execute({
    source: 'direct',
    requestId,
    turnId: preview.turnId || '',
    taskId,
    owner,
    previewId,
    cancel: async () => {
      abortController.abort();
      return service.cancel(previewId);
    },
    work: async entry => {
      const generationStartedAt = Date.now();
      let archivePhase = false;
       requestLedger.update(requestId, { state: RequestStates.EXECUTING, taskId, previewId, ...owner });
       if (agent?.sessionManager.activeProjectId === owner.projectId && agent?.sessionManager.activeSessionId === owner.sessionId) {
         agent.sessionManager.setSessionState({ requestId, turnId: preview.turnId || '', lastTaskId: taskId, taskStatus: 'executing', state: 'executing' });
       }
      await updateDirectTask(taskId, 'executing', { currentStep: 'comfyui', currentAttempt: 1 });
      await recordDirectExecutionEvent({
        ...directContext,
        turnId: preview.turnId || '',
        traceId: `trace_${taskId}`,
        status: 'running',
        description: '正在执行直接生成',
      });
      sendToRenderer('project:state', agent.sessionManager.getState());
      sendToRenderer('direct:status', {
        source: 'direct',
        requestId,
        ...directContext,
        taskId,
        status: 'running',
        uiStatus: 'running',
        message: '\u6b63\u5728\u6267\u884c\u539f\u6587\u63d0\u793a\u8bcd',
        timeEstimate: preview.timeEstimate || null,
        startedAt: generationStartedAt,
      });
      try {
        const result = await service.run(previewId, edits, {
          clientId: options.clientId || '',
          signal: abortController.signal,
          isCancelled: () => entry.cancelRequested,
          onProgress: progress => {
            updateDirectTask(taskId, 'executing', {
              ...(progress.promptId ? { promptId: progress.promptId } : {}),
              progress: {
                stage: progress.stage || '',
                percent: progress.percent,
                overallPercent: progress.overallPercent,
                nodePercent: progress.nodePercent,
                nodeId: progress.nodeId || '',
                nodeType: progress.nodeType || '',
                message: progress.message || '',
                timeEstimate: preview.timeEstimate || null,
                startedAt: generationStartedAt,
                updatedAt: Date.now(),
              },
            });
            sendToRenderer('direct:progress', { ...progress, timeEstimate: preview.timeEstimate || null, startedAt: generationStartedAt, source: 'direct', requestId, ...directContext });
          },
          executionId: previewId,
        });
        const taskResult = {
           ...result,
           taskId,
           requestId,
           turnId: preview.turnId || '',
           workflowName: preview?.workflow?.name || preview?.workflowName || '',
           positive: edits.positive || preview?.positive || '',
           negative: edits.negative || preview?.negative || '',
           settings: preview?.settings || result.settings || {},
        };
        // 取消竞态：取消到达时生成可能已完成并取回结果，成果不应被吞掉；
        // 只有确实没有产出媒体时才按取消处理。
        if ((entry.cancelRequested || abortController.signal.aborted) && !(taskResult.media?.length > 0)) {
          throw Object.assign(new Error('Direct generation cancelled'), { code: 'GENERATION_CANCELLED' });
        }
          let archived;
           try {
             archivePhase = true;
              archived = await archiveProjectResult(taskResult, owner, { signal: abortController.signal });
            if (archived.archiveStatus === 'archive_failed') {
               const archiveError = new Error(archived.archiveError || '生成结果归档失败');
               archiveError.code = 'ARCHIVE_FAILED';
              archiveError.failureType = 'archive';
              archiveError.stage = 'archive';
              archiveError.archiveResult = archived;
               throw archiveError;
            }
          } catch (error) {
           const archiveResult = error.archiveResult || taskResult;
           requestLedger.update(requestId, { state: 'archive_failed', result: archiveResult, error: { message: error.message, code: error.code || 'ARCHIVE_FAILED' } });
           await completeDirectTask(taskId, archiveResult, { message: error.message, stage: 'archive' });
           throw error;
         }
         archivePhase = false;
        await completeDirectTask(taskId, archived);
        await agent?.recordArtifact?.(taskResult, {
          taskId,
          workflow: preview?.workflow?.name || '',
          parameters: preview?.settings || {},
          compiledPrompt: {
            positive: edits.positive || preview?.positive || '',
            negative: edits.negative || preview?.negative || '',
            constraints: preview?.constraints || {},
          },
        });
        await recordDirectExecutionEvent({
          ...directContext,
          turnId: preview.turnId || '',
          traceId: `trace_${taskId}`,
          status: 'completed',
          description: '直接生成已完成',
        });
        await agent?.sessionManager.flush?.();
        // 取消竞态：取消处理可能已先标记 cancelled（终态），完成结果不能覆盖终态。
        if (!requestLedger.isTerminal(requestLedger.get(requestId)?.state)) requestLedger.complete(requestId, archived);
        const completionMessageId = `direct:${requestId}:completed`;
        await agent?.recordConversationMessage?.('agent', 'Generated ' + ((archived.media || archived.images || []).length || 0) + ' media item(s).', {
          kind: 'completed',
          messageId: completionMessageId,
          directTaskId: taskId,
          requestId,
          images: archived.images || [],
          videos: archived.videos || [],
          media: archived.media || [...(archived.images || []), ...(archived.videos || [])],
          prompt: edits.positive || preview.positive || '',
          negative: edits.negative || preview.negative || '',
          turnId: preview.turnId || '',
        });
         if (agent) sendToRenderer('project:state', agent.sessionManager.getState());
        sendToRenderer('direct:status', {
          source: 'direct',
          requestId,
          ...directContext,
          taskId,
          status: 'completed',
           uiStatus: 'complete',
           message: '\u76f4\u63a5\u751f\u6210\u5df2\u5b8c\u6210',
           messageId: completionMessageId,
           directTaskId: taskId,
           positive: archived.compiledPrompt?.positive || archived.positive || '',
           negative: archived.compiledPrompt?.negative || archived.negative || '',
           workflowName: archived.workflowName || archived.workflow?.name || '',
           parameters: preview?.settings || archived.parameters || archived.settings || {},
           result: archived,
        });
        notifyGeneration(true, 'direct');
        return archived;
      } catch (error) {
         const archiveFailed = archivePhase || error?.code === 'ARCHIVE_FAILED' || error?.failureType === 'archive';
         const status = archiveFailed ? 'archive_failed' : entry.cancelRequested ? 'cancelled' : 'failed';
        sendToRenderer('direct:status', {
          source: 'direct',
          requestId,
          ...directContext,
          taskId,
          status,
           uiStatus: status === 'cancelled' ? 'idle' : 'error',
           message: status === 'cancelled' ? '\u76f4\u63a5\u751f\u6210\u5df2\u53d6\u6d88' : error.message,
         });
          if (status !== 'cancelled' && status !== 'archive_failed') notifyGeneration(false, 'direct');
         if (entry.cancelRequested && !archiveFailed) {
          const cancelled = { cancelled: true, taskId, source: 'direct' };
           await completeDirectTask(taskId, cancelled);
          requestLedger.update(requestId, { state: 'cancelled', result: cancelled });
          return cancelled;
        }
        if (!archiveFailed) await completeDirectTask(taskId, {}, { message: error.message, stage: 'direct' });
        await recordDirectExecutionEvent({
          ...directContext,
          turnId: preview.turnId || '',
          traceId: `trace_${taskId}`,
          status: 'error',
          description: '直接生成失败',
          error: error.message || '',
        });
        await agent?.sessionManager.flush?.();
        if (!archiveFailed) requestLedger.fail(requestId, error);
        throw error;
      }
    },
  });
});

ipcMain.handle('direct:discard-preview', async (_, { previewId } = {}) => {
  const service = ensureDirectService();
  const preview = service.getPreview(previewId);
  assertPreviewOwner(preview);
  const discarded = service.discardPreview(previewId);
  if (discarded && preview?.taskId) await completeDirectTask(preview.taskId, { cancelled: true, taskId: preview.taskId });
  if (discarded && preview?.requestId) requestLedger.update(preview.requestId, { state: 'cancelled' });
  executionCoordinator.discardPreview(previewId);
  return { discarded };
});

ipcMain.handle('direct:cancel', async () => {
  const entry = executionCoordinator.active;
  const result = await executionCoordinator.cancel({ source: 'direct', taskId: entry?.taskId || '' });
  if (result.cancelled && entry) {
    if (entry.requestId) requestLedger.update(entry.requestId, {
      state: result.settled ? 'cancelled' : 'stopping',
      taskId: entry.taskId,
      result: result.settled ? { cancelled: true, taskId: entry.taskId } : null,
    });
    sendToRenderer('direct:status', {
      source: 'direct',
      requestId: entry.requestId || entry.taskId,
      taskId: entry.taskId,
      ...entry.owner,
      status: result.settled ? 'cancelled' : 'stopping',
      uiStatus: result.settled ? 'idle' : 'stopping',
      message: result.settled ? '\u76f4\u63a5\u751f\u6210\u5df2\u53d6\u6d88' : '\u53d6\u6d88\u8bf7\u6c42\u5df2\u53d1\u9001\uff0c\u6b63\u5728\u7b49\u5f85\u540e\u53f0\u4efb\u52a1\u6536\u5c3e',
    });
  }
  return result;
});

ipcMain.handle('agent:turn', async (_, turn = {}) => {
  await startAgent(getStoredConfig());
  const owner = executionOwner({ projectId: turn.projectId, sessionId: turn.sessionId });
  const requestId = turn.requestId || '';
  if (requestId) {
    const existing = requestLedger.get(requestId);
    if (existing?.state === 'completed') return existing.result;
    if (existing?.state === 'executing') return requestLedger.snapshot(requestId);
  }
  const pending = executionCoordinator.preview;
  const previewId = pending?.source === 'ai' && pending.owner.sessionId === owner.sessionId && pending.owner.projectId === owner.projectId
    ? pending.previewId
    : '';
  return executionCoordinator.execute({
    source: 'ai',
    owner,
    previewId,
    cancel: taskId => agent.cancel(taskId || ''),
    work: async entry => {
      let response;
      try {
        response = await agent.handleTurn({
          text: turn.text || '',
          modeHint: turn.modeHint === 'generate' ? 'generate' : 'creative',
          media: turn.media || null,
          workflowName: turn.workflowName || '',
          workflowManifest: turn.workflowManifest || null,
          skillId: turn.skillId || '',
           sessionId: turn.sessionId || agent.sessionManager.activeSessionId,
           projectId: turn.projectId || owner.projectId,
          turnId: turn.turnId || '',
          recordConfirmation: turn.recordConfirmation !== false,
           confirmation: turn.confirmation || {},
           previewEdits: turn.previewEdits || undefined,
           allowPolicyOverride: turn.allowPolicyOverride === true,
           skipUserMessage: turn.skipUserMessage === true,
           executionPolicy: turn.executionPolicy || undefined,
        });
      } catch (error) {
        const blocked = policyBlockResult(error, turn.turnId || '');
        if (blocked) return blocked;
        if (requestId) {
          try { requestLedger.fail(requestId, error); } catch {}
        }
        throw error;
      }
      if (requestId && response?.cancelled && !requestLedger.isTerminal(requestLedger.get(requestId)?.state)) {
        try { requestLedger.update(requestId, { state: 'cancelled', result: { cancelled: true, taskId: response.taskId || '' } }); } catch {}
      }
      if (response?.action === 'prepare' && response.preview?.previewId) {
        executionCoordinator.registerPreview({
          source: 'ai',
          previewId: response.preview.previewId,
          taskId: response.preview.taskId || agent.taskId,
          requestId,
          owner,
          entry,
        });
      }
      if (response?.action === 'execute' && response.result) {
        const result = { ...response, result: await archiveProjectResult({ ...response.result, requestId, turnId: turn.turnId || response.result.turnId || '' }, { ...owner, requestId, turnId: turn.turnId || '' }) };
        // 取消竞态：取消处理可能已先标记 cancelled（终态），晚到的完成结果不能覆盖
        // 终态，否则 REQUEST_TERMINAL 会破坏整个 turn 结果投递。
        if (requestId && !requestLedger.isTerminal(requestLedger.get(requestId)?.state)) requestLedger.complete(requestId, result);
        return result;
      }
      if (requestId && response?.action === 'prepare' && response.preview?.previewId) {
        requestLedger.begin(requestId, { source: 'ai', turnId: turn.turnId || '', previewId: response.preview.previewId, ...owner });
        requestLedger.update(requestId, { state: 'prepared', taskId: response.preview.taskId || agent.taskId, previewId: response.preview.previewId, preview: response.preview });
      }
      return response;
    },
  });
});

ipcMain.handle('agent:get-request-status', async (_, { requestId = '' } = {}) => {
  const entry = requestLedger.snapshot(requestId);
  if (!entry) return null;
  assertLedgerOwner(entry);
  return entry;
});

ipcMain.handle('agent:list-request-status', async (_, { projectId = '', sessionId = '', activeOnly = false } = {}) => {
  await startAgent(getStoredConfig());
  const activeOwner = executionOwner();
  if ((projectId && activeOwner.projectId !== projectId) || (sessionId && activeOwner.sessionId !== sessionId)) {
    const error = new Error('请求状态所属会话已变化');
    error.code = 'GENERATION_OWNER_MISMATCH';
    throw error;
  }
  const owner = { ...activeOwner };
  return requestLedger.list({
    projectId: owner.projectId,
    sessionId: owner.sessionId,
    ...(activeOnly ? { states: [
      RequestStates.CREATED,
      RequestStates.QUEUED,
      RequestStates.PREPARING,
      RequestStates.PREPARED,
      RequestStates.EXECUTING,
      RequestStates.OBSERVING,
      RequestStates.SUBMIT_UNKNOWN,
      RequestStates.STOPPING,
      RequestStates.TIMED_OUT,
      RequestStates.ARCHIVE_FAILED,
    ] } : {}),
  });
});

ipcMain.handle('agent:discard-preview', async (_, { previewId }) => {
  const pending = executionCoordinator.getPreview(previewId);
  assertPreviewOwner(pending?.owner || null);
  const requestId = pending?.requestId
    || pending?.result?.requestId
    || requestLedger.list().find(entry => entry.previewId === previewId || entry.preview?.previewId === previewId)?.requestId
    || '';
  executionCoordinator.discardPreview(previewId);
  const result = agent ? await agent.discardPrepared(previewId) : { discarded: false };
  if (result.discarded && requestId && !requestLedger.isTerminal(requestLedger.get(requestId)?.state)) {
    requestLedger.update(requestId, { state: RequestStates.CANCELLED, result: { cancelled: true, previewId, requestId } });
  }
  if (result.discarded && agent?.taskId) await persistTaskTrace(agent.taskId);
  return result;
});

ipcMain.handle('agent:clear-conversation', async () => {
  if (agent) return agent.clearConversation();
  return { cleared: false };
});

ipcMain.handle('agent:compact-conversation', async () => {
  await startAgent(getStoredConfig());
  if (!agent) return { archived: 0 };
  return agent.compactConversation();
});

ipcMain.handle('agent:title-for-message', async (_, { text = '' } = {}) => {
  await startAgent(getStoredConfig());
  if (!agent) return { title: '' };
  return agent.suggestSessionTitle(text);
});

ipcMain.handle('agent:rewind-conversation', async (_, { index }) => {
  if (!agent) return { rewound: false };
  const rewound = await agent.rewindConversation(index);
  return { rewound, messages: agent.conversation.toJSON() };
});

ipcMain.handle('agent:list-tasks', async () => {
  if (agent) return (await agent.listTasks(50)).filter(task => {
    try { assertOwnerMatch(task, currentGovernanceOwner()); return true; } catch { return false; }
  });
  return [];
});

ipcMain.handle('agent:get-trace', async (_, { taskId }) => {
  const task = agent?.taskManager?.get(taskId);
  if (!task) throw traceError('task_not_found', 'Task not found');
  assertOwnerMatch(task, currentGovernanceOwner());
  return readTaskTrace(taskId);
});

ipcMain.handle('agent:recover-tasks', async () => recoverAgentTasks());

ipcMain.handle('agent:monitor-task', async (_, { taskId } = {}) => {
  const task = agent?.taskManager?.get(taskId);
  if (!task) throw new Error('Task not found');
  assertOwnerMatch(task, currentGovernanceOwner());
  const promptId = task.promptId || task.attempts?.find(attempt => attempt.promptId)?.promptId;
  if (!promptId) return { status: 'submit_unknown', taskId, promptId: '', task };
  const monitored = await ComfyUITool.monitor(promptId);
  const progress = task.progress || monitored.progress || null;
  if (monitored.status !== 'completed') {
    agent.taskManager.update(taskId, { progress, promptId, status: monitored.status === 'running' ? 'executing' : monitored.status });
    await agent.taskManager.persist();
    return { ...monitored, taskId, promptId, progress };
  }
  const recovered = await ComfyUITool.recoverResult(promptId, monitored.history);
  try {
    const archived = await archiveProjectResult({ ...recovered, taskId, promptId, requestId: task.requestId || '' }, {
      projectId: task.projectId,
      sessionId: task.sessionId,
      requestId: task.requestId || '',
    });
    agent.taskManager.settleComplete(taskId, { result: archived });
    if (task.requestId) requestLedger.complete(task.requestId, archived);
    await agent.taskManager.persist();
    return { status: 'completed', taskId, promptId, result: archived };
  } catch (error) {
    agent.taskManager.update(taskId, { state: 'archive_failed', status: 'archive_failed', lastError: error.message, error: error.message });
    await agent.taskManager.persist();
    return { status: 'archive_failed', taskId, promptId, message: error.message };
  }
});

ipcMain.handle('agent:retry-recovery', async (_, { taskId } = {}) => {
  const task = agent?.taskManager?.get(taskId);
  if (!task) throw new Error('Task not found');
  assertOwnerMatch(task, currentGovernanceOwner());
  const promptId = task.promptId || task.attempts?.find(attempt => attempt.promptId)?.promptId;
  if (!promptId) return {
    status: 'submit_unknown',
    taskId,
    requiresConfirmation: true,
    message: '提交状态未知，未发现 promptId。请在 ComfyUI 队列/历史中确认后再重试，系统不会自动重复提交。',
  };
  if (task.result?.executionStatus === 'success' && (task.result.images?.length || task.result.videos?.length || task.result.media?.length)) {
    const archived = task.result;
    settleRecoveredTask(taskId, archived);
    if (task.requestId) requestLedger.complete(task.requestId, archived);
    await agent.taskManager.persist();
    return { status: 'completed', taskId, promptId, result: archived, recoveredFromTask: true };
  }
  const result = await ComfyUITool.monitor(promptId);
  if (result.status !== 'completed') return result;
  const recovered = await ComfyUITool.recoverResult(promptId, result.history);
  try {
    const archived = await archiveProjectResult({ ...recovered, taskId, promptId, requestId: task.requestId || '' }, { projectId: task.projectId, sessionId: task.sessionId, requestId: task.requestId || '' });
    settleRecoveredTask(taskId, archived);
    if (task.requestId) requestLedger.complete(task.requestId, archived);
    await agent.taskManager.persist();
    return { status: 'completed', result: archived };
  } catch (error) {
    agent.taskManager.update(taskId, { state: 'archive_failed', status: 'archive_failed', lastError: error.message, error: error.message });
    await agent.taskManager.persist();
    throw error;
  }
});

ipcMain.handle('agent:archive-task', async (_, { taskId } = {}) => {
  if (!agent) throw new Error('Agent not ready');
  const task = agent.taskManager.get(taskId);
  if (!task) throw Object.assign(new Error('Task not found'), { code: 'TASK_NOT_FOUND' });
  assertOwnerMatch(task || {}, currentGovernanceOwner());
  const archived = await runGovernedIpcMutation({ action: 'admin.recover', input: { taskId }, projectId: task.projectId, sessionId: task.sessionId, execute: () => agent.taskManager.archive(taskId) });
  if (!archived) throw new Error('Task not found or is not recoverable');
  await agent.taskManager.persist();
  return { archived: true, taskId };
});

ipcMain.handle('agent:cancel', async (_, { taskId } = {}) => {
  if (taskId && agent?.taskManager?.get(taskId)) assertOwnerMatch(agent.taskManager.get(taskId), currentGovernanceOwner());
  const entry = executionCoordinator.active;
  if (entry?.source === 'ai') {
    const result = await executionCoordinator.cancel({
      source: 'ai',
      taskId: taskId || '',
      cancel: () => agent.cancel(taskId || ''),
    });
    if (entry.requestId && !requestLedger.isTerminal(requestLedger.get(entry.requestId)?.state)) {
      try { requestLedger.update(entry.requestId, { state: 'cancelled', result: { cancelled: true, taskId: taskId || entry.taskId || '' } }); } catch {}
    }
    if (result.reason === 'not_running' && agent) return agent.cancel(taskId || '');
    return result;
  }
  if (agent) return agent.cancel(taskId || '');
  return { cancelled: false };
});

ipcMain.handle('agent:remove-conversation-turn', async (_, { turnId } = {}) => {
  if (!agent || !turnId) return { removed: 0 };
  return agent.removeConversationTurn(turnId);
});

ipcMain.handle('queue:cancel-prompt', async (_, { promptId }) => {
  if (!agent) return { error: 'agent not ready' };
  try {
    return await runGovernedIpcMutation({ action: 'comfyui.cancel', input: { promptId }, execute: () => agent.cancelPrompt(promptId) });
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('agent:feedback', async (_, { type, details = {} }) => {
  if (!agent) return { recorded: false, reason: 'Agent is not initialized' };
  return agent.recordFeedback(type, details);
});

ipcMain.handle('agent:config', async (_, { config }) => {
  if (config.llm) {
    const current = prefStore.get('llm');
    if (Array.isArray(config.llm.providers)) {
      prefStore.set('llm', config.llm);
    } else {
      const active = current.providers.find(item => item.id === current.active.providerId) || current.providers[0];
      Object.assign(active, {
        type: config.llm.provider || active.type,
        baseUrl: config.llm.baseUrl ?? active.baseUrl,
        apiKey: config.llm.apiKey ?? active.apiKey,
      });
      if (config.llm.model) {
        active.models = [{ id: config.llm.model, name: config.llm.model }];
        current.active.modelId = config.llm.model;
      }
      prefStore.set('llm', current);
    }
  }
  if (config.workflowDir) prefStore.set('workflowDir', config.workflowDir);
  if (agent) {
    await agent.reconfigureLLM(prefStore.get('llm') || {});
  }
  applyComfyConfig(prefStore.getAll());
  return { saved: true };
});

ipcMain.handle('agent:test-llm', async (_, { config }) => {
  const provider = new LLMProvider(config || {});
  if (!provider.isConfigured) throw new Error('请先填写模型连接信息');
  const result = await provider.chat({
    messages: [
      { role: 'system', content: 'Reply with OK only.' },
      { role: 'user', content: 'Connection test' },
    ],
  });
  return { ok: true, response: result.content || '' };
});

ipcMain.handle('agent:get-config', async () => {
  const config = getStoredConfig();
  return {
    // Sanitize before returning to the renderer: publicLLM strips apiKey /
    // _encryptedApiKey and exposes only hasApiKey (see publicProvider).
    llm: publicLLM(config.llm || { provider: 'openai-compatible', baseUrl: '', model: '' }),
    workflowDir: agent?.workflowDir || getDefaultWorkflowDir(),
  };
});

ipcMain.handle('projects:list', async () => {
  try { await startAgent(getStoredConfig()); } catch { return null; }
  return agent?.sessionManager.getState() || null;
});

ipcMain.handle('projects:create', async (_, input = {}) => {
  if (executionCoordinator.isBusy) throw new Error('当前会话仍有直接生成任务或待确认预览，请先取消后再切换会话');
  await startAgent(getStoredConfig());
  const state = await runGovernedIpcMutation({ action: 'project.write', input, execute: () => agent.createProject(input) });
  syncProjectPreferences();
  return state;
});

ipcMain.handle('projects:rename', async (_, { projectId, name }) => {
  await runGovernedIpcMutation({ action: 'project.write', input: { projectId, name }, projectId, execute: () => agent.sessionManager.renameProject(projectId, name) });
  syncProjectPreferences();
  return agent.sessionManager.getState();
});

ipcMain.handle('projects:delete', async (_, { projectId }) => {
  if (executionCoordinator.isBusy) throw new Error('当前会话仍有直接生成任务或待确认预览，请先取消后再删除会话');
  const state = await runGovernedIpcMutation({ action: 'project.write', input: { projectId }, projectId, execute: () => agent.deleteProject(projectId) });
  syncProjectPreferences();
  return state;
});

ipcMain.handle('sessions:list', async (_, { projectId } = {}) => {
  const project = agent?.sessionManager.getProject(projectId || agent.sessionManager.activeProjectId);
  return project?.sessions || [];
});

ipcMain.handle('sessions:create', async (_, { title, projectId } = {}) => {
  await startAgent(getStoredConfig());
  const activate = !executionCoordinator.isBusy;
  await runGovernedIpcMutation({
    action: 'session.write',
    input: { title, projectId, activate },
    projectId,
    execute: () => agent.createSession(title, projectId, { activate }),
  });
  const state = agent.sessionManager.getState();
  sendToRenderer('project:state', state);
  return state;
});

ipcMain.handle('sessions:delete', async (_, { sessionId, projectId } = {}) => {
  if (executionCoordinator.isBusy) throw new Error('当前会话仍有直接生成任务或待确认预览，请先取消后再删除会话');
  return runGovernedIpcMutation({ action: 'session.write', input: { sessionId, projectId }, projectId, sessionId, execute: () => agent.deleteSession(sessionId, projectId) });
});

ipcMain.handle('sessions:rename', async (_, { sessionId, title, projectId } = {}) => {
  return runGovernedIpcMutation({ action: 'session.write', input: { sessionId, title, projectId }, projectId, sessionId, execute: () => agent.sessionManager.renameSession(sessionId, title, projectId) });
});

ipcMain.handle('session:activate', async (_, { projectId, sessionId }) => {
  if (executionCoordinator.isBusy) throw new Error('当前会话仍有直接生成任务或待确认预览，请先取消后再切换会话');
  const activateSession = (targetProjectId, targetSessionId) => agent.useSession(targetProjectId, targetSessionId);
  const state = await runGovernedIpcMutation({ action: 'session.write', input: { projectId, sessionId }, projectId, sessionId, execute: () => activateSession(projectId, sessionId) });
  sendToRenderer('project:state', state);
  return state;
});

ipcMain.handle('session:upsert-generation-record', async (_, { record = {} } = {}) => {
  if (!record?.requestId) return { ok: false };
  await startAgent(getStoredConfig());
  if (!agent?.sessionManager?.upsertGenerationRecord) return { ok: false };
  const merged = agent.sessionManager.upsertGenerationRecord(record);
  return { ok: Boolean(merged) };
});

ipcMain.handle('session:append-execution-event', async (_, { event = {} } = {}) => {
  if (!event?.turnId) return { ok: false };
  await startAgent(getStoredConfig());
  if (!agent?.sessionManager?.appendExecutionEvent) return { ok: false };
  const saved = agent.sessionManager.appendExecutionEvent(event);
  return { ok: Boolean(saved) };
});

ipcMain.handle('llm:providers', async () => {
  const llm = prefStore.get('llm');
  return publicLLM(llm);
});

ipcMain.handle('image:generate', async (_, { prompt, size = 'auto', count = 1, quality = 'auto', images = [], projectId, sessionId, requestId = '', allowPolicyOverride = false } = {}) => {
  await startAgent(getStoredConfig());
  const normalizedRequestId = requestId || `openai_image_request_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const owner = executionOwner({ projectId, sessionId });
  const imageContext = createGovernanceContext({ ...owner, source: 'ipc', requestId: normalizedRequestId, taskId: `openai_image_${normalizedRequestId}`, traceId: `trace_openai_image_${normalizedRequestId}` });
  const project = agent?.sessionManager.getProject(owner.projectId);
  if (!project?.dir) {
    const error = Object.assign(new Error('当前项目目录无效'), { code: 'IMAGE_PROJECT_NOT_FOUND' });
    throw error;
  }
  const fingerprint = JSON.stringify({ prompt, size, count, quality, projectId: owner.projectId, sessionId: owner.sessionId, images: (images || []).map(image => image.path || image.name || '') });
  const existing = requestLedger.begin(normalizedRequestId, { source: 'openai-image', fingerprint, ...owner });
  if (existing.state === 'completed') return existing.result;
  if (existing.state === 'executing') return requestLedger.snapshot(normalizedRequestId);
  const llm = prefStore.get('llm');
  const provider = llm.providers.find(item => item.id === llm.imageProviderId);
  const model = provider?.models?.find(item => item.id === llm.imageModelId && item.kind === 'image' && item.enabled !== false);
  const config = provider && model ? { ...provider, model: model.id } : null;
  if (!config) throw new Error('请先在设置中添加并选择 OpenAI Image 提供商');
  if (model.runtime === 'local') throw new Error('本地生图请使用 ComfyUI，云端 Image API 不会重复发送请求');
  const imageLease = governanceAdmission.admit(imageContext, { action: 'llm.invoke', resource: { projectId: owner.projectId, sessionId: owner.sessionId }, input: { confirmation: true }, operation: 'image:generate', quota: { generation_count: 1 } });
  await getGovernanceGateway().audit.emit({ ...imageContext, action: 'llm.invoke', decision: 'started', data: { projectId: owner.projectId, sessionId: owner.sessionId } });
  let imageSucceeded = false;
  const referenceInputs = Array.isArray(images) ? images : [];
  const taskId = `openai_image_${normalizedRequestId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  await agent?.recordConversationMessage?.('user', String(prompt || ''), {
    intent: 'generate',
    action: 'prepare',
    turnId: normalizedRequestId,
    messageId: `${normalizedRequestId}:user`,
  });
  const policyMessages = [{ role: 'user', content: [{ type: 'text', text: String(prompt || '') }, ...referenceInputs.map(() => ({ type: 'image_url', image_url: { url: 'data:image/png;base64,policy' } }))] }];
  const policyRouter = new CloudPolicyRouter();
  policyRouter.setStateHandler(({ state }) => sendToRenderer('agent:progress', {
    scope: 'llm-policy',
    stage: state,
    policyState: state,
    message: state === 'reviewing' ? '正在审查内容（将发送到云端模型）' : state === 'cloud_allowed' ? '内容审查通过，正在发送到云端模型' : state === 'user_override' ? '已通过手动确认，正在发送到云端模型' : state === 'blocked' ? '内容包含禁止项，已停止发送' : state === 'local_fallback' ? '内容需在本地模型处理，已切换本地模型' : '',
    taskId,
    projectId: owner.projectId,
    sessionId: owner.sessionId,
  }));
  const decision = policyRouter.review(policyMessages, { allowMediaToCloud: llm.allowMediaToCloud !== false, forceAllow: allowPolicyOverride === true });
  if (!decision.allowed && !allowPolicyOverride) {
    policyRouter.block(decision);
    const error = new CloudPolicyBlockedError('该请求未发送到云端：图像生成内容需要本地处理或手动确认。', decision);
    requestLedger.fail(normalizedRequestId, error);
    policyRouter.complete();
    throw error;
  }
  requestLedger.update(normalizedRequestId, { state: 'executing', taskId });
  const controller = new AbortController();
  activeImageRequests.set(normalizedRequestId, controller);
  try {
    const referenceImages = await Promise.all(referenceInputs.map(async image => {
      const dataUrl = await getAuthorizedMediaDataUrl(image);
      const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
      if (!match) throw Object.assign(new Error('参考图片格式无效'), { code: 'IMAGE_REFERENCE_INVALID' });
      return { mimeType: match[1], base64: match[2], filename: image.name || basename(image.path) };
    }));
    const result = await new OpenAIImageProvider(config).generate({ prompt, size, count, quality, images: referenceImages, signal: controller.signal });
    const imageDir = join(project.dir, 'images', taskId);
    await mkdir(imageDir, { recursive: true });
    const assets = [];
    for (const [index, image] of result.images.entries()) {
      const extension = image.mimeType?.includes('jpeg') ? 'jpg' : 'png';
      const filename = `${taskId}_${index + 1}.${extension}`;
      await writeFile(join(imageDir, filename), Buffer.from(image.base64, 'base64'));
      assets.push({
        filename,
        subfolder: join('images', taskId),
        type: 'project',
        projectId: project.id,
        sessionId: owner.sessionId,
        taskId,
        source: 'openai-image',
        positive: result.revisedPrompt || prompt || '',
        negative: '',
        workflowName: 'OpenAI Image',
        parameters: { size, count, quality, model: model.id },
        createdAt: Date.now(),
      });
    }
    await Promise.all(assets.map(asset => writeFile(assetRecipePath(join(project.dir, asset.subfolder, asset.filename)), JSON.stringify({
      positive: asset.positive,
      negative: asset.negative,
      workflowName: asset.workflowName,
      parameters: asset.parameters,
      source: asset.source,
    }))));
    await agent.project.set('lastImages', assets);
    await agent.project.set('lastPrompt', prompt || '');
    await agent.project.set('lastGenerationSource', 'openai-image');
    await agent.project.set('assets', [...(agent.project.get('assets') || []), ...assets]);
    const archived = { images: assets, revisedPrompt: result.revisedPrompt, taskId, requestId: normalizedRequestId, source: 'openai-image' };
    if (agent?.sessionManager.activeProjectId === owner.projectId && agent?.sessionManager.activeSessionId === owner.sessionId) {
      const current = agent.sessionManager.sessionState?.generationRecords || {};
      const existing = current[normalizedRequestId] || {};
      agent.sessionManager.setSessionState({
        generationRecords: {
          ...current,
          [normalizedRequestId]: {
            ...existing,
            requestId: normalizedRequestId,
            turnId: existing.turnId || normalizedRequestId,
            taskId,
            projectId: owner.projectId,
            sessionId: owner.sessionId,
            source: 'openai-image',
            status: 'completed',
            createdAt: existing.createdAt || Date.now(),
            updatedAt: Date.now(),
            prompt: result.revisedPrompt || prompt || existing.prompt || '',
            negative: '',
            workflowName: 'OpenAI Image',
            parameters: { size, count, quality, model: model.id },
            nodeOverrides: existing.nodeOverrides || {},
            outputNodeIds: existing.outputNodeIds || null,
            media: assets,
            durationMs: existing.durationMs || 0,
            completedAt: Date.now(),
            progressPercent: 100,
            progressNodePercent: 100,
            progressMessage: '生成完成',
            progressStage: 'completed',
            error: null,
          },
        },
      });
      await agent.sessionManager.flush();
      sendToRenderer('project:state', agent.sessionManager.getState());
    }
    await agent?.recordConversationMessage?.('agent', 'OpenAI Image 生成完成。', {
      kind: 'completed',
      images: assets,
      media: assets,
      turnId: normalizedRequestId,
      messageId: `${normalizedRequestId}:agent`,
    });
    requestLedger.complete(normalizedRequestId, archived);
    imageSucceeded = true;
    await getGovernanceGateway().audit.emit({ ...imageContext, action: 'llm.invoke', decision: 'allow', reason: 'completed', data: { requestId: normalizedRequestId } });
    return archived;
  } catch (error) {
    requestLedger.fail(normalizedRequestId, error);
    await getGovernanceGateway().audit.emit({ ...imageContext, action: error.code === 'CANCELLED' ? 'llm.invoke' : 'llm.invoke', decision: error.code === 'CANCELLED' ? 'cancel' : 'error', reason: error.code || error.message, data: { requestId: normalizedRequestId } }).catch(() => {});
    throw error;
  } finally {
    imageLease.release(undefined, imageSucceeded);
    activeImageRequests.delete(normalizedRequestId);
    policyRouter.complete();
  }
});

ipcMain.handle('image:cancel', async (_, { requestId = '' } = {}) => {
  const entry = requestLedger.get(requestId);
  if (entry) assertLedgerOwner(entry);
  const controller = activeImageRequests.get(requestId);
  if (!controller) return { cancelled: false };
  controller.abort('cancelled');
  requestLedger.update(requestId, { state: 'cancelled' });
  await getGovernanceGateway().audit.emit({ ...executionOwner(entry || {}), requestId, action: 'llm.invoke', decision: 'cancel', reason: 'cancel_requested' });
  return { cancelled: true, requestId };
});

ipcMain.handle('llm:save-provider', async (_, { provider }) => {
  if (!/^[a-z0-9_-]+$/.test(provider?.id || '')) throw new Error('提供商 ID 仅支持小写字母、数字、下划线和连字符');
  const llm = prefStore.get('llm');
  const { apiKeyError, hasApiKey, apiKeyMasked, ...providerConfig } = provider;
  const existing = llm.providers.find(item => item.id === provider.id);
  if (!providerConfig.name || String(providerConfig.name).length > 120) throw new Error('提供商名称不能为空且不能超过 120 个字符');
  if (!providerConfig.baseUrl) throw new Error('请填写 API 地址');
  providerConfig.baseUrl = normalizeHttpUrl(providerConfig.baseUrl, 'API 地址');
  if (providerConfig.apiKey === undefined && existing?.apiKey) providerConfig.apiKey = existing.apiKey;
  if (providerConfig.apiKey === undefined && existing?._encryptedApiKey) providerConfig.apiKey = existing._encryptedApiKey;
  const normalized = {
    ...providerConfig,
    type: provider.type || 'openai-compatible',
    headers: normalizeHeaders(provider.headers),
    models: Array.isArray(provider.models) ? provider.models.filter(model => model.id).map(model => ({ ...model, enabled: model.enabled !== false, kind: model.kind === 'image' ? 'image' : 'chat', runtime: model.kind === 'image' ? (model.runtime === 'local' ? 'local' : 'cloud') : '' })) : [],
  };
  const index = llm.providers.findIndex(item => item.id === normalized.id);
  if (index >= 0) llm.providers[index] = normalized;
  else llm.providers.push(normalized);
  if (!llm.active.providerId) {
    llm.active.providerId = normalized.id;
    llm.active.modelId = normalized.models.find(model => model.enabled !== false)?.id || '';
  }
  const imageModel = normalized.models.find(model => model.kind === 'image' && model.enabled !== false);
  if (imageModel && !llm.imageProviderId) {
    llm.imageProviderId = normalized.id;
    llm.imageModelId = imageModel.id;
  }
  prefStore.set('llm', llm);
  await agent?.reconfigureLLM(llm);
  return publicLLM(llm);
});

ipcMain.handle('llm:delete-provider', async (_, { providerId }) => {
  const llm = prefStore.get('llm');
  if (llm.providers.length === 1) throw new Error('至少保留一个提供商');
  llm.providers = llm.providers.filter(item => item.id !== providerId);
  if (llm.active.providerId === providerId) {
    llm.active.providerId = llm.providers[0].id;
    llm.active.modelId = llm.providers[0].models?.find(model => model.kind !== 'image' && model.enabled !== false)?.id || '';
  }
  if (llm.imageProviderId === providerId) {
    llm.imageProviderId = '';
    llm.imageModelId = '';
  }
  prefStore.set('llm', llm);
  await agent?.reconfigureLLM(llm);
  return publicLLM(llm);
});

ipcMain.handle('llm:toggle-model', async (_, { providerId, modelId, enabled }) => {
  const llm = prefStore.get('llm');
  const provider = llm.providers.find(item => item.id === providerId);
  if (!provider) throw new Error('提供商不存在');
  const model = provider.models?.find(item => item.id === modelId);
  if (!model) throw new Error('模型不存在');
  model.enabled = enabled !== false;
  if (!model.enabled) {
    if (llm.active.providerId === providerId && llm.active.modelId === modelId) {
      const next = provider.models.find(item => item.id !== modelId && item.kind !== 'image' && item.enabled !== false);
      if (next) llm.active.modelId = next.id;
      else { llm.active.providerId = ''; llm.active.modelId = ''; }
    }
    if (llm.imageProviderId === providerId && llm.imageModelId === modelId) {
      const nextImage = provider.models.find(item => item.id !== modelId && item.kind === 'image' && item.enabled !== false);
      if (nextImage) llm.imageModelId = nextImage.id;
      else { llm.imageProviderId = ''; llm.imageModelId = ''; }
    }
  }
  prefStore.set('llm', llm);
  await agent?.reconfigureLLM(llm);
  return publicLLM(llm);
});

ipcMain.handle('llm:disconnect-provider', async (_, { providerId, templateReset }) => {
  const llm = prefStore.get('llm');
  const existing = llm.providers.find(item => item.id === providerId);
  if (!existing) throw new Error('提供商不存在');
  if (templateReset && templateReset.id === providerId) {
    const { apiKey, _encryptedApiKey, hasApiKey, apiKeyError, ...rest } = templateReset;
    const reset = {
      ...rest,
      headers: {},
      models: Array.isArray(templateReset.models) ? templateReset.models.filter(model => model.id).map(model => ({ ...model, enabled: model.enabled !== false, kind: model.kind === 'image' ? 'image' : 'chat', runtime: model.kind === 'image' ? (model.runtime === 'local' ? 'local' : 'cloud') : '' })) : [],
    };
    llm.providers = llm.providers.map(item => item.id === providerId ? reset : item);
    if (llm.active.providerId === providerId && !reset.models.some(model => model.id === llm.active.modelId && model.kind !== 'image' && model.enabled !== false)) {
      llm.active.modelId = reset.models.find(model => model.kind !== 'image' && model.enabled !== false)?.id || '';
    }
    if (llm.imageProviderId === providerId) {
      const imageModel = reset.models.find(model => model.kind === 'image' && model.enabled !== false);
      if (imageModel) llm.imageModelId = imageModel.id;
      else { llm.imageProviderId = ''; llm.imageModelId = ''; }
    }
  } else {
    if (llm.providers.length === 1) throw new Error('至少保留一个提供商');
    llm.providers = llm.providers.filter(item => item.id !== providerId);
    if (llm.active.providerId === providerId) {
      const next = llm.providers[0];
      llm.active.providerId = next.id;
      llm.active.modelId = next.models?.find(model => model.kind !== 'image' && model.enabled !== false)?.id || '';
    }
    if (llm.imageProviderId === providerId) {
      llm.imageProviderId = '';
      llm.imageModelId = '';
    }
  }
  prefStore.set('llm', llm);
  await agent?.reconfigureLLM(llm);
  return publicLLM(llm);
});

ipcMain.handle('llm:select', async (_, selection = {}) => {
  const llm = prefStore.get('llm');
  const active = { ...llm.active };
  if (selection.strategy) {
    if (!['auto', 'local', 'cloud', 'manual'].includes(selection.strategy)) throw new Error('无效模型策略');
    active.strategy = selection.strategy;
  }
  if (selection.providerId) {
    const provider = llm.providers.find(item => item.id === selection.providerId);
    if (!provider) throw new Error('提供商不存在');
    const modelId = selection.modelId || provider.models?.find(item => item.kind !== 'image' && item.enabled !== false)?.id || '';
    if (!provider.models?.some(item => item.id === modelId && item.kind !== 'image' && item.enabled !== false)) throw new Error('聊天模型不存在');
    active.providerId = provider.id;
    active.modelId = modelId;
  }
  if (selection.modelId && !selection.providerId) {
    const provider = llm.providers.find(item => item.id === active.providerId);
    if (!provider?.models?.some(item => item.id === selection.modelId && item.kind !== 'image' && item.enabled !== false)) throw new Error('聊天模型不存在');
    active.modelId = selection.modelId;
  }
  if (selection.reasoningEffort) {
    if (!['low', 'medium', 'high'].includes(selection.reasoningEffort)) throw new Error('无效推理强度');
    active.reasoningEffort = selection.reasoningEffort;
  }
  if (selection.imageProviderId !== undefined) {
    const provider = llm.providers.find(item => item.id === selection.imageProviderId);
    const imageModel = provider?.models?.find(item => item.kind === 'image' && item.enabled !== false);
    if (selection.imageProviderId && !imageModel) throw new Error('该提供商没有可用的生图模型');
    llm.imageProviderId = selection.imageProviderId;
    if (selection.imageProviderId && !provider.models.some(item => item.id === llm.imageModelId && item.kind === 'image' && item.enabled !== false)) llm.imageModelId = imageModel.id;
  }
  if (selection.imageModelId !== undefined) {
    const provider = llm.providers.find(item => item.id === llm.imageProviderId);
    if (selection.imageModelId && !provider?.models?.some(item => item.id === selection.imageModelId && item.kind === 'image' && item.enabled !== false)) throw new Error('生图模型不存在');
    llm.imageModelId = selection.imageModelId;
  }
  llm.active = active;
  prefStore.set('llm', llm);
  await agent?.reconfigureLLM(llm);
  return publicLLM(llm);
});

ipcMain.handle('llm:media-policy', async (_, { allowMediaToCloud }) => {
  const llm = prefStore.get('llm');
  llm.allowMediaToCloud = allowMediaToCloud !== false;
  prefStore.set('llm', llm);
  await agent?.reconfigureLLM(llm);
  return publicLLM(llm);
});

ipcMain.handle('llm:test', async (_, { provider, modelId }) => {
  if (!provider?.baseUrl) throw new Error('请先填写 API 地址');
  const llm = prefStore.get('llm');
  const existing = llm.providers.find(item => item.id === provider.id);
  // 测试使用编辑框中的当前配置，不保存；Key 留空时回退到已保存的 Key。
  const apiKey = provider.apiKey || existing?.apiKey || existing?._encryptedApiKey || '';
  const imageModel = (provider.models || []).find(item => item.id === modelId && item.kind === 'image');
  if (imageModel) {
    throw new Error('生图模型测试可能产生费用，请直接使用工具栏进行一次受控生成');
  }
  const testConfig = {
    providers: [{
      id: provider.id,
      type: provider.type || 'openai-compatible',
      baseUrl: normalizeHttpUrl(provider.baseUrl, 'API 地址'),
      apiKey,
      headers: normalizeHeaders(provider.headers),
      models: Array.isArray(provider.models) ? provider.models : [],
    }],
    active: {
      providerId: provider.id,
      modelId: modelId || provider.models?.find(item => item.kind !== 'image')?.id || '',
      reasoningEffort: llm.active?.reasoningEffort || 'medium',
      strategy: 'manual',
    },
  };
  const testProvider = new LLMProvider(testConfig);
  if (!testProvider.isConfigured) throw new Error('请先填写模型连接信息');
  const result = await testProvider.chat({ messages: [{ role: 'user', content: 'Reply with OK only.' }], maxTokens: 8 });
  return { ok: true, message: result.content || 'OK' };
});

ipcMain.handle('skills:list', async () => {
  const skills = prefStore.get('skills') || {};
  const external = Object.fromEntries((skills.external || []).filter(item => item?.id && item.enabled !== false).map(item => {
    try { return [item.id, normalizeExternalSkill(item, item.source || 'config')]; } catch { return null; }
  }).filter(Boolean));
  const custom = Object.fromEntries((skills.custom || []).filter(item => item?.id && item.enabled !== false).map(item => [item.id, createCustomSkill(item)]));
  return { ...skills, registry: [...skillManifest(BUILTIN_SKILLS, skills.system), ...skillManifest(custom), ...skillManifest(external)] };
});

ipcMain.handle('skills:set-enabled', async (_, { id, enabled, custom = false, external = false }) => {
  const skills = prefStore.get('skills');
  if (external) {
    const skill = skills.external.find(item => item.id === id);
    if (!skill) throw new Error('外部 Skill 不存在');
    skill.enabled = Boolean(enabled);
  } else if (custom) {
    const skill = skills.custom.find(item => item.id === id);
    if (!skill) throw new Error('技能不存在');
    skill.enabled = Boolean(enabled);
  } else {
    if (!(id in BUILTIN_SKILLS)) throw new Error('系统技能不存在');
    skills.system[id] = Boolean(enabled);
  }
  prefStore.set('skills', skills);
  configureSkills({ systemEnabled: skills.system, custom: skills.custom, external: skills.external });
  return skills;
});

ipcMain.handle('skills:add-custom', async (_, { skill }) => {
  if (!/^[a-z0-9_-]+$/.test(skill?.id || '')) throw new Error('技能 ID 格式无效');
  const skills = prefStore.get('skills');
  if (skills.custom.some(item => item.id === skill.id) || skill.id in skills.system) throw new Error('技能 ID 已存在');
  skills.custom.push({ ...skill, keywords: Array.isArray(skill.keywords) ? skill.keywords : [], enabled: skill.enabled !== false });
  prefStore.set('skills', skills);
  configureSkills({ systemEnabled: skills.system, custom: skills.custom, external: skills.external });
  return skills;
});

ipcMain.handle('skills:delete-custom', async (_, { id }) => {
  const skills = prefStore.get('skills');
  skills.custom = skills.custom.filter(item => item.id !== id);
  prefStore.set('skills', skills);
  configureSkills({ systemEnabled: skills.system, custom: skills.custom, external: skills.external });
  return skills;
});

ipcMain.handle('agent:prompt-mode', async (_, { mode }) => {
  if (agent) await agent.setPromptMode(mode);
  return { mode };
});

ipcMain.handle('project:update-state', async (_, patch = {}) => {
  if (!agent) return null;
  const allowed = new Set(['workflow', 'skillId', 'budgets', 'researchSettings', 'promptMode', 'savedPreferences', 'commonParameters', 'customSystemPrompt']);
  const unknown = Object.keys(patch).filter(key => !allowed.has(key));
  if (unknown.length) throw new Error(`不允许修改项目字段：${unknown.join(', ')}`);
  await runGovernedIpcMutation({ action: 'project.write', input: patch, execute: () => agent.call('project.update', [patch]) });
  const state = agent.sessionManager.getState();
  sendToRenderer('project:state', state);
  return state;
});

ipcMain.handle('ui:preferences', async () => normalizeUIPreferences(prefStore.get('ui')));

ipcMain.handle('ui:save-preferences', async (_, preferences = {}) => {
  const normalized = normalizeUIPreferences(preferences);
  prefStore.set('ui', normalized);
  await agent?.reconfigurePrompt(promptRuntimeConfig());
  return normalized;
});

ipcMain.handle('research:settings', async () => {
  const research = prefStore.get('research') || {};
  return {
    // 只有解密成功（明文可用）才算有 key；解不开的加密串会通过 *KeyError 提示重新输入，
    // 避免界面显示 ****** 但实际运行时 key 为空
    hasBaiduApiKey: Boolean(research.baiduApiKey),
    hasSearchApiKey: Boolean(research.searchApiKey),
    baiduApiKeyError: research.baiduApiKeyError || '',
    searchApiKeyError: research.searchApiKeyError || '',
  };
});

ipcMain.handle('research:save-settings', async (_, settings = {}) => {
  const research = prefStore.get('research') || {};
  const nextResearch = { ...research };
  // 展开运算符不复制不可枚举属性，这里显式保留解不开的加密串（_save 会把它写回磁盘）
  for (const field of ['_encryptedBaiduApiKey', '_encryptedSearchApiKey']) {
    if (research[field]) Object.defineProperty(nextResearch, field, { value: research[field], configurable: true });
  }
  if (settings.baiduApiKey !== undefined) nextResearch.baiduApiKey = String(settings.baiduApiKey || '').trim();
  if (settings.searchApiKey !== undefined) nextResearch.searchApiKey = String(settings.searchApiKey || '').trim();
  prefStore.set('research', nextResearch);
  await agent?.reconfigureResearch(prefStore.get('research') || {});
  const stored = prefStore.get('research') || {};
  return {
    hasBaiduApiKey: Boolean(stored.baiduApiKey),
    hasSearchApiKey: Boolean(stored.searchApiKey),
    baiduApiKeyError: stored.baiduApiKeyError || '',
    searchApiKeyError: stored.searchApiKeyError || '',
  };
});

function promptRuntimeConfig() {
  const personality = prefStore.get('prompt.personality') || {};
  const language = normalizeUIPreferences(prefStore.get('ui') || {}).language;
  return { personality: { enabled: Boolean(personality.enabled), strategy: personality.strategy === 'replace' ? 'replace' : 'append', text: String(personality.text || '').trim() }, language };
}

ipcMain.handle('prompt:settings', async () => {
  const config = promptRuntimeConfig();
  return { enabled: config.personality.enabled, strategy: config.personality.strategy, text: config.personality.text, language: config.language };
});

ipcMain.handle('prompt:save-settings', async (_, settings = {}) => {
  const personality = {
    enabled: Boolean(settings.enabled),
    strategy: settings.strategy === 'replace' ? 'replace' : 'append',
    text: String(settings.text || '').slice(0, 4000).trim(),
  };
  if (personality.enabled && !personality.text) personality.enabled = false;
  const prompt = prefStore.get('prompt') || {};
  prefStore.set('prompt', { ...prompt, personality });
  await agent?.reconfigurePrompt(promptRuntimeConfig());
  return promptRuntimeConfig();
});

ipcMain.handle('skills:import-external', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'External Skill manifest', extensions: ['json'] }],
    title: '导入外部 Skill（声明式 JSON）',
  });
  if (result.canceled || result.filePaths.length === 0) return prefStore.get('skills');
  const skills = prefStore.get('skills');
  const imported = [];
  for (const filePath of result.filePaths) {
    const skill = await loadExternalSkillFile(filePath);
    if (skills.system[skill.id] || skills.custom.some(item => item.id === skill.id) || skills.external.some(item => item.id === skill.id)) throw new Error(`Skill ID 已存在：${skill.id}`);
    imported.push(skill);
  }
  skills.external.push(...imported.map(externalSkillConfig));
  prefStore.set('skills', skills);
  configureSkills({ systemEnabled: skills.system, custom: skills.custom, external: skills.external });
  return skills;
});

ipcMain.handle('skills:delete-external', async (_, { id }) => {
  const skills = prefStore.get('skills');
  skills.external = skills.external.filter(item => item.id !== id);
  prefStore.set('skills', skills);
  configureSkills({ systemEnabled: skills.system, custom: skills.custom, external: skills.external });
  return skills;
});

// Create an external (declarative) skill from form fields instead of a JSON
// file: validates through the same normalize/validate path as file import.
ipcMain.handle('skills:add-external', async (_, input = {}) => {
  const skill = normalizeExternalSkill(input, 'form');
  const skills = prefStore.get('skills');
  if (skills.system[skill.id] || skills.custom.some(item => item.id === skill.id) || skills.external.some(item => item.id === skill.id)) {
    throw new Error(`Skill ID 已存在：${skill.id}`);
  }
  skills.external.push(externalSkillConfig(skill));
  prefStore.set('skills', skills);
  configureSkills({ systemEnabled: skills.system, custom: skills.custom, external: skills.external });
  return skills;
});

ipcMain.handle('memory:get-state', async (_, { projectId = '' } = {}) => agent.call('memory.getState', [projectId]));
ipcMain.handle('memory:set-profile', async (_, { projectId = '', patch = {} } = {}) => agent.call('memory.setProfile', [projectId, patch]));
ipcMain.handle('memory:upsert-character-card', async (_, { projectId = '', card = {} } = {}) => agent.call('memory.upsertCharacterCard', [projectId, card]));
ipcMain.handle('memory:delete-character-card', async (_, { projectId = '', name = '' } = {}) => agent.call('memory.deleteCharacterCard', [projectId, name]));
ipcMain.handle('memory:clear', async (_, { projectId = '' } = {}) => agent.call('memory.clear', [projectId]));
ipcMain.handle('memory:export', async () => agent.call('memory.export'));
ipcMain.handle('memory:recall', async (_, { projectId = '', query = '', limit } = {}) => agent.call('memory.recall', [projectId, { query, limit }]));

ipcMain.handle('plugins:list', async () => {
  await startAgent(getStoredConfig());
  return agent.call('plugins.list');
});
ipcMain.handle('plugins:enable', async (_, { pluginId = '', enabled = true } = {}) => {
  await startAgent(getStoredConfig());
  return agent.call('plugins.enable', [pluginId, Boolean(enabled)]);
});
ipcMain.handle('plugins:remove', async (_, { pluginId = '' } = {}) => {
  await startAgent(getStoredConfig());
  return agent.call('plugins.remove', [pluginId]);
});

ipcMain.handle('batch:create', async (_, input = {}) => {
  const owner = executionOwner();
  return getBatchScheduler().createBatch({ ...input, projectId: owner.projectId, sessionId: owner.sessionId });
});
ipcMain.handle('batch:start', async (_, { batchId = '' } = {}) => getBatchScheduler().start(batchId));
ipcMain.handle('batch:pause', async (_, { batchId = '' } = {}) => getBatchScheduler().pause(batchId));
ipcMain.handle('batch:resume', async (_, { batchId = '' } = {}) => getBatchScheduler().resume(batchId));
ipcMain.handle('batch:cancel', async (_, { batchId = '' } = {}) => getBatchScheduler().cancel(batchId));
ipcMain.handle('batch:retry-job', async (_, { batchId = '', jobId = '' } = {}) => getBatchScheduler().retryJob(batchId, jobId));
ipcMain.handle('batch:get', async (_, { batchId = '' } = {}) => getBatchScheduler().publicBatch(batchId));
ipcMain.handle('batch:list', async (_, { projectId = '', limit = 20 } = {}) => getBatchScheduler().listBatches({ projectId, limit }));

// Cross-window queue draft: assembled in the renderer (main or floating window),
// shared through the main process so both windows see the same queue before
// start. In-memory only (lost on restart) — the "one-shot execution ticket"
// model. Started batches persist via BatchScheduler.
let queueDraft = [];

function broadcastQueueDraft() {
  windowRegistry.send('queue:event', { type: 'changed', items: queueDraft }, () => true);
}

ipcMain.handle('queue:list', () => queueDraft);

ipcMain.handle('queue:add', (_, { item = {} } = {}) => {
  const entry = { ...item, id: item.id || `queue_item_${Date.now()}_${randomUUID().slice(0, 6)}` };
  queueDraft = [...queueDraft, entry];
  broadcastQueueDraft();
  return { item: entry, position: queueDraft.length };
});

ipcMain.handle('queue:remove', (_, { id = '' } = {}) => {
  queueDraft = queueDraft.filter(item => item.id !== id);
  broadcastQueueDraft();
  return true;
});

ipcMain.handle('queue:move', (_, { id = '', direction = 0 } = {}) => {
  const index = queueDraft.findIndex(item => item.id === id);
  const target = index + (Number(direction) < 0 ? -1 : 1);
  if (index >= 0 && target >= 0 && target < queueDraft.length) {
    const next = [...queueDraft];
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item);
    queueDraft = next;
  }
  broadcastQueueDraft();
  return true;
});

ipcMain.handle('queue:update', (_, { id = '', patch = {} } = {}) => {
  queueDraft = queueDraft.map(item => item.id === id ? { ...item, ...patch } : item);
  broadcastQueueDraft();
  return true;
});

ipcMain.handle('queue:clear', () => {
  queueDraft = [];
  broadcastQueueDraft();
  return true;
});

ipcMain.handle('queue:start', async () => {
  const owner = executionOwner();
  const jobs = expandQueueItems(queueDraft);
  if (!jobs.length) throw Object.assign(new Error('queue empty'), { code: 'QUEUE_EMPTY' });
  const batch = await getBatchScheduler().createBatch({ jobs, title: '', projectId: owner.projectId, sessionId: owner.sessionId });
  queueDraft = [];
  broadcastQueueDraft();
  // Fire-and-forget: run to completion in the background. Progress flows to
  // the renderer via batch:event + batch:list; the IPC must return immediately
  // so the caller sees the batch start right away.
  void getBatchScheduler().start(batch.id).catch(() => {});
  return batch;
});

ipcMain.handle('queue:open-main-tab', () => {
  showMainWindow();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('queue:open-tab');
  return true;
});

// Batch curation: score completed jobs' first output image via the agent
// evaluator (technical + vision), record scores, return the Top-K.
ipcMain.handle('batch:curate', async (_, { batchId = '', limit = 12 } = {}) => {
  await startAgent(getStoredConfig());
  const scheduler = getBatchScheduler();
  const batch = scheduler.publicBatch(batchId);
  const candidates = batch.jobs
    .filter(job => job.status === 'completed' && job.result?.images?.length > 0)
    .slice(0, Math.max(1, Number(limit) || 12));
  const scored = [];
  for (const job of candidates) {
    const image = job.result.images[0].path;
    if (!image) continue;
    const outcome = await agent.call('evaluator.score', [{ path: image }, job.positive]);
    if (outcome?.score != null && await scheduler.scoreJob(batchId, job.index, outcome.score)) {
      scored.push({ index: job.index, seed: job.seed, score: outcome.score, passed: outcome.passed === true });
    }
  }
  return {
    scored: scored.length,
    top: scored.sort((a, b) => b.score - a.score).slice(0, 5),
    ranked: [...scored].sort((a, b) => b.score - a.score),
  };
});

ipcMain.handle('mcp:settings', async () => {
  const mcp = prefStore.get('mcp') || {};
  return { enabled: mcp.enabled === true, host: mcp.host || '127.0.0.1', port: mcp.port || 3333, hasToken: Boolean(mcp.token), modules: mcpModuleFlags(mcp.modules || {}) };
});

ipcMain.handle('mcp:save-settings', async (_, settings = {}) => {
  const current = prefStore.get('mcp') || {};
  const port = Number(settings.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('MCP 端口必须是 1-65535 的整数');
  const host = String(settings.host || '127.0.0.1').trim();
  if (!host || /[\s/]/.test(host)) throw new Error('MCP 主机地址无效');
  const token = settings.token === undefined ? current.token || '' : String(settings.token || '').trim();
  if (settings.enabled === true && host !== '127.0.0.1' && host !== 'localhost' && !token) throw new Error('MCP 监听局域网地址时必须设置访问令牌');
  const modules = settings.modules && typeof settings.modules === 'object'
    ? mcpModuleFlags({ web: settings.modules.web, files: settings.modules.files, comfyui: settings.modules.comfyui, skills: settings.modules.skills })
    : mcpModuleFlags(current.modules || {});
  prefStore.set('mcp', { enabled: settings.enabled === true, host, port, token, modules });
  await restartEmbeddedMcp();
  return { enabled: settings.enabled === true, host, port, hasToken: Boolean(token), modules };
});

ipcMain.handle('agent:artifacts', async (_, { type, limit } = {}) => {
  if (!agent) return [];
  return agent.getArtifacts({ type, limit });
});

ipcMain.handle('agent:detect-workflow', async (_, { workflowName }) => {
  if (!agent) return null;
  return agent.detectWorkflow(workflowName);
});

ipcMain.handle('agent:inspect-workflow', async (_, { workflowName }) => {
  if (!agent || !workflowName) return null;
  const comfyState = await comfyManager.ensureStarted();
  if (comfyState.status !== 'ready') throw new Error(comfyState.message || 'ComfyUI 未就绪');
  const workflowDir = getWorkflowDir({ workflowDir: agent.workflowDir });
  if (workflowDir !== agent.workflowDir) await agent.setWorkflowDir(workflowDir);
  const key = `${workflowDir}\u0000${workflowName}`;
  const existing = workflowInspectionRequests.get(key);
  if (existing) return existing;
  const request = ComfyUITool.inspectWorkflow(workflowName, workflowDir).finally(() => {
    workflowInspectionRequests.delete(key);
  });
  workflowInspectionRequests.set(key, request);
  return request;
});

ipcMain.handle('agent:status', async () => {
  if (agent) await recoverAgentTasks();
  return {
    running: agent?.isRunning || false,
    state: agent?.state || 'idle',
    taskId: agent?.taskId || '',
    sessionState: agent?.sessionManager?.getSessionState?.() || null,
    workflowDir: getWorkflowDir({ workflowDir: agent?.workflowDir }),
  };
});

ipcMain.handle('agent:workflow-dir', async (_, { dir }) => {
  if (!isDirectoryPath(dir)) throw new Error('工作流目录不存在');
  if (agent) await agent.setWorkflowDir(dir);
  directService?.setWorkflowDir(dir);
  prefStore.set('workflowDir', dir);
  return { dir };
});

ipcMain.handle('comfyui:status', async () => comfyManager.refreshState());
ipcMain.handle('h3:readiness', async () => {
  const state = await comfyManager.refreshState();
  if (state.status !== 'ready') return { ready: false, message: state.message || 'ComfyUI is not ready' };
  try {
    const info = await ComfyUITool.client.objectInfo();
    const required = ['MiniMaxH3ReferenceToVideo', 'MiniMaxH3SigmaShift', 'EmptyMiniMaxH3LatentAV'];
    const missing = required.filter(name => !info?.[name]);
    return missing.length === 0
      ? { ready: true, message: 'MiniMax H3 官方节点已加载' }
      : { ready: false, message: `H3 节点未加载：${missing.join('、')}。请完成更新后重启 ComfyUI。`, missing };
  } catch (error) {
    return { ready: false, message: error.message || '无法读取 ComfyUI 节点信息' };
  }
});

ipcMain.handle('comfyui:start', async () => comfyManager.ensureStarted());

ipcMain.handle('comfyui:select-root', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    defaultPath: comfyManager.portableRoot || undefined,
    title: '选择 ComfyUI 根目录（含 python_embeded 和 ComfyUI 文件夹）',
  });
  if (result.canceled || result.filePaths.length === 0) return comfyManager.getState();
  const root = result.filePaths[0];
  if (!hasPortableLayout(root)) {
    throw new Error('所选目录不是 ComfyUI portable 根目录（缺少 python_embeded\\python.exe 和 ComfyUI\\main.py）');
  }
  comfyManager.setPortableRoot(root);
  prefStore.set('comfyui', { ...prefStore.get('comfyui'), portableRoot: root });
  if (agent?.isAlive) await agent.reconfigureComfy({ comfyRoot: join(root, 'ComfyUI'), workflowDir: getWorkflowDir(getStoredConfig()) });
  return comfyManager.getState();
});

ipcMain.handle('comfyui:set-base-url', async (_, { baseUrl = '' } = {}) => {
  const normalized = comfyManager.setBaseUrl(normalizeHttpUrl(baseUrl || DEFAULT_BASE_URL, 'ComfyUI 地址'));
  ComfyUITool.setClient(new ComfyUIClient({ baseUrl: normalized }));
  prefStore.set('comfyui', { ...prefStore.get('comfyui'), baseUrl: normalized });
  if (agent?.isAlive) await agent.reconfigureComfy({ baseUrl: normalized });
  return comfyManager.refreshState();
});

ipcMain.handle('comfyui:reset', async () => {
  comfyManager.setBaseUrl(envConfig.COMFYUI_BASE_URL || DEFAULT_BASE_URL);
  comfyManager.redetectRoot(COMFY_START_DIRS);
  prefStore.set('comfyui', { baseUrl: comfyManager.baseUrl });
  ComfyUITool.setClient(new ComfyUIClient({ baseUrl: comfyManager.baseUrl }));
  if (agent?.isAlive) await agent.reconfigureComfy({ baseUrl: comfyManager.baseUrl });
  return comfyManager.refreshState();
});

ipcMain.handle('comfyui:download-portable', async (_, { kind = 'nvidia' } = {}) => {
  const url = COMFYUI_PORTABLE_URLS[kind] || COMFYUI_PORTABLE_URLS.nvidia;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    defaultPath: comfyManager.portableRoot || undefined,
    title: '选择安装位置（将在此创建 ComfyUI_windows_portable 文件夹）',
  });
  if (result.canceled || result.filePaths.length === 0) return { cancelled: true };
  const targetDir = result.filePaths[0];
  const archivePath = join(targetDir, 'comfyui-portable.7z');
  const extractDir = join(targetDir, '.comfyui-portable-extract');
  try {
    sendToRenderer('comfyui:download-progress', { phase: 'download', percent: 0, message: '正在下载 ComfyUI portable...' });
    await downloadToFile(url, archivePath, progress => {
      const percent = progress.total ? Math.round(progress.percent * 100) : -1;
      sendToRenderer('comfyui:download-progress', {
        phase: 'download',
        percent,
        message: `已下载 ${formatBytes(progress.bytes)}${progress.total ? ` / ${formatBytes(progress.total)}` : ''}`,
      });
    });
    await rm(extractDir, { recursive: true, force: true });
    await mkdir(extractDir, { recursive: true });
    sendToRenderer('comfyui:download-progress', { phase: 'extract', percent: -1, message: '正在解压，请稍候...' });
    const extraction = spawnSync('tar', ['-xf', archivePath, '-C', extractDir], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    if (extraction.status !== 0) {
      throw new Error('解压失败：系统 tar 无法读取 7z 文件（需要 Windows 10 1803 及以上版本）');
    }
    const root = findPortableRootUnder(extractDir);
    if (!root) throw new Error('解压结果中未找到 ComfyUI 目录');
    const finalRoot = join(targetDir, basename(root));
    if (existsSync(finalRoot)) await rm(finalRoot, { recursive: true, force: true });
    await rename(root, finalRoot);
    comfyManager.setPortableRoot(finalRoot);
    prefStore.set('comfyui', { ...prefStore.get('comfyui'), portableRoot: finalRoot });
    sendToRenderer('comfyui:download-progress', { phase: 'done', message: '安装完成' });
    const state = await comfyManager.ensureStarted();
    return state;
  } finally {
    await rm(archivePath, { force: true });
    await rm(extractDir, { recursive: true, force: true });
  }
});

ipcMain.handle('comfyui:image-data', async (_, image) => getImageDataUrl(image));
ipcMain.handle('media:image-data', async (_, media) => getAuthorizedMediaDataUrl(media));

ipcMain.handle('comfyui:save-image', async (_, image) => {
  const source = resolveImagePath(image);
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '另存图片',
    defaultPath: image.filename,
  });
  if (result.canceled || !result.filePath) return { saved: false };
  if (resolve(result.filePath) !== source) await copyFile(source, result.filePath);
  return { saved: true, path: result.filePath };
});

ipcMain.handle('comfyui:show-image', async (_, image) => {
  const filePath = resolveImagePath(image);
  await stat(filePath);
  shell.showItemInFolder(filePath);
  return { shown: true };
});

ipcMain.handle('app:save-text-file', async (_, { defaultName = 'export.txt', content = '', filterName = '文本文件' } = {}) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '导出文件',
    defaultPath: defaultName,
    filters: [{ name: filterName, extensions: [defaultName.split('.').pop() || 'txt'] }],
  });
  if (result.canceled || !result.filePath) return { saved: false };
  await writeFile(result.filePath, content, 'utf8');
  return { saved: true, path: result.filePath };
});

ipcMain.handle('comfyui:recent-images', async () => getRecentImages());

ipcMain.handle('project:assets', async (_, projectId) => {
  const requestedProjectId = typeof projectId === 'string' ? projectId : projectId?.projectId;
  assertOwnerMatch(executionOwner({ projectId: requestedProjectId || executionOwner().projectId }), currentGovernanceOwner());
  return getProjectAssets(requestedProjectId);
});

ipcMain.handle('project:delete-asset', async (_, image) => runGovernedIpcMutation({ action: 'media.export', input: image, projectId: image?.projectId, execute: () => deleteProjectAsset(image) }));

// ===== App Lifecycle =====

app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

if (hasSingleInstanceLock) {
  app.on('second-instance', () => {
    showMainWindow();
  });
}

if (hasSingleInstanceLock) app.whenReady().then(async () => {
  const envDataDir = resolveAppPath(envConfig.AGENT_DATA_DIR);
  const userDataPath = envDataDir || join(app.getPath('appData'), USER_DATA_DIR_NAME);
  app.setPath('userData', userDataPath);
  comfyManager.setStartupLockPath(join(userDataPath, 'comfyui-startup.lock'));
  prefStore = new PreferenceMemory(join(userDataPath, 'config.json'));
  const savedComfy = prefStore.get('comfyui') || {};
  const envComfyRoot = resolveAppPath(envConfig.COMFYUI_PORTABLE_ROOT);
  const savedComfyRoot = resolveAppPath(savedComfy.portableRoot);
  if (!comfyManager.setPortableRoot(envComfyRoot || savedComfyRoot)) {
    comfyManager.redetectRoot(COMFY_START_DIRS);
  }
  const config = getStoredConfig();
  const llm = config.llm || {};
  if (llm.apiKey && !String(llm.apiKey).startsWith('enc:')) {
    prefStore.set('llm', llm);
  }
  const workflowDir = getWorkflowDir(config);
  if (workflowDir && config.workflowDir !== workflowDir) {
    prefStore.set('workflowDir', workflowDir);
  }
  applyComfyConfig(prefStore.getAll());
  createWindow();
  tray = new Tray(nativeImage.createFromPath(APP_ICON_PATH));
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主应用', click: showMainWindow },
    { label: '隐藏主应用', click: () => mainWindow?.hide() },
    { label: '显示快速生成', click: showFloatingWindow },
    { label: '隐藏快速生成', click: () => floatingWindow?.hide() },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]));
  tray.on('double-click', showMainWindow);
  globalShortcut.register('CommandOrControl+Shift+Space', () => {
    if (floatingWindow && !floatingWindow.isDestroyed() && floatingWindow.isVisible()) floatingWindow.hide();
    else showFloatingWindow();
  });
  void startAgent(prefStore.getAll()).catch(() => {});
  void comfyManager.ensureStarted().catch(error => console.error(`ComfyUI startup failed: ${error.message}`));
  void startEmbeddedMcp(config).catch(error => console.error(`MCP initialization failed: ${error.message}`));
});

let quitRequested = false;

app.on('before-quit', event => {
  if (quitRequested) return;
  quitRequested = true;
  event.preventDefault();
  comfyManager.stopOwned({ permanent: true });
  void (async () => {
    try { await agent?.stop?.(); } catch {}
    try { await embeddedMcpTransport?.close?.(); } catch {}
    app.quit();
  })();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  tray?.destroy();
  if (floatingWindow && !floatingWindow.isDestroyed()) floatingWindow.destroy();
  void agent?.stop?.();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  showMainWindow();
});
