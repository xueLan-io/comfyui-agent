import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Copy-don't-share gate for the core-loop kernel (agent-v2-design.md §7).
 *
 * The kernel must stay self-contained: it may import node builtins, npm
 * packages, and its own files — but never a module from the legacy src/ tree.
 * A reverse dependency would re-couple the new kernel to the pipeline code
 * that S5 is scheduled to delete.
 *
 * Wired into `npm run lint`. Exits 1 with the offending imports on violation.
 */

const ROOT = resolve(import.meta.dirname ?? '.', '..');
const KERNEL = join(ROOT, 'src', 'agent', 'core-loop');

function listTsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listTsFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

const IMPORT_RE = /(?:from|import)\s+['"]([^'"]+)['"]/g;
const errors = [];

for (const file of listTsFiles(KERNEL)) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(IMPORT_RE)) {
    const spec = match[1];
    if (!spec.startsWith('.')) continue; // builtin or npm package
    const target = resolve(dirname(file), spec);
    const rel = relative(KERNEL, target);
    if (rel.startsWith('..') || resolve(rel) === rel) {
      errors.push(`${relative(ROOT, file)}: imports outside core-loop -> "${spec}"`);
    }
  }
}

if (errors.length > 0) {
  console.error(`lint-core-loop: ${errors.length} forbidden import(s):`);
  for (const line of errors) console.error(`  ${line}`);
  process.exit(1);
}

console.log('lint-core-loop: OK (kernel imports stay inside core-loop)');
