import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export function hasPortableLayout(root) {
  return existsSync(join(root, 'python_embeded', 'python.exe'))
    && existsSync(join(root, 'ComfyUI', 'main.py'));
}

export function findPortableRoot(...startDirs) {
  const visited = new Set();
  for (const startDir of startDirs.filter(Boolean)) {
    let current = resolve(startDir);
    for (;;) {
      const key = current.toLowerCase();
      if (!visited.has(key)) {
        visited.add(key);
        if (hasPortableLayout(current)) return current;
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return '';
}

export function createPathContext(baseDir = process.cwd()) {
  const configuredRoot = process.env.COMFYUI_PORTABLE_ROOT
    ? resolve(baseDir, process.env.COMFYUI_PORTABLE_ROOT)
    : '';
  const portableRoot = configuredRoot && hasPortableLayout(configuredRoot)
    ? configuredRoot
    : findPortableRoot(baseDir);
  const workflowDir = process.env.COMFYUI_WORKFLOW_DIR
    ? resolve(baseDir, process.env.COMFYUI_WORKFLOW_DIR)
    : portableRoot
      ? join(portableRoot, 'ComfyUI', 'user', 'default', 'workflows')
      : baseDir;
  return { baseDir: resolve(baseDir), portableRoot, workflowDir };
}

export function isDirectory(value) {
  try {
    return statSync(value).isDirectory();
  } catch {
    return false;
  }
}

export function findPortableRootUnder(dir) {
  if (!isDirectory(dir)) return '';
  const candidates = [dir];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) candidates.push(join(dir, entry.name));
  }
  return candidates.find(hasPortableLayout) || '';
}
