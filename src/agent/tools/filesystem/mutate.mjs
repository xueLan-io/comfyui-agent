import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { resolveSandboxPath } from '../../security/sandbox.mjs';

const ACTIONS = new Set(['write', 'edit', 'apply_patch']);
const FORBIDDEN_ACTIONS = new Set(['delete', 'remove', 'move', 'copy']);

function hash(buffer) {
  return buffer === null ? null : createHash('sha256').update(buffer).digest('hex');
}

function pathLabel(root, filePath) {
  return relative(root, filePath).replaceAll('\\', '/');
}

function splitText(value) {
  const normalized = String(value).replace(/\r\n/g, '\n');
  const finalNewline = normalized.endsWith('\n');
  const lines = normalized.split('\n');
  if (finalNewline) lines.pop();
  return { lines, finalNewline };
}

function joinText(lines, finalNewline) {
  return lines.join('\n') + (finalNewline ? '\n' : '');
}

function unifiedDiff(path, before, after) {
  if (before === after) return '';
  const oldLines = splitText(before).lines;
  const newLines = splitText(after).lines;
  return [
    `--- ${path}`,
    `+++ ${path}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map(line => `-${line}`),
    ...newLines.map(line => `+${line}`),
  ].join('\n') + '\n';
}

function stripPatchPath(value) {
  const path = String(value).split('\t', 1)[0].trim();
  if (path === '/dev/null') return null;
  if (path.startsWith('a/') || path.startsWith('b/')) return path.slice(2);
  return path;
}

function parseHunkHeader(line) {
  const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (!match) throw new Error(`Invalid patch hunk header: ${line}`);
  return {
    oldStart: Number(match[1]),
    oldCount: Number(match[2] ?? 1),
    newStart: Number(match[3]),
    newCount: Number(match[4] ?? 1),
  };
}

function parsePatch(source) {
  const lines = String(source).replace(/\r\n/g, '\n').split('\n');
  const files = [];
  let index = 0;
  while (index < lines.length) {
    if (!lines[index].startsWith('--- ')) {
      index++;
      continue;
    }
    const oldPath = stripPatchPath(lines[index].slice(4));
    index++;
    if (!lines[index]?.startsWith('+++ ')) throw new Error('Patch is missing its new file header');
    const newPath = stripPatchPath(lines[index].slice(4));
    index++;
    if (!newPath) throw new Error('File deletion patches are not allowed');
    const hunks = [];
    while (index < lines.length && !lines[index].startsWith('--- ')) {
      if (!lines[index] || lines[index].startsWith('diff ') || lines[index].startsWith('index ')) {
        index++;
        continue;
      }
      const header = parseHunkHeader(lines[index]);
      index++;
      const body = [];
      while (index < lines.length && !lines[index].startsWith('@@ ') && !lines[index].startsWith('--- ')) {
        const line = lines[index++];
        if (line === '' && index === lines.length) break;
        if (line.startsWith('\\ No newline at end of file')) continue;
        if (![' ', '+', '-'].includes(line[0])) throw new Error(`Invalid patch line: ${line}`);
        body.push(line);
      }
      const oldCount = body.filter(line => line[0] !== '+').length;
      const newCount = body.filter(line => line[0] !== '-').length;
      if (oldCount !== header.oldCount || newCount !== header.newCount) {
        throw new Error(`Patch hunk line count does not match ${header.oldStart},${header.oldCount} ${header.newStart},${header.newCount}`);
      }
      hunks.push({ ...header, body });
    }
    if (hunks.length === 0) throw new Error(`Patch contains no hunks for ${newPath}`);
    files.push({ oldPath, path: newPath, hunks });
  }
  if (files.length === 0) throw new Error('Patch contains no file changes');
  return files;
}

function applyHunks(before, hunks) {
  const source = splitText(before);
  const output = [];
  let cursor = 0;
  for (const hunk of hunks) {
    const start = Math.max(0, hunk.oldStart - 1);
    if (start < cursor || start > source.lines.length) throw new Error('Patch hunk is out of order or outside the file');
    output.push(...source.lines.slice(cursor, start));
    for (const line of hunk.body) {
      if (line[0] === ' ' || line[0] === '-') {
        if (source.lines[cursor] !== line.slice(1)) throw new Error('Patch context does not match the current file');
        if (line[0] === ' ') output.push(source.lines[cursor]);
        cursor++;
      } else {
        output.push(line.slice(1));
      }
    }
  }
  output.push(...source.lines.slice(cursor));
  return joinText(output, source.finalNewline);
}

function rootInput(input) {
  return {
    workflowDir: input.workflowDir,
    allowedRoots: input.allowedRoots,
    comfyRoot: input.comfyRoot,
  };
}

function resolveMutationPath(input, value, root) {
  const filePath = resolveSandboxPath(rootInput(input), value, { root });
  const parent = dirname(filePath);
  if (!existsSync(parent) || !statSync(parent).isDirectory()) throw new Error(`Parent directory does not exist: ${parent}`);
  return filePath;
}

function readCurrent(filePath) {
  try {
    const entry = lstatSync(filePath);
    if (!entry.isFile()) throw new Error('Mutation target is not a regular file');
    return readFileSync(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function expectedFor(input, path) {
  if (input.expectedHashes && typeof input.expectedHashes === 'object') {
    return input.expectedHashes[path] ?? input.expectedHashes[path.replaceAll('\\', '/')];
  }
  return input.expectedHash;
}

function prepareFile(filePath, relativePath, nextContent, input) {
  const beforeBuffer = readCurrent(filePath);
  const before = beforeBuffer === null ? '' : beforeBuffer.toString('utf8');
  const beforeHash = hash(beforeBuffer);
  const expectedHash = expectedFor(input, relativePath);
  if (expectedHash !== undefined && String(expectedHash).toLowerCase() !== String(beforeHash).toLowerCase()) {
    const error = new Error(`File changed since it was read: ${relativePath}`);
    error.code = 'FILE_CONFLICT';
    error.path = relativePath;
    error.expectedHash = expectedHash;
    error.actualHash = beforeHash;
    throw error;
  }
  const afterBuffer = Buffer.from(nextContent, 'utf8');
  return {
    filePath,
    path: relativePath,
    beforeBuffer,
    beforeHash,
    afterBuffer,
    afterHash: hash(afterBuffer),
    before,
    after: nextContent,
    changed: !beforeBuffer || !beforeBuffer.equals(afterBuffer),
    diff: unifiedDiff(relativePath, before, nextContent),
  };
}

function buildChanges(input) {
  const root = input.root;
  if (typeof root !== 'string' || !root) throw new Error('Filesystem root is required');
  if (FORBIDDEN_ACTIONS.has(input.action)) throw new Error(`Filesystem action is not allowed: ${input.action}`);
  if (!ACTIONS.has(input.action)) throw new Error(`Unknown filesystem mutation action: ${input.action}`);

  if (input.action === 'write') {
    if (typeof input.path !== 'string' || !input.path) throw new Error('File path is required');
    if (typeof input.content !== 'string') throw new Error('Write content is required');
    const filePath = resolveMutationPath(input, input.path, root);
    return [prepareFile(filePath, input.path.replaceAll('\\', '/'), input.content, input)];
  }

  if (input.action === 'edit') {
    if (typeof input.path !== 'string' || !input.path) throw new Error('File path is required');
    if (typeof input.old !== 'string' || typeof input.new !== 'string') throw new Error('Edit requires old and new text');
    if (input.old.length === 0) throw new Error('Edit old text must not be empty');
    const filePath = resolveMutationPath(input, input.path, root);
    const current = readCurrent(filePath);
    if (current === null) throw new Error(`File not found: ${input.path}`);
    const source = current.toString('utf8');
    const matches = source.split(input.old).length - 1;
    if (matches !== 1) throw new Error(`Edit text must match exactly once; found ${matches} matches`);
    return [prepareFile(filePath, input.path.replaceAll('\\', '/'), source.replace(input.old, input.new), input)];
  }

  if (typeof input.patch !== 'string' || !input.patch) throw new Error('Patch content is required');
  const changes = [];
  for (const file of parsePatch(input.patch)) {
    if (file.oldPath && file.oldPath !== file.path) throw new Error('Patch renames are not allowed');
    const filePath = resolveMutationPath(input, file.path, root);
    const current = readCurrent(filePath);
    const before = current === null ? '' : current.toString('utf8');
    if (!file.oldPath && current !== null) throw new Error(`Patch create target already exists: ${file.path}`);
    changes.push(prepareFile(filePath, file.path.replaceAll('\\', '/'), applyHunks(before, file.hunks), input));
  }
  const paths = new Set(changes.map(change => change.path));
  if (paths.size !== changes.length) throw new Error('Patch contains duplicate file paths');
  return changes;
}

function atomicReplace(filePath, buffer) {
  const tempPath = `${filePath}.agent-tmp-${randomUUID()}`;
  writeFileSync(tempPath, buffer, { flag: 'wx' });
  try {
    try {
      renameSync(tempPath, filePath);
      return;
    } catch (error) {
      if (!['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(error.code)) throw error;
    }

    const backupPath = `${filePath}.agent-backup-${randomUUID()}`;
    renameSync(filePath, backupPath);
    try {
      renameSync(tempPath, filePath);
      rmSync(backupPath, { force: true });
    } catch (error) {
      try { renameSync(backupPath, filePath); } catch {}
      throw error;
    }
  } finally {
    rmSync(tempPath, { force: true });
  }
}

function rollback(changes) {
  for (const change of changes.toRevert || []) {
    try {
      if (change.beforeBuffer === null) rmSync(change.filePath, { force: true });
      else atomicReplace(change.filePath, change.beforeBuffer);
    } catch {}
  }
}

function executeChanges(changes) {
  const committed = [];
  try {
    for (const change of changes) {
      if (!change.changed) continue;
      const latest = readCurrent(change.filePath);
      if (hash(latest) !== change.beforeHash) {
        const error = new Error(`File changed during mutation: ${change.path}`);
        error.code = 'FILE_CONFLICT';
        throw error;
      }
      atomicReplace(change.filePath, change.afterBuffer);
      committed.push(change);
    }
  } catch (error) {
    committed.toRevert = committed;
    rollback(committed);
    throw error;
  }
}

export const FilesystemMutateTool = {
  name: 'filesystem_mutate',
  description: 'Preview and, after confirmation, write or edit text files inside trusted local roots. It cannot run commands, delete, move, or copy files.',
  category: 'filesystem',
  tags: ['filesystem', 'write', 'edit', 'patch', 'diff'],
  timeout_ms: 20000,
  side_effects: ['filesystem_write'],
  requires_confirmation: true,
  idempotent: false,
  retry: { mode: 'never' },
  output_schema: {
    type: 'object',
    properties: {
      files: { type: 'array', items: { type: 'object' } },
      diff: { type: 'array', items: { type: 'object' } },
      patch: { type: 'string' },
      patchFile: { type: 'string' },
      beforeHash: { type: 'string' },
      afterHash: { type: 'string' },
      error: { type: 'string' },
    },
  },
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['write', 'edit', 'apply_patch'] },
      root: { type: 'string', enum: ['workflow', 'project', 'input', 'output', 'temp'] },
      path: { type: 'string' },
      content: { type: 'string' },
      contentFile: { type: 'string' },
      old: { type: 'string' },
      new: { type: 'string' },
      patch: { type: 'string' },
      expectedHash: { type: 'string' },
      expectedHashes: { type: 'object' },
      execute: { type: 'boolean' },
      workflowDir: { type: 'string' },
    },
    required: ['action', 'root'],
  },

  async execute(input = {}) {
    if (input.contentFile !== undefined) {
      if (input.content !== undefined) throw new Error('Use content or contentFile, not both');
      const contentPath = resolveMutationPath(input, input.contentFile, input.root);
      input = { ...input, content: readFileSync(contentPath, 'utf8') };
    }
    if (input.patchFile !== undefined) {
      if (input.patch !== undefined) throw new Error('Use patch or patchFile, not both');
      const patchPath = resolveMutationPath(input, input.patchFile, input.root);
      input = { ...input, patch: readFileSync(patchPath, 'utf8') };
    }
    let changes;
    try {
      changes = buildChanges(input);
    } catch (error) {
      if (error.code === 'FILE_CONFLICT') {
        return { error: error.message, code: error.code, path: error.path, expectedHash: error.expectedHash, actualHash: error.actualHash, files: [], diff: [] };
      }
      throw error;
    }

    const files = changes.map(change => ({
      path: change.path,
      beforeHash: change.beforeHash,
      afterHash: change.afterHash,
      changed: change.changed,
      diff: change.diff,
    }));
    const result = {
      action: input.action,
      root: input.root,
      mode: input.execute === true ? 'execute' : 'preview',
      executed: input.execute === true,
      files,
      diff: files,
      patch: changes.map(change => change.diff).filter(Boolean).join('\n'),
      beforeHash: changes.length === 1 ? changes[0].beforeHash : undefined,
      afterHash: changes.length === 1 ? changes[0].afterHash : undefined,
    };
    if (input.execute === true) {
      try {
        executeChanges(changes);
      } catch (error) {
        if (error.code === 'FILE_CONFLICT') return { ...result, executed: false, mode: 'conflict', error: error.message, code: error.code };
        throw error;
      }
    }
    return result;
  },
};
