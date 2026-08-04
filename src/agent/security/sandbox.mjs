import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, win32 } from 'node:path';

const ROOT_NAMES = new Set(['workflow', 'project', 'input', 'output', 'temp']);
export const SANDBOX_AUTHORIZED_FILES = Symbol('sandbox-authorized-files');

function absolutePath(value) {
  return isAbsolute(value) || win32.isAbsolute(value);
}

function inside(base, candidate) {
  const child = relative(base, candidate);
  return child === '' || (!child.startsWith('..') && !absolutePath(child));
}

function hasParentSegment(value) {
  return value.split(/[\\/]/).includes('..');
}

function rootDirectory(value, name) {
  if (typeof value !== 'string' || !value || !existsSync(value)) return null;
  try {
    const path = realpathSync(resolve(value));
    return { name, path };
  } catch {
    return null;
  }
}

export class SandboxViolation extends Error {
  constructor(message) {
    super(message);
    this.name = 'SandboxViolation';
    this.code = 'SANDBOX_VIOLATION';
  }
}

export function sandboxRoots(input = {}) {
  const roots = new Map();
  const add = (name, path) => {
    if (!ROOT_NAMES.has(name) || roots.has(name)) return;
    const root = rootDirectory(path, name);
    if (root) roots.set(name, root.path);
  };

  add('workflow', input.workflowDir);
  for (const root of input.allowedRoots || []) add(root?.name, root?.path);
  if (input.comfyRoot) {
    for (const name of ['input', 'output', 'temp']) add(name, resolve(input.comfyRoot, name));
  }
  add('project', input.projectDir);
  return roots;
}

function resolveExistingPath(root, candidate) {
  let entry;
  try {
    entry = lstatSync(candidate);
  } catch {
    const parent = resolveExistingPath(root, resolve(candidate, '..'));
    return resolve(parent, candidate.slice(parent.length).replace(/^[\\/]+/, ''));
  }

  if (entry.isSymbolicLink()) throw new SandboxViolation('Symbolic link paths are not allowed');
  const canonical = realpathSync(candidate);
  if (!inside(root, canonical)) throw new SandboxViolation('Path is outside the allowed directory');
  return canonical;
}

export function resolveSandboxPath(input, value, options = {}) {
  if (typeof value !== 'string' || !value) throw new SandboxViolation('Path is required');
  const roots = sandboxRoots(input);
  const rootName = options.root || 'workflow';
  const root = roots.get(rootName);
  if (!root) throw new SandboxViolation(`Sandbox root does not exist: ${rootName}`);

  if (!options.allowAbsolute && (absolutePath(value) || hasParentSegment(value))) {
    throw new SandboxViolation('Path must be relative and cannot contain parent traversal');
  }

  const candidate = absolutePath(value) ? resolve(value) : resolve(root, value);
  if (!inside(root, candidate)) throw new SandboxViolation('Path is outside the allowed directory');
  return resolveExistingPath(root, candidate);
}

export function resolveSandboxFile(input, value) {
  if (typeof value !== 'string' || !value) throw new SandboxViolation('File path is required');
  const roots = sandboxRoots(input);
  if (absolutePath(value)) {
    const candidate = resolve(value);
    for (const authorized of input[SANDBOX_AUTHORIZED_FILES] || []) {
      if (typeof authorized !== 'string' || resolve(authorized) !== candidate) continue;
      try {
        return resolveExistingPath(candidate, candidate);
      } catch (error) {
        if (error instanceof SandboxViolation) throw error;
      }
    }
  }
  const candidates = absolutePath(value)
    ? [...roots.values()]
    : [...roots.values()].slice(0, 1);
  for (const root of candidates) {
    const candidate = absolutePath(value) ? resolve(value) : resolve(root, value);
    if (!inside(root, candidate)) continue;
    try {
      return resolveExistingPath(root, candidate);
    } catch (error) {
      if (error instanceof SandboxViolation) throw error;
    }
  }
  throw new SandboxViolation('File path is outside the allowed directories');
}

export function assertSandboxMedia(input = {}) {
  for (const kind of ['images', 'masks', 'videos']) {
    for (const entry of input[kind] || []) {
      const path = typeof entry === 'string' ? entry : entry?.path;
      if (path) resolveSandboxFile(input, path);
    }
  }
}

export function createSandboxPolicy(options = {}) {
  let networkEnabled = options.allowNetwork !== false;
  return {
    get networkEnabled() {
      return networkEnabled;
    },
    setNetworkEnabled(value) {
      networkEnabled = value !== false;
    },
    assertToolCall(tool, input = {}) {
      if (tool === 'web' && !networkEnabled) {
        throw new SandboxViolation('Network access is disabled by the agent sandbox');
      }
      if (tool === 'comfyui') assertSandboxMedia(input);
      if (tool === 'inspect_image' && input.image?.path) resolveSandboxFile(input, input.image.path);
      if (tool === 'inspect_image' && input.other?.path) resolveSandboxFile(input, input.other.path);
    },
  };
}
