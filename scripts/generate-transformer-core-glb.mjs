#!/usr/bin/env node
/**
 * Generates src/public/assets/quanta/transformer-core.glb — the transformer
 * bench's laminated **C-core** plus its two coil bobbins, as a focus-only prop.
 * Run: npm run generate:transformer-core-glb
 *
 * Why this bench first (ADR-0005 WS1, epic #203 WS B): the transformer's whole
 * lesson is that flux takes a *path* through iron, and the procedural stand-in
 * is a pair of coils in mid-air with no visible magnetic circuit. A C-core is
 * also the cheapest recognisable silhouette in the lab — five boxes and two
 * cylinders — so it fits the ~50 KB placeholder budget with room to spare.
 *
 * Device-local units, origin at the bench centre, Y up, +Z toward the focus
 * camera. `DEVICE_CONFIG`/plugin `defaults` place the device; this GLB knows
 * nothing about where the bench stands.
 *
 * Geometry is deliberately laminated-looking rather than a smooth loop: real
 * C-cores are stacked E/I or C laminations, and the flat faces read correctly
 * under the seg-enhanced PBR pass without needing a normal map.
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { box, cylinder, merge, writePlaceholderGlb } from './lib/seg-placeholder-glb.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'src', 'public', 'assets', 'quanta', 'transformer-core.glb');

// Matches buildTransformerMesh in src/devices/quanta/transformer.ts: the primary
// winding sits at x ≈ −0.55, the secondary at x ≈ +0.55, flux bridges at y ≈ 0.55.
const LEG_X = 0.55;
const CORE_DEPTH = 0.34;
const LEG_W = 0.2;
const YOKE_H = 0.18;
const TOP_Y = 0.62;
const BOTTOM_Y = -0.32;
const LEG_H = TOP_Y - BOTTOM_Y;

const coreMesh = merge([
  // Two vertical legs — the winding windows sit between them and the yokes.
  box(-LEG_X, (TOP_Y + BOTTOM_Y) / 2, 0, LEG_W, LEG_H, CORE_DEPTH),
  box(LEG_X, (TOP_Y + BOTTOM_Y) / 2, 0, LEG_W, LEG_H, CORE_DEPTH),
  // Top and bottom yokes close the magnetic circuit.
  box(0, TOP_Y, 0, LEG_X * 2 + LEG_W, YOKE_H, CORE_DEPTH),
  box(0, BOTTOM_Y, 0, LEG_X * 2 + LEG_W, YOKE_H, CORE_DEPTH),
  // Clamp plate under the core, so the prop has somewhere to sit on the bench.
  box(0, BOTTOM_Y - YOKE_H * 0.5 - 0.04, 0, LEG_X * 2 + LEG_W + 0.24, 0.06, CORE_DEPTH + 0.2),
  // Bobbins: the formers the windings are wound on, around each leg.
  cylinder(-LEG_X, 0.15, 0, 0.19, 0.5, 14),
  cylinder(LEG_X, 0.15, 0, 0.19, 0.5, 14)
]);

const result = writePlaceholderGlb(OUT, {
  generator: 'power_gen generate-transformer-core-glb',
  rootName: 'transformer_core_root',
  meshName: 'transformer_core',
  mesh: coreMesh,
  extras: {
    power_gen: {
      role: 'transformer_core',
      deviceId: 'transformer',
      // Ring 12 is the phenolic-ish / former slot; the registry overrides this
      // with a laminated-steel tint, but a raw import still shades sanely.
      materialRingIndex: 12.0,
      anchors: [
        { name: 'primary_axis', position: [-LEG_X, 0.15, 0] },
        { name: 'secondary_axis', position: [LEG_X, 0.15, 0] },
        { name: 'flux_bridge', position: [0, TOP_Y, 0] }
      ]
    }
  }
});

console.log(
  `[generate-transformer-core-glb] wrote ${OUT} ` +
  `(${result.vertexCount} verts, ${result.bytes} bytes)`
);
