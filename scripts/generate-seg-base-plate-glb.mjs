#!/usr/bin/env node
/**
 * Generates src/public/assets/seg/base-plate.glb — focus-only floor plate
 * below the housing plinth. Run: npm run generate:base-plate-glb
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { box, writePlaceholderGlb } from './lib/seg-placeholder-glb.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'src', 'public', 'assets', 'seg', 'base-plate.glb');

// Housing plinth is 12.5×0.38 at y≈−2.55. Plate is larger and lower.
const plateMesh = box(0, -2.85, 0, 14.0, 0.12, 14.0);

const result = writePlaceholderGlb(OUT, {
  generator: 'power_gen generate-seg-base-plate-glb',
  rootName: 'seg_base_plate_root',
  meshName: 'base_plate',
  mesh: plateMesh,
  extras: {
    power_gen: {
      role: 'base_plate',
      materialRingIndex: 13.0,
      anchors: [
        { name: 'base_plate_origin', position: [0, -2.85, 0] }
      ]
    }
  },
  includeKtx2: false
});

console.log(
  `[generate-seg-base-plate-glb] wrote ${OUT} ` +
  `(${result.vertexCount} verts, ${result.bytes} bytes)`
);
