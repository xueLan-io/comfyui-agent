import { join, basename, extname, relative, resolve, sep } from 'path';
import { readFile, writeFile, mkdir, copyFile, rm, stat, rename } from 'fs/promises';
import { normalizePresetExtensions, snapshotPreset, PRESET_SCHEMA_VERSION } from './preset-schema.mjs';
import { composePresetLayers } from './preset-compose.mjs';

const FORMAT = 'comfy-agent-preset';
const VERSION = 1;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
let writeChain = Promise.resolve();

function withWriteLock(task) {
  const next = writeChain.then(task, task);
  writeChain = next.catch(() => {});
  return next;
}

function now() { return Date.now(); }
function id() { return `preset_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`; }
function isObject(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function cleanRelative(value) { return typeof value === 'string' ? value.replaceAll('\\', '/') : ''; }
function inside(root, candidate) {
  const base = resolve(root);
  const target = resolve(candidate);
  const rel = relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(`..${sep}`) && !resolve(target).startsWith(`${base}${sep}`));
}
function assertInside(root, candidate) {
  const base = resolve(root);
  const target = resolve(candidate);
  const rel = relative(base, target);
  if (rel.startsWith('..') || rel === '..' || rel.startsWith(`..${sep}`) || target === base || !target.startsWith(`${base}${sep}`)) throw new Error('预设资源路径无效');
  return target;
}
function defaultPreset(input = {}) {
  const timestamp = now();
  return {
    id: input.id || id(),
    title: String(input.title || '未命名预设'),
    description: String(input.description || ''),
    positive: String(input.positive || ''),
    negative: String(input.negative || ''),
    cover: input.cover || null,
    sourceImages: Array.isArray(input.sourceImages) ? input.sourceImages : [],
    resultImages: Array.isArray(input.resultImages) ? input.resultImages : [],
    workflow: cleanRelative(input.workflow),
    workflowName: String(input.workflowName || ''),
    source: String(input.source || 'direct'),
    origin: String(input.origin || 'manual'),
    parameters: isObject(input.parameters) ? input.parameters : {},
    nodeOverrides: isObject(input.nodeOverrides) ? input.nodeOverrides : {},
    outputNodeIds: Array.isArray(input.outputNodeIds) ? input.outputNodeIds : null,
    modelRequirements: Array.isArray(input.modelRequirements) ? input.modelRequirements : [],
    parameterOverrides: isObject(input.parameterOverrides) ? input.parameterOverrides : {},
    versions: Array.isArray(input.versions) ? input.versions : [],
    rating: Number.isFinite(input.rating) ? input.rating : 0,
    ratingCount: Number.isFinite(input.ratingCount) ? input.ratingCount : 0,
    components: Array.isArray(input.components) ? input.components : [],
    schemaVersion: Number(input.schemaVersion) || PRESET_SCHEMA_VERSION,
    extensions: normalizePresetExtensions(input).extensions,
    tags: Array.isArray(input.tags) ? input.tags.filter(Boolean).map(String) : [],
    favorite: Boolean(input.favorite),
    usageCount: Number.isFinite(input.usageCount) ? input.usageCount : 0,
    lastUsedAt: Number.isFinite(input.lastUsedAt) ? input.lastUsedAt : 0,
    lastGeneratedAt: Number.isFinite(input.lastGeneratedAt) ? input.lastGeneratedAt : 0,
    createdAt: input.createdAt || timestamp,
    updatedAt: input.updatedAt || timestamp,
  };
}

