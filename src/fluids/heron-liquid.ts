/**
 * Heron's fountain as a liquid scene for the MLS-MPM solver (ADR-0022,
 * docs/FLUIDS.md → Heron).
 *
 * What is simulated is the part of the fountain you watch: the jet leaving
 * the nozzle at the plant's exit speed, rising, breaking at its top and
 * falling back onto the basin. The basin is a wide, shallow, perforated tray:
 * water splashes on it and drains through its floor. It does not fill — a
 * tray wide enough to catch the falling water (it lands up to 0.3 m off the
 * axis) holds far more than the particle budget if it is allowed to. The
 * sealed vessels and the pipes between them stay with the plant (a head ODE
 * with Bernoulli and pipe friction); their levels are not particles.
 *
 * Everything here is SI and local to the solver's box. The bench maps the box
 * into its scene with `HERON_METRES_PER_SCENE_UNIT`.
 *
 * Pure: no GPU, no DOM. The frame-graph pass (visualizer/heron-liquid-pass.ts)
 * and the tests both build their scene here.
 */
import { DEVICE_FLUIDS } from '../../generated/device-fluids.js';
import { HERON_CONSTANTS, PHYSICAL_CONSTANTS } from '../../generated/physics-constants.js';
import type { MpmSolid } from './mpm-boundary.js';
import {
  mpmDerived, mpmWaterConfig, validateMpmConfig,
  type MpmConfig, type MpmEmitter, type MpmSink, type MpmTier
} from './mpm-params.js';

/** The numbers of a layout preset the liquid needs (HeronLayout has the first three). */
export interface HeronLiquidLayout {
  headMaxM: number;
  nozzleDiameterM?: number;
  dischargeCoeff?: number;
  /** Height of the nozzle mouth above the basin it stands in, m (`heronRiserM`). Default: a stub riser. */
  riserM?: number;
}

/** Metres per scene unit on the Heron bench (physics/constants.json `heron.metresPerSceneUnit`). */
export const HERON_METRES_PER_SCENE_UNIT: number = HERON_CONSTANTS.METRES_PER_SCENE_UNIT;
/** Simulated seconds per displayed second: the liquid is shown slowed down (`heron.liquidTimeScale`). */
export const HERON_LIQUID_TIME_SCALE: number = HERON_CONSTANTS.LIQUID_TIME_SCALE;

/**
 * The basin tray under the nozzle: the floor of the solver's box, this far
 * from the axis to each side, m. The box's own walls stand in for its rim.
 */
export const HERON_TRAY = Object.freeze({ halfWidthM: 0.35 });
/** The shortest riser the box is built for, m: the nozzle has to clear the splash on the tray. */
export const HERON_MIN_RISER_M = 0.03;
/** The tray's fixed cylinder mesh is this tall in scene units (visualizer/setup-geometry.ts). */
const VESSEL_HALF_HEIGHT_SCENE = 1.25;
/** Cells across the nozzle bore a tier aims for. */
const CELLS_ACROSS_NOZZLE: Record<MpmTier, number> = { low: 1.6, default: 3.2, high: 4.8 };
/** The liquid's sound speed is held at least this many times the fastest jet. */
const SOUND_OVER_JET = 2.7;
/** Below this exit speed the nozzle only dribbles and nothing is emitted, m/s. */
export const HERON_MIN_JET_MS = 0.2;
/** Divergence of the jet at the nozzle rim (tangent of the half-angle). */
const NOZZLE_SPREAD = 0.02;

export interface HeronLiquidScene {
  tier: MpmTier;
  config: MpmConfig;
  /** Substeps per displayed frame at 60 Hz, and at most this many in one frame. */
  substepsPerFrame: number;
  /** Simulated seconds per displayed second. */
  timeScale: number;
  solids: MpmSolid[];
  sinks: MpmSink[];
  /** Centre of the nozzle mouth, m, box-local. */
  nozzle: [number, number, number];
  nozzleRadiusM: number;
  /** Top of the tray's floor, m: where falling water lands. */
  trayFloorM: number;
  /** The fastest jet the preset can make, m/s, and how high that one rises, m. */
  jetMaxMS: number;
  jetMaxHeightM: number;
  /** Layer mass (particle masses) that counts as "the jet is here" when reading its top. */
  jetThreshold: number;
}

/** Fastest exit speed a preset reaches: C_d·√(2·g·H_max), pipe friction ignored (an upper bound). */
export function heronJetMax(layout: HeronLiquidLayout): number {
  return (layout.dischargeCoeff ?? 0.35) * Math.sqrt(2 * PHYSICAL_CONSTANTS.G * layout.headMaxM);
}

/** The ballistic rise of a jet leaving at `v`: v²/2g. */
export function heronIdealJetHeight(vExitMS: number): number {
  return (vExitMS * vExitMS) / (2 * PHYSICAL_CONSTANTS.G);
}

/**
 * Size the box, the grid and the step for a preset at a tier. The cell is the
 * largest of three demands: enough cells across the nozzle, a box that fits
 * the tier's node budget, and a jet at full head that fits the particle
 * budget with room to spare for what is splashing on the tray.
 */
