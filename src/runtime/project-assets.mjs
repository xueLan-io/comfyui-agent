import { dirname, join, relative, resolve } from 'node:path';
import { readdir, rmdir, stat } from 'node:fs/promises';

const ASSET_EXTENSIONS = /\.(gif|jpe?g|png|webp|mp4|webm|mov)$/i;
const ASSET_ROOTS = ['images', 'videos'];

export function normalizeAssetPath(value = '') {
  return String(value)
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
}

function assetPathVariants(value) {
  const normalized = normalizeAssetPath(value);
  const variants = new Set([normalized]);
  for (const root of ASSET_ROOTS) {
    if (normalized.startsWith(`${root}/`)) variants.add(normalized.slice(root.length + 1));
  }
  return variants;
}

function matchesAssetMetadata(item, subfolder, filename) {
  if (!item || item.filename !== filename) return false;
  const scannedPaths = assetPathVariants(subfolder);
  const storedPaths = assetPathVariants(item.subfolder);
  return [...scannedPaths].some(path => storedPaths.has(path));
}

async function readTraceSession(readTrace, taskId) {
  if (!readTrace || !taskId) return '';
  try {
    const trace = await readTrace(taskId);
    return trace?.sessionId || '';
  } catch {
    return '';
  }
}

export async function scanProjectAssets({ project, readTrace } = {}) {
  if (!project?.dir) return [];
  const assets = [];
  const metadata = [
    ...(Array.isArray(project.assets) ? project.assets : []),
    ...(Array.isArray(project.lastImages) ? project.lastImages : []),
  ];

  async function collect(rootName, currentDir) {
    for (const entry of await readdir(currentDir, { withFileTypes: true })) {
      const filePath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await collect(rootName, filePath);
        continue;
      }
      if (!ASSET_EXTENSIONS.test(entry.name)) continue;

      const info = await stat(filePath);
      const subfolder = normalizeAssetPath(relative(project.dir, currentDir));
      const stored = metadata.find(item => matchesAssetMetadata(item, subfolder, entry.name));
      const taskId = relative(join(project.dir, rootName), currentDir).split(/[\\/]/)[0] || '';
      assets.push({
        ...(stored || {}),
        filename: entry.name,
        subfolder,
        type: 'project',
        projectId: project.id,
        sessionId: stored?.sessionId || await readTraceSession(readTrace, taskId),
        taskId,
        source: stored?.source || '',
        createdAt: info.mtimeMs,
      });
    }
  }

  for (const rootName of ASSET_ROOTS) {
    const root = join(project.dir, rootName);
    try {
      const info = await stat(root);
      if (info.isDirectory()) await collect(rootName, root);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return assets.sort((a, b) => b.createdAt - a.createdAt);
}

export function projectAssetRoot(projectDir, filePath) {
  const resolvedFile = resolve(projectDir, filePath);
  for (const rootName of ASSET_ROOTS) {
    const root = resolve(projectDir, rootName);
    const relativePath = relative(root, resolvedFile);
    if (!relativePath.startsWith('..') && !relativePath.includes('..\\') && !relativePath.includes('../')) return root;
  }
  return '';
}

export async function removeEmptyAssetDirectories(filePath, root) {
  const boundary = resolve(root);
  let current = resolve(dirname(filePath));
  while (current !== boundary) {
    const parent = dirname(current);
    if (parent === current || relative(boundary, current).startsWith('..')) break;
    try {
      await rmdir(current);
    } catch (error) {
      if (error.code === 'ENOENT') {
        current = parent;
        continue;
      }
      if (error.code === 'ENOTEMPTY' || error.code === 'EEXIST') break;
      throw error;
    }
    current = parent;
  }
}

export { ASSET_ROOTS };
