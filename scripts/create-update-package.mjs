#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const staging = join(root, '.release-update-staging');
const app = join(staging, 'resources', 'app');
const output = join(root, `ComfyMuse-update-v${packageJson.version}.zip`);

for (const required of ['dist/index.html', 'electron/main.mjs', 'src/agent/index.mjs', 'comfy-client.mjs']) {
  if (!existsSync(join(root, required))) {
    throw new Error(`Missing build artifact: ${required} — run "npm run build" (or pack-update.bat) first`);
  }
}

rmSync(staging, { recursive: true, force: true });
try {
  mkdirSync(join(app, 'scripts'), { recursive: true });

  // Build a fresh resources\app from current source, mirroring pack-portable.bat.
  // Never zip an existing dist-portable: it may hold a stale bundle.
  cpSync(join(root, 'electron'), join(app, 'electron'), { recursive: true });
  cpSync(join(root, 'dist'), join(app, 'dist'), { recursive: true });
  cpSync(join(root, 'src'), join(app, 'src'), { recursive: true });
  cpSync(join(root, 'scripts', 'verify-comfyui-recovery.mjs'), join(app, 'scripts', 'verify-comfyui-recovery.mjs'));
  cpSync(join(root, 'package.json'), join(app, 'package.json'));
  cpSync(join(root, 'comfy-client.mjs'), join(app, 'comfy-client.mjs'));
  writeFileSync(join(app, 'comfyui-root.txt'), '..\\..\\..\\..');

  // Validate the staged app the same way the full portable pack does.
  execFileSync(process.execPath, [join(root, 'scripts', 'verify-packaged-runtime.mjs'), app], { stdio: 'inherit' });

  if (existsSync(output)) rmSync(output, { force: true });
  const command = `Compress-Archive -Path '${join(staging, '*').replaceAll("'", "''")}' -DestinationPath '${output.replaceAll("'", "''")}' -Force`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { stdio: 'inherit' });
} finally {
  rmSync(staging, { recursive: true, force: true });
}

console.log(`Created update package: ${output}`);
console.log('Install by extracting it over the existing dist-portable directory and overwriting resources\\app.');
console.log('Keep ComfyMuse.exe and its Chromium runtime files in place.');
