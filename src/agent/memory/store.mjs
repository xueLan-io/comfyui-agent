import { randomUUID } from 'node:crypto';
import { access, copyFile, mkdir, readFile, rename, rm, writeFile } from 'fs/promises';
import { dirname, join } from 'node:path';

// Windows: an antivirus scan or a briefly held handle can make the atomic
// rename fail transiently with EPERM/EBUSY. Retry a few times before giving up
// so concurrent saves do not flake; the tmp file is removed on final failure.
const RENAME_RETRIES = 5;
const RENAME_BACKOFF_MS = 25;

async function renameWithRetry(tmpPath, targetPath) {
  let lastError;
  for (let attempt = 0; attempt < RENAME_RETRIES; attempt++) {
    try {
      await rename(tmpPath, targetPath);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < RENAME_RETRIES - 1 && ['EPERM', 'EBUSY', 'EEXIST'].includes(error.code)) {
        await new Promise(resolve => setTimeout(resolve, RENAME_BACKOFF_MS * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

export class JSONFileStore {
  constructor(dir, filename, defaults = {}) {
    this.filePath = join(dir, filename);
    this.data = null;
    this.defaults = defaults;
    this._savePromise = Promise.resolve();
  }

  async load() {
    try {
      const raw = JSON.parse(await readFile(this.filePath, 'utf-8'));
      this.data = { ...this.defaults, ...(raw && typeof raw === 'object' ? raw : {}) };
    } catch {
      this.data = { ...this.defaults };
      await this._backupCorrupt();
    }
    return this.data;
  }

  async _backupCorrupt() {
    try {
      await access(this.filePath);
    } catch {
      return;
    }
    try {
      await copyFile(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
    } catch {}
  }

  get(key) {
    return this.data?.[key];
  }

  set(key, value) {
    if (!this.data) this.data = { ...this.defaults };
    this.data[key] = value;
  }

  async save() {
    const content = JSON.stringify(this.data, null, 2);
    this._savePromise = this._savePromise.catch(() => {}).then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.${randomUUID()}.tmp`;
      await writeFile(tmp, content);
      try {
        await renameWithRetry(tmp, this.filePath);
      } catch (error) {
        await rm(tmp, { force: true }).catch(() => {});
        throw error;
      }
    });
    return this._savePromise;
  }

  flush() { return this.save(); }
  commit() { return this.save(); }
}
