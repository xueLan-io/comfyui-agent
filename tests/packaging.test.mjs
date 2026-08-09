import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const batch = await readFile(new URL('../pack-portable.bat', import.meta.url), 'utf8');
const builder = await readFile(new URL('../electron-builder.yml', import.meta.url), 'utf8');
const verifier = await readFile(new URL('../scripts/verify-packaged-runtime.mjs', import.meta.url), 'utf8');
const ignore = await readFile(new URL('../.gitignore', import.meta.url), 'utf8');
const updateScript = await readFile(new URL('../scripts/create-update-package.mjs', import.meta.url), 'utf8');
const h3Smoke = await readFile(new URL('../scripts/run-h3-amd-smoke.mjs', import.meta.url), 'utf8');

test('portable packaging includes the direct runtime', () => {
  assert.match(batch, /xcopy \/e \/i \/q "src" "%APPDIR%\\src"/);
  assert.match(batch, /xcopy \/e \/i \/q "electron" "%APPDIR%\\electron"/);
  assert.match(batch, /src\\runtime\\direct\\direct-service\.mjs/);
  assert.match(batch, /src\\config\\modelProfiles\.json/);
  assert.match(batch, /verify-packaged-runtime\.mjs/);
});

test('portable packaging does not rely on a partial Electron file list', () => {
  assert.doesNotMatch(batch, /copy \/y "electron\\main\.mjs"/);
  assert.doesNotMatch(batch, /copy \/y "electron\\agent-process\.mjs"/);
});

test('electron-builder includes the direct runtime', () => {
  assert.match(builder, /src\/\*\*\/\*/);
});

test('packaged runtime validation checks local imports and required files', () => {
  assert.match(verifier, /unpackaged local import/);
  assert.match(verifier, /src\/config\/modelProfiles\.json/);
});

test('release packaging excludes local artifacts and cleans update staging', () => {
  assert.match(ignore, /\.release-update-staging\//);
  assert.match(ignore, /\.env\.\*/);
  assert.match(ignore, /manifest-\*\.json/);
  assert.match(updateScript, /finally \{/);
  assert.match(updateScript, /rmSync\(staging, \{ recursive: true, force: true \}\)/);
});

test('H3 smoke probe works from a clean checkout', () => {
  assert.match(h3Smoke, /workflows\/minimax_h3_amd_smoke\.json/);
  assert.match(h3Smoke, /H3_WORKFLOW_SOURCE/);
  assert.match(h3Smoke, /H3_OUTPUT_PATH/);
  assert.match(h3Smoke, /mkdtemp/);
  assert.match(h3Smoke, /COMFYUI_BASE_URL/);
});
