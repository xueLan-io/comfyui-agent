// Application update IPC domain extracted from electron/main.mjs (2026-08-14):
// signature-verified manifest fetch, download with integrity check, and the
// portable updater handoff. Update state lives here; main.mjs only provides
// app/paths/notify hooks through ctx.

import { get as httpGet } from 'http';
import { get as httpsGet } from 'https';
import { join, dirname } from 'path';
import { unlink, readFileSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import { spawn } from 'child_process';

export function createUpdateService(ctx) {
  const {
    app,
    appRoot,
    envConfig,
    verifyUpdateManifest,
    downloadToFile,
    sendToRenderer,
    onQuitRequested,
  } = ctx;

  let updateState = { status: 'idle', progress: 0, version: '', error: '' };
  let downloadedUpdate = null;
  // The only manifest the download/install chain may trust: set exclusively by
  // checkForUpdate() after verifyUpdateManifest() succeeds. The renderer can
  // never influence it, so a renderer compromise cannot steer downloads.
  let verifiedManifest = null;

  function fetchJson(url) {
    return new Promise((resolvePromise, rejectPromise) => {
      const getter = url.startsWith('https:') ? httpsGet : httpGet;
      const request = getter(url, { headers: { 'User-Agent': 'ComfyUI-Agent-Updater' } }, response => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          const next = new URL(response.headers.location, url);
          if (next.protocol !== 'https:') return rejectPromise(new Error('Update manifest redirect must use HTTPS'));
          return fetchJson(next.toString()).then(resolvePromise, rejectPromise);
        }
        if (response.statusCode !== 200) return rejectPromise(new Error(`Update manifest request failed: HTTP ${response.statusCode}`));
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { body += chunk; });
        response.on('end', () => { try { resolvePromise(JSON.parse(body)); } catch { rejectPromise(new Error('Update manifest is not valid JSON')); } });
      });
      request.on('error', rejectPromise);
    });
  }

  function fetchBytes(url) {
    return new Promise((resolvePromise, rejectPromise) => {
      const getter = url.startsWith('https:') ? httpsGet : httpGet;
      const request = getter(url, { headers: { 'User-Agent': 'ComfyMuse-Updater' } }, response => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          const next = new URL(response.headers.location, url);
          if (next.protocol !== 'https:') return rejectPromise(new Error('Update redirect must use HTTPS'));
          return fetchBytes(next.toString()).then(resolvePromise, rejectPromise);
        }
        if (response.statusCode !== 200) return rejectPromise(new Error(`Update signature request failed: HTTP ${response.statusCode}`));
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolvePromise(Buffer.concat(chunks)));
      });
      request.on('error', rejectPromise);
    });
  }

  function assertHttpsUrl(value, label = 'URL') {
    let url;
    try { url = new URL(String(value || '')); } catch { throw new Error(`${label} is not a valid URL`); }
    if (url.protocol !== 'https:') throw new Error(`${label} must use HTTPS`);
    return url.toString();
  }

  async function fetchSignedManifest(url) {
    const [manifestBytes, signatureBytes] = await Promise.all([fetchBytes(url), fetchBytes(`${url}.sig`)]);
    const signature = signatureBytes.toString('utf8').trim();
    if (!verifyUpdateManifest(manifestBytes, signature)) throw new Error('Update manifest signature verification failed.');
    try { return JSON.parse(manifestBytes.toString('utf8')); } catch { throw new Error('Update manifest is not valid JSON'); }
  }

  function semverParts(version) {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(version || ''));
    return match ? [Number(match[1]), Number(match[2]), Number(match[3]), match[4] || ''] : null;
  }
  function compareVersions(left, right) {
    const a = semverParts(left); const b = semverParts(right);
    if (!a || !b) return 0;
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
    if (!a[3] && b[3]) return 1;
    if (a[3] && !b[3]) return -1;
    return String(a[3]).localeCompare(String(b[3]));
  }

  async function checkForUpdate() {
    const channel = envConfig.COMFY_AGENT_UPDATE_CHANNEL === 'preview' ? 'preview' : 'stable';
    updateState = { status: 'checking', progress: 0, version: '', error: '' };
    try {
      let manifest;
      if (envConfig.COMFY_AGENT_UPDATE_MANIFEST_URL) {
        manifest = await fetchSignedManifest(assertHttpsUrl(envConfig.COMFY_AGENT_UPDATE_MANIFEST_URL, '更新清单地址'));
      } else {
        const releases = await fetchJson('https://api.github.com/repos/xueLan-io/comfyui-agent/releases?per_page=20');
        const release = releases.find(item => channel === 'preview' ? item.prerelease : !item.prerelease);
        const asset = release?.assets?.find(item => item.name === `manifest-${channel}.json`);
        if (!asset?.browser_download_url) throw new Error('No release manifest is available for the selected channel.');
        manifest = await fetchSignedManifest(asset.browser_download_url);
      }
      verifiedManifest = manifest;
      const available = compareVersions(manifest.version, app.getVersion()) > 0;
      const runtimeCompatible = manifest.runtimeVersion === 'electron-33';
      updateState = { status: available ? (runtimeCompatible ? 'available' : 'full-required') : 'latest', progress: 0, version: manifest.version || '', error: '', manifest, runtimeCompatible };
      return updateState;
    } catch (error) {
      updateState = { status: 'error', progress: 0, version: '', error: error.message };
      throw error;
    }
  }

  async function downloadUpdate() {
    // Ignore any renderer-supplied manifest: only the signature-verified one
    // recorded by checkForUpdate() may drive a download (prevents the renderer
    // from steering the updater to attacker-chosen content).
    const manifest = verifiedManifest;
    if (!manifest) throw new Error('No verified update is available. Check for updates first.');
    if (manifest.runtimeVersion && manifest.runtimeVersion !== 'electron-33') throw new Error('This release changes the Electron runtime; download the full portable package instead.');
    if (!manifest?.updatePackage?.url) throw new Error('No compatible application update is available.');
    const version = String(manifest.version || '');
    if (!/^[A-Za-z0-9._-]+$/.test(version)) throw new Error('Update manifest version is not a safe file name.');
    const target = join(app.getPath('temp'), `comfy-agent-update-${version}.zip`);
    updateState = { ...updateState, status: 'downloading', progress: 0, error: '' };
    const urls = [manifest.updatePackage.url, ...(manifest.updatePackage.urls || [])].filter(Boolean).map(url => assertHttpsUrl(url, '更新包地址'));
    let lastError;
    for (const url of urls) {
      try {
        await downloadToFile(url, target, progress => {
          updateState = { ...updateState, status: 'downloading', progress: Math.round((progress.percent || 0) * 100) };
          sendToRenderer('app:update-progress', updateState);
        });
        lastError = null;
        break;
      } catch (error) { lastError = error; }
    }
    if (lastError) throw lastError;
    const digest = createHash('sha256').update(readFileSync(target)).digest('hex');
    if (digest.toLowerCase() !== String(manifest.updatePackage.sha256).toLowerCase()) {
      await unlink(target).catch(() => {});
      throw new Error('Update package integrity check failed.');
    }
    downloadedUpdate = { path: target, manifest };
    updateState = { ...updateState, status: 'ready', progress: 100 };
    return updateState;
  }

  function installUpdate() {
    if (!downloadedUpdate) throw new Error('Download an update before installing it.');
    const updater = join(dirname(process.execPath), 'ComfyUI-Agent-Updater.exe');
    const launcher = join(dirname(process.execPath), 'ComfyMuseLauncher.exe');
    if (!existsSync(updater) || !existsSync(launcher)) throw new Error('The portable updater is not installed.');
    spawn(updater, ['--package', downloadedUpdate.path, '--app-dir', appRoot, '--launcher', launcher, '--pid', String(process.pid)], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    updateState = { ...updateState, status: 'installing' };
    onQuitRequested();
    app.quit();
    return updateState;
  }

  return {
    checkForUpdate,
    downloadUpdate,
    installUpdate,
    getState: () => updateState,
  };
}

export function registerUpdateIpc(ctx) {
  const { ipcMain, service } = ctx;
  ipcMain.handle('app:update-check', () => service.checkForUpdate());
  ipcMain.handle('app:update-download', () => service.downloadUpdate());
  ipcMain.handle('app:update-install', () => service.installUpdate());
  ipcMain.handle('app:update-state', () => service.getState());
}
