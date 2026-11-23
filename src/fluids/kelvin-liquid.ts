/**
 * Kelvin's water dropper as a liquid scene for the MLS-MPM solver (ADR-0022,
 * docs/FLUIDS.md → Kelvin).
 *
 * What is simulated is the two streams of drops between the drip tips and the
 * collectors: each drop leaves with the charge its induction ring gives it,
 * falls under gravity, and feels the rings and the collectors — conductors at
 * the potentials the plant computes. Near breakdown the collector under a
 * stream, which carries the stream's own sign, turns the drops away, and what
 * no longer lands no longer charges it: the share that does land is read back
 * and handed to the plant (`kelvinCollectionEff`).
 *
 * Break-up is not resolved. A drop is one particle of the Rayleigh–Plateau
 * drop's volume, released at the Rayleigh–Plateau rate; nothing pinches off.
 *
 * Everything here is SI and local to the solver's box. Pure: no GPU, no DOM.
 */
import { DEVICE_FLUIDS } from '../../generated/device-fluids.js';
import { KELVIN_CONSTANTS } from '../../generated/physics-constants.js';
import { KELVIN_APPARATUS, KELVIN_COLLECTOR_MOUTH_Y } from '../kelvin-layout.js';
import {
  KELVIN_MIN_DRIVE, KELVIN_MOUTH_SQUARE, KELVIN_TIP_SPREAD, kelvinDropChargeC, kelvinDropperConductors, kelvinDrops
} from '../physics/kelvin-dropper.js';
import {
  mpmWaterConfig, validateMpmConfig,
  type MpmConductor, type MpmConfig, type MpmEmitter, type MpmSink, type MpmTier
} from './mpm-params.js';

// The drops' own physics is shared with the WebGL2 fallback's CPU drops.
export {
  KELVIN_EFFICIENCY_MIN_DROPS, KELVIN_EFFICIENCY_WINDOW_S, KELVIN_MIN_DRIVE, KelvinEfficiency, RAYLEIGH_PLATEAU_WAVELENGTH,
  kelvinDropChargeC, kelvinDrops, rayleighLimitC, type KelvinDrops
} from '../physics/kelvin-dropper.js';

/** Metres per scene unit on the Kelvin bench (physics/constants.json `kelvin.metresPerSceneUnit`). */
export const KELVIN_METRES_PER_SCENE_UNIT: number = KELVIN_CONSTANTS.METRES_PER_SCENE_UNIT;
/** Simulated seconds per displayed second: 1 — the drops fall through the plant's potential on the plant's clock. */
export const KELVIN_LIQUID_TIME_SCALE: number = KELVIN_CONSTANTS.LIQUID_TIME_SCALE;

/**
 * The bench's budgets are its `fluid` block in physics/devices.json: one size
 * at every tier. Drops do not meet, so a coarse grid costs nothing in
 * accuracy; ~17 drops are in the air at full drive, more while some hover at
 * their rings.
 */
export const KELVIN_MAX_DROPS: number = DEVICE_FLUIDS.kelvin.tiers.low.particles;

export interface KelvinLiquidScene {
  config: MpmConfig;
  /** Substeps per displayed frame at 60 Hz. */
  substepsPerFrame: number;
  /** Simulated seconds per displayed second. */
  timeScale: number;
  /** Drip-tip mouths, m, box-local: [left, right]. */
  tips: [[number, number, number], [number, number, number]];
  /** Centres of the induction rings and of the collectors' mouths, m, box-local: [left, right]. */
  rings: [[number, number, number], [number, number, number]];
  mouths: [[number, number, number], [number, number, number]];
  ringRadiusM: number;
  ringWireM: number;
  collectorRadiusM: number;
  /** Fall from a tip to a collector's mouth, m. */
  fallM: number;
  /** Bore of the drip tips, m. */
  nozzleDiameterM: number;
  /** Sinks: [0] the column under the left collector's mouth, [1] the right's, [2] the floor — what missed. */
  sinks: MpmSink[];
  /** Scene position of the box corner, bench-local, and scene units per metre. */
  origin: [number, number, number];
  scale: number;
}

/**
 * Size the box, the grid and the step. The catalog gives every solver tier
 * the same budget: drops that do not touch are exact on any grid, so there is
 * nothing a finer one would buy. A particle is given the Rayleigh–Plateau
 * drop's volume, so one particle is one drop.
 */
