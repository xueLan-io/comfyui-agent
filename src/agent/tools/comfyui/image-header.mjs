import { inflateSync } from 'node:zlib';

function ascii(bytes, start, length) {
  return String.fromCharCode(...bytes.slice(start, start + length));
}

function parsePng(bytes) {
  if (bytes.length < 24 || ascii(bytes, 1, 3) !== 'PNG') return null;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const colorType = bytes[25];
  const hasAlpha = colorType === 4 || colorType === 6;
  const metadata = {};
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = ascii(bytes, offset + 4, 4);
    const dataStart = offset + 8;
    if (type === 'tEXt' && dataStart + length <= bytes.length) {
      const chunk = bytes.slice(dataStart, dataStart + length);
      const sep = chunk.indexOf(0);
      if (sep > 0) {
        const key = ascii(chunk, 0, sep);
        const text = Buffer.from(chunk.slice(sep + 1)).toString('utf-8');
        if (text) metadata[key] = text;
      }
    } else if (type === 'zTXt' && dataStart + length <= bytes.length) {
      const chunk = bytes.slice(dataStart, dataStart + length);
      const sep = chunk.indexOf(0);
      if (sep > 0) {
        const key = ascii(chunk, 0, sep);
        try {
          const text = inflateSync(chunk.slice(sep + 2)).toString('utf-8');
          if (text) metadata[key] = text;
        } catch {}
      }
    }
    offset = dataStart + length + 4;
  }
  return { format: 'png', width, height, hasAlpha, metadata };
}

function parseJpeg(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 <= bytes.length) {
    if (bytes[offset] !== 0xff) { offset++; continue; }
    const marker = bytes[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
    const length = bytes.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = bytes.readUInt16BE(offset + 5);
      const width = bytes.readUInt16BE(offset + 7);
      return { format: 'jpeg', width, height, hasAlpha: false };
    }
    offset += 2 + length;
  }
  return { format: 'jpeg', width: null, height: null, hasAlpha: false };
}

function parseGif(bytes) {
  if (bytes.length < 10 || (ascii(bytes, 0, 3) !== 'GIF')) return null;
  const width = bytes.readUInt16LE(6);
  const height = bytes.readUInt16LE(8);
  return { format: 'gif', width, height, hasAlpha: false };
}

function parseWebp(bytes) {
  if (bytes.length < 30 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') return null;
  const chunkType = ascii(bytes, 12, 4);
  if (chunkType === 'VP8 ' && bytes.length >= 30) {
    const width = bytes.readUInt16LE(26) & 0x3fff;
    const height = bytes.readUInt16LE(28) & 0x3fff;
    return { format: 'webp', width, height, hasAlpha: false };
  }
  if (chunkType === 'VP8L' && bytes.length >= 25) {
    const b0 = bytes[21];
    const b1 = bytes[22];
    const b2 = bytes[23];
    const b3 = bytes[24];
    const width = 1 + (((b1 & 0x3f) << 8) | b0);
    const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
    return { format: 'webp', width, height, hasAlpha: true };
  }
  if (chunkType === 'VP8X' && bytes.length >= 30) {
    const flags = bytes[24];
    const width = 1 + bytes[24 + 4] + (bytes[24 + 5] << 8) + (bytes[24 + 6] << 16);
    const height = 1 + bytes[27 + 4] + (bytes[27 + 5] << 8) + (bytes[27 + 6] << 16);
    return { format: 'webp', width, height, hasAlpha: Boolean(flags & 0x10) };
  }
  return { format: 'webp', width: null, height: null, hasAlpha: false };
}

function parseBmp(bytes) {
  if (bytes.length < 26 || ascii(bytes, 0, 2) !== 'BM') return null;
  const width = bytes.readInt32LE(18);
  const height = Math.abs(bytes.readInt32LE(22));
  const bitCount = bytes.readUInt16LE(28);
  return { format: 'bmp', width, height, hasAlpha: bitCount === 32 };
}

export function parseImageInfo(bytes) {
  if (!bytes || bytes.length === 0) return null;
  bytes = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return parsePng(bytes) || parseJpeg(bytes) || parseGif(bytes) || parseWebp(bytes) || parseBmp(bytes);
}
