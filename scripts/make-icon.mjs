// Draws the Claude Kanban mark (three kanban columns on a dark rounded tile) and writes
// assets/claude-kanban.ico (16–256px) plus assets/icon-256.png. No dependencies: PNGs are
// encoded here with zlib, and the .ico simply embeds them.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");
const SIZES = [16, 24, 32, 48, 64, 128, 256];

const BG = [18, 19, 16, 255]; // ink-900
const EDGE = [41, 42, 37, 255]; // ink-700
const BARS = [
  { x: 0.17, w: 0.17, top: 0.2, color: [242, 169, 59, 255] }, // amber — running
  { x: 0.415, w: 0.17, top: 0.32, color: [235, 232, 222, 255] }, // bone — queued
  { x: 0.66, w: 0.17, top: 0.47, color: [111, 168, 114, 255] }, // moss — done
];

/** Coverage of a pixel by a rounded rect, sampled 3×3 for smooth edges. */
function roundedCoverage(px, py, x0, y0, x1, y1, r) {
  let hits = 0;
  for (let sy = 0; sy < 3; sy++) {
    for (let sx = 0; sx < 3; sx++) {
      const x = px + (sx + 0.5) / 3;
      const y = py + (sy + 0.5) / 3;
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      const cx = Math.min(Math.max(x, x0 + r), x1 - r);
      const cy = Math.min(Math.max(y, y0 + r), y1 - r);
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r * r + 1e-9) hits++;
    }
  }
  return hits / 9;
}

function blend(dst, i, color, a) {
  if (a <= 0) return;
  const sa = (color[3] / 255) * a;
  for (let c = 0; c < 3; c++) dst[i + c] = Math.round(dst[i + c] * (1 - sa) + color[c] * sa);
  dst[i + 3] = Math.round(Math.min(255, dst[i + 3] + 255 * sa));
}

function render(size) {
  const px = new Uint8Array(size * size * 4); // transparent
  const pad = size * 0.055;
  const radius = size * 0.22;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const tile = roundedCoverage(x, y, pad, pad, size - pad, size - pad, radius);
      if (tile > 0) {
        blend(px, i, EDGE, tile);
        const inner = roundedCoverage(x, y, pad + size * 0.02, pad + size * 0.02, size - pad - size * 0.02, size - pad - size * 0.02, radius * 0.92);
        blend(px, i, BG, inner);
      }
      for (const bar of BARS) {
        const bx0 = size * bar.x;
        const bx1 = size * (bar.x + bar.w);
        const by0 = size * bar.top;
        const by1 = size * 0.8;
        const cov = roundedCoverage(x, y, bx0, by0, bx1, by1, Math.min(size * 0.045, (bx1 - bx0) / 2));
        blend(px, i, bar.color, cov);
      }
    }
  }
  return px;
}

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const images = SIZES.map((size) => ({ size, png: png(size, render(size)) }));

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(images.length, 4);
let offset = 6 + images.length * 16;
const entries = images.map(({ size, png: data }) => {
  const e = Buffer.alloc(16);
  e[0] = size >= 256 ? 0 : size;
  e[1] = size >= 256 ? 0 : size;
  e[4] = 1; // colour planes
  e.writeUInt16LE(32, 6); // bits per pixel
  e.writeUInt32BE(0, 8);
  e.writeUInt32LE(data.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += data.length;
  return e;
});

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "claude-kanban.ico"), Buffer.concat([header, ...entries, ...images.map((i) => i.png)]));
writeFileSync(join(OUT, "icon-256.png"), images.find((i) => i.size === 256).png);
console.log(`wrote ${join(OUT, "claude-kanban.ico")} (${SIZES.join(", ")}px) and icon-256.png`);