async function ensureRoot(root) {
  await Promise.all([
    mkdir(root, { recursive: true }),
    mkdir(join(root, 'covers'), { recursive: true }),
    mkdir(join(root, 'sources'), { recursive: true }),
    mkdir(join(root, 'results'), { recursive: true }),
    mkdir(join(root, 'workflows'), { recursive: true }),
  ]);
}
async function readStore(root) {
  await ensureRoot(root);
  try {
    const value = JSON.parse(await readFile(join(root, 'presets.json'), 'utf8'));
    return Array.isArray(value) ? value.map(defaultPreset) : Array.isArray(value?.presets) ? value.presets.map(defaultPreset) : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    try {
      const backup = JSON.parse(await readFile(join(root, 'presets.json.bak'), 'utf8'));
      return Array.isArray(backup) ? backup.map(defaultPreset) : Array.isArray(backup?.presets) ? backup.presets.map(defaultPreset) : [];
    } catch { throw new Error('预设存储文件损坏，未执行保存'); }
  }
}
async function writeStore(root, presets) {
  await ensureRoot(root);
  const target = join(root, 'presets.json');
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, JSON.stringify(presets, null, 2), 'utf8');
  JSON.parse(await readFile(temporary, 'utf8'));
  try { await rm(`${target}.bak`, { force: true }); } catch {}
  try { await rename(target, `${target}.bak`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await rename(temporary, target);
  return presets;
}
function validateInput(input) {
  if (!input || typeof input !== 'object') throw new Error('预设数据无效');
  if (!String(input.positive || '').trim()) throw new Error('正向提示词不能为空');
}
function imageExtension(filePath) {
  const extension = extname(filePath).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(extension)) throw new Error('资源必须是图片文件');
  return extension;
}
async function copyResource(root, folder, presetId, sourcePath, index = 0) {
  const extension = imageExtension(sourcePath);
  const name = `${folder === 'sources' ? 'reference' : 'image'}-${String(index + 1).padStart(3, '0')}${extension}`;
  const target = join(root, folder, presetId, name);
  await mkdir(join(root, folder, presetId), { recursive: true });
  await copyFile(sourcePath, target);
  return { path: `${folder}/${presetId}/${name}`, name, kind: 'image' };
}
async function copyWorkflow(root, presetId, sourcePath) {
  if (!sourcePath) return '';
  if (extname(sourcePath).toLowerCase() !== '.json') throw new Error('工作流必须是 JSON 文件');
  JSON.parse(await readFile(sourcePath, 'utf8'));
  const name = `${presetId}.json`;
  await mkdir(join(root, 'workflows'), { recursive: true });
  await copyFile(sourcePath, join(root, 'workflows', name));
  return `workflows/${name}`;
}
async function materializeResources(root, preset, input) {
  const sourcePaths = Array.isArray(input.sourcePaths) ? input.sourcePaths : [];
  const resultPaths = Array.isArray(input.resultPaths) ? input.resultPaths : [];
  if (Array.isArray(input.sourcePaths)) preset.sourceImages = await Promise.all(sourcePaths.map((file, index) => copyResource(root, 'sources', preset.id, file, index)));
  if (Array.isArray(input.resultPaths)) preset.resultImages = await Promise.all(resultPaths.map((file, index) => copyResource(root, 'results', preset.id, file, index)));
  if (Object.prototype.hasOwnProperty.call(input, 'workflowSourcePath')) preset.workflow = input.workflowSourcePath ? await copyWorkflow(root, preset.id, input.workflowSourcePath) : '';
  if (Object.prototype.hasOwnProperty.call(input, 'coverSourcePath')) {
    if (!input.coverSourcePath) {
      preset.cover = null;
      return preset;
    }
    const extension = imageExtension(input.coverSourcePath);
    const name = `${preset.id}${extension}`;
    await mkdir(join(root, 'covers'), { recursive: true });
    await copyFile(input.coverSourcePath, join(root, 'covers', name));
    preset.cover = { path: `covers/${name}`, name };
  }
  return preset;
}
async function removePresetResources(root, preset) {
  await Promise.all([
    rm(join(root, 'sources', preset.id), { recursive: true, force: true }),
    rm(join(root, 'results', preset.id), { recursive: true, force: true }),
    rm(join(root, 'workflows', `${preset.id}.json`), { force: true }),
    ...[preset.cover?.path].filter(Boolean).map(path => rm(assertInside(root, join(root, path)), { force: true })),
  ]);
}

