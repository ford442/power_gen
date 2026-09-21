#!/usr/bin/env node
/**
 * Generates src/public/assets/quanta/thomson-stand.glb — the Thomson jumping
 * ring's plinth, laminated core, winding bobbin, rest shoulder and travel stop,
 * as a focus-only prop. Run: npm run generate:thomson-stand-glb
 *
 * Why this bench (ADR-0005 WS1, epic #203 WS B): the demonstration only reads if
 * you can see *where h = 0 is* and *where the travel stops*. The plant has both
 * as rigid stops — the ring rests on the core shoulder and cannot pass
 * `poleHeightM` — but the procedural stand-in draws the core as a stack of plain
 * shared cylinders with nothing at either datum, so the ring appears to float at
 * an arbitrary height and the settling point has nothing to settle against. A
 * shoulder wide enough for the ring to rest on, and a stop it rises to meet,
 * give both numbers a shape.
 *
 * **The ring itself stays procedural.** Its Y is `ringHeightM` straight out of
 * the plant — the one thing on this bench that moves, and baking it into static
 * CAD would nail Lenz's law to the bench. Same for the winding courses, whose
 * emissive tracks I_p, and the core glow, which tracks k(h). This prop is only
 * the parts that do not move and do not report anything.
 *
 * Dimensions track `RING_SCENE` and `buildJumpingRingMesh` in
 * src/devices/quanta/jumping-ring.ts. **Device-local render units, not metres**:
 * `RING_SCENE` is deliberately separate from the SI numbers in `JUMPING_RING`,
 * because the shared instance cylinder is r = 0.8, h = 2.5 and carries no
 * per-instance scale. The device uniform supplies world position and rotation,
 * so this GLB bakes at scale 1 with no Y offset — and it must **not** be
 * re-derived from `poleHeightM` in metres.
 *
 * The ring is a chain of tangential shared cylinders at `ringRadiusU` = 2.8, so
 * its tube half-thickness is the cylinder radius 0.8: it occupies y ± 0.8 about
 * `ringHeightM`, and spans out to r = 3.6. The shoulder and the stop are sized
 * from that, not from the ring centreline — a collar at r = 1.5 would pass
 * straight through a ring at r = 2.8 and stop nothing.
 *
 * The core is a box rather than a cylinder, at a half-width just outside the
 * procedural stack's r = 0.8, so the square corners read as laminations against
 * the round segments instead of disappearing inside them.
 *
 * Low poly on purpose: three boxes and seven cylinders at 10–14 segments,
 * inside the ~50 KB placeholder budget.
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { box, cylinder, merge, writePlaceholderGlb } from './lib/seg-placeholder-glb.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'src', 'public', 'assets', 'quanta', 'thomson-stand.glb');

/** src/devices/quanta/jumping-ring.ts → RING_SCENE (render units). */
const BASE_Y = -1.0;         // core shoulder: ringHeightM 0 rests here
const POLE_U = 12.5;         // pole run above the shoulder (maps to poleHeightM)
const POLE_BOTTOM_Y = -7.0;  // core foot, below the winding
const RING_RADIUS_U = 2.8;
const WINDING_RADIUS_U = 1.7;
/** Top of travel: buildJumpingRingMesh puts the ring here at heightNorm 1. */
const POLE_TOP = BASE_Y + POLE_U;
/** Ring tube half-thickness / outer reach — the shared cylinder's r = 0.8. */
const RING_TUBE_R = 0.8;
const COLLAR_R = RING_RADIUS_U + RING_TUBE_R * 0.5;
/** buildJumpingRingMesh puts the two winding courses at these heights. */
const COURSE_LOW_Y = POLE_BOTTOM_Y + 1.4;
const COURSE_HIGH_Y = POLE_BOTTOM_Y + 1.4 + 2.4;
/** The procedural bench plinth sits at poleBottomY - 1.6. */
const PLINTH_Y = POLE_BOTTOM_Y - 1.6;
/**
 * Half-width of the laminated stack. The procedural core is r = 0.8, so 0.88
 * leaves the corners proud and the flats flush.
 */