export function kelvinLiquidScene(nozzleDiameterM: number = KELVIN_CONSTANTS.NOZZLE_DIAMETER_M, tier: MpmTier = 'low'): KelvinLiquidScene {
  const budget = DEVICE_FLUIDS.kelvin.tiers[tier];
  const a = KELVIN_APPARATUS;
  const m = KELVIN_METRES_PER_SCENE_UNIT;
  const drops = kelvinDrops(1, nozzleDiameterM);
  // Bench-local scene extents of the box: past both rings, from under the mouths to over the tips.
  const halfX = a.columnX + a.ringRadius + 0.8;
  const halfZ = a.ringRadius + 0.8;
  const bottomY = KELVIN_COLLECTOR_MOUTH_Y - 0.9;
  const topY = a.tipY + 0.5;
  const size = [2 * halfX * m, (topY - bottomY) * m, 2 * halfZ * m];
  const h = Math.cbrt((size[0] * size[1] * size[2]) / budget.grid ** 3);
  const gridN: [number, number, number] = [Math.ceil(size[0] / h) + 4, Math.ceil(size[1] / h) + 4, Math.ceil(size[2] / h) + 4];
  // The step: a drop at 4 m/s (a fall plus a kick from a ring) crosses under half a cell.
  const maxSpeedMS = 6;
  const dtWanted = (0.5 * h) / 4;
  // (Up to 16 a frame: the grid is small, and the drops keep the plant's clock.)
  const substepsPerFrame = Math.min(16, Math.max(1, Math.ceil(KELVIN_LIQUID_TIME_SCALE / 60 / dtWanted - 1e-9)));
  const dt = KELVIN_LIQUID_TIME_SCALE / 60 / substepsPerFrame;
  const config = mpmWaterConfig(gridN, h, dt, budget.particles, {
    restDensity: KELVIN_CONSTANTS.WATER_DENSITY,
    maxSpeedMS,
    // One particle = one drop: this many drop volumes make a cell.
    particlesPerCell: (h * h * h) / drops.volumeM3
  });
  const errors = validateMpmConfig(config);
  if (errors.length) throw new Error(`kelvinLiquidScene: ${errors.join('; ')}`);

  // Box-local metres of a bench-local scene point; the box is centred on the bench in x and z.
  const cx = (gridN[0] * h) / 2;
  const cz = (gridN[2] * h) / 2;
  const y0 = 2 * h - bottomY * m; // box y of scene y = 0: the floor sink's slab is under bottomY
  const at = (x: number, y: number): [number, number, number] => [cx + x * m, y0 + y * m, cz];
  const mouths: [[number, number, number], [number, number, number]] = [at(-a.columnX, KELVIN_COLLECTOR_MOUTH_Y), at(a.columnX, KELVIN_COLLECTOR_MOUTH_Y)];
  const collectorRadiusM = a.collectorRadius * m;
  // A square of the mouth's area stands in for the round mouth.
  const half = collectorRadiusM * KELVIN_MOUTH_SQUARE;
  // The whole column under the mouth, down to the floor: sinks are tested once
  // a frame, and a drop falls up to a few centimetres between two tests — a
  // thin slab at the mouth would be stepped over. One that goes all the way
  // down in a frame is stopped by the floor inside the column and taken next.
  const mouthSink = (c: readonly number[]): MpmSink => ({ min: [c[0] - half, 0, c[2] - half], max: [c[0] + half, c[1] + 0.6 * h, c[2] + half] });
  return {
    config,
    substepsPerFrame,
    timeScale: KELVIN_LIQUID_TIME_SCALE,
    tips: [at(-a.columnX, a.tipY), at(a.columnX, a.tipY)],
    rings: [at(-a.columnX, a.ringY), at(a.columnX, a.ringY)],
    mouths,
    ringRadiusM: a.ringRadius * m,
    ringWireM: a.ringWire * m,
    collectorRadiusM,
    fallM: (a.tipY - KELVIN_COLLECTOR_MOUTH_Y) * m,
    nozzleDiameterM,
    sinks: [
      mouthSink(mouths[0]),
      mouthSink(mouths[1]),
      // Whatever reaches the floor anywhere else has missed them. (Listed last:
      // the columns above take what is theirs first.)
      { min: [0, 0, 0], max: [gridN[0] * h, 2.5 * h, gridN[2] * h] }
    ],
    origin: [-cx / m, -y0 / m, -cz / m],
    scale: 1 / m
  };
}

/**
 * The two drip tips at a drive setting and an induction potential. The left
 * ring is the positive one, so the left stream is negative and the right
 * positive. `volts` is what the rings stand at: the plant's voltage plus any
 * coupled seed.
 */
export function kelvinEmitters(scene: KelvinLiquidScene, drive: number, volts: number): MpmEmitter[] {
  if (!(drive >= KELVIN_MIN_DRIVE)) return [];
  const drops = kelvinDrops(drive, scene.nozzleDiameterM);
  const q = kelvinDropChargeC(volts, drops.radiusM);
  const tip = (centre: [number, number, number], chargeC: number): MpmEmitter => ({
    centre,
    direction: [0, -1, 0],
    radiusM: scene.nozzleDiameterM / 2,
    speedMS: drops.jetSpeedMS,
    spread: KELVIN_TIP_SPREAD,
    chargeC
  });
  return [tip(scene.tips[0], -q), tip(scene.tips[1], q)];
}

/**
 * The four conductors at the plant's potential, in the box's frame: each
 * induction ring at ±V and the rim of each collector at the opposite ring's
 * (`kelvinDropperConductors`).
 */
export function kelvinConductors(scene: KelvinLiquidScene, volts: number): MpmConductor[] {
  return kelvinDropperConductors(scene, volts);
}

/** What landed and what missed, from the solver's per-sink totals: the collectors are sinks 0 and 1, the floor 2. */
export function kelvinLanded(sunkBy: readonly number[]): { landed: number; missed: number } {
  return { landed: (sunkBy[0] ?? 0) + (sunkBy[1] ?? 0), missed: sunkBy[2] ?? 0 };
}
