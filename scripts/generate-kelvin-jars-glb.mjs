#!/usr/bin/env node
/**
 * Generates src/public/assets/lab/kelvin-jars.glb — the header reservoir,
 * spouts, drip tips, insulating pillars and collection jars of Kelvin's
 * Thunderstorm, as a focus-only prop. Run: npm run generate:kelvin-jars-glb
 *
 * Why this bench (ADR-0005 WS1, epic #203 WS B): the dropper's argument is that
 * the two sides are fed from **one shared supply** and are **electrically
 * isolated** from the bench and from each other. The procedural stand-in shows
 * neither — there is no reservoir the water comes from, and the collection
 * buckets stand on nothing. A single header tank with two spouts, and jars on
 * insulating pillars, put both on screen without touching the plant.
 *
 * Dimensions track `buildKelvinInstances` / `buildKelvinBucketInstances` /
 * `buildKelvinRingInstances` / `buildKelvinTubeInstances` in
 * src/device-mesh-layouts.ts — columns at x = ±2.5, cans at y = 4.8 / 1.5 /
 * -2.5, buckets at -3.4, induction rings at 5.6, support beam at 6.4.
 * **Device-local render units, not metres**: the shared instance cylinder is
 * r = 0.8, h = 2.5 and the induction torus is major 1.0 / minor 0.14
 * (setup-geometry.ts), so the bench is drawn at a size that reads next to its
 * neighbours rather than at 1 unit = 1 m. The device uniform supplies world
 * position and rotation, so this GLB bakes at scale 1 with no Y offset.
 *
 * The jars sit **under** the buckets, not around them: `segEnhanced` culls back
 * faces, so a jar tall enough to enclose a can would put an opaque near wall
 * between the camera and the can it is meant to show. A short jar with the can
 * standing in it reads as a receiver on a stand and hides nothing.
 *
 * The drip tips are r = 0.16 on the column axis, inside the induction torus's
 * 0.86 inner radius, so the stream falls through the ring rather than past it —
 * and they stop 0.13 above the torus rather than through it.
 *
 * The induction rings themselves stay procedural: they are torus instances
 * tagged `MATERIAL_KELVIN_RING` (ring index 100) that the fragment shader draws
 * as ring geometry and glows with the accumulated charge, so baking them into
 * static CAD would freeze the one part of the bench telling you the physics.
 *
 * Low poly on purpose: ten cylinders and two boxes at 10–12 segments, inside
 * the ~50 KB placeholder budget.
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { box, cylinder, merge, writePlaceholderGlb } from './lib/seg-placeholder-glb.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'src', 'public', 'assets', 'lab', 'kelvin-jars.glb');

/** src/device-mesh-layouts.ts → the two column centres. */
const COLUMN_X = 2.5;
/** Collection bucket centre; the shared cylinder is h = 2.5, so its foot is here. */
const BUCKET_Y = -3.4;
const BUCKET_FOOT_Y = BUCKET_Y - 1.25;
/** Induction ring height, and the torus minor radius that sets its top. */
const RING_Y = 5.6;
const RING_MINOR = 0.14;
/** Top support beam; the reservoir sits clear above it. */
const BEAM_Y = 6.4;

const WALL_SEG = 12;
const DISC_SEG = 10;

const BENCH_Y = -6.4;
const PILLAR_TOP = BUCKET_FOOT_Y - 0.55;
const JAR_R = 1.16;
const JAR_H = 1.35;
const JAR_Y = PILLAR_TOP + JAR_H * 0.5;
const TANK_Y = BEAM_Y + 1.6;
const TANK_FLOOR_Y = TANK_Y - 0.55;
const TIP_TOP_Y = RING_Y + RING_MINOR + 0.13 + 0.26;

/**
 * One side: insulating pillar, then a short open jar the collection can stands
 * in. Open at both ends — the floor disc is separate, and nothing caps the top.
 */
function collector(x) {
  const pillarBottom = BENCH_Y + 0.2;
  return merge([
    // Insulating pillar — why the collector can hold a charge at all.
    cylinder(x, (pillarBottom + PILLAR_TOP) * 0.5, 0, 0.36, PILLAR_TOP - pillarBottom, DISC_SEG),
    cylinder(x, JAR_Y, 0, JAR_R, JAR_H, WALL_SEG, { caps: false }),
    cylinder(x, PILLAR_TOP + 0.08, 0, JAR_R, 0.16, DISC_SEG),
    cylinder(x, JAR_Y + JAR_H * 0.5 - 0.09, 0, JAR_R * 1.06, 0.18, WALL_SEG, { caps: false })
  ]);
}

/** Spout from the tank floor down to the drip tip above the induction ring. */
function spout(x) {
  const top = TANK_FLOOR_Y;
  const bottom = TIP_TOP_Y;
  return merge([
    cylinder(x, (top + bottom) * 0.5, 0, 0.1, top - bottom, DISC_SEG),
    // The drip tip: nozzle bore is what sets the drop rate in the real demo.
    cylinder(x, bottom - 0.13, 0, 0.16, 0.26, DISC_SEG)
  ]);
}

const kelvinMesh = merge([
  // Bench slab under both columns.
  box(0, BENCH_Y, 0, 8.0, 0.4, 3.2),
  collector(-COLUMN_X),
  collector(COLUMN_X),
  // Shared header reservoir above the support beam — the supply both streams
  // come from, and the reason the two sides are not two separate experiments.
  box(0, TANK_Y, 0, 6.8, 1.1, 2.0),
  spout(-COLUMN_X),
  spout(COLUMN_X)
]);

const result = writePlaceholderGlb(OUT, {
  generator: 'power_gen generate-kelvin-jars-glb',
  rootName: 'kelvin_jars_root',
  meshName: 'kelvin_jars',
  mesh: kelvinMesh,
  extras: {
    power_gen: {
      role: 'kelvin_jars',
      deviceId: 'kelvin',
      // Ring 11 is structural aluminium / brass — the right base for tinned cans
      // and a galvanised tank, and not the copper the cross wiring uses.
      materialRingIndex: 11.0,
      anchors: [
        { name: 'reservoir', position: [0, TANK_Y, 0] },
        { name: 'left_drip', position: [-COLUMN_X, TIP_TOP_Y - 0.26, 0] },
        { name: 'right_drip', position: [COLUMN_X, TIP_TOP_Y - 0.26, 0] },
        { name: 'left_collector', position: [-COLUMN_X, BUCKET_Y, 0] },
        { name: 'right_collector', position: [COLUMN_X, BUCKET_Y, 0] }
      ]
    }
  }
});

console.log(
  `[generate-kelvin-jars-glb] wrote ${OUT} ` +
  `(${result.vertexCount} verts, ${result.bytes} bytes)`
);
