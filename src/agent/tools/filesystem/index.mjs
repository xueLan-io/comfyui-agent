import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'fs';
import { isAbsolute, relative, resolve, win32 } from 'path';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif']);
const ROOT_NAMES = new Set(['workflow', 'project', 'input', 'output', 'temp']);

function isAbsolutePath(value) {
  return isAbsolute(value) || win32.isAbsolute(value);
}

function hasParentSegment(value) {
  return value.split(/[\\/]/).includes('..');
}

function isWithin(base, candidate) {
  const path = relative(base, candidate);
  return path === '' || (!path.startsWith('..') && !isAbsolutePath(path));
}

function rootMap(workflowDir, allowedRoots = []) {
  const roots = new Map();
  if (workflowDir) roots.set('workflow', workflowDir);
  for (const root of allowedRoots) {
    if (!root || typeof root !== 'object' || !ROOT_NAMES.has(root.name) || !root.path) continue;
    if (!roots.has(root.name)) roots.set(root.name, root.path);
  }
  return roots;
}

function resolveRoot(roots, name = 'workflow') {
  if (!ROOT_NAMES.has(name)) throw new Error(`Invalid filesystem root: ${name}`);
  const root = roots.get(name);
  if (!root || !existsSync(root)) throw new Error(`Filesystem root does not exist: ${name}`);
  return realpathSync(resolve(root));
}

function resolveSafePath(root, value = '') {
  if (typeof value !== 'string' || isAbsolutePath(value) || hasParentSegment(value)) {
    throw new Error('Filesystem path must be a relative path without parent traversal');
  }

  const candidate = resolve(root, value);
  if (!isWithin(root, candidate)) throw new Error('Filesystem path is outside the allowed directory');

  let entry;
  try {
    entry = lstatSync(candidate);
  } catch {
    const parent = realpathSync(resolve(candidate, '..'));
    if (!isWithin(root, parent)) throw new Error('Filesystem path is outside the allowed directory');
    return candidate;
  }

  if (entry.isSymbolicLink()) throw new Error('Symbolic link paths are not allowed');
  const canonical = realpathSync(candidate);
  if (!isWithin(root, canonical)) throw new Error('Filesystem path is outside the allowed directory');
  return canonical;
}

function resolveWorkflowFile(roots, filename) {
  if (!filename) throw new Error('filename required');
  if (!String(filename).toLowerCase().endsWith('.json')) throw new Error(`Invalid workflow filename: ${filename}`);
  const root = resolveRoot(roots, 'workflow');
  const filePath = resolveSafePath(root, filename);
  return { root, filePath };
}

export const FilesystemTool = {
  name: 'filesystem',
  description: 'List and inspect files inside trusted local roots. It cannot write, delete, move, copy, or read arbitrary paths.',
  category: 'filesystem',
  tags: ['filesystem', 'workflow', 'discover'],
  timeout_ms: 10000,
  side_effects: [],
  requires_confirmation: false,
  idempotent: true,
  retry: { mode: 'never' },
  output_schema: {
    type: 'object',
    properties: {
      files: { type: 'array', items: { type: 'object' } },
      error: { type: 'string' },
      valid: { type: 'boolean' },
    },
  },
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'read', 'validate', 'list_images'],
        description: 'Read-only action to perform',
      },
      workflowDir: { type: 'string', description: 'Trusted workflow directory supplied by the runtime' },
      filename: { type: 'string', description: 'Relative workflow filename for read/validate' },
      root: { type: 'string', enum: [...ROOT_NAMES], description: 'Trusted root name' },
      path: { type: 'string', description: 'Relative text file path for read' },
      relativePath: { type: 'string', description: 'Relative directory inside the selected trusted root' },
      outputDir: { type: 'string', description: 'Relative directory inside the selected trusted root' },
      limit: { type: 'number', description: 'Max images to return (list_images)' },
    },
    required: ['action', 'workflowDir'],
  },

  async execute({ action, workflowDir, filename, root, path, relativePath, outputDir, limit, allowedRoots }) {
    const roots = rootMap(workflowDir, allowedRoots);
    if (!roots.has('workflow')) return { error: 'Workflow directory does not exist', path: workflowDir };

    if (action === 'list') {
      const directory = resolveRoot(roots, 'workflow');
      const files = readdirSync(directory)
        .filter(name => name.endsWith('.json') && !name.includes('backup'))
        .filter(name => {
          try {
            return lstatSync(resolve(directory, name)).isFile();
          } catch {
            return false;
          }
        })
        .map(name => ({ name }));
      return { files, path: directory, count: files.length };
    }

    if (action === 'read') {
      if (path !== undefined) {
        const directoryRoot = resolveRoot(roots, root || 'workflow');
        const filePath = resolveSafePath(directoryRoot, path);
        if (!existsSync(filePath) || !statSync(filePath).isFile()) return { error: `File not found: ${path}` };
        return { path, content: readFileSync(filePath, 'utf8'), size: statSync(filePath).size };
      }
      const { filePath } = resolveWorkflowFile(roots, filename);
      if (!existsSync(filePath)) return { error: `File not found: ${filename}` };
      const content = JSON.parse(readFileSync(filePath, 'utf-8'));
      return {
        filename,
        nodes: (content.nodes || []).map(node => ({
          id: node.id,
          type: node.type,
          inputs: (node.inputs || []).map(input => ({ name: input.name, link: input.link })),
          widgetCount: (node.widgets_values || []).length,
        })),
        linksCount: (content.links || []).length,
      };
    }

    if (action === 'validate') {
      const { filePath } = resolveWorkflowFile(roots, filename);
      if (!existsSync(filePath)) return { valid: false, error: 'File not found' };
      try {
        const workflow = JSON.parse(readFileSync(filePath, 'utf-8'));
        return {
          valid: true,
          nodeCount: workflow.nodes?.length || 0,
          hasPromptList: workflow.nodes?.some(node => node.type === 'easy promptList'),
          promptSlots: workflow.nodes?.filter(node => node.type === 'easy promptList')
            .reduce((sum, node) => sum + (node.widgets_values?.length || 0), 0),
        };
      } catch (error) {
        return { valid: false, error: `Invalid JSON: ${error.message}` };
      }
    }

    if (action === 'list_images') {
      const directoryRoot = resolveRoot(roots, root || 'workflow');
      const directory = resolveSafePath(directoryRoot, relativePath || outputDir || '');
      if (!existsSync(directory) || !statSync(directory).isDirectory()) {
        return { error: 'Image directory does not exist', path: directory };
      }
      const max = Math.max(1, Math.min(Number(limit) || 10, 100));
      const files = readdirSync(directory)
        .filter(name => IMAGE_EXTENSIONS.has(name.slice(name.lastIndexOf('.')).toLowerCase()))
        .map(name => {
          const fullPath = resolveSafePath(directory, name);
          const stat = statSync(fullPath);
          return { name, path: fullPath, size: stat.size, mtimeMs: stat.mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, max);
      return { files, path: directory, count: files.length };
    }

    return { error: `Unknown action: ${action}` };
  },
};
