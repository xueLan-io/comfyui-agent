import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function createTempDataDir(prefix = 'comfy-agent-test-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return { dir, dispose: () => rm(dir, { recursive: true, force: true }) };
}
