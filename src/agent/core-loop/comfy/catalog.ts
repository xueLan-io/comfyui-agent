import type { ComfyClient } from './client.ts';
import { ObjectInfoIndex } from './objectInfo.ts';

/**
 * Lazily loads and caches the node catalogue for the lifetime of a process.
 *
 * `/object_info` is large and is not needed for every run (a run that only calls
 * `server_status` should not pay for it), so loading is deferred to first use and
 * then shared. One snapshot per process — see ADR 0003 for the staleness tradeoff.
 */
export class NodeCatalogService {
  private index: ObjectInfoIndex | undefined;
  private loading: Promise<ObjectInfoIndex> | undefined;
  private readonly client: ComfyClient;

  constructor(client: ComfyClient) {
    this.client = client;
  }

  /** The catalogue, fetching it on first call. Concurrent callers share one fetch. */
  async ensure(): Promise<ObjectInfoIndex> {
    if (this.index) return this.index;
    if (this.loading) return this.loading;

    this.loading = this.client
      .getObjectInfo()
      .then((raw) => {
        const index = new ObjectInfoIndex(raw);
        this.index = index;
        return index;
      })
      .finally(() => {
        this.loading = undefined;
      });

    return this.loading;
  }

  /** Already-loaded catalogue, or undefined. Lets sync paths avoid a fetch. */
  peek(): ObjectInfoIndex | undefined {
    return this.index;
  }
}