export function heronLiquidScene(layout: HeronLiquidLayout, tier: MpmTier = 'default'): HeronLiquidScene {
  const g = PHYSICAL_CONSTANTS.G;
  // What the bench asks of the tier: its `fluid` block in physics/devices.json.
  const budget = DEVICE_FLUIDS.heron.tiers[tier];
  const nozzleD = layout.nozzleDiameterM ?? 0.04;
  const jetMaxMS = heronJetMax(layout);
  const jetMaxHeightM = heronIdealJetHeight(jetMaxMS);

  const riserM = Math.max(HERON_MIN_RISER_M, layout.riserM ?? HERON_MIN_RISER_M);

  // Box in units of the cell h (the wall nodes on each side) plus metres (the tray, the riser, the jet).
  const widthM = (h: number): number => 2 * HERON_TRAY.halfWidthM + 4 * h;
  const heightM = (h: number): number => h + riserM + 1.2 * jetMaxHeightM + 4 * h;
  // The jet in flight at full head: Q · (time up, back down, and on down the riser), at rest density.
  const flowMax = Math.PI * (nozzleD / 2) ** 2 * jetMaxMS;
  const flightS = (2 * jetMaxMS) / g + Math.sqrt((2 * riserM) / g) + 0.1;
  let h = nozzleD / CELLS_ACROSS_NOZZLE[tier];
  h = Math.max(h, Math.cbrt((flowMax * flightS * 8) / (0.5 * budget.particles)));
  for (let i = 0; i < 4; i++) h = Math.max(h, Math.cbrt((widthM(h) ** 2 * heightM(h)) / budget.grid ** 3));
  const nx = Math.ceil(widthM(h) / h);
  const ny = Math.ceil(heightM(h) / h);

  // The step: sound at least SOUND_OVER_JET × the fastest jet, a whole number of substeps per frame.
  const dtWanted = (0.5 * h) / (SOUND_OVER_JET * jetMaxMS);
  const substepsPerFrame = Math.min(8, Math.max(1, Math.ceil(HERON_LIQUID_TIME_SCALE / 60 / dtWanted - 1e-9)));
  const dt = HERON_LIQUID_TIME_SCALE / 60 / substepsPerFrame;
  const config = mpmWaterConfig([nx, ny, nx], h, dt, budget.particles, {
    restDensity: HERON_CONSTANTS.REST_DENSITY,
    maxSpeedMS: Math.min(1.6 * jetMaxMS, (0.9 * h) / dt)
  });
  const errors = validateMpmConfig(config);
  if (errors.length) throw new Error(`heronLiquidScene(${tier}): ${errors.join('; ')}`);

  const cx = (nx * h) / 2;
  // The tray is the box floor: the wall plane at node 1.
  const trayFloorM = h;
  const nozzleY = trayFloorM + riserM;
  const nozzleRadiusM = nozzleD / 2;
  const solids: MpmSolid[] = [
    // The riser the nozzle sits on.
    { kind: 'cylinder', base: [cx, 0, cx], radiusM: Math.max(nozzleRadiusM, 1.2 * h), heightM: Math.max(1.5 * h, nozzleY - 0.5 * h) }
  ];
  const sinks: MpmSink[] = [
    // The perforated floor: water that settles onto the tray drains through it.
    { min: [0, 0, 0], max: [nx * h, trayFloorM + 0.4 * h, nx * h] }
  ];
  return {
    tier,
    config,
    substepsPerFrame,
    timeScale: HERON_LIQUID_TIME_SCALE,
    solids,
    sinks,
    nozzle: [cx, nozzleY, cx],
    nozzleRadiusM,
    trayFloorM,
    jetMaxMS,
    jetMaxHeightM,
    jetThreshold: (0.1 * Math.PI * nozzleRadiusM ** 2 * config.particlesPerCell) / (h * h)
  };
}

/** The nozzle as an emitter at the plant's exit speed; none below a dribble. */
export function heronEmitters(scene: HeronLiquidScene, vExitMS: number): MpmEmitter[] {
  if (!(vExitMS >= HERON_MIN_JET_MS)) return [];
  return [{
    centre: scene.nozzle,
    direction: [0, 1, 0],
    radiusM: scene.nozzleRadiusM,
    speedMS: Math.min(vExitMS, 1.05 * scene.jetMaxMS),
    spread: NOZZLE_SPREAD
  }];
}

/**
 * Where the box sits in the bench's scene: `origin` is the scene position of
 * the box corner, `scale` scene units per metre. `nozzleScene` is where the
 * nozzle mouth is drawn (device-local scene units).
 */
export function heronLiquidPlacement(scene: HeronLiquidScene, nozzleScene: readonly [number, number, number]): { origin: [number, number, number]; scale: number } {
  const scale = 1 / HERON_METRES_PER_SCENE_UNIT;
  return {
    origin: [nozzleScene[0] - scene.nozzle[0] * scale, nozzleScene[1] - scene.nozzle[1] * scale, nozzleScene[2] - scene.nozzle[2] * scale],
    scale
  };
}

/**
 * Height of the nozzle above the basin for a layout's drawn geometry: the
 * nozzle mouth is at `flow.apexY`, and the basin is the top face of the
 * highest vessel (instance records: x, y, z, …).
 */
export function heronRiserM(mesh: { vessels: readonly (readonly number[])[]; flow: { apexY: number } }): number {
  let top = -Infinity;
  for (const v of mesh.vessels) top = Math.max(top, v[1]);
  if (!Number.isFinite(top)) return HERON_MIN_RISER_M;
  return Math.max(HERON_MIN_RISER_M, (mesh.flow.apexY - (top + VESSEL_HALF_HEIGHT_SCENE)) * HERON_METRES_PER_SCENE_UNIT);
}

/** How long, in displayed seconds, a jet at `vExitMS` takes to reach its top. */
export function heronJetRiseDisplayS(vExitMS: number): number {
  return vExitMS / PHYSICAL_CONSTANTS.G / HERON_LIQUID_TIME_SCALE;
}

/** Rest-density volume (m³) of `count` particles of a scene. */
export function heronLiquidVolume(scene: HeronLiquidScene, count: number): number {
  return count * mpmDerived(scene.config).particleVolume;
}
