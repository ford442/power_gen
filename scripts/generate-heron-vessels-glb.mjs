#!/usr/bin/env node
/**
 * Generates src/public/assets/lab/heron-vessels.glb — the plinth, vessel end
 * flanges, open catch basin and jet nozzle of Heron's Fountain, as a focus-only
 * prop. Run: npm run generate:heron-vessels-glb
 *
 * Why this bench (ADR-0005 WS1, epic #203 WS B): the fountain works because two
 * of its vessels are **sealed** and one is open to the air. The procedural
 * stand-in draws all four as identical shared cylinders, so nothing on screen
 * says which is which — the one fact the whole hydraulic argument rests on.
 * Flanged lids on the sealed pair, and a rimmed open bowl on the catch basin,
 * say it in geometry.
 *
 * **Why flanges and a bowl rather than glass walls.** `segEnhanced` culls back
 * faces, so a vessel drawn as a wall around a shared cylinder would put an
 * opaque near wall between the camera and the water column the flow-path
 * particle pass draws inside it. Marking the ends leaves every interior open.
 * The shared instance cylinder is r = 0.8, so the flanges are r ≈ 1.0: proud
 * enough to read as a flange, not so wide as to become a shelf.
 *
 * **Classic preset only.** Heron's five layout presets do not differ by scale:
 * `tower` and `wide` move the vessels to different heights and re-route the
 * plumbing, so one baked GLB cannot cover them the way the SEG's `worldScale`
 * covers its presets. `parseGltfHeronVesselsEnabled()` therefore returns false
 * unless the active preset is `classic`, and the other four keep the procedural
 * vessels they already had. `setHeronLayoutPreset()` re-runs
 * `ensureGltfPropsForView()` so switching away disposes this prop rather than
 * leaving the classic CAD standing in a tower layout.
 *
 * Dimensions track `PRESET_DEFS.classic` in src/heron-layout.ts — vessels at
 * y = -2.2 / -0.4 / 2.0 / 4.8, platform at -2.65, jet apex 6.1, risers at
 * x = ±1.6. **Device-local render units, not metres**: the shared instance
 * cylinder is r = 0.8, h = 2.5 (`generateCylinder(0.8, 2.5, 64)` in
 * setup-geometry.ts), so the bench is drawn at a size that reads next to its
 * neighbours rather than at 1 unit = 1 m. The device uniform supplies world
 * position and rotation, so this GLB bakes at scale 1 with no Y offset.
 *
 * Low poly on purpose: eleven cylinders and one box at 6–10 segments, well
 * inside the ~50 KB placeholder budget.
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { box, cylinder, merge, writePlaceholderGlb } from './lib/seg-placeholder-glb.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'src', 'public', 'assets', 'lab', 'heron-vessels.glb');

/** src/heron-layout.ts → PRESET_DEFS.classic. */
const SUMP_Y = -2.2;      // bottom reservoir, open to the drain
const LOWER_Y = -0.4;     // sealed supply vessel
const MID_Y = 2.0;        // sealed air vessel
const BASIN_Y = 4.8;      // open catch basin the jet falls back into
const PLATFORM_Y = -2.65;
const APEX_Y = 6.1;
/** Plumbing risers sit at x = ±1.6 — the flanges must stay clear of them. */
const RISER_X = 1.6;

/** Shared instance cylinder: generateCylinder(0.8, 2.5, 64). */
const CYL_R = 0.8;
const CYL_HALF = 1.25;
/** A flange reads as a flange at ~1.25× the body it sits on. */
const FLANGE_R = CYL_R * 1.26;
const FLANGE_T = 0.18;

const DISC_SEG = 10;
const RIM_SEG = 10;

/** A closed end: a solid disc across the top or bottom of a vessel. */
const lid = (y, radius = FLANGE_R) => cylinder(0, y, 0, radius, FLANGE_T, DISC_SEG);
/** An open end: a collar with nothing across it. */
const rim = (y, radius, height = 0.22) =>
  cylinder(0, y, 0, radius, height, RIM_SEG, { caps: false });

const heronMesh = merge([
  // Slate plinth under the whole stack.
  box(0, PLATFORM_Y - 0.22, 0, 4.1, 0.44, 4.1),

  // Bottom reservoir: floor closed, top OPEN — it drains to atmosphere.
  lid(SUMP_Y - CYL_HALF + FLANGE_T * 0.5, 1.02),
  rim(SUMP_Y + CYL_HALF - 0.11, 1.04, 0.22),

  // Sealed supply vessel: both ends closed. This is the pressurised one.
  lid(LOWER_Y - CYL_HALF + FLANGE_T * 0.5),
  lid(LOWER_Y + CYL_HALF - FLANGE_T * 0.5),
  // Tie rods between the two lids — how a sealed vessel is actually held shut,
  // and a silhouette cue you can read from the side. Clear of the ±1.6 risers.
  cylinder(0.98, LOWER_Y, 0, 0.07, CYL_HALF * 2, 6),
  cylinder(-0.98, LOWER_Y, 0, 0.07, CYL_HALF * 2, 6),

  // Sealed air vessel above it: both ends closed again.
  lid(MID_Y - CYL_HALF + FLANGE_T * 0.5),
  lid(MID_Y + CYL_HALF - FLANGE_T * 0.5),
  cylinder(0.98, MID_Y, 0, 0.07, CYL_HALF * 2, 6),
  cylinder(-0.98, MID_Y, 0, 0.07, CYL_HALF * 2, 6),

  // Catch basin: floor closed, and a wide flared rim. The one vessel that is
  // NOT sealed, and the only place the jet can fall back into.
  lid(BASIN_Y - CYL_HALF + FLANGE_T * 0.5, 1.12),
  rim(BASIN_Y + CYL_HALF - 0.16, 1.24, 0.32),

  // Jet nozzle rising out of the basin toward the apex the flow model uses.
  cylinder(0, BASIN_Y + CYL_HALF + 0.42, 0, 0.075, 0.9, 10)
]);

const result = writePlaceholderGlb(OUT, {
  generator: 'power_gen generate-heron-vessels-glb',
  rootName: 'heron_vessels_root',
  meshName: 'heron_vessels',
  mesh: heronMesh,
  extras: {
    power_gen: {
      role: 'heron_vessels',
      deviceId: 'heron',
      // Ring 12 is the coil-former / dielectric ring — a non-metal base, so the
      // flanges read as the vessel's own material, not as the brass plumbing.
      materialRingIndex: 12.0,
      layoutPreset: 'classic',
      anchors: [
        { name: 'basin_rim', position: [0, BASIN_Y + CYL_HALF, 0] },
        { name: 'jet_apex', position: [0, APEX_Y, 0] },
        { name: 'sealed_air_vessel', position: [0, MID_Y, 0] },
        { name: 'sump_floor', position: [0, SUMP_Y - CYL_HALF, 0] },
        { name: 'supply_riser', position: [RISER_X, LOWER_Y, 0] }
      ]
    }
  }
});

console.log(
  `[generate-heron-vessels-glb] wrote ${OUT} ` +
  `(${result.vertexCount} verts, ${result.bytes} bytes)`
);
