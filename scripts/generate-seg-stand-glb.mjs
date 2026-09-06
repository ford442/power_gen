#!/usr/bin/env node
/**
 * Generates src/public/assets/seg/stand.glb — focus-only showroom stand
 * (four posts + cradle; no rollers). Run: npm run generate:stand-glb
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { box, merge, writePlaceholderGlb } from './lib/seg-placeholder-glb.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'src', 'public', 'assets', 'seg', 'stand.glb');

// Posts sit on the base plate (y≈−2.85) and meet the housing plinth (y≈−2.55).
const postY = -2.62;
const postH = 0.36;
const span = 5.4;
const standMesh = merge([
  box(-span, postY, -span, 0.42, postH, 0.42),
  box(span, postY, -span, 0.42, postH, 0.42),
  box(-span, postY, span, 0.42, postH, 0.42),
  box(span, postY, span, 0.42, postH, 0.42),
  box(0, -2.48, 0, 11.2, 0.1, 11.2),
  box(0, -2.42, 0, 10.4, 0.08, 0.28),
  box(0, -2.42, 0, 0.28, 0.08, 10.4)
]);

const result = writePlaceholderGlb(OUT, {
  generator: 'power_gen generate-seg-stand-glb',
  rootName: 'seg_stand_root',
  meshName: 'stand',
  mesh: standMesh,
  extras: {
    power_gen: {
      role: 'stand',
      materialRingIndex: 13.0,
      anchors: [
        { name: 'stand_origin', position: [0, -2.55, 0] }
      ]
    }
  },
  includeKtx2: true,
  albedoRgb: [90, 92, 97]
});

console.log(
  `[generate-seg-stand-glb] wrote ${OUT} ` +
  `(${result.vertexCount} verts, ${result.bytes} bytes, ktx2=${result.ktx2})`
);
