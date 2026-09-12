import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';

import type { ObjectInfoResponse } from './client.ts';
import type { ExecutionOutcome, WaitOptions } from './ws.ts';

/**
 * A fake ComfyUI server for the desktop demo mode.
 *
 * Purpose: the desktop app must be fully usable with ComfyUI not running —
 * "打开就能用". This speaks the same HTTP routes as the real server
 * (docs/research/2026-landscape.md §8) over a real local socket, so the agent's
 * ComfyClient runs unmodified. `/view` returns a generated SVG instead of a
 * diffusion output, clearly labelled as such.
 *
 * This is a demo convenience, not a test double: the offline test suite keeps
 * using its in-process fixture fetch.
 */

export interface DemoServer {
  baseUrl: string;
  close(): Promise<void>;
}

export function startDemoServer(options: { objectInfoPath: string }): Promise<DemoServer> {
  const objectInfo = JSON.parse(
    readFileSync(options.objectInfoPath, 'utf8'),
  ) as ObjectInfoResponse;

  let promptCounter = 0;
  const history = new Map<string, { outputs: Record<string, unknown>; status: unknown }>();

  const server = createServer((req, res) => {
    route(req, res, objectInfo, history, () => {
      const number = ++promptCounter;
      return { id: `demo-${String(number).padStart(3, '0')}`, number };
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

function route(
  req: IncomingMessage,
  res: ServerResponse,
  objectInfo: ObjectInfoResponse,
  history: Map<string, { outputs: Record<string, unknown>; status: unknown }>,
  nextPrompt: () => { id: string; number: number },
): void {
  const url = new URL(req.url ?? '/', 'http://demo.local');
  const path = url.pathname;
  const method = (req.method ?? 'GET').toUpperCase();

  const json = (body: unknown, status = 200): void => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  if (method === 'GET' && path === '/object_info') return json(objectInfo);
  if (method === 'GET' && path === '/system_stats') {
    return json({
      system: { comfyui_version: 'demo-0.0.0', python_version: '3.12 (demo)', os: 'demo' },
      devices: [
        {
          name: 'Demo Render Device',
          type: 'cuda',
          vram_total: 8 * 1024 ** 3,
          vram_free: 6 * 1024 ** 3,
        },
      ],
    });
  }
  if (method === 'GET' && path === '/queue') return json({ queue_running: [], queue_pending: [] });
  if (method === 'GET' && path === '/models/checkpoints') {
    const enumValues = getCheckpointNames(objectInfo);
    return json(enumValues.length > 0 ? enumValues : ['demo_checkpoint.safetensors']);
  }
  if (method === 'POST' && path === '/prompt') {
    const prompt = nextPrompt();
    history.set(prompt.id, {
      outputs: {
        '7': { images: [{ filename: `${prompt.id}_00001_.png`, subfolder: '', type: 'output' }] },
      },
      status: { status_str: 'success', completed: true },
    });
    return json({ prompt_id: prompt.id, number: prompt.number, node_errors: {} });
  }
  if (method === 'GET' && path === `/history/${url.pathname.split('/').pop() ?? ''}`) {
    const id = path.split('/').pop() ?? '';
    const entry = history.get(id);
    if (!entry) return json({}, 404);
    return json({ [id]: entry });
  }
  if (method === 'GET' && path === '/view') {
    const filename = url.searchParams.get('filename') ?? 'demo.png';
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
    res.end(svgFor(filename));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: `demo server has no route: ${method} ${path}` }));
}

function getCheckpointNames(objectInfo: ObjectInfoResponse): string[] {
  const loader = objectInfo['CheckpointLoaderSimple'];
  const spec = loader?.input?.required?.['ckpt_name'];
  if (Array.isArray(spec) && Array.isArray(spec[0])) {
    return (spec[0] as unknown[]).filter((v): v is string => typeof v === 'string');
  }
  return [];
}

/** Deterministic pleasant gradient seeded by the filename. */
function svgFor(filename: string): string {
  let hash = 7;
  for (const ch of filename) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const hue1 = hash % 360;
  const hue2 = (hue1 + 70 + ((hash >> 8) % 120)) % 360;
  const cx = ((hash >> 3) % 380) + 60;
  const cy = ((hash >> 5) % 380) + 60;
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">',
    '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">',
    `<stop offset="0" stop-color="hsl(${hue1},62%,46%)"/>`,
    `<stop offset="1" stop-color="hsl(${hue2},66%,28%)"/>`,
    '</linearGradient></defs>',
    '<rect width="512" height="512" fill="url(#g)"/>',
    `<circle cx="${cx}" cy="${cy}" r="150" fill="rgba(255,255,255,0.10)"/>`,
    `<circle cx="${512 - cx}" cy="${512 - cy}" r="90" fill="rgba(0,0,0,0.10)"/>`,
    `<text x="50%" y="50%" text-anchor="middle" font-family="monospace" font-size="20" fill="rgba(255,255,255,0.88)">${escapeXml(filename)}</text>`,
    '<text x="50%" y="56%" text-anchor="middle" font-family="monospace" font-size="13" fill="rgba(255,255,255,0.55)">demo render — not a diffusion output</text>',
    '</svg>',
  ].join('');
}

function escapeXml(text: string): string {
  return text.replace(/[<>&'"]/g, (c) =>
    c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : c === "'" ? '&apos;' : '&quot;',
  );
}

/**
 * WebSocket stand-in for demo runs.
 *
 * Resolves after a short, progress-annotated delay so the desktop timeline
 * shows the same progress path a real run produces. Structurally satisfies the
 * ComfySocket surface the tool context expects (waitForResult + close).
 */
export class DemoSocket {
  async waitForResult(promptId: string, options: WaitOptions = {}): Promise<ExecutionOutcome> {
    const total = 20;
    const steps = [0.15, 0.4, 0.65, 0.85, 1];
    for (const fraction of steps) {
      await delay(260 + (fraction * 300) | 0);
      options.onProgress?.({
        node: '5',
        value: Math.max(1, Math.round(fraction * total)),
        max: total,
        fraction,
      });
    }
    return {
      promptId,
      status: 'success',
      outputs: {
        '7': {
          images: [
            {
              filename: `${promptId}_00001_.png`,
              subfolder: '',
              type: 'output',
            },
          ],
        },
      },
      cachedNodes: [],
      durationMs: 2200,
    };
  }

  close(): void {}
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