const CORE_HALF = 0.88;

/** Bobbin flanges bracket the winding bundle without touching the collars. */
const FLANGE_LOW_Y = COURSE_LOW_Y - 1.0;
const FLANGE_HIGH_Y = COURSE_HIGH_Y + 0.9;
const FLANGE_T = 0.35;
const FLANGE_R = WINDING_RADIUS_U + 0.85;
/** Rest shoulder: the ring's underside at h = 0 is BASE_Y - RING_TUBE_R. */
const SHOULDER_TOP_Y = BASE_Y - RING_TUBE_R;
const COLLAR_T = 0.32;
/** Travel stop: the ring's top face at h = poleHeightM. */
const STOP_BOTTOM_Y = POLE_TOP + RING_TUBE_R;
const CORE_TOP_Y = STOP_BOTTOM_Y + COLLAR_T + 0.5;

const FLANGE_SEG = 14;
const POST_SEG = 10;

const thomsonMesh = merge([
  // Bench plinth, in two tiers so the silhouette is not one slab.
  box(0, PLINTH_Y - 0.25, 0, 8.6, 0.7, 8.6),
  box(0, PLINTH_Y + 0.35, 0, 7.0, 0.5, 7.0),
  // Laminated square core, foot to just above the travel stop.
  box(0, (POLE_BOTTOM_Y + CORE_TOP_Y) * 0.5, 0,
    CORE_HALF * 2, CORE_TOP_Y - POLE_BOTTOM_Y, CORE_HALF * 2),
  // Winding bobbin: two flanges bracketing the courses, former between them.
  cylinder(0, FLANGE_LOW_Y, 0, FLANGE_R, FLANGE_T, FLANGE_SEG),
  cylinder(0, FLANGE_HIGH_Y, 0, FLANGE_R, FLANGE_T, FLANGE_SEG),
  cylinder(0, (FLANGE_LOW_Y + FLANGE_HIGH_Y) * 0.5, 0, 1.25,
    FLANGE_HIGH_Y - FLANGE_LOW_Y, FLANGE_SEG, { caps: false }),
  // Rest shoulder — this is h = 0. Wide enough for the ring to actually sit on.
  cylinder(0, SHOULDER_TOP_Y - COLLAR_T * 0.5, 0, COLLAR_R, COLLAR_T, FLANGE_SEG),
  // Travel stop at poleHeightM: the rigid stop the plant clamps against, placed
  // where the risen ring's top face meets it rather than at the centreline.
  cylinder(0, STOP_BOTTOM_Y + COLLAR_T * 0.5, 0, COLLAR_R, COLLAR_T, FLANGE_SEG),
  // Terminal posts for the supply leads at the foot.
  cylinder(-WINDING_RADIUS_U - 2.0, POLE_BOTTOM_Y - 0.4, 0, 0.26, 1.4, POST_SEG),
  cylinder(WINDING_RADIUS_U + 2.0, POLE_BOTTOM_Y - 0.4, 0, 0.26, 1.4, POST_SEG)
]);

const result = writePlaceholderGlb(OUT, {
  generator: 'power_gen generate-thomson-stand-glb',
  rootName: 'thomson_stand_root',
  meshName: 'thomson_stand',
  mesh: thomsonMesh,
  extras: {
    power_gen: {
      role: 'thomson_stand',
      deviceId: 'jumping-ring',
      // Ring 12 is the laminated-steel / former ring the transformer core uses —
      // the same magnetic-circuit material, drawn the same way.
      materialRingIndex: 12.0,
      anchors: [
        { name: 'rest_shoulder', position: [0, BASE_Y, 0] },
        { name: 'travel_stop', position: [0, POLE_TOP, 0] },
        { name: 'winding_centre', position: [0, (COURSE_LOW_Y + COURSE_HIGH_Y) * 0.5, 0] }
      ]
    }
  }
});

console.log(
  `[generate-thomson-stand-glb] wrote ${OUT} ` +
  `(${result.vertexCount} verts, ${result.bytes} bytes)`
);
