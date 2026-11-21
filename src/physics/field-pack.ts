/**
 * Field-volume pass policy and uniform packing (ADR-0017). Pure, so
 * test:field-volume checks every layout against its WGSL struct and the gate
 * against the issue's constraints; the WebGPU pass (visualizer/field-volume-pass.ts)
 * only writes what these return.
 */

import { FIELD_BRICK, fieldVolumeResolution } from './field-volume';
import type { FieldParticlePlan } from './field-particles';

export const FIELD_STREAM_PARAMS_BYTES = 48;
export const FIELD_LINE_STYLE_BYTES = 16;
export const FIELD_SLICE_PARAMS_BYTES = 64;
export const FIELD_ISO_PARAMS_BYTES = 64;
export const FIELD_PROBE_INFO_BYTES = 16;
export const FIELD_PROBE_MAX_POINTS = 64;
/** FieldLineSegment (common/field-line-segment.wgsl). */
export const FIELD_LINE_SEGMENT_BYTES = 32;
/** Particle (field-particles.wgsl): pos + vel. */
export const FIELD_PARTICLE_BYTES = 32;

/** Segments per traced line (half forward, half backward from the seed). */
export const FIELD_SEGMENTS_PER_LINE = 48;
export const FIELD_MAX_SEEDS = 256;
export const FIELD_ISO_MAX_LEVELS = 4;

export type FieldSliceAxis = 'off' | 'x' | 'y' | 'z';
export type FieldSliceMode = 'heat' | 'arrows' | 'lic';
export const FIELD_SLICE_MODES: readonly FieldSliceMode[] = ['heat', 'arrows', 'lic'];

export interface FieldGateInput {
  enabled: boolean;
  /** WebGPU device + pipelines built. */
  ready: boolean;
  currentView: string | null | undefined;
  qualityTier: string | null | undefined;
  /** The focused bench has a catalog `fieldSources` row. */
  hasField: boolean;
}

/**
 * Focus view on a bench with a field row, `medium` tier and up. Low (and
 * critical) skip the volume and the particles entirely, and overview never
 * allocates it (#255 constraints).
 */
export function fieldVolumeGateOpen(g: FieldGateInput): boolean {
  return g.enabled
    && g.ready
    && g.hasField
    && !!g.currentView
    && g.currentView !== 'overview'
    && fieldVolumeResolution(g.qualityTier) !== null;
}

/** Particle count per tier (0 = none; low tier never reaches here). */
export function fieldParticleCount(tier: string | null | undefined): number {
  if (tier === 'high' || tier === 'ultra') return 1024;
  if (tier === 'medium') return 256;
  return 0;
}

/**
 * How a volume refresh is spread over frames. 64³ fits one frame; 128³ is
 * eight times the work, so it is time-sliced in z-slabs over four frames.
 * Sources are snapshotted at the start of a sweep, so a slab never mixes
 * two source states. `minIntervalS` caps the refresh rate for benches whose
 * sources move every frame (SEG rollers).
 */
export interface FieldSweepPlan {
  zBricks: number;
  bricksPerFrame: number;
  framesPerSweep: number;
  minIntervalS: number;
}

export function fieldSweepPlan(n: number): FieldSweepPlan {
  const zBricks = Math.ceil(n / FIELD_BRICK);
  const framesPerSweep = n > 64 ? 4 : 1;
  return {
    zBricks,
    bricksPerFrame: Math.ceil(zBricks / framesPerSweep),
    framesPerSweep,
    minIntervalS: n > 64 ? 1 / 15 : 1 / 30
  };
}

/** Relative source change that triggers a new sweep. */
export const FIELD_SOURCE_CHANGE_EPS = 1e-3;

type Bounds = readonly [ArrayLike<number>, ArrayLike<number>];

function diag(b: Bounds): number {
  return Math.hypot(b[1][0] - b[0][0], b[1][1] - b[0][1], b[1][2] - b[0][2]);
}

/** StreamParams: bounds (w = step, minimum |B| mT), shape (seeds, segments, time). */
export function packStreamParams(
  bounds: Bounds, seedCount: number, bRefMt: number, time: number, out = new Float32Array(FIELD_STREAM_PARAMS_BYTES / 4)
): Float32Array {
  const step = (diag(bounds) * 0.9) / FIELD_SEGMENTS_PER_LINE;
  out[0] = bounds[0][0]; out[1] = bounds[0][1]; out[2] = bounds[0][2]; out[3] = step;
  out[4] = bounds[1][0]; out[5] = bounds[1][1]; out[6] = bounds[1][2]; out[7] = Math.max(bRefMt, 1e-9) * 1e-3;
  out[8] = Math.min(seedCount, FIELD_MAX_SEEDS); out[9] = FIELD_SEGMENTS_PER_LINE; out[10] = time; out[11] = 0;
  return out;
}

