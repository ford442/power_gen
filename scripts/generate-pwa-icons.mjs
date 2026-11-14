#!/usr/bin/env node
/**
 * generate-pwa-icons.mjs — the install icons for the offline PWA (#224 §5).
 *
 * Writes `src/public/icons/icon.svg` plus 192 / 512 px PNGs from one shape list
 * (a stator hub and three rings of rollers — the SEG, abstracted), so the
 * vector and raster icons cannot drift. No image library: discs are rendered
 * with analytic edge coverage and encoded with `node:zlib`.
 *
 * Everything sits inside the central 40 %-radius circle, so the same 512 px
 * file also serves as the manifest's `maskable` icon.
 *
 * Usage: node scripts/generate-pwa-icons.mjs          (write)
 *        node scripts/generate-pwa-icons.mjs --check  (exit 1 if stale)
 */
import { deflateSync } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const OUT_DIR = 'src/public/icons';
export const PNG_SIZES = [192, 512];
const BACKGROUND = '#050a0f';

/** Unit-square shapes, painted in order: `ring` is a stroked circle, `disc` filled. */
function shapes() {
  const list = [];
  const rings = [
    { r: 0.19, n: 8, roller: 0.042, color: '#00e5ff' },
    { r: 0.28, n: 12, roller: 0.037, color: '#00c4d8' },
    { r: 0.36, n: 16, roller: 0.032, color: '#00a2b4' }
  ];
  for (const ring of rings) list.push({ kind: 'ring', cx: 0.5, cy: 0.5, r: ring.r, w: 0.008, color: '#0c3a46' });
  list.push({ kind: 'disc', cx: 0.5, cy: 0.5, r: 0.105, color: '#00e5ff' });
  list.push({ kind: 'disc', cx: 0.5, cy: 0.5, r: 0.05, color: BACKGROUND });
  for (const ring of rings) {
    for (let i = 0; i < ring.n; i++) {
      // Stagger the rings so rollers don't line up radially.
      const a = (2 * Math.PI * (i + (ring.n % 3) * 0.25)) / ring.n - Math.PI / 2;
      list.push({ kind: 'disc', cx: 0.5 + ring.r * Math.cos(a), cy: 0.5 + ring.r * Math.sin(a), r: ring.roller, color: ring.color });
    }
  }
  return list;
}

const round = (v) => Number(v.toFixed(4));

export function renderSvg() {
  const body = shapes().map((s) => s.kind === 'ring'
    ? `  <circle cx="${round(s.cx * 512)}" cy="${round(s.cy * 512)}" r="${round(s.r * 512)}" fill="none" stroke="${s.color}" stroke-width="${round(s.w * 512)}"/>`
    : `  <circle cx="${round(s.cx * 512)}" cy="${round(s.cy * 512)}" r="${round(s.r * 512)}" fill="${s.color}"/>`);
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">',
    `  <rect width="512" height="512" fill="${BACKGROUND}"/>`,
    ...body,
    '</svg>',
    ''
  ].join('\n');
}

const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));

/** RGB raster: per pixel, signed distance to each shape edge → coverage → "over". */
export function renderRgb(size) {
  const px = new Float64Array(size * size * 3);
  const bg = hex(BACKGROUND);
  for (let i = 0; i < size * size; i++) px.set(bg, i * 3);
  for (const s of shapes()) {
    const rgb = hex(s.color);
    const reach = (s.r + (s.w ?? 0)) * size + 2;
    const x0 = Math.max(0, Math.floor(s.cx * size - reach));
    const x1 = Math.min(size - 1, Math.ceil(s.cx * size + reach));
    const y0 = Math.max(0, Math.floor(s.cy * size - reach));
    const y1 = Math.min(size - 1, Math.ceil(s.cy * size + reach));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x + 0.5 - s.cx * size, y + 0.5 - s.cy * size);
        const edge = s.kind === 'ring' ? Math.abs(d - s.r * size) - (s.w * size) / 2 : d - s.r * size;
        const a = Math.min(1, Math.max(0, 0.5 - edge));
        if (!a) continue;
        const o = (y * size + x) * 3;
        for (let c = 0; c < 3; c++) px[o + c] += (rgb[c] - px[o + c]) * a;
      }
    }
  }
  return Uint8Array.from(px, (v) => Math.round(v));
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** 8-bit RGB PNG, filter 0 on every row. */
export function encodePng(size, rgb) {
  const stride = size * 3;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) Buffer.from(rgb.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/** Every icon file, keyed by repo-relative path. */
export function renderIcons() {
  const files = { [`${OUT_DIR}/icon.svg`]: Buffer.from(renderSvg()) };
  for (const size of PNG_SIZES) files[`${OUT_DIR}/icon-${size}.png`] = encodePng(size, renderRgb(size));
  return files;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const check = process.argv.includes('--check');
  const stale = [];
  for (const [rel, bytes] of Object.entries(renderIcons())) {
    const full = join(ROOT, rel);
    const same = existsSync(full) && readFileSync(full).equals(bytes);
    if (check) {
      if (!same) stale.push(rel);
      continue;
    }
    mkdirSync(join(ROOT, OUT_DIR), { recursive: true });
    if (!same) writeFileSync(full, bytes);
    console.log(`${same ? 'unchanged' : 'wrote'} ${rel} (${bytes.length} B)`);
  }
  if (stale.length) {
    console.error(`[pwa-icons] stale: ${stale.join(', ')} — run npm run generate:pwa-icons`);
    process.exit(1);
  }
  if (check) console.log('[pwa-icons] icons up to date');
}
