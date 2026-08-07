import { spawn, spawnSync } from 'child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { get as httpGet } from 'http';
import { get as httpsGet } from 'https';
import { dirname, join, resolve } from 'path';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8188';

function normalizeBaseUrl(value) {
  const url = new URL(value || DEFAULT_BASE_URL);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('ComfyUI URL must use http or https');
  return url.toString().replace(/\/+$/, '');
}

export function killProcessTree(child, platform = process.platform) {
  if (!child?.pid) return false;

  if (platform === 'win32') {
    const result = spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 8000,
    });
    if (result.status === 0) return true;
  }

  try {
    return child.kill('SIGTERM');
  } catch {
    return false;
  }
}

export function hasPortableLayout(root) {
  return existsSync(join(root, 'python_embeded', 'python.exe'))
    && existsSync(join(root, 'ComfyUI', 'main.py'));
}

export function findPortableRoot(...startDirs) {
  const visited = new Set();

  for (const startDir of startDirs.filter(Boolean)) {
    let current = resolve(startDir);
    for (;;) {
      const key = current.toLowerCase();
      if (!visited.has(key)) {
        visited.add(key);
        if (hasPortableLayout(current)) return current;
      }

      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  return '';
}

export class ComfyUIManager {
  constructor({ startDirs = [], baseUrl = DEFAULT_BASE_URL, onStatus, killTree = killProcessTree, startupLockPath = '' } = {}) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.portableRoot = findPortableRoot(...startDirs);
    this.onStatus = onStatus || (() => {});
    this.killTree = killTree;
    this.startupLockPath = startupLockPath;
    this.startupLockHeld = false;
    this.process = null;
    this.startPromise = null;
    this.shuttingDown = false;
    this.logTail = [];
    this.state = {
      status: 'checking',
      message: '正在检测 ComfyUI...',
      managed: false,
      baseUrl: this.baseUrl,
      portableRoot: this.portableRoot,
    };
  }

  get workflowDir() {
    if (!this.portableRoot) return '';
    return join(this.portableRoot, 'ComfyUI', 'user', 'default', 'workflows');
  }

  getState() {
    return { ...this.state };
  }

  setPortableRoot(root) {
    const resolvedRoot = root ? resolve(root) : '';
    if (resolvedRoot !== this.portableRoot && this.process) this.stopOwned();
    this.portableRoot = resolvedRoot && hasPortableLayout(resolvedRoot) ? resolvedRoot : '';
    this.state = { ...this.state, portableRoot: this.portableRoot };
    return this.portableRoot;
  }

  redetectRoot(startDirs) {
    this.portableRoot = findPortableRoot(...startDirs);
    this.state = { ...this.state, portableRoot: this.portableRoot };
    return this.portableRoot;
  }

  setBaseUrl(value) {
    const nextBaseUrl = normalizeBaseUrl(value);
    if (nextBaseUrl !== this.baseUrl && this.process) this.stopOwned();
    this.baseUrl = nextBaseUrl;
    this.state = { ...this.state, baseUrl: this.baseUrl };
    return this.baseUrl;
  }

  setStartupLockPath(filePath) {
    this.startupLockPath = filePath || '';
    if (this.startupLockPath) {
      try { mkdirSync(dirname(this.startupLockPath), { recursive: true }); } catch {}
    }
  }

  async refreshState() {
    const healthy = await this.checkHealth(2000);
    if (healthy) {
      if (this.state.status !== 'ready') {
        this._setState('ready', this.process ? '本地 ComfyUI 已启动' : 'ComfyUI 已连接');
      }
    } else if (this.state.status === 'ready') {
      this._setState('disconnected', 'ComfyUI 连接已断开');
    }
    return this.getState();
  }

  _setState(status, message, extra = {}) {
    this.state = {
      ...this.state,
      ...extra,
      status,
      message,
      managed: Boolean(this.process),
      portableRoot: this.portableRoot,
    };
    this.onStatus(this.getState());
  }

  async checkHealth(timeoutMs = 1500) {
    return new Promise(resolveHealth => {
      let settled = false;
      const finish = healthy => {
        if (settled) return;
        settled = true;
        resolveHealth(healthy);
      };

      const requestGet = this.baseUrl.startsWith('https:') ? httpsGet : httpGet;
      const request = requestGet(`${this.baseUrl}/system_stats`, response => {
        response.resume();
        finish(response.statusCode >= 200 && response.statusCode < 300);
      });
      request.once('error', () => finish(false));
      request.setTimeout(timeoutMs, () => {
        request.destroy();
        finish(false);
      });
    });
  }

  async ensureStarted({ timeoutMs = 120000 } = {}) {
    if (this.startPromise) return this.startPromise;

    this.startPromise = this._ensureStarted(timeoutMs).finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async _ensureStarted(timeoutMs) {
    this._setState('checking', '正在检测 ComfyUI...');
    if (await this.checkHealth()) {
      if (this.shuttingDown) {
        this._setState('stopped', 'ComfyUI 已停止');
        return this.getState();
      }
      this._setState('ready', 'ComfyUI 已连接');
      return this.getState();
    }

    if (this.shuttingDown) {
      this._setState('stopped', 'ComfyUI 已停止');
      return this.getState();
    }

    if (!this.portableRoot) {
      this._setState('error', '未找到内置 ComfyUI 和 Python 运行环境');
      return this.getState();
    }

    if (!this.process) {
      const lock = this._acquireStartupLock();
      if (!lock.acquired) {
        const recovered = await this._waitForHealthy(timeoutMs);
        if (recovered) {
          this._setState('ready', 'ComfyUI 已连接（其他实例启动）');
          return this.getState();
        }
        this._setState('error', '已有其他 ComfyUI 实例正在启动或占用此连接');
        return this.getState();
      }
      this._spawnProcess();
    }
    this._setState('starting', '正在启动本地 ComfyUI...');

    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (this.shuttingDown) {
        this.stopOwned();
        this._setState('stopped', 'ComfyUI 已停止');
        return this.getState();
      }
      if (!this.process) break;
      if (await this.checkHealth(2000)) {
        this._setState('ready', '本地 ComfyUI 已启动');
        return this.getState();
      }
      await new Promise(resolvePromise => setTimeout(resolvePromise, 1000));
    }

    const detail = this.logTail.at(-1);
    this._setState('error', detail ? `ComfyUI 启动失败：${detail}` : 'ComfyUI 启动超时');
    return this.getState();
  }

  _spawnProcess() {
    const pythonPath = join(this.portableRoot, 'python_embeded', 'python.exe');
    const args = [
      '-s',
      'ComfyUI\\main.py',
      '--windows-standalone-build',
      '--enable-manager',
    ];

    const child = spawn(pythonPath, args, {
      cwd: this.portableRoot,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.process = child;
    this.logTail = [];

    const collect = chunk => {
      const lines = chunk.toString('utf-8').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      this.logTail.push(...lines);
      if (this.logTail.length > 30) this.logTail.splice(0, this.logTail.length - 30);
    };

    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', error => {
      this.logTail.push(error.message);
      this.process = null;
      if (!this.shuttingDown) this._setState('error', `ComfyUI 启动失败：${error.message}`);
      this._releaseStartupLock();
    });
    child.once('exit', code => {
      this.process = null;
      if (!this.shuttingDown && this.state.status !== 'error') {
        this._setState('stopped', `ComfyUI 已停止${code == null ? '' : `（退出码 ${code}）`}`);
      }
      this._releaseStartupLock();
    });
  }

  stopOwned({ permanent = false } = {}) {
    this.shuttingDown = permanent;
    const ownedProcess = this.process;
    this.process = null;
    if (!ownedProcess) {
      this._releaseStartupLock();
      return false;
    }
    const stopped = this.killTree(ownedProcess);
    this._releaseStartupLock();
    return stopped;
  }

  async _waitForHealthy(timeoutMs) {
    const deadline = Date.now() + Math.min(timeoutMs, 15000);
    while (Date.now() < deadline) {
      if (await this.checkHealth(1000)) return true;
      await new Promise(resolvePromise => setTimeout(resolvePromise, 500));
    }
    return false;
  }

  _acquireStartupLock() {
    if (!this.startupLockPath || this.startupLockHeld) return { acquired: true };
    try {
      const fd = openSync(this.startupLockPath, 'wx');
      writeFileSync(fd, JSON.stringify({ pid: process.pid, root: this.portableRoot, baseUrl: this.baseUrl }));
      closeSync(fd);
      this.startupLockHeld = true;
      return { acquired: true };
    } catch (error) {
      if (error.code !== 'EEXIST') return { acquired: false };
      let record;
      try { record = JSON.parse(readFileSync(this.startupLockPath, 'utf8')); } catch { return { acquired: false }; }
      try {
        process.kill(Number(record.pid), 0);
        return { acquired: false };
      } catch (probeError) {
        if (probeError.code !== 'ESRCH') return { acquired: false };
        try { unlinkSync(this.startupLockPath); } catch {}
        return this._acquireStartupLock();
      }
    }
  }

  _releaseStartupLock() {
    if (!this.startupLockPath || !this.startupLockHeld) return;
    try { unlinkSync(this.startupLockPath); } catch {}
    this.startupLockHeld = false;
  }
}
