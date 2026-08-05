#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const portable = join(root, 'dist-portable');
const app = join(portable, 'resources', 'app');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const staging = join(root, '.release-update-staging');
const output = join(root, `ComfyUI-Agent-update-v${packageJson.version}.zip`);

if (!existsSync(app)) throw new Error(`Missing built app directory: ${app}`);

rmSync(staging, { recursive: true, force: true });
mkdirSync(join(staging, 'resources'), { recursive: true });
cpSync(app, join(staging, 'resources', 'app'), { recursive: true });
if (existsSync(output)) rmSync(output, { force: true });

const command = `Compress-Archive -Path '${join(staging, '*').replaceAll("'", "''")}' -DestinationPath '${output.replaceAll("'", "''")}' -Force`;
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { stdio: 'inherit' });
rmSync(staging, { recursive: true, force: true });

console.log(`Created update package: ${output}`);
console.log('Install by extracting it over the existing dist-portable directory.');
