import { readdirSync } from 'fs';
import { copyFile, readFile, readdir, rename as fsRename, rmdir, stat, unlink } from 'fs/promises';
import { dirname, isAbsolute, join, parse, basename, resolve, relative } from 'path';

export function isComfyWorkflowJson(content) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  if (Array.isArray(parsed.nodes) && parsed.nodes.length > 0) return true;
  const keys = Object.keys(parsed);
  if (keys.length > 0) {
    return keys.every(key => /^\d+$/.test(key))
      && keys.some(key => parsed[key]?.class_type);
  }
  return false;
}

export function collectWorkflowFiles(dir) {
  if (!dir) return [];
  const files = [];
  function collect(currentDir, prefix = '') {
    let entries;
    try {
      entries = readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relativeName = join(prefix, entry.name);
      const filePath = join(currentDir, entry.name);
      if (entry.isDirectory()) collect(filePath, relativeName);
      else if (entry.name.toLowerCase().endsWith('.json') && !entry.name.toLowerCase().includes('backup')) files.push(relativeName);
    }
  }
  collect(dir);
  return files.sort((a, b) => a.localeCompare(b));
}

export async function uniqueWorkflowName(dir, name) {
  const parsed = parse(name);
  let candidate = name;
  let index = 2;
  while (true) {
    try {
      await stat(join(dir, candidate));
      candidate = `${parsed.name} (${index})${parsed.ext}`;
      index += 1;
    } catch {
      return candidate;
    }
  }
}

export async function importWorkflowFiles(sourcePaths, workflowDir) {
  if (!workflowDir) throw new Error('工作流目录未设置');
  const results = [];
  const imported = [];
  for (const sourcePath of sourcePaths || []) {
    const sourceName = basename(sourcePath);
    let content;
    try {
      content = await readFile(sourcePath, 'utf-8');
    } catch {
      results.push({ name: sourceName, status: 'unreadable', error: '无法读取文件' });
      continue;
    }
    if (!isComfyWorkflowJson(content)) {
      results.push({ name: sourceName, status: 'invalid', error: '不是有效的 ComfyUI 工作流（缺少 nodes 或 API prompt 结构）' });
      continue;
    }
    const targetName = await uniqueWorkflowName(workflowDir, sourceName);
    const targetPath = join(workflowDir, targetName);
    try {
      await copyFile(sourcePath, targetPath);
    } catch {
      results.push({ name: sourceName, status: 'error', error: '复制到工作流目录失败' });
      continue;
    }
    results.push({ name: targetName, status: 'imported' });
    imported.push(targetName);
  }
  return { results, imported, files: collectWorkflowFiles(workflowDir) };
}

export function resolveWorkflowFilePath(dir, name) {
  if (!dir || !name || typeof name !== 'string') {
    throw new Error(`无效的工作流文件名: ${name}`);
  }
  const baseDir = resolve(dir);
  const filePath = resolve(baseDir, name);
  const relativePath = relative(baseDir, filePath);
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error(`工作流路径超出配置目录: ${name}`);
  }
  return filePath;
}

export async function deleteWorkflowFile(name, dir) {
  if (!dir) throw new Error('工作流目录未设置');
  const filePath = resolveWorkflowFilePath(dir, name);
  try {
    await stat(filePath);
  } catch {
    throw new Error(`工作流不存在: ${name}`);
  }
  await unlink(filePath);
  await removeEmptyWorkflowDirs(filePath);
  return { deleted: name, files: collectWorkflowFiles(dir) };
}

export async function renameWorkflowFile(name, nextName, dir) {
  if (!dir) throw new Error('工作流目录未设置');
  const filePath = resolveWorkflowFilePath(dir, name);
  const nextPath = resolveWorkflowFilePath(dir, nextName);
  try {
    await stat(filePath);
  } catch {
    throw new Error(`工作流不存在: ${name}`);
  }
  try {
    await stat(nextPath);
    throw new Error(`已存在同名工作流: ${nextName}`);
  } catch (error) {
    if (error?.message?.startsWith('已存在同名工作流')) throw error;
  }
  await fsRename(filePath, nextPath);
  return { renamed: nextName, files: collectWorkflowFiles(dir) };
}

async function removeEmptyWorkflowDirs(filePath) {
  let current = dirname(filePath);
  try {
    while (relative(current, filePath)) {
      const entries = await readdir(current);
      if (entries.length > 0) break;
      const parent = dirname(current);
      if (parent === current) break;
      await rmdir(current);
      current = parent;
    }
  } catch {
    // Best-effort cleanup only.
  }
}