async function moveIfPresent(source, target) {
  try { await rename(source, target); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function backupPresetResources(root, preset) {
  const token = `${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const entries = [
    { source: join(root, 'sources', preset.id), target: join(root, 'sources', `${preset.id}.${token}.bak`) },
    { source: join(root, 'results', preset.id), target: join(root, 'results', `${preset.id}.${token}.bak`) },
    { source: join(root, 'workflows', `${preset.id}.json`), target: join(root, 'workflows', `${preset.id}.${token}.json.bak`) },
  ];
  if (preset.cover?.path) {
    const source = assertInside(root, join(root, preset.cover.path));
    entries.push({ source, target: `${source}.${token}.bak` });
  }
  const moved = [];
  try {
    for (const entry of entries) {
      if (await moveIfPresent(entry.source, entry.target)) moved.push(entry);
    }
    return moved;
  } catch (error) {
    await Promise.all(moved.reverse().map(entry => moveIfPresent(entry.target, entry.source).catch(() => {})));
    throw error;
  }
}

async function restorePresetResources(entries) {
  for (const entry of [...entries].reverse()) {
    await rm(entry.source, { recursive: true, force: true });
    await moveIfPresent(entry.target, entry.source);
  }
}

async function removeBackups(entries) {
  await Promise.all(entries.map(entry => rm(entry.target, { recursive: true, force: true })));
}

export async function listGlobalPresets(root) { return readStore(root); }
async function createGlobalPresetUnlocked(root, input) {
  validateInput(input);
  const presets = await readStore(root);
  const preset = defaultPreset(input);
  try { await materializeResources(root, preset, input); presets.unshift(preset); await writeStore(root, presets); return preset; }
  catch (error) { await removePresetResources(root, preset).catch(() => {}); throw error; }
}
export async function createGlobalPreset(root, input) {
  return withWriteLock(() => createGlobalPresetUnlocked(root, input));
}
async function updateGlobalPresetUnlocked(root, presetId, patch = {}) {
  const presets = await readStore(root);
  const index = presets.findIndex(item => item.id === presetId);
  if (index < 0) throw new Error('预设不存在');
  const previous = presets[index];
  const versionSnapshot = snapshotPreset(previous, now());
  const next = defaultPreset({ ...previous, ...patch, id: presetId, createdAt: previous.createdAt, updatedAt: now(), versions: [...(previous.versions || []), versionSnapshot].slice(-20) });
  validateInput(next);
  const hasResourcePatch = ['sourcePaths', 'resultPaths', 'workflowSourcePath', 'coverSourcePath'].some(key => Object.prototype.hasOwnProperty.call(patch, key));
  if (!hasResourcePatch) {
    presets[index] = next;
    await writeStore(root, presets);
    return next;
  }
  const backups = await backupPresetResources(root, previous);
  try {
    await materializeResources(root, next, patch);
    presets[index] = next;
    await writeStore(root, presets);
    await removeBackups(backups);
    return next;
  } catch (error) {
    await removePresetResources(root, next).catch(() => {});
    await restorePresetResources(backups).catch(() => {});
    throw error;
  }
}
export async function updateGlobalPreset(root, presetId, patch = {}) {
  return withWriteLock(() => updateGlobalPresetUnlocked(root, presetId, patch));
}
async function deleteGlobalPresetUnlocked(root, presetId) {
  const presets = await readStore(root);
  const target = presets.find(item => item.id === presetId);
  if (!target) throw new Error('预设不存在');
  await removePresetResources(root, target);
  await writeStore(root, presets.filter(item => item.id !== presetId));
  return presets.filter(item => item.id !== presetId);
}
export async function deleteGlobalPreset(root, presetId) {
  return withWriteLock(() => deleteGlobalPresetUnlocked(root, presetId));
}
async function copyGlobalPresetUnlocked(root, presetId) {
  const presets = await readStore(root);
  const source = presets.find(item => item.id === presetId);
  if (!source) throw new Error('预设不存在');
  const sourcePaths = [...(source.sourceImages || [])].map(item => join(root, item.path || item)).filter(Boolean);
  const resultPaths = [...(source.resultImages || [])].map(item => join(root, item.path || item)).filter(Boolean);
  const workflowSourcePath = source.workflow ? join(root, source.workflow) : '';
  const coverSourcePath = source.cover?.path ? join(root, source.cover.path) : '';
  const copy = await createGlobalPresetUnlocked(root, {
    ...source,
    id: undefined,
    title: `${source.title} 副本`,
    favorite: false,
    origin: 'copy',
    sourcePaths,
    resultPaths,
    workflowSourcePath,
    coverSourcePath,
  });
  return copy;
}
export async function copyGlobalPreset(root, presetId) {
  return withWriteLock(() => copyGlobalPresetUnlocked(root, presetId));
}
async function markPresetUsedUnlocked(root, presetId, generated = false) {
  const presets = await readStore(root);
  const index = presets.findIndex(item => item.id === presetId);
  if (index < 0) return null;
  const timestamp = now();
  presets[index] = defaultPreset({ ...presets[index], usageCount: (presets[index].usageCount || 0) + 1, lastUsedAt: timestamp, lastGeneratedAt: generated ? timestamp : presets[index].lastGeneratedAt, updatedAt: timestamp });
  await writeStore(root, presets);
  return presets[index];
}
export async function markPresetUsed(root, presetId, generated = false) {
  return withWriteLock(() => markPresetUsedUnlocked(root, presetId, generated));
}
export async function rateGlobalPreset(root, presetId, rating) {
  return withWriteLock(async () => {
    const presets = await readStore(root);
    const index = presets.findIndex(item => item.id === presetId);
    if (index < 0) throw new Error('预设不存在');
    const score = Math.max(1, Math.min(5, Number(rating) || 0));
    const previous = presets[index];
    const count = previous.ratingCount || 0;
    presets[index] = defaultPreset({ ...previous, rating: ((previous.rating || 0) * count + score) / (count + 1), ratingCount: count + 1, updatedAt: now() });
    await writeStore(root, presets);
    return presets[index];
  });
}
export async function listPresetVersions(root, presetId) {
  const preset = (await readStore(root)).find(item => item.id === presetId);
  if (!preset) throw new Error('预设不存在');
  return preset.versions || [];
}
export async function replacePresetModel(root, presetId, from, to) {
  const presets = await readStore(root);
  const preset = presets.find(item => item.id === presetId);
  if (!preset) throw new Error('预设不存在');
  const requirements = (preset.modelRequirements || []).map(item => item?.value === from ? { ...item, value: to, available: true, replacedFrom: from } : item);
  return updateGlobalPreset(root, presetId, { modelRequirements: requirements, extensions: { ...preset.extensions, models: { replacements: { ...(preset.extensions?.models?.replacements || {}), [from]: to } } } });
}
export async function composeGlobalPresets(root, presetIds = [], input = {}) {
  return withWriteLock(async () => {
    const presets = await readStore(root);
    const selected = presetIds.map(id => presets.find(item => item.id === id)).filter(Boolean);
    if (selected.length < 2) throw new Error('至少选择两个预设进行组合');
    const composed = defaultPreset(composePresetLayers(selected, input));
    presets.unshift(composed);
    await writeStore(root, presets);
    return composed;
  });
}
export async function copyPresetCover(root, presetId, sourcePath) {
  const extension = imageExtension(sourcePath);
  await mkdir(join(root, 'covers'), { recursive: true });
  const target = join(root, 'covers', `${presetId}${extension}`);
  await copyFile(sourcePath, target);
  return { path: `covers/${presetId}${extension}`, name: basename(sourcePath) };
}
async function importGlobalPresetUnlocked(root, sourcePath, extractZip) {
  const extracted = sourcePath.toLowerCase().endsWith('.zip') ? await extractZip(sourcePath) : { files: [sourcePath] };
  const files = extracted.files || extracted;
  const presetFile = files.find(file => basename(file).toLowerCase() === 'preset.json');
  if (!presetFile || files.filter(file => basename(file).toLowerCase() === 'preset.json').length !== 1) throw new Error('压缩包必须包含唯一的 preset.json');
  let data;
  try { data = JSON.parse(await readFile(presetFile, 'utf8')); } catch { throw new Error('预设 JSON 无法解析'); }
  if (data.format !== FORMAT) throw new Error('不是 Comfy Agent 预设文件');
  if (data.version !== VERSION) throw new Error(`不支持的预设版本：${data.version}`);
  validateInput(data);
  const preset = defaultPreset({ ...data, id: undefined, origin: data.origin || 'import', cover: null, workflow: '' });
  const base = resolve(presetFile, '..');
  const findAsset = value => {
    if (typeof value !== 'string') return '';
    const candidate = resolve(base, value);
    assertInside(base, candidate);
    return files.includes(candidate) ? candidate : '';
  };
  const sourcePaths = (data.sourceImages || []).map(findAsset).filter(Boolean);
  const resultPaths = (data.resultImages || []).map(findAsset).filter(Boolean);
  const coverPath = findAsset(data.cover);
  const workflowPath = findAsset(data.workflow);
  try {
    await materializeResources(root, preset, { sourcePaths, resultPaths, coverSourcePath: coverPath, workflowSourcePath: workflowPath });
    const presets = await readStore(root);
    presets.unshift(preset);
    await writeStore(root, presets);
    return [preset];
  } catch (error) {
    await removePresetResources(root, preset).catch(() => {});
    throw error;
  } finally {
    await extracted.cleanup?.();
  }
}
export async function importGlobalPreset(root, sourcePath, extractZip) {
  return withWriteLock(() => importGlobalPresetUnlocked(root, sourcePath, extractZip));
}
export { FORMAT, VERSION, defaultPreset, assertInside };
