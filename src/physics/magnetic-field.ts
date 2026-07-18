/**
 * Shared magnetic field utilities — dipole superposition, Halbach arrays,
 * field-line tracing, and educational force estimates.
 *
 * Used by maglev, homopolar, SEG flux helpers, and the halbach-viz plugin.
 */

import { ValidatedConstants } from '../ValidatedConstants';

export const MU0 = ValidatedConstants.MU_0?.value ?? 1.2566370614e-7;
export const MAGNET_BR = ValidatedConstants.MAGNET_BR?.value ?? 1.48;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface DipoleSource {
  position: Vec3;
  moment: Vec3;
}

export type HalbachLayout = 'ring' | 'linear';

export interface HalbachConfig {
  segmentCount: number;
  /** Magnetization rotation per segment (degrees). Ideal Halbach ≈ 360/N. */
  magAngleDeg: number;
  layout?: HalbachLayout;
  /** Ring major radius (m) or half-length scale for linear array. */
  radiusM?: number;
  /** Segment arc / block thickness (m). */
  thicknessM?: number;
  /** Remanence used for moment magnitude (T). */
  remanenceT?: number;
}

export interface HalbachSegment extends DipoleSource {
  index: number;
  azimuthRad: number;
}

export interface FieldLineTraceOpts {
  maxSteps?: number;
  stepM?: number;
  maxLengthM?: number;
}

export interface FieldLineSeed {
  x: number;
  y: number;
  z: number;
}

const FOUR_PI = 4 * Math.PI;
const MIN_R3 = 1e-9;

