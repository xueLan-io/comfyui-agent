import pkg from 'electron';
import { spawnSync } from 'child_process';
import { get as httpGet } from 'http';
import { get as httpsGet } from 'https';
import { join, dirname, extname, isAbsolute, relative, resolve, basename } from 'path';
import { fileURLToPath } from 'url';
import { readFile, readdir, stat, writeFile, mkdir, copyFile, unlink, rename, rm, realpath, lstat } from 'fs/promises';
import { createWriteStream, existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { ComfyUITool, on, AgentEventTypes, configureSkills } from '../src/agent/index.mjs';
import { LLMProvider, resolveLLMRouting } from '../src/agent/llm/provider.mjs';
import { PreferenceMemory } from '../src/agent/memory/preference.mjs';
import { ComfyUIClient } from '../src/agent/tools/comfyui/client.mjs';
import { ComfyUIManager, hasPortableLayout, findPortableRoot } from './comfyui-manager.mjs';
import { sanitizeContextValue } from '../src/agent/schemas/context-sanitizer.mjs';
import { normalizeUIPreferences } from '../src/ui-preferences.mjs';
import { DirectService } from '../src/runtime/direct/direct-service.mjs';
import { ComfyExecutor } from '../src/runtime/executor/comfy-executor.mjs';
import { AgentProcessClient } from './agent-process.mjs';
import { ExecutionCoordinator } from './execution-coordinator.mjs';
import { SANDBOX_AUTHORIZED_FILES, resolveSandboxPath } from '../src/agent/security/sandbox.mjs';
import { normalizeAssetPath, projectAssetRoot, removeEmptyAssetDirectories, scanProjectAssets } from '../src/runtime/project-assets.mjs';
import { displayPath } from '../src/runtime/path-display.mjs';
import { directGenerationRequest } from '../src/runtime/generation-contract.mjs';
import { traceError, validateTaskTrace } from '../src/runtime/trace-contract.mjs';
import { RequestLedger } from './request-ledger.mjs';

const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = pkg;

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_NAME = 'ComfyUI 智能创作台';
const APP_ID = 'com.comfyui.agent';
const USER_DATA_DIR_NAME = 'comfy-agent';
const APP_ICON_PATH = join(__dirname, 'icon.ico');
const DEFAULT_BASE_URL = 'http://127.0.0.1:8188';
const portableRootPath = join(__dirname, '..', 'comfyui-root.txt');
const appRoot = dirname(__dirname);

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
let agent;
let agentReadyPromise;
let agentEventUnsubscribers = [];
let directService;
let prefStore;
const authorizedMediaPaths = new Set();
const executionCoordinator = new ExecutionCoordinator();
const requestLedger = new RequestLedger();

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
    projectId,
    sessionId,
    projectDir: project?.dir || '',
    workflowDir: input.workflowDir || agent?.workflowDir || getDefaultWorkflowDir(),
  };
}

function assertExecutionAvailable() {
  executionCoordinator.assertAvailable();
}

function listWorkflowFiles(dir) {
  if (!isDirectoryPath(dir)) return [];
  const files = [];
  function collect(currentDir, prefix = '') {
    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      const relativeName = join(prefix, entry.name);
      const filePath = join(currentDir, entry.name);
      if (entry.isDirectory()) collect(filePath, relativeName);
      else if (entry.name.toLowerCase().endsWith('.json') && !entry.name.toLowerCase().includes('backup')) files.push(relativeName);
    }
  }
  collect(dir);
  return files.sort((a, b) => a.localeCompare(b));
}

function directSandboxInput() {
  const project = agent?.sessionManager.getActiveProject?.();
  const allowedRoots = project?.dir ? [{ name: 'project', path: project.dir }] : [];
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
    staged.push({ filename: basename(file.filename), source: sourcePath });
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
  if (owner.projectId && agent?.sessionManager.activeProjectId !== owner.projectId) {
    throw new Error('Generation owner session is no longer active');
  }
  if (owner.sessionId && agent?.sessionManager.activeSessionId !== owner.sessionId) {
    throw new Error('Generation owner session is no longer active');
  }
  if (result?.source === 'direct' && agent?.project && result.compiledPrompt) {
    await agent.project.set('lastPrompt', result.compiledPrompt.positive || '');
    await agent.project.set('lastCompiledPrompt', {
      positive: result.compiledPrompt.positive || '',
      negative: result.compiledPrompt.negative || '',
      tags: [],
      narrative: '',
      constraints: {},
    });
    await agent.project.set('lastGenerationSource', result.source);
  }
  if ((!result?.images?.length && !result?.videos?.length) || !comfyManager.portableRoot) return result;
  const project = agent?.sessionManager.getProject(owner.projectId || agent?.sessionManager.activeProjectId);
  if (owner.projectId && agent?.sessionManager.activeProjectId !== owner.projectId) {
    throw new Error('Generation owner session is no longer active');
  }
  if (!project?.dir) return result;
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
    projectId: project.id,
    sessionId: ownerSessionId,
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
    projectId: project.id,
    sessionId: ownerSessionId,
  }));
  if (result.isVideoWorkflow && (result.videos?.length || 0) === 0 && (result.images?.length || 0) > 1) {
    try {
      const { composeVideo } = await import('../src/agent/video/video-compose.mjs');
      const frameFiles = readdirSync(imageDir)
        .filter(name => /\.(png|jpe?g|webp)$/i.test(name))
        .sort();
      if (frameFiles.length > 1) {
        const videoFilename = `${taskId}.mp4`;
        await composeVideo({
          frames: frameFiles.map(file => ({ path: join(imageDir, file) })),
          outputPath: join(videoDir, videoFilename),
          fps: 24,
        });
        archivedVideos.push({
          filename: videoFilename,
          subfolder: join('videos', taskId),
          type: 'project',
          projectId: project.id,
          sessionId: ownerSessionId,
        });
      }
    } catch (error) {
      console.warn(`帧序列合成失败：${error.message}`);
    }
  }
  if (archived.length === 0 && archivedVideos.length === 0) return result;
  if (archived.length > 0) await agent.project.set('lastImages', archived);
  const existingAssets = (agent.project.get('assets') || []).filter(asset => asset.taskId !== taskId);
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
  await agent.project.set('assets', assets);
  const archivedResult = { ...result, images: archived };
  if (archivedVideos.length > 0) archivedResult.videos = archivedVideos;
  await persistTaskTrace(result.taskId, archivedResult);
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
    return validateTaskTrace(trace, taskId, project.id);
  }
  const trace = await agent.getTrace(taskId);
  if (!trace) throw traceError('trace_not_found', 'Trace not found');
  return validateTaskTrace(trace, taskId, project.id);
}

