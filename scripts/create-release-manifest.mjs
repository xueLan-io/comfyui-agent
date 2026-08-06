import { createHash, createPrivateKey, sign } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = process.env.RELEASE_VERSION || pkg.version;
const channel = process.env.RELEASE_CHANNEL || (version.includes('-') ? 'preview' : 'stable');
const repository = process.env.GITHUB_REPOSITORY || 'xueLan-io/comfyui-agent';
const baseUrl = process.env.RELEASE_BASE_URL || `https://github.com/${repository}/releases/download/v${version}`;
const fullName = `ComfyMuse-portable-v${version}.zip`;
const updateName = `ComfyMuse-update-v${version}.zip`;
const signingKey = process.env.RELEASE_SIGNING_PRIVATE_KEY_B64 || '';

function artifact(name) {
  const path = join(root, name);
  if (!existsSync(path)) throw new Error(`Missing release artifact: ${path}`);
  return { name, url: `${baseUrl}/${name}`, size: statSync(path).size, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
}

const manifest = {
  schemaVersion: 1,
  channel,
  version,
  publishedAt: new Date().toISOString(),
  packageType: 'portable-application',
  runtimeVersion: 'electron-33',
  minimumVersion: process.env.MINIMUM_VERSION || '0.2.1',
  fullPackage: artifact(fullName),
  updatePackage: artifact(updateName),
  releaseNotesUrl: `https://github.com/${repository}/releases/tag/v${version}`,
  mandatory: process.env.RELEASE_MANDATORY === 'true',
};
const output = process.env.MANIFEST_OUTPUT || join(root, `manifest-${channel}.json`);
writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
if (!signingKey) throw new Error('RELEASE_SIGNING_PRIVATE_KEY_B64 is required to sign release manifests');
const manifestBytes = readFileSync(output);
const signature = sign(null, manifestBytes, createPrivateKey({ key: Buffer.from(signingKey, 'base64'), type: 'pkcs8', format: 'der' })).toString('base64');
writeFileSync(`${output}.sig`, `${signature}\n`);
writeFileSync(join(root, 'SHA256SUMS.txt'), `${manifest.fullPackage.sha256}  ${fullName}\n${manifest.updatePackage.sha256}  ${updateName}\n`);
console.log(`Created ${output}`);
