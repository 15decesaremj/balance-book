import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const outputPath = path.resolve('assets', 'balance-book.ico');
const sizes = [16, 24, 32, 48, 64, 128, 256];

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

const crc32 = (buffer) => {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

const pngChunk = (name, data) => {
  const type = Buffer.from(name, 'ascii');
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  type.copy(header, 4);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([type, data])), 0);
  return Buffer.concat([header, data, checksum]);
};

const encodePng = (size, rgba) => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  const scanlines = Buffer.alloc((size * 4 + 1) * size);
  for (let row = 0; row < size; row += 1) {
    const outputOffset = row * (size * 4 + 1);
    scanlines[outputOffset] = 0;
    rgba.copy(scanlines, outputOffset + 1, row * size * 4, (row + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(scanlines, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
};

const insidePolygon = (x, y, points) => {
  let inside = false;
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
    const [xi, yi] = points[index];
    const [xj, yj] = points[previous];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

const segmentDistance = (x, y, x1, y1, x2, y2) => {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;
  const amount = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / lengthSquared));
  return Math.hypot(x - (x1 + amount * dx), y - (y1 + amount * dy));
};

const sample = (x, y) => {
  const roundedX = Math.max(Math.abs(x) - 0.66, 0);
  const roundedY = Math.max(Math.abs(y) - 0.66, 0);
  const insideBackground = Math.hypot(roundedX, roundedY) <= 0.22;
  if (!insideBackground) return [0, 0, 0, 0];
  const mix = Math.max(0, Math.min(1, (x + y + 2) / 4));
  let color = [
    Math.round(36 - 19 * mix),
    Math.round(88 - 62 * mix),
    Math.round(137 - 88 * mix),
    255,
  ];
  const leftPage = [
    [-0.57, -0.38],
    [-0.07, -0.22],
    [-0.07, 0.56],
    [-0.57, 0.4],
  ];
  const rightPage = [
    [0.07, -0.22],
    [0.57, -0.38],
    [0.57, 0.4],
    [0.07, 0.56],
  ];
  if (insidePolygon(x, y, leftPage)) color = [247, 251, 255, 255];
  if (insidePolygon(x, y, rightPage)) color = [232, 242, 251, 255];
  if (Math.abs(x) < 0.032 && y > -0.24 && y < 0.58) color = [185, 209, 229, 255];
  const trend = [
    [-0.45, 0.25, -0.2, 0.02],
    [-0.2, 0.02, 0.04, 0.16],
    [0.04, 0.16, 0.43, -0.23],
  ];
  if (trend.some((line) => segmentDistance(x, y, ...line) < 0.052)) {
    color = [85, 229, 194, 255];
  }
  if (
    insidePolygon(x, y, [
      [0.24, -0.26],
      [0.48, -0.29],
      [0.45, -0.05],
    ])
  ) {
    color = [85, 229, 194, 255];
  }
  return color;
};

const render = (size) => {
  const rgba = Buffer.alloc(size * size * 4);
  const samples = size <= 32 ? 5 : 3;
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      const total = [0, 0, 0, 0];
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const x = ((column + (sx + 0.5) / samples) / size) * 2 - 1;
          const y = ((row + (sy + 0.5) / samples) / size) * 2 - 1;
          const color = sample(x, y);
          for (let channel = 0; channel < 4; channel += 1) total[channel] += color[channel];
        }
      }
      const offset = (row * size + column) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        rgba[offset + channel] = Math.round(total[channel] / (samples * samples));
      }
    }
  }
  return encodePng(size, rgba);
};

const images = sizes.map((size) => ({ size, buffer: render(size) }));
const pngOutputDirectory = process.env.BALANCE_BOOK_ICON_PNG_OUTPUT;
if (pngOutputDirectory) {
  fs.mkdirSync(pngOutputDirectory, { recursive: true });
  for (const image of images) {
    fs.writeFileSync(path.join(pngOutputDirectory, `balance-book-${image.size}.png`), image.buffer);
  }
}
const header = Buffer.alloc(6 + images.length * 16);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(images.length, 4);
let offset = header.length;
for (const [index, image] of images.entries()) {
  const entry = 6 + index * 16;
  header[entry] = image.size === 256 ? 0 : image.size;
  header[entry + 1] = image.size === 256 ? 0 : image.size;
  header[entry + 2] = 0;
  header[entry + 3] = 0;
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(image.buffer.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += image.buffer.length;
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
const icon = Buffer.concat([header, ...images.map((image) => image.buffer)]);
if (!fs.existsSync(outputPath) || !fs.readFileSync(outputPath).equals(icon)) {
  fs.writeFileSync(outputPath, icon);
}
process.stdout.write(`Balance Book icon ready (${icon.length} bytes)\n`);