function directTaskId(requestId = '') {
  return `direct_task_${requestId}_${Math.random().toString(36).slice(2, 8)}`;
}

async function createDirectTask(preview) {
  const taskId = directTaskId(preview.requestId);
  if (!agent?.taskManager) return taskId;
  await agent.taskManager.create({
    id: taskId,
    requestId: preview.requestId,
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

function updateDirectTask(taskId, state, patch = {}) {
  if (!taskId || !agent?.taskManager?.get(taskId)) return;
  const task = agent.taskManager.get(taskId);
  if (state === 'executing' && ['failed', 'cancelled'].includes(task.state)) {
    agent.taskManager.transition(taskId, 'classifying');
  }
  agent.taskManager.transition(taskId, state, patch);
  void agent.taskManager.persist();
}

function completeDirectTask(taskId, result = {}, error = null) {
  if (!taskId || !agent?.taskManager?.get(taskId)) return;
  const task = agent.taskManager.get(taskId);
  const state = error ? 'failed' : result.cancelled ? 'cancelled' : 'completed';
  if (!error && !result.cancelled && task.state === 'executing') updateDirectTask(taskId, 'observing', { promptId: result.promptId || task.promptId || '' });
  if (task.state !== state) updateDirectTask(taskId, state, { promptId: result.promptId || task.promptId || '' });
  agent.taskManager.complete(taskId, { result, error });
  void agent.taskManager.persist();
  void persistTaskTrace(taskId, result).catch(() => {});
}

async function confirmLegacyExecution(detail) {
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: '执行确认',
    message: '此操作将提交 ComfyUI 生成任务',
    detail,
    buttons: ['取消', '确认并执行'],
    defaultId: 0,
    cancelId: 0,
  });
  return result.response === 1;
}

function sendToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
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
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', () => {
    if (process.platform !== 'darwin') comfyManager.stopOwned();
  });
  mainWindow.on('closed', () => {
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

function initAgent(config) {
  const llmConfig = config.llm || {};
  for (const unsubscribe of agentEventUnsubscribers) unsubscribe();
  agentEventUnsubscribers = [];
  agent = new AgentProcessClient({
    workflowDir: getWorkflowDir(config),
    onStderr: message => console.error(`[agent] ${message}`),
  });
  ensureDirectService().setWorkflowDir(agent.workflowDir);
  bindAgentEvent(AgentEventTypes.STATUS, (data) => {
    sendToRenderer('agent:status', data);
    if (['completed', 'failed', 'error', 'cancelled'].includes(data.status) && data.taskId) {
      void persistTaskTrace(data.taskId).catch(() => {});
    }
  });
  bindAgentEvent(AgentEventTypes.STEP, (data) => sendToRenderer('agent:step', data));
  bindAgentEvent(AgentEventTypes.TOOL_CALL, (data) => sendToRenderer('agent:tool-call', data));
  bindAgentEvent(AgentEventTypes.TOOL_RESULT, (data) => sendToRenderer('agent:tool-result', data));
  bindAgentEvent(AgentEventTypes.MESSAGE, (data) => sendToRenderer('agent:message', data));
  bindAgentEvent(AgentEventTypes.ERROR, (data) => sendToRenderer('agent:error', data));
  bindAgentEvent(AgentEventTypes.PLAN, (data) => sendToRenderer('agent:plan', data));
  bindAgentEvent(AgentEventTypes.TASK, (data) => sendToRenderer('agent:task', data));
  bindAgentEvent(AgentEventTypes.TRACE, (data) => sendToRenderer('agent:trace', data));
  bindAgentEvent(AgentEventTypes.PROGRESS, (data) => sendToRenderer('agent:progress', data));
  bindAgentEvent(AgentEventTypes.FEEDBACK, (data) => sendToRenderer('agent:feedback', data));
  configureSkills({ systemEnabled: config.skills?.system, custom: config.skills?.custom });
  const started = agent.start({
    llm: llmConfig,
    research: config.research || {},
    workflowDir: getWorkflowDir(config),
    comfyRoot: comfyManager.portableRoot ? join(comfyManager.portableRoot, 'ComfyUI') : '',
    userDataPath: app.getPath('userData'),
    comfyBaseUrl: config.comfyui?.baseUrl || 'http://127.0.0.1:8188',
    skills: config.skills || {},
  });
  return started.then(async result => {
    await requestLedger.load(join(app.getPath('userData'), 'agent-data', 'request-ledger.json'));
    return result;
  });
}

function bindAgentEvent(type, handler) {
  agentEventUnsubscribers.push(on(type, handler));
}

function startAgent(config) {
  if (agentReadyPromise) return agentReadyPromise;
  if (agent) return Promise.resolve(agent);

  const promise = initAgent(config)
    .then(() => {
      syncProjectPreferences();
      return agent;
    })
    .catch(error => {
      console.error(`Agent initialization failed: ${error.stack || error.message}`);
      void agent?.stop?.();
      agent = null;
      sendToRenderer('agent:error', { message: error.message, code: error.code || 'AGENT_INIT_FAILED' });
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
  const recovered = await agent.recoverTasks?.() || [];
  for (const item of recovered) {
    if (item.status !== 'completed' || !item.history) continue;
    try {
      const result = await ComfyUITool.recoverResult(item.promptId, item.history);
      const task = agent.taskManager.get(item.taskId);
      const archived = await archiveProjectResult({ ...result, taskId: item.taskId, promptId: item.promptId }, {
        projectId: task?.projectId,
        sessionId: task?.sessionId,
      });
      agent.taskManager.complete(item.taskId, { result: archived });
      await agent.taskManager.persist();
    } catch (error) {
      const task = agent.taskManager.get(item.taskId);
      if (task) {
        agent.taskManager.update(item.taskId, { state: 'archive_failed', status: 'archive_failed', lastError: error.message, error: error.message });
        await agent.taskManager.persist();
      }
    }
  }
  return recovered;
}

function applyComfyConfig(config) {
  const baseUrl = envConfig.COMFYUI_BASE_URL || config?.comfyui?.baseUrl || DEFAULT_BASE_URL;
  ComfyUITool.setClient(new ComfyUIClient({ baseUrl }));
  comfyManager.setBaseUrl(baseUrl);
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
          request(new URL(response.headers.location, currentUrl).toString(), redirects + 1);
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

ipcMain.handle('select-media-files', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    title: '选择参考素材',
    filters: [
      { name: '图片和视频', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'mp4', 'webm', 'mov', 'mkv', 'avi'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  if (result.canceled) return [];
  const videoExtensions = new Set(['.mp4', '.webm', '.mov', '.mkv', '.avi']);
  for (const filePath of result.filePaths) authorizedMediaPaths.add(filePath);
  return result.filePaths.map(filePath => ({
    path: filePath,
    name: basename(filePath),
    kind: videoExtensions.has(extname(filePath).toLowerCase()) ? 'video' : 'image',
  }));
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
  };
}

ipcMain.handle('agent:run', async (_, { message, workflowName, clientId, controls = {} }) => {
  await startAgent(getStoredConfig());
  const comfyState = await comfyManager.ensureStarted();
  if (comfyState.status !== 'ready') throw new Error(comfyState.message || 'ComfyUI \u672a\u5c31\u7eea');
  const owner = executionOwner();
  return executionCoordinator.execute({
    source: 'ai',
    owner,
    work: async () => {
      const options = generationOptions(clientId, controls);
      const preview = workflowName
        ? await agent.prepareWithWorkflow(message, workflowName, options)
        : await agent.prepareGeneration(message, options);
      if (preview?.action === 'clarify' || preview?.action === 'queued') return preview;
      const detail = (preview.confirmation?.actions || []).map(action => action.label + (action.detail ? '?' + action.detail : '')).join('\n');
      if (!await confirmLegacyExecution(detail || '\u63d0\u4ea4\u751f\u6210\u4efb\u52a1')) {
        await agent.discardPrepared(preview.previewId);
        await persistTaskTrace(agent.taskId);
        return { cancelled: true, taskId: agent.taskId };
      }
      return archiveProjectResult(await agent.runPrepared(preview.previewId), owner);
    },
  });
});

ipcMain.handle('agent:prepare', async (_, { message, workflowName, clientId, controls = {} }) => {
  await startAgent(getStoredConfig());
  const comfyState = await comfyManager.ensureStarted();
  if (comfyState.status !== 'ready') throw new Error(comfyState.message || 'ComfyUI is not ready');
  const owner = executionOwner();
  const requestId = controls.requestId || `ai_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const fingerprint = JSON.stringify({ source: 'ai', message, workflowName, controls });
  const existing = requestLedger.begin(requestId, { source: 'ai', fingerprint });
  if (existing.preview) return existing.preview;
  return executionCoordinator.execute({
    source: 'ai',
    owner,
    work: async entry => {
       const options = { ...generationOptions(clientId, controls), requestId };
      const preview = workflowName
        ? await agent.prepareWithWorkflow(message, workflowName, options)
        : await agent.prepareGeneration(message, options);
      if (preview?.previewId) {
        requestLedger.update(requestId, { state: 'prepared', taskId: agent.taskId, previewId: preview.previewId, preview });
        executionCoordinator.registerPreview({
          source: 'ai',
          previewId: preview.previewId,
          taskId: agent.taskId,
          owner,
          entry,
        });
      }
      return preview;
    },
  });
});

ipcMain.handle('agent:generate', async (_, { message, workflowName, clientId, controls = {} }) => {
  await startAgent(getStoredConfig());
  const comfyState = await comfyManager.ensureStarted();
  if (comfyState.status !== 'ready') throw new Error(comfyState.message || 'ComfyUI is not ready');
  const owner = executionOwner();
  const requestId = controls.requestId || `ai_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const fingerprint = JSON.stringify({ source: 'ai', message, workflowName, controls });
  const existing = requestLedger.begin(requestId, { source: 'ai', fingerprint });
  if (existing.preview) return existing.preview;
  return executionCoordinator.execute({
    source: 'ai',
    owner,
    work: async entry => {
       const preview = await agent.prepareGeneration(message, {
         ...generationOptions(clientId, controls),
         requestId,
        workflowName,
      });
      if (preview?.previewId) {
        requestLedger.update(requestId, { state: 'prepared', taskId: agent.taskId, previewId: preview.previewId, preview });
        executionCoordinator.registerPreview({
          source: 'ai',
          previewId: preview.previewId,
          taskId: agent.taskId,
          owner,
          entry,
        });
      }
      return preview;
    },
  });
});

ipcMain.handle('direct:prepare', async (_, { request = {} } = {}) => {
  const comfyState = await comfyManager.ensureStarted();
  if (comfyState.status !== 'ready') throw new Error(comfyState.message || 'ComfyUI is not ready');
  const normalized = directGenerationRequest({
    ...request,
    projectId: request.projectId || agent?.sessionManager.activeProjectId,
    sessionId: request.sessionId || agent?.sessionManager.activeSessionId,
  });
  const owner = executionOwner(normalized);
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
  const existing = requestLedger.begin(normalized.requestId, { source: 'direct', fingerprint });
  if (existing.preview) return existing.preview;
  service.setWorkflowDir(owner.workflowDir);
  return executionCoordinator.execute({
    source: 'direct',
    taskId: normalized.requestId,
    owner,
    work: async entry => {
      let preview;
      try {
        preview = await service.prepare(normalized, { sandboxInput: directSandboxInput() });
        preview.taskId = await createDirectTask(preview);
        requestLedger.update(normalized.requestId, { state: 'prepared', taskId: preview.taskId, previewId: preview.previewId, preview });
        await agent?.recordConversationMessage?.('user', normalized.positive || '', {
          intent: 'generate',
          action: 'prepare',
          turnId: normalized.turnId || '',
          attachments: [...(normalized.media?.images || []), ...(normalized.media?.videos || [])],
        });
        executionCoordinator.registerPreview({
          source: 'direct',
          previewId: preview.previewId,
          taskId: normalized.requestId,
          owner,
          entry,
        });
        return preview;
      } catch (error) {
        service.discardPreview('direct_preview_' + normalized.requestId);
        completeDirectTask(preview?.taskId, {}, { message: error.message, stage: 'direct_prepare' });
        requestLedger.fail(normalized.requestId, error);
        throw error;
      }
    },
  });
});

ipcMain.handle('direct:get-preview', async (_, { previewId } = {}) => ensureDirectService().getPreview(previewId) || null);

ipcMain.handle('direct:run-prepared', async (_, { previewId, edits = {}, options = {} } = {}) => {
  const comfyState = await comfyManager.ensureStarted();
  if (comfyState.status !== 'ready') throw new Error(comfyState.message || 'ComfyUI is not ready');
  const service = ensureDirectService();
  const preview = service.getPreview(previewId);
  if (!preview) throw new Error('Direct generation preview expired; prepare it again');
  const owner = executionOwner(preview);
  const requestId = preview.requestId || '';
  const taskId = preview.taskId || requestId;
  const ledgerEntry = requestLedger.get(requestId);
  if (ledgerEntry?.state === 'completed') return ledgerEntry.result;
  if (ledgerEntry?.state === 'executing') return requestLedger.snapshot(requestId);
  requestLedger.update(requestId, { state: 'executing', taskId, previewId });
  const directContext = { projectId: owner.projectId, sessionId: owner.sessionId, taskId };
  return executionCoordinator.execute({
    source: 'direct',
    taskId,
    owner,
    previewId,
    cancel: () => service.cancel(),
    work: async entry => {
      updateDirectTask(taskId, 'executing', { currentStep: 'comfyui', currentAttempt: 1 });
      sendToRenderer('direct:status', {
        source: 'direct',
        requestId,
        ...directContext,
        status: 'running',
        uiStatus: 'running',
        message: '\u6b63\u5728\u6267\u884c\u539f\u6587\u63d0\u793a\u8bcd',
      });
      try {
        const result = await service.run(previewId, edits, {
          clientId: options.clientId || '',
          onProgress: progress => {
            if (progress.promptId) updateDirectTask(taskId, 'executing', { promptId: progress.promptId });
            sendToRenderer('direct:progress', { ...progress, source: 'direct', requestId, ...directContext });
          },
        });
        const taskResult = { ...result, taskId };
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
        const archived = await archiveProjectResult(taskResult, owner);
        completeDirectTask(taskId, archived);
        requestLedger.complete(requestId, archived);
        await agent?.recordConversationMessage?.('agent', 'Generated ' + (archived.images?.length || 0) + ' image(s).', {
          kind: 'completed',
          images: archived.images || [],
          prompt: edits.positive || preview.positive || '',
          negative: edits.negative || preview.negative || '',
          turnId: preview.turnId || '',
        });
        sendToRenderer('direct:status', {
          source: 'direct',
          requestId,
          ...directContext,
          status: 'completed',
          uiStatus: 'idle',
          message: '\u76f4\u63a5\u751f\u6210\u5df2\u5b8c\u6210',
        });
        return archived;
      } catch (error) {
        const status = entry.cancelRequested ? 'cancelled' : 'failed';
        sendToRenderer('direct:status', {
          source: 'direct',
          requestId,
          ...directContext,
          status,
          uiStatus: status === 'cancelled' ? 'idle' : 'error',
          message: status === 'cancelled' ? '\u76f4\u63a5\u751f\u6210\u5df2\u53d6\u6d88' : error.message,
        });
        if (entry.cancelRequested) {
          const cancelled = { cancelled: true, taskId, source: 'direct' };
          completeDirectTask(taskId, cancelled);
          requestLedger.update(requestId, { state: 'cancelled', result: cancelled });
          return cancelled;
        }
        completeDirectTask(taskId, {}, { message: error.message, stage: 'direct' });
        requestLedger.fail(requestId, error);
        throw error;
      }
    },
  });
});

ipcMain.handle('direct:discard-preview', async (_, { previewId } = {}) => {
  const service = ensureDirectService();
  const preview = service.getPreview(previewId);
  const discarded = service.discardPreview(previewId);
  if (discarded && preview?.taskId) completeDirectTask(preview.taskId, { cancelled: true, taskId: preview.taskId });
  if (discarded && preview?.requestId) requestLedger.update(preview.requestId, { state: 'cancelled' });
  executionCoordinator.discardPreview(previewId);
  return { discarded };
});

ipcMain.handle('direct:cancel', async () => {
  const entry = executionCoordinator.active;
  const result = await executionCoordinator.cancel({ source: 'direct', taskId: entry?.taskId || '' });
  if (result.cancelled && entry) {
    sendToRenderer('direct:status', {
      source: 'direct',
      requestId: entry.taskId,
      taskId: entry.taskId,
      ...entry.owner,
      status: 'cancelled',
      uiStatus: 'idle',
      message: '\u76f4\u63a5\u751f\u6210\u5df2\u53d6\u6d88',
    });
  }
  return result;
});

ipcMain.handle('agent:send', async (_, { message, workflowName, workflowManifest, controls = {} }) => {
  await startAgent(getStoredConfig());
  const owner = executionOwner();
  return executionCoordinator.execute({
    source: 'ai',
    owner,
    work: async entry => {
      const media = controls.media || null;
      const decision = await agent.routeIntent(message, { media, workflowManifest });
      if (decision.intent === 'cancel') {
        await agent.cancel();
        return { action: 'chat', decision, result: { response: '\u5df2\u53d6\u6d88\u5f53\u524d\u4efb\u52a1\u3002' } };
      }
      if (decision.action === 'clarify') {
        return { action: 'clarify', decision, result: await agent.clarify(message, decision) };
      }
      if (decision.action === 'reply') {
        return {
          action: 'chat',
          decision,
          result: await agent.chat(message, { workflowName, workflowManifest, intent: decision.intent, media: controls.media || null }),
        };
      }

      const comfyState = await comfyManager.ensureStarted();
      if (comfyState.status !== 'ready') throw new Error(comfyState.message || 'ComfyUI is not ready');
      const options = generationOptions(controls.clientId || '', {
        ...controls,
        workflowManifest,
        intent: decision.intent,
        effectiveRequest: decision.request || message,
        readiness: decision.readiness || null,
      });
      const preview = workflowName
        ? await agent.prepareWithWorkflow(message, workflowName, options)
        : await agent.prepareGeneration(message, options);
      if (preview?.action === 'clarify' || preview?.action === 'queued') {
        return { action: preview.action, decision: { ...decision, ...preview }, result: preview, preview };
      }
      if (preview?.previewId) {
        executionCoordinator.registerPreview({
          source: 'ai',
          previewId: preview.previewId,
          taskId: agent.taskId,
          owner,
          entry,
        });
      }
      return { action: 'generate', decision, preview };
    },
  });
});

ipcMain.handle('agent:turn', async (_, turn = {}) => {
  await startAgent(getStoredConfig());
  const owner = executionOwner({ sessionId: turn.sessionId });
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
      const response = await agent.handleTurn({
        text: turn.text || '',
        modeHint: turn.modeHint === 'generate' ? 'generate' : 'answer',
        media: turn.media || null,
        workflowName: turn.workflowName || '',
        workflowManifest: turn.workflowManifest || null,
        sessionId: turn.sessionId || agent.sessionManager.activeSessionId,
        turnId: turn.turnId || '',
        recordConfirmation: turn.recordConfirmation !== false,
        confirmation: turn.confirmation || {},
      });
      if (response?.action === 'prepare' && response.preview?.previewId) {
        executionCoordinator.registerPreview({
          source: 'ai',
          previewId: response.preview.previewId,
          taskId: response.preview.taskId || agent.taskId,
          owner,
          entry,
        });
      }
      if (response?.action === 'execute' && response.result) {
        const result = { ...response, result: await archiveProjectResult(response.result, owner) };
        if (requestId) requestLedger.complete(requestId, result);
        return result;
      }
      if (requestId && response?.action === 'prepare' && response.preview?.previewId) {
        requestLedger.begin(requestId, { source: 'ai', previewId: response.preview.previewId });
        requestLedger.update(requestId, { state: 'prepared', taskId: response.preview.taskId || agent.taskId, previewId: response.preview.previewId, preview: response.preview });
      }
      return response;
    },
  });
});

ipcMain.handle('agent:get-request-status', async (_, { requestId = '' } = {}) => requestLedger.snapshot(requestId));

ipcMain.handle('agent:run-prepared', async (_, { previewId, edits = {} }) => {
  if (!agent) throw new Error('Agent is not initialized');
  const comfyState = await comfyManager.ensureStarted();
  if (comfyState.status !== 'ready') throw new Error(comfyState.message || 'ComfyUI is not ready');
  const pending = executionCoordinator.getPreview(previewId);
  const owner = pending?.owner || executionOwner();
  return executionCoordinator.execute({
    source: 'ai',
    taskId: pending?.taskId || agent.taskId,
    owner,
    previewId: pending ? previewId : '',
    cancel: taskId => agent.cancel(taskId || ''),
    work: async () => {
      if (!await confirmLegacyExecution('\u63d0\u4ea4\u5df2\u51c6\u5907\u7684 agent \u4efb\u52a1')) {
        await agent.discardPrepared(previewId);
        return { cancelled: true };
      }
      return archiveProjectResult(await agent.runPrepared(previewId, edits), owner);
    },
  });
});

ipcMain.handle('agent:discard-preview', async (_, { previewId }) => {
  executionCoordinator.discardPreview(previewId);
  const result = agent ? await agent.discardPrepared(previewId) : { discarded: false };
  if (result.discarded && agent?.taskId) await persistTaskTrace(agent.taskId);
  return result;
});

ipcMain.handle('agent:chat', async (_, { message, workflowName, workflowManifest, controls = {} }) => {
  await startAgent(getStoredConfig());
  const owner = executionOwner();
  return executionCoordinator.execute({
    source: 'ai',
    owner,
    work: () => agent.chat(message, { workflowName, workflowManifest, media: controls.media || null, intent: controls.intent || 'chat' }),
  });
});

ipcMain.handle('agent:clear-conversation', async () => {
  if (agent) return agent.clearConversation();
  return { cleared: false };
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
  if (agent) return agent.listTasks(50);
  return [];
});

ipcMain.handle('agent:get-trace', async (_, { taskId }) => readTaskTrace(taskId));

ipcMain.handle('agent:recover-tasks', async () => recoverAgentTasks());

ipcMain.handle('agent:retry-recovery', async (_, { taskId } = {}) => {
  const task = agent?.taskManager?.get(taskId);
  if (!task) throw new Error('Task not found');
  const promptId = task.promptId || task.attempts?.find(attempt => attempt.promptId)?.promptId;
  if (!promptId) return {
    status: 'submit_unknown',
    taskId,
    requiresConfirmation: true,
    message: '提交状态未知，未发现 promptId。请在 ComfyUI 队列/历史中确认后再重试，系统不会自动重复提交。',
  };
  const result = await ComfyUITool.monitor(promptId);
  if (result.status !== 'completed') return result;
  const recovered = await ComfyUITool.recoverResult(promptId, result.history);
  try {
    const archived = await archiveProjectResult({ ...recovered, taskId, promptId }, { projectId: task.projectId, sessionId: task.sessionId });
    agent.taskManager.complete(taskId, { result: archived });
    await agent.taskManager.persist();
    return { status: 'completed', result: archived };
  } catch (error) {
    agent.taskManager.update(taskId, { state: 'archive_failed', status: 'archive_failed', lastError: error.message, error: error.message });
    await agent.taskManager.persist();
    throw error;
  }
});

ipcMain.handle('agent:cancel', async (_, { taskId } = {}) => {
  const entry = executionCoordinator.active;
  if (entry?.source === 'ai') {
    return executionCoordinator.cancel({
      source: 'ai',
      taskId: taskId || '',
      cancel: () => agent.cancel(taskId || ''),
    });
  }
  if (agent) return agent.cancel(taskId || '');
  return { cancelled: false };
});

ipcMain.handle('agent:remove-conversation-turn', async (_, { turnId } = {}) => {
  if (!agent || !turnId) return { removed: 0 };
  return agent.removeConversationTurn(turnId);
});

ipcMain.handle('queue:list', async () => agent ? agent.listQueue() : { error: 'agent not ready' });

ipcMain.handle('queue:cancel-prompt', async (_, { promptId }) => {
  if (!agent) return { error: 'agent not ready' };
  try {
    return await agent.cancelPrompt(promptId);
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('queue:clear', async () => {
  if (!agent) return { error: 'agent not ready' };
  try {
    return await agent.clearQueue();
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
    llm: config.llm || { provider: 'openai-compatible', baseUrl: '', model: '' },
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
  const state = await agent.createProject(input);
  syncProjectPreferences();
  return state;
});

ipcMain.handle('projects:rename', async (_, { projectId, name }) => {
  await agent.sessionManager.renameProject(projectId, name);
  syncProjectPreferences();
  return agent.sessionManager.getState();
});

ipcMain.handle('projects:delete', async (_, { projectId }) => {
  if (executionCoordinator.isBusy) throw new Error('当前会话仍有直接生成任务或待确认预览，请先取消后再删除会话');
  const state = await agent.deleteProject(projectId);
  syncProjectPreferences();
  return state;
});

ipcMain.handle('sessions:list', async (_, { projectId } = {}) => {
  const project = agent?.sessionManager.getProject(projectId || agent.sessionManager.activeProjectId);
  return project?.sessions || [];
});

ipcMain.handle('sessions:create', async (_, { title, projectId } = {}) => {
  if (executionCoordinator.isBusy) throw new Error('当前会话仍有直接生成任务或待确认预览，请先取消后再切换会话');
  await agent.createSession(title, projectId);
  return agent.sessionManager.getState();
});

ipcMain.handle('sessions:delete', async (_, { sessionId, projectId } = {}) => {
  if (executionCoordinator.isBusy) throw new Error('当前会话仍有直接生成任务或待确认预览，请先取消后再删除会话');
  return agent.deleteSession(sessionId, projectId);
});

ipcMain.handle('sessions:rename', async (_, { sessionId, title, projectId } = {}) => {
  return agent.sessionManager.renameSession(sessionId, title, projectId);
});

ipcMain.handle('session:activate', async (_, { projectId, sessionId }) => {
  if (executionCoordinator.isBusy) throw new Error('当前会话仍有直接生成任务或待确认预览，请先取消后再切换会话');
  return agent.useSession(projectId, sessionId);
});

ipcMain.handle('llm:providers', async () => {
  const llm = prefStore.get('llm');
  return { ...llm, resolved: resolveLLMRouting(llm) };
});

ipcMain.handle('llm:save-provider', async (_, { provider }) => {
  if (!/^[a-z0-9_-]+$/.test(provider?.id || '')) throw new Error('提供商 ID 仅支持小写字母、数字、下划线和连字符');
  const llm = prefStore.get('llm');
  const { apiKeyError, ...providerConfig } = provider;
  const normalized = {
    ...providerConfig,
    type: provider.type || 'openai-compatible',
    headers: provider.headers && typeof provider.headers === 'object' ? provider.headers : {},
    models: Array.isArray(provider.models) ? provider.models.filter(model => model.id) : [],
  };
  const index = llm.providers.findIndex(item => item.id === normalized.id);
  if (index >= 0) llm.providers[index] = normalized;
  else llm.providers.push(normalized);
  if (!llm.active.providerId) {
    llm.active.providerId = normalized.id;
    llm.active.modelId = normalized.models[0]?.id || '';
  }
  prefStore.set('llm', llm);
  await agent?.reconfigureLLM(llm);
  return llm;
});

ipcMain.handle('llm:delete-provider', async (_, { providerId }) => {
  const llm = prefStore.get('llm');
  if (llm.providers.length === 1) throw new Error('至少保留一个提供商');
  llm.providers = llm.providers.filter(item => item.id !== providerId);
  if (llm.active.providerId === providerId) {
    llm.active.providerId = llm.providers[0].id;
    llm.active.modelId = llm.providers[0].models?.[0]?.id || '';
  }
  prefStore.set('llm', llm);
  await agent?.reconfigureLLM(llm);
  return llm;
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
    const modelId = selection.modelId || provider.models?.[0]?.id || '';
    if (!provider.models?.some(item => item.id === modelId)) throw new Error('模型不存在');
    active.providerId = provider.id;
    active.modelId = modelId;
  }
  if (selection.reasoningEffort) {
    if (!['low', 'medium', 'high'].includes(selection.reasoningEffort)) throw new Error('无效推理强度');
    active.reasoningEffort = selection.reasoningEffort;
  }
  llm.active = active;
  prefStore.set('llm', llm);
  await agent?.reconfigureLLM(llm);
  return llm;
});

ipcMain.handle('llm:test', async (_, { providerId, modelId }) => {
  const llm = prefStore.get('llm');
  const testConfig = { ...llm, active: { providerId, modelId, reasoningEffort: llm.active.reasoningEffort, strategy: 'manual' } };
  const provider = new LLMProvider(testConfig);
  if (!provider.isConfigured) throw new Error('请先填写模型连接信息');
  const result = await provider.chat({ messages: [{ role: 'user', content: 'Reply with OK only.' }], maxTokens: 8 });
  return { ok: true, message: result.content || 'OK' };
});

ipcMain.handle('skills:list', async () => prefStore.get('skills'));

ipcMain.handle('skills:set-enabled', async (_, { id, enabled, custom = false }) => {
  const skills = prefStore.get('skills');
  if (custom) {
    const skill = skills.custom.find(item => item.id === id);
    if (!skill) throw new Error('技能不存在');
    skill.enabled = Boolean(enabled);
  } else {
    if (!(id in skills.system)) throw new Error('系统技能不存在');
    skills.system[id] = Boolean(enabled);
  }
  prefStore.set('skills', skills);
  configureSkills({ systemEnabled: skills.system, custom: skills.custom });
  return skills;
});

ipcMain.handle('skills:add-custom', async (_, { skill }) => {
  if (!/^[a-z0-9_-]+$/.test(skill?.id || '')) throw new Error('技能 ID 格式无效');
  const skills = prefStore.get('skills');
  if (skills.custom.some(item => item.id === skill.id) || skill.id in skills.system) throw new Error('技能 ID 已存在');
  skills.custom.push({ ...skill, keywords: Array.isArray(skill.keywords) ? skill.keywords : [], enabled: skill.enabled !== false });
  prefStore.set('skills', skills);
  configureSkills({ systemEnabled: skills.system, custom: skills.custom });
  return skills;
});

ipcMain.handle('skills:delete-custom', async (_, { id }) => {
  const skills = prefStore.get('skills');
  skills.custom = skills.custom.filter(item => item.id !== id);
  prefStore.set('skills', skills);
  configureSkills({ systemEnabled: skills.system, custom: skills.custom });
  return skills;
});

ipcMain.handle('agent:prompt-mode', async (_, { mode }) => {
  if (agent) await agent.setPromptMode(mode);
  return { mode };
});

ipcMain.handle('project:update-state', async (_, patch = {}) => {
  if (!agent) return null;
  await agent.call('project.update', [patch]);
  return agent.sessionManager.getState();
});

ipcMain.handle('ui:preferences', async () => normalizeUIPreferences(prefStore.get('ui')));

ipcMain.handle('ui:save-preferences', async (_, preferences = {}) => {
  const normalized = normalizeUIPreferences(preferences);
  prefStore.set('ui', normalized);
  return normalized;
});

ipcMain.handle('research:settings', async () => {
  const research = prefStore.get('research') || {};
  return { baiduApiKey: research.baiduApiKey || '' };
});

ipcMain.handle('research:save-settings', async (_, settings = {}) => {
  const research = prefStore.get('research') || {};
  prefStore.set('research', {
    ...research,
    baiduApiKey: String(settings.baiduApiKey || '').trim(),
  });
  await agent?.reconfigureResearch(prefStore.get('research') || {});
  return { baiduApiKey: prefStore.get('research')?.baiduApiKey || '' };
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
  return ComfyUITool.inspectWorkflow(workflowName, workflowDir);
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
  return comfyManager.getState();
});

ipcMain.handle('comfyui:set-base-url', async (_, { baseUrl = '' } = {}) => {
  const normalized = comfyManager.setBaseUrl(baseUrl || DEFAULT_BASE_URL);
  ComfyUITool.setClient(new ComfyUIClient({ baseUrl: normalized }));
  prefStore.set('comfyui', { ...prefStore.get('comfyui'), baseUrl: normalized });
  return comfyManager.refreshState();
});

ipcMain.handle('comfyui:reset', async () => {
  comfyManager.setBaseUrl(envConfig.COMFYUI_BASE_URL || DEFAULT_BASE_URL);
  comfyManager.redetectRoot(COMFY_START_DIRS);
  prefStore.set('comfyui', { baseUrl: comfyManager.baseUrl });
  ComfyUITool.setClient(new ComfyUIClient({ baseUrl: comfyManager.baseUrl }));
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

ipcMain.handle('comfyui:recent-images', async () => getRecentImages());

ipcMain.handle('project:assets', async (_, projectId) => getProjectAssets(projectId));

ipcMain.handle('project:delete-asset', async (_, image) => deleteProjectAsset(image));

// ===== App Lifecycle =====

app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

app.whenReady().then(async () => {
  const envDataDir = resolveAppPath(envConfig.AGENT_DATA_DIR);
  const userDataPath = envDataDir || join(app.getPath('appData'), USER_DATA_DIR_NAME);
  app.setPath('userData', userDataPath);
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
  void startAgent(prefStore.getAll()).catch(() => {});
  void comfyManager.ensureStarted();
});

let quitRequested = false;

app.on('before-quit', event => {
  if (quitRequested) return;
  quitRequested = true;
  event.preventDefault();
  void (async () => {
    try { await agent?.stop?.(); } catch {}
    comfyManager.stopOwned();
    app.quit();
  })();
});

app.on('will-quit', () => {
  void agent?.stop?.();
  comfyManager.stopOwned();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
