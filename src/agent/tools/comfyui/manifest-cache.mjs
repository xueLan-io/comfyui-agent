import { resolve, normalize } from 'node:path';

function cacheKey(workflowName, workflowDir) {
  return `${normalize(resolve(workflowDir))}::${normalize(String(workflowName))}`;
}

export function createManifestCache({ resolveManifest, statFile, resolveFile = async ({ workflowName }) => workflowName, ttlMs = 300000, staleWhileRevalidate = false, clock = () => Date.now(), metrics } = {}) {
  const entries = new Map();
  const pending = new Map();

  async function get(workflowName, workflowDir, options = {}) {
    const key = cacheKey(workflowName, workflowDir);
    if (!options.refresh && pending.has(key)) return pending.get(key);
    const load = (async () => {
      const filePath = await resolveFile({ workflowName, workflowDir, key });
      const fileStat = await statFile(filePath);
      const cached = entries.get(key);
       const fresh = cached && clock() - cached.createdAt < (options.ttlMs ?? ttlMs);
       if (!options.refresh && cached && cached.filePath === filePath && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size && fresh) {
         cached.lastAccessAt = clock();
         metrics?.increment('cache.hit'); return cached.manifest;
       }
       if (!options.refresh && staleWhileRevalidate && cached && cached.filePath === filePath && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size) {
         void get(workflowName, workflowDir, { ...options, refresh: true, _background: true }).catch(() => {});
         cached.lastAccessAt = clock();
         metrics?.increment('cache.stale'); return cached.manifest;
       }
      metrics?.increment(options.refresh ? 'cache.refresh' : 'cache.miss');
      const manifest = await resolveManifest({ workflowName, workflowDir, filePath, key, refresh: Boolean(options.refresh) });
       const now = clock();
      entries.set(key, {
        key, workflowDir, workflowName, filePath,
        mtimeMs: fileStat.mtimeMs, size: fileStat.size, manifest,
        createdAt: now, lastAccessAt: now,
      });
      return manifest;
    })();
    pending.set(key, load);
    try { return await load; }
    catch (error) { throw error; }
    finally { pending.delete(key); }
  }

  return {
    get,
    invalidate(workflowName, workflowDir) { entries.delete(cacheKey(workflowName, workflowDir)); },
    clear() { entries.clear(); pending.clear(); },
    size() { return entries.size; },
  };
}
