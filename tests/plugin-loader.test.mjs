import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadPluginsFromDirectory, verifyPluginSignature } from '../src/runtime/plugins/plugin-loader.mjs';

async function fixtureDir() {
  const dir = await mkdtemp(join(tmpdir(), 'comfy-plugins-'));
  return dir;
}

const MANIFEST = { contractVersion: '1.0', pluginId: 'hello', name: 'Hello', version: '1.0.0', capabilities: ['tools'] };

test('loadPluginsFromDirectory reads manifests and main.mjs hooks', async () => {
  const dir = await fixtureDir();
  try {
    const pluginDir = join(dir, 'hello');
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, 'plugin.json'), JSON.stringify(MANIFEST));
    await writeFile(join(pluginDir, 'main.mjs'), 'export async function start() { return "started"; }');
    const { plugins, errors } = await loadPluginsFromDirectory(dir);
    assert.equal(errors.length, 0);
    assert.equal(plugins.length, 1);
    assert.equal(plugins[0].manifest.pluginId, 'hello');
    assert.equal(plugins[0].signed, false);
    assert.equal(typeof plugins[0].start, 'function');
    assert.equal(await plugins[0].start(), 'started');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadPluginsFromDirectory reports invalid manifests and skips non-plugin dirs', async () => {
  const dir = await fixtureDir();
  try {
    await mkdir(join(dir, 'bad'), { recursive: true });
    await writeFile(join(dir, 'bad', 'plugin.json'), JSON.stringify({ pluginId: 'no-version' }));
    await mkdir(join(dir, 'not-a-plugin'), { recursive: true });
    const { plugins, errors } = await loadPluginsFromDirectory(dir);
    assert.equal(plugins.length, 0);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].pluginId, 'bad');
    assert.match(errors[0].error, /Missing manifest field/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadPluginsFromDirectory returns empty for missing dir', async () => {
  const { plugins, errors } = await loadPluginsFromDirectory(join(await fixtureDir(), 'nope'));
  assert.deepEqual(plugins, []);
  assert.deepEqual(errors, []);
});

test('plugin signature verification accepts valid and rejects tampered signatures', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const bytes = Buffer.from(JSON.stringify(MANIFEST));
  const signature = sign(null, bytes, privateKey).toString('base64');
  assert.equal(verifyPluginSignature(bytes, signature, publicB64), true);
  assert.equal(verifyPluginSignature(Buffer.from('tampered'), signature, publicB64), false);
  assert.equal(verifyPluginSignature(bytes, 'AAAA', publicB64), false);
  assert.equal(verifyPluginSignature(bytes, signature, 'not-base64'), false);
});

test('signed plugin directories are flagged in the loader', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const dir = await fixtureDir();
  try {
    const pluginDir = join(dir, 'signed');
    await mkdir(pluginDir, { recursive: true });
    const bytes = Buffer.from(JSON.stringify(MANIFEST));
    await writeFile(join(pluginDir, 'plugin.json'), bytes);
    await writeFile(join(pluginDir, 'plugin.json.sig'), sign(null, bytes, privateKey).toString('base64'));
    const { plugins } = await loadPluginsFromDirectory(dir, { publicKeyBase64: publicB64 });
    assert.equal(plugins[0].signed, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
