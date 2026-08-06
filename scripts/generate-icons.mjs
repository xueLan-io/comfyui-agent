import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Resvg } from '@resvg/resvg-js';

const root = process.cwd();
const sizes = [16, 32, 48, 64, 128, 256];
const svg = await readFile(join(root, 'src', 'assets', 'app-icon.svg'), 'utf8');
const outputDir = join(root, 'electron', 'generated-icons');

function buildIco(images) {
  const header = 6;
  const entry = 16;
  const dataOffset = header + entry * images.length;
  const output = Buffer.alloc(dataOffset + images.reduce((sum, image) => sum + image.data.length, 0));
  output.writeUInt16LE(0, 0);
  output.writeUInt16LE(1, 2);
  output.writeUInt16LE(images.length, 4);
  let offset = dataOffset;
  images.forEach((image, index) => {
    const at = header + index * entry;
    output[at] = image.size === 256 ? 0 : image.size;
    output[at + 1] = image.size === 256 ? 0 : image.size;
    output.writeUInt16LE(1, at + 4);
    output.writeUInt16LE(32, at + 6);
    output.writeUInt32LE(image.data.length, at + 8);
    output.writeUInt32LE(offset, at + 12);
    image.data.copy(output, offset);
    offset += image.data.length;
  });
  return output;
}

await mkdir(outputDir, { recursive: true });
const images = sizes.map(size => {
  const rendered = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render();
  return { size, data: Buffer.from(rendered.asPng()) };
});
for (const image of images) await writeFile(join(outputDir, `icon-${image.size}.png`), image.data);
await writeFile(join(root, 'electron', 'icon.ico'), buildIco(images));
console.log(`Generated ${images.length} icon sizes directly from src/assets/app-icon.svg`);
