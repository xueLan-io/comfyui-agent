import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

export function isVideoFilename(name) {
  return /\.(mp4|webm|mov|mkv|avi)$/i.test(name);
}

export async function resolveFfmpeg() {
  if (process.env.COMFY_FFMPEG_PATH) return process.env.COMFY_FFMPEG_PATH;
  const command = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(command, ['ffmpeg'], { encoding: 'utf8' });
  if (result.status === 0 && result.stdout) {
    return result.stdout.split(/\r?\n/)[0].trim() || null;
  }
  return null;
}

export async function composeVideo({ frames, outputPath, fps = 24, ffmpegPath, signal, timeoutMs = 120000 }) {
  const ffmpeg = ffmpegPath || await resolveFfmpeg();
  if (!ffmpeg) throw new Error('未找到 ffmpeg，无法合成视频');

  const paths = frames.map((frame, index) => ({ path: typeof frame === 'string' ? frame : frame.path, index }))
    .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' }) || a.index - b.index)
    .map(frame => frame.path);
  const listContent = paths.map(path => `file '${path.replace(/'/g, "'\\''").replaceAll('\\', '/')}'`).join('\n');

  const tempDir = await mkdtemp(join(tmpdir(), 'comfy-video-'));
  const listPath = join(tempDir, 'list.txt');
  try {
    await writeFile(listPath, `${listContent}\n`, 'utf8');
    await new Promise((resolve, reject) => {
      const child = spawn(ffmpeg, ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-vf', `fps=${fps},format=yuv420p`, '-c:v', 'libx264', '-movflags', '+faststart', outputPath]);
      let stderr = '';
      let timer;
      const stop = reason => {
        child.kill('SIGTERM');
        reject(new Error(reason));
      };
      if (signal) {
        if (signal.aborted) return stop('视频合成已取消');
        signal.addEventListener('abort', () => stop('视频合成已取消'), { once: true });
      }
      timer = setTimeout(() => stop('ffmpeg 合成视频超时'), timeoutMs);
      child.stderr.on('data', chunk => {
        stderr += chunk.toString();
      });
      child.on('error', error => reject(new Error(`ffmpeg 启动失败：${error.message}`)));
      child.on('close', code => {
        clearTimeout(timer);
        if (code === 0) {
          resolve();
        } else {
          const tail = stderr.trim().slice(-500);
          reject(new Error(tail ? `ffmpeg 合成视频失败：${tail}` : 'ffmpeg 合成视频失败'));
        }
      });
    });
    return outputPath;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