/** FieldLineParams.style: reference |B| (mT), width, alpha, trail mode. */
export function packLineStyle(
  bRefMt: number, trail: boolean, out = new Float32Array(FIELD_LINE_STYLE_BYTES / 4)
): Float32Array {
  out[0] = trail ? 1 : Math.max(bRefMt, 1e-9);
  out[1] = trail ? 0.8 : 1;
  out[2] = trail ? 0.9 : 0.85;
  out[3] = trail ? 1 : 0;
  return out;
}

/** Log colour-map range around the reference field (field-colormap.wgsl). */
export function fieldColorRange(bRefMt: number): [number, number] {
  const b = Math.max(bRefMt, 1e-9);
  return [b / 30, b * 10];
}

export function packSliceParams(
  bounds: Bounds,
  axis: Exclude<FieldSliceAxis, 'off'>,
  offset: number,
  mode: FieldSliceMode,
  devicePos: ArrayLike<number>,
  bRefMt: number,
  time: number,
  out = new Float32Array(FIELD_SLICE_PARAMS_BYTES / 4)
): Float32Array {
  const [lo, hi] = fieldColorRange(bRefMt);
  out[0] = bounds[0][0]; out[1] = bounds[0][1]; out[2] = bounds[0][2]; out[3] = 'xyz'.indexOf(axis);
  out[4] = bounds[1][0]; out[5] = bounds[1][1]; out[6] = bounds[1][2]; out[7] = Math.min(1, Math.max(0, offset));
  out[8] = devicePos[0] ?? 0; out[9] = devicePos[1] ?? 0; out[10] = devicePos[2] ?? 0; out[11] = FIELD_SLICE_MODES.indexOf(mode);
  out[12] = lo; out[13] = hi; out[14] = 0.82; out[15] = time;
  return out;
}

/** Default shells: a factor of four apart, bracketing the reference field. */
export function fieldIsoLevels(bRefMt: number): number[] {
  const b = Math.max(bRefMt, 1e-9);
  return [b * 4, b, b / 4];
}

export function packIsoParams(
  bounds: Bounds,
  levelsMt: readonly number[],
  devicePos: ArrayLike<number>,
  steps: number,
  out = new Float32Array(FIELD_ISO_PARAMS_BYTES / 4)
): Float32Array {
  const levels = [...levelsMt].filter((v) => v > 0).sort((a, b) => a - b).slice(0, FIELD_ISO_MAX_LEVELS);
  out[0] = bounds[0][0]; out[1] = bounds[0][1]; out[2] = bounds[0][2]; out[3] = levels.length;
  out[4] = bounds[1][0]; out[5] = bounds[1][1]; out[6] = bounds[1][2]; out[7] = 0.32;
  out[8] = devicePos[0] ?? 0; out[9] = devicePos[1] ?? 0; out[10] = devicePos[2] ?? 0; out[11] = steps;
  for (let i = 0; i < 4; i++) out[12 + i] = levels[i] ?? 0;
  return out;
}

export function packParticleParams(
  bounds: Bounds,
  unitM: number,
  plan: FieldParticlePlan,
  efield: ArrayLike<number>,
  spawn: ArrayLike<number>,
  count: number,
  trail: number,
  frame: number,
  perTesla: number,
  out = new Float32Array(24)
): Float32Array {
  out[0] = bounds[0][0]; out[1] = bounds[0][1]; out[2] = bounds[0][2]; out[3] = unitM;
  out[4] = bounds[1][0]; out[5] = bounds[1][1]; out[6] = bounds[1][2]; out[7] = plan.qOverM;
  out[8] = efield[0] ?? 0; out[9] = efield[1] ?? 0; out[10] = efield[2] ?? 0; out[11] = plan.dt;
  out[12] = spawn[0]; out[13] = spawn[1]; out[14] = spawn[2]; out[15] = diag(bounds) * 0.12;
  out[16] = plan.v0; out[17] = 900; out[18] = plan.pushesPerFrame; out[19] = frame;
  out[20] = count; out[21] = trail; out[22] = perTesla; out[23] = 0;
  return out;
}

/**
 * Probe click: intersect a world-space ray with the slice plane (device-local
 * bounds + device position). Returns the device-local hit inside the bounds,
 * or null.
 */
export function raySliceHit(
  origin: ArrayLike<number>,
  dir: ArrayLike<number>,
  bounds: Bounds,
  axis: Exclude<FieldSliceAxis, 'off'>,
  offset: number,
  devicePos: ArrayLike<number>
): [number, number, number] | null {
  const a = 'xyz'.indexOf(axis);
  const plane = bounds[0][a] + Math.min(1, Math.max(0, offset)) * (bounds[1][a] - bounds[0][a]) + (devicePos[a] ?? 0);
  if (Math.abs(dir[a]) < 1e-9) return null;
  const t = (plane - origin[a]) / dir[a];
  if (!(t > 0)) return null;
  const p: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    p[c] = origin[c] + dir[c] * t - (devicePos[c] ?? 0);
    if (c !== a && (p[c] < bounds[0][c] || p[c] > bounds[1][c])) return null;
  }
  return p;
}