export function vec3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scale(v: Vec3, s: number): Vec3 {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function length(v: Vec3): number {
  return Math.sqrt(dot(v, v));
}

export function normalize(v: Vec3, fallback: Vec3 = vec3(0, 1, 0)): Vec3 {
  const len = length(v);
  if (len < 1e-12) return { ...fallback };
  return scale(v, 1 / len);
}

/** Magnetic dipole field B (tesla) at observation point r from dipole at origin. */
export function dipoleFieldT(obs: Vec3, moment: Vec3): Vec3 {
  const r = length(obs);
  if (r < 1e-6) return vec3();

  const rHat = scale(obs, 1 / r);
  const mDotR = dot(moment, rHat);
  const factor = MU0 / (FOUR_PI * r * r * r);
  const term1 = scale(rHat, 3 * mDotR);
  const term2 = moment;
  return scale(sub(term1, term2), factor);
}

/** Superposition of dipole sources at arbitrary positions. */
export function superposeDipoleFieldT(obs: Vec3, sources: readonly DipoleSource[]): Vec3 {
  let bx = 0;
  let by = 0;
  let bz = 0;
  for (const src of sources) {
    const rel = sub(obs, src.position);
    const b = dipoleFieldT(rel, src.moment);
    bx += b.x;
    by += b.y;
    bz += b.z;
  }
  return { x: bx, y: by, z: bz };
}

export function fieldMagnitudeT(b: Vec3): number {
  return length(b);
}

function segmentMomentMagnitude(remanenceT: number, thicknessM: number, arcLengthM: number): number {
  const volume = thicknessM * thicknessM * arcLengthM;
  return (remanenceT / MU0) * volume;
}

/**
 * Build Halbach segment dipoles for a ring or linear array.
 * Scene units: 1 unit ≈ 1 m for field math; mesh scaling applied separately.
 */
export function buildHalbachSegments(config: HalbachConfig): HalbachSegment[] {
  const n = Math.max(2, Math.min(32, Math.round(config.segmentCount)));
  const layout = config.layout ?? 'ring';
  const radiusM = config.radiusM ?? 0.14;
  const thicknessM = config.thicknessM ?? 0.028;
  const br = config.remanenceT ?? MAGNET_BR;
  const magStepRad = (config.magAngleDeg * Math.PI) / 180;

  const segments: HalbachSegment[] = [];

  if (layout === 'linear') {
    const totalLen = radiusM * 2;
    const segLen = totalLen / n;
    for (let i = 0; i < n; i++) {
      const x = -radiusM + (i + 0.5) * segLen;
      const mAngle = i * magStepRad;
      const momentMag = segmentMomentMagnitude(br, thicknessM, segLen);
      segments.push({
        index: i,
        azimuthRad: 0,
        position: vec3(x, 0, 0),
        moment: vec3(Math.cos(mAngle) * momentMag, 0, Math.sin(mAngle) * momentMag)
      });
    }
    return segments;
  }

  const arcLen = (2 * Math.PI * radiusM) / n;
  const momentMag = segmentMomentMagnitude(br, thicknessM, arcLen);

  for (let i = 0; i < n; i++) {
    const theta = (i / n) * Math.PI * 2;
    const x = Math.cos(theta) * radiusM;
    const z = Math.sin(theta) * radiusM;
    const mAngle = theta + Math.PI / 2 + i * magStepRad;
    segments.push({
      index: i,
      azimuthRad: theta,
      position: vec3(x, 0, z),
      moment: vec3(Math.cos(mAngle) * momentMag, 0, Math.sin(mAngle) * momentMag)
    });
  }
  return segments;
}

/** B-field (T) from a Halbach segment array. */
export function halbachFieldAt(obs: Vec3, segments: readonly HalbachSegment[]): Vec3 {
  return superposeDipoleFieldT(obs, segments);
}

/** Order-of-magnitude surface B for a Halbach-like ring (educational). */
export function estimateHalbachFieldT(gapM: number, remanenceT = MAGNET_BR): number {
  const R = 0.028;
  const B0 = remanenceT * MU0 / FOUR_PI * (2 * Math.PI * R) / Math.max(gapM, 0.002);
  return Math.min(1.2, B0 * 8);
}

/** Spatial period of the Halbach pattern (m). */
export function halbachPeriodM(config: HalbachConfig): number {
  const n = Math.max(2, config.segmentCount);
  const layout = config.layout ?? 'ring';
  const radiusM = config.radiusM ?? 0.14;
  if (layout === 'linear') return (radiusM * 2) / n;
  return (2 * Math.PI * radiusM) / n;
}

/** Sample peak |B| on a coarse grid near the array (T). */
export function estimatePeakFieldT(
  segments: readonly HalbachSegment[],
  opts: { samples?: number; extentM?: number } = {}
): number {
  const samples = opts.samples ?? 12;
  const extent = opts.extentM ?? 0.22;
  let peak = 0;
  for (let ix = 0; ix < samples; ix++) {
    for (let iz = 0; iz < samples; iz++) {
      const x = (ix / (samples - 1) - 0.5) * extent * 2;
      const z = (iz / (samples - 1) - 0.5) * extent * 2;
      for (const y of [0.02, 0.06, 0.12]) {
        const b = halbachFieldAt(vec3(x, y, z), segments);
        peak = Math.max(peak, fieldMagnitudeT(b));
      }
    }
  }
  return peak;
}

/** Gradient of |B|² used for dipole force proxy: F ≈ ∇(m·B). */
export function estimateDipoleForceN(
  testMomentAm2: number,
  position: Vec3,
  segments: readonly HalbachSegment[],
  deltaM = 0.002
): number {
  const mVec = vec3(0, testMomentAm2, 0);
  const bPlus = halbachFieldAt(add(position, vec3(0, deltaM, 0)), segments);
  const bMinus = halbachFieldAt(sub(position, vec3(0, deltaM, 0)), segments);
  const gradY = (dot(mVec, bPlus) - dot(mVec, bMinus)) / (2 * deltaM);
  return Math.abs(gradY);
}

function rk4Step(pos: Vec3, h: number, sign: number, segments: readonly HalbachSegment[]): Vec3 {
  const k1 = normalize(halbachFieldAt(pos, segments));
  const k2 = normalize(halbachFieldAt(add(pos, scale(k1, sign * h * 0.5)), segments));
  const k3 = normalize(halbachFieldAt(add(pos, scale(k2, sign * h * 0.5)), segments));
  const k4 = normalize(halbachFieldAt(add(pos, scale(k3, sign * h)), segments));
  const dx = (k1.x + 2 * k2.x + 2 * k3.x + k4.x) / 6;
  const dy = (k1.y + 2 * k2.y + 2 * k3.y + k4.y) / 6;
  const dz = (k1.z + 2 * k2.z + 2 * k3.z + k4.z) / 6;
  return add(pos, scale(vec3(dx, dy, dz), sign * h));
}

/** Trace one field line via RK4 along ±B. Returns flat [x,y,z, ...] scene coords. */
export function traceFieldLine(
  seed: FieldLineSeed,
  segments: readonly HalbachSegment[],
  opts: FieldLineTraceOpts = {}
): Float32Array {
  const maxSteps = opts.maxSteps ?? 48;
  const stepM = opts.stepM ?? 0.006;
  const maxLengthM = opts.maxLengthM ?? 0.55;
  const points: number[] = [seed.x, seed.y, seed.z];

  let pos = vec3(seed.x, seed.y, seed.z);
  let traveled = 0;
  for (let i = 0; i < maxSteps && traveled < maxLengthM; i++) {
    const b = halbachFieldAt(pos, segments);
    if (fieldMagnitudeT(b) < MIN_R3) break;
    pos = rk4Step(pos, stepM, 1, segments);
    traveled += stepM;
    points.push(pos.x, pos.y, pos.z);
  }

  pos = vec3(seed.x, seed.y, seed.z);
  traveled = 0;
  const backward: number[] = [];
  for (let i = 0; i < maxSteps && traveled < maxLengthM; i++) {
    const b = halbachFieldAt(pos, segments);
    if (fieldMagnitudeT(b) < MIN_R3) break;
    pos = rk4Step(pos, stepM, -1, segments);
    traveled += stepM;
    backward.unshift(pos.x, pos.y, pos.z);
  }

  return new Float32Array([...backward, ...points]);
}

/** Generate multiple field line polylines for rendering. */
export function traceHalbachFieldLines(
  segments: readonly HalbachSegment[],
  lineCount: number,
  layout: HalbachLayout = 'ring',
  radiusM = 0.14
): Float32Array[] {
  const lines: Float32Array[] = [];
  const n = Math.max(4, Math.min(24, lineCount));

  if (layout === 'linear') {
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const x = -radiusM + t * radiusM * 2;
      lines.push(traceFieldLine({ x, y: 0.04, z: 0 }, segments));
    }
    return lines;
  }

  for (let i = 0; i < n; i++) {
    const angle = (i / n) * Math.PI * 2;
    const r = radiusM * 0.35;
    lines.push(traceFieldLine({
      x: Math.cos(angle) * r,
      y: 0.03 + (i % 3) * 0.025,
      z: Math.sin(angle) * r
    }, segments));
  }
  return lines;
}

/** |B| heatmap on a Y=sliceY plane; returns RGBA 0..1 per texel. */
export function sampleFieldHeatmap(
  segments: readonly HalbachSegment[],
  gridSize: number,
  extentM: number,
  sliceY = 0
): Float32Array {
  const data = new Float32Array(gridSize * gridSize * 4);
  let peak = 1e-9;
  const samples: number[] = [];

  for (let iz = 0; iz < gridSize; iz++) {
    for (let ix = 0; ix < gridSize; ix++) {
      const x = (ix / (gridSize - 1) - 0.5) * extentM * 2;
      const z = (iz / (gridSize - 1) - 0.5) * extentM * 2;
      const b = halbachFieldAt(vec3(x, sliceY, z), segments);
      const mag = fieldMagnitudeT(b);
      samples.push(mag);
      peak = Math.max(peak, mag);
    }
  }

  for (let i = 0; i < samples.length; i++) {
    const t = Math.min(1, samples[i] / peak);
    const o = i * 4;
    data[o] = 0.15 + t * 0.75;
    data[o + 1] = 0.25 + t * 0.55;
    data[o + 2] = 0.85 + t * 0.15;
    data[o + 3] = 0.15 + t * 0.65;
  }
  return data;
}
