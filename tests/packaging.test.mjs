import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const batch = await readFile(new URL('../pack-portable.bat', import.meta.url), 'utf8');
const builder = await readFile(new URL('../electron-builder.yml', import.meta.url), 'utf8');
const verifier = await readFile(new URL('../scripts/verify-packaged-runtime.mjs', import.meta.url), 'utf8');

test('portable packaging includes the direct runtime', () => {
  assert.match(batch, /xcopy \/e \/i \/q "src" "%APPDIR%\\src"/);
  assert.match(batch, /src\\runtime\\direct\\direct-service\.mjs/);
  assert.match(batch, /src\\config\\modelProfiles\.json/);
  assert.match(batch, /verify-packaged-runtime\.mjs/);
});

test('electron-builder includes the direct runtime', () => {
  assert.match(builder, /src\/\*\*\/\*/);
});

test('packaged runtime validation checks local imports and required files', () => {
  assert.match(verifier, /unpackaged local import/);
  assert.match(verifier, /src\/config\/modelProfiles\.json/);
});
