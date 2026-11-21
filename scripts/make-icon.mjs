// Generates icon.png (128x128) with zero dependencies: a dark rounded tile with
// three staggered "chips". Re-run only when the design changes.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const W = 128, H = 128;
const pixels = new Float64Array(W * H * 4); // premultiplied-ish accumulators

const SUB = 3; // supersampling grid per axis for smooth edges
function blend(x, y, [r, g, b, a]) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  const srcA = a / SUB / SUB;
  pixels[i] += r * srcA; pixels[i + 1] += g * srcA; pixels[i + 2] += b * srcA;
  pixels[i + 3] += 255 * srcA;
}
function roundedRect(x0, y0, x1, y1, radius, color) {
  for (let py = Math.floor(y0); py < Math.ceil(y1); py++) {
    for (let px = Math.floor(x0); px < Math.ceil(x1); px++) {
      for (let sy = 0; sy < SUB; sy++) {
        for (let sx = 0; sx < SUB; sx++) {
          const x = px + (sx + 0.5) / SUB, y = py + (sy + 0.5) / SUB;
          const cx = Math.min(Math.max(x, x0 + radius), x1 - radius);
          const cy = Math.min(Math.max(y, y0 + radius), y1 - radius);
          const dx = x - cx, dy = y - cy;
          if (dx * dx + dy * dy <= radius * radius) blend(px, py, color);
        }
      }
    }
  }
}

// Tile + ring
roundedRect(4, 4, 124, 124, 28, [61, 71, 87, 255]);
roundedRect(8, 8, 120, 120, 24, [32, 36, 43, 255]);
// Three staggered chips
roundedRect(22, 44, 82, 60, 8, [76, 141, 255, 255]);
roundedRect(34, 70, 100, 86, 8, [159, 198, 255, 255]);
roundedRect(46, 96, 90, 112, 8, [230, 233, 240, 255]);

// Encode PNG (RGBA, filter 0)
const raw = Buffer.alloc(H * (1 + W * 4));
for (let y = 0; y < H; y++) {
  raw[y * (1 + W * 4)] = 0;
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4, o = y * (1 + W * 4) + 1 + x * 4;
    const a = Math.min(255, pixels[i + 3]);
    const k = a > 0 ? a / 255 : 0;
    raw[o] = Math.round(pixels[i] / (pixels[i + 3] / 255 || 1));
    raw[o + 1] = Math.round(pixels[i + 1] / (pixels[i + 3] / 255 || 1));
    raw[o + 2] = Math.round(pixels[i + 2] / (pixels[i + 3] / 255 || 1));
    raw[o + 3] = Math.round(a);
  }
}
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = buf => { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(new URL('../icon.png', import.meta.url), png);
console.log('icon.png written:', png.length, 'bytes');
