import { relative, resolve } from 'node:path';

function samePath(left, right) {
  return left.toLowerCase() === right.toLowerCase();
}

export function displayPath(filePath, aliases = []) {
  if (!filePath) return '';
  const resolved = resolve(filePath);
  const ordered = aliases
    .filter(alias => alias?.path && alias?.label)
    .map(alias => ({ ...alias, path: resolve(alias.path) }))
    .sort((left, right) => right.path.length - left.path.length);

  for (const alias of ordered) {
    if (samePath(resolved, alias.path)) return alias.label;
    const child = relative(alias.path, resolved);
    if (child && !child.startsWith('..') && !child.includes('../') && !child.includes('..\\')) {
      return `${alias.label}\\${child}`;
    }
  }
  return filePath;
}
