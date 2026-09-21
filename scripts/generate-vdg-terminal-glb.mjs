#!/usr/bin/env node
/**
 * Generates src/public/assets/quanta/vdg-terminal.glb — the Van de Graaff's
 * sphere terminal, insulating column, belt run and discharge electrode, as a
 * focus-only prop. Run: npm run generate:vdg-terminal-glb
 *
 * Why this bench (ADR-0005 WS1, epic #203 WS B): the VDG is the one apparatus in
 * the lab whose *shape* is the explanation — a charge carried up a moving belt
 * onto an isolated sphere, with a gap to a grounded electrode. The procedural
 * stand-in draws that as shared cylinder instances, which reads as a stack of
 * cans; a real sphere on a column makes the mechanism legible at a glance.
 *
 * Dimensions track `VDG.columnHeightM` (1.05 m) and `VDG.gapM` (0.05 m) from
 * physics/constants.json, and `buildVdgMesh` in
 * src/devices/quanta/van-de-graaff.ts, so the CAD and the procedural fallback
 * occupy the same space. Device-local units, origin at the bench floor plane,
 * Y up.
 *
 * Low-poly on purpose: a 14×7 sphere plus five cylinders and two boxes, which
 * lands around 40 KB — inside the ~50 KB placeholder budget with headroom, since
 * the sphere is the one part that would grow if someone bumped the segment
 * counts. The belt is two flat slabs, not a loop: a real loop needs a torus and
 * buys nothing at focus distance.
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { box, cylinder, merge, sphere, writePlaceholderGlb } from './lib/seg-placeholder-glb.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'src', 'public', 'assets', 'quanta', 'vdg-terminal.glb');

/** physics/constants.json → VDG.columnHeightM */
const COLUMN_H = 1.05;
/** physics/constants.json → VDG.gapM */
const GAP_M = 0.05;
/** Same placement as buildVdgMesh: the terminal sits at h * 0.55. */
const TERMINAL_Y = COLUMN_H * 0.55;
/** Same as buildVdgMesh's electrode offset. */
const ELECTRODE_X = GAP_M * 3 + 0.18;
const SPHERE_R = 0.26;

const vdgMesh = merge([
  // Base plate + foot.
  box(0, -0.58, 0, 0.62, 0.05, 0.62),
  cylinder(0, -0.53, 0, 0.17, 0.08, 14),
  // Insulating column, up to just inside the sphere.
  cylinder(0, (-0.49 + TERMINAL_Y) / 2, 0, 0.075, TERMINAL_Y + 0.49, 14, { caps: false }),
  // Belt: two flat runs either side of the column, lower brush to upper brush.
  box(0.085, -0.05, 0, 0.018, 0.9, 0.16),
  box(-0.085, -0.05, 0, 0.018, 0.9, 0.16),
  // Lower (charging) and upper (collecting) brush combs.
  cylinder(0, -0.44, 0, 0.11, 0.05, 12),
  cylinder(0, TERMINAL_Y - SPHERE_R + 0.02, 0, 0.09, 0.04, 12),
  // The terminal itself.
  sphere(0, TERMINAL_Y, 0, SPHERE_R, 14, 7),
  // Grounded discharge electrode across the gap, on its own post.
  sphere(ELECTRODE_X + SPHERE_R, TERMINAL_Y, 0, 0.07, 10, 5),
  cylinder(ELECTRODE_X + SPHERE_R, TERMINAL_Y * 0.5 - 0.29, 0, 0.03, TERMINAL_Y + 0.58, 10)
]);

const result = writePlaceholderGlb(OUT, {
  generator: 'power_gen generate-vdg-terminal-glb',
  rootName: 'vdg_terminal_root',
  meshName: 'vdg_terminal',
  mesh: vdgMesh,
  extras: {
    power_gen: {
      role: 'vdg_terminal',
      deviceId: 'vdg',
      // Ring 11 is structural aluminium — the right base for a polished terminal.
      materialRingIndex: 11.0,
      anchors: [
        { name: 'terminal_centre', position: [0, TERMINAL_Y, 0] },
        { name: 'spark_gap', position: [ELECTRODE_X * 0.5 + SPHERE_R, TERMINAL_Y, 0] },
        { name: 'lower_brush', position: [0, -0.44, 0] }
      ]
    }
  }
});

console.log(
  `[generate-vdg-terminal-glb] wrote ${OUT} ` +
  `(${result.vertexCount} verts, ${result.bytes} bytes)`
);
