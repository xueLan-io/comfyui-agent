import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const appRoot = resolve(process.argv[2] || '');
const sourceEntries = [
  'electron/main.mjs',
  'electron/preload.cjs',
  'src/ui-preferences.mjs',
];
const requiredFiles = [
  'electron/main.mjs',
  'electron/preload.cjs',
  'electron/comfyui-manager.mjs',
  'electron/request-ledger.mjs',
  'package.json',
  'comfy-client.mjs',
  'dist/index.html',
  'src/agent/index.mjs',
  'src/runtime/direct/direct-service.mjs',
  'src/config/modelProfiles.json',
  'src/ui-preferences.mjs',
  'scripts/verify-comfyui-recovery.mjs',
];

function isLocalPath(filePath, root) {
  const value = relative(root, filePath);
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..');
}

function resolveImport(importer, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(importer), specifier);
  const candidates = [base, `${base}.mjs`, `${base}.cjs`, `${base}.js`, `${base}.json`, resolve(base, 'index.mjs')];
  return candidates.find(candidate => existsSync(candidate)) || base;
}

function importedSpecifiers(source) {
  const specifiers = new Set();
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']/g,
    /\brequire\s*\(\s*["']([^"']+)["']/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.add(match[1]);
  }
  return specifiers;
}

function validateRequiredFiles(errors) {
  for (const file of requiredFiles) {
    if (!existsSync(resolve(appRoot, file))) errors.push(`missing packaged file: ${file}`);
  }
}

function validateDependencyClosure(errors) {
  const pending = sourceEntries.map(file => resolve(sourceRoot, file));
  const visited = new Set();

  while (pending.length > 0) {
    const importer = pending.pop();
    if (visited.has(importer)) continue;
    visited.add(importer);
    if (!existsSync(importer)) {
      errors.push(`missing source entry: ${relative(sourceRoot, importer)}`);
      continue;
    }

    for (const specifier of importedSpecifiers(readFileSync(importer, 'utf8'))) {
      const dependency = resolveImport(importer, specifier);
      if (!dependency) continue;
      if (!existsSync(dependency)) {
        errors.push(`unresolved local import: ${relative(sourceRoot, importer)} -> ${specifier}`);
        continue;
      }
      if (!isLocalPath(dependency, sourceRoot)) {
        errors.push(`local import leaves source tree: ${relative(sourceRoot, importer)} -> ${specifier}`);
        continue;
      }
      const packagedPath = resolve(appRoot, relative(sourceRoot, dependency));
      if (!existsSync(packagedPath)) {
        errors.push(`unpackaged local import: ${relative(sourceRoot, importer)} -> ${relative(sourceRoot, dependency)}`);
      }
      pending.push(dependency);
    }
  }
}

if (!appRoot || !existsSync(appRoot)) {
  console.error(`Packaged app directory not found: ${appRoot || '(empty)'}`);
  process.exit(1);
}

const errors = [];
validateRequiredFiles(errors);
validateDependencyClosure(errors);

if (errors.length > 0) {
  console.error('Packaged runtime validation failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log('Packaged runtime validation passed.');
