import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../src/', import.meta.url));

function listMjs(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...listMjs(full));
    } else if (entry.endsWith('.mjs')) {
      files.push(full);
    }
  }
  return files;
}

const files = listMjs(root);
const failures = [];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) failures.push({ file, stderr: result.stderr.trim() });
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`Syntax error in ${failure.file}`);
    console.error(failure.stderr);
  }
  console.error(`lint failed: ${failures.length} file(s)`);
  process.exit(1);
}

console.log(`lint ok: ${files.length} files checked`);
