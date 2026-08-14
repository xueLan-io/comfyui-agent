// Plugin directory loader: reads <pluginsDir>/<pluginId>/plugin.json manifests
// (with optional main.mjs exporting start/stop hooks) and verifies optional
// Ed25519 signatures (<manifest>.sig) against the plugin signing key.
//
// Plugins are plain data + hooks: they never receive code-execution
// capabilities beyond what their declared capabilities allow at registration
// time (see plugin-registry.mjs), and start() may only use the host handles
// declared in the manifest.

import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPublicKey, verify } from 'node:crypto';
import { assertPluginManifest } from './plugin-contract.mjs';

// Public half of the plugin signing key. The private key is kept out of the
// app; signed plugins opt into a stronger trust level shown in the UI, while
// unsigned local plugins still work but are labeled as untrusted.
export const PLUGIN_SIGNING_PUBLIC_KEY_B64 = 'MCowBQYDK2VwAyEAJvebsdRdBSZY+5naIDt59Z7yKu4YiOc/lGaAthYkiZg=';

export function verifyPluginSignature(manifestBytes, signatureBase64, publicKeyBase64 = PLUGIN_SIGNING_PUBLIC_KEY_B64) {
  if (!Buffer.isBuffer(manifestBytes) || !signatureBase64 || !publicKeyBase64) return false;
  try {
    return verify(null, manifestBytes, createPublicKey({ key: Buffer.from(publicKeyBase64, 'base64'), type: 'spki', format: 'der' }), Buffer.from(String(signatureBase64).trim(), 'base64'));
  } catch {
    return false;
  }
}

// Returns { manifest, signed } or throws on malformed input.
async function readManifest(dir, pluginId, publicKeyBase64) {
  const manifestPath = join(dir, 'plugin.json');
  if (!existsSync(manifestPath)) return null;
  const bytes = await readFile(manifestPath);
  const manifest = JSON.parse(bytes.toString('utf8'));
  assertPluginManifest(manifest);
  let signed = false;
  const sigPath = join(dir, 'plugin.json.sig');
  if (existsSync(sigPath)) {
    const signature = (await readFile(sigPath, 'utf8')).trim();
    signed = verifyPluginSignature(bytes, signature, publicKeyBase64);
  }
  return { manifest, signed };
}

// Load all plugins under pluginsDir. Returns { plugins, errors }.
// plugin objects: { manifest, directory, signed, start?, stop? }.
export async function loadPluginsFromDirectory(pluginsDir = '', { publicKeyBase64 = PLUGIN_SIGNING_PUBLIC_KEY_B64 } = {}) {
  if (!pluginsDir || !existsSync(pluginsDir)) return { plugins: [], errors: [] };
  const errors = [];
  const plugins = [];
  for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(pluginsDir, entry.name);
    try {
      const loaded = await readManifest(dir, entry.name, publicKeyBase64);
      if (!loaded) continue;
      let mod = {};
      const mainPath = join(dir, 'main.mjs');
      if (existsSync(mainPath)) mod = await import(pathToFileURL(mainPath).href);
      plugins.push({
        manifest: loaded.manifest,
        signed: loaded.signed,
        directory: dir,
        start: typeof mod.start === 'function' ? mod.start : undefined,
        stop: typeof mod.stop === 'function' ? mod.stop : undefined,
      });
    } catch (error) {
      errors.push({ pluginId: entry.name, error: error?.message || String(error) });
    }
  }
  return { plugins, errors };
}
