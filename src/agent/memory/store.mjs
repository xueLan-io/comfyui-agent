import { access, copyFile, mkdir, readFile, rename, writeFile } from 'fs/promises';
import { dirname, join } from 'node:path';

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
      const tmp = `${this.filePath}.tmp`;
      await writeFile(tmp, content);
      await rename(tmp, this.filePath);
    });
    return this._savePromise;
  }

  flush() { return this.save(); }
  commit() { return this.save(); }
}
