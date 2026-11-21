/**
 * Magnetostatic field sources — the packed form the field volume reads
 * (ADR-0017, #255 §1).
 *
 * One `FieldSource` is 16 × f32 = 64 B, in SI units (metres, A·m², A, A/m).
 * The same Float32Array is uploaded to the GPU (`array<FieldSource>` in
 * shaders/common/field-sources.wgsl) and read by the CPU reference
 * (field-eval.ts), so the two can only disagree in arithmetic, never in data.
 *
 *   word  0..3  p0  position / start / centre (m)   | kind (FIELD_KIND_*)
 *   word  4..7  p1  kind-specific (below)
 *   word  8..11 p2  kind-specific
 *   word 12..15 p3  kind-specific
 *
 *   dipole      p1 = moment (A·m²), core radius rc (m). Inside rc the field is
 *               the uniform interior field of a magnetised sphere with that
 *               moment, so the source is exact inside and out (no 1/r³ blow-up).
 *   segment     p1 = end (m), current I (A); p2.x = wire radius (m). Exact
 *               finite-wire Biot–Savart, regularised inside the wire.
 *   box         p1 = half-size (m, local), unused; p2 = rotation quaternion
 *               (local → world); p3 = magnetisation M (A/m, local axes). Exact
 *               surface-charge closed form, inside and out (B = μ0 (H + M)).
 *   cylinder    p1 = axis (unit), radius a (m); p2 = half-length b (m), axial
 *               magnetisation or sheet current density K (A/m). Exact
 *               (Derby & Olbert 2010) — a magnet, or an ideal solenoid with
 *               K = N·I / length.
 *
 * The kind ids are catalog constants (physics/devices.json → codegen:catalog
 * emits generated/field-sources.ts and src/shaders/generated/field-sources.wgsl).
 */

import {
  FIELD_KIND_BOX,
  FIELD_KIND_CYLINDER,
  FIELD_KIND_DIPOLE,
  FIELD_KIND_SEGMENT
} from '../../generated/field-sources';

export { FIELD_KIND_BOX, FIELD_KIND_CYLINDER, FIELD_KIND_DIPOLE, FIELD_KIND_SEGMENT };

export const FIELD_SOURCE_FLOATS = 16;
export const FIELD_SOURCE_BYTES = FIELD_SOURCE_FLOATS * 4;
/** Hard cap per bench (64 KiB of sources). The GPU buffer grows to the next power of two up to this. */
export const FIELD_MAX_SOURCES = 1024;

export type V3 = readonly [number, number, number];
/** Unit quaternion (x, y, z, w), local → world. */
export type Quat = readonly [number, number, number, number];

export interface DipoleSourceSpec {
  kind: 'dipole';
  at: V3;
  moment: V3;
  /** Core radius (m); default 1 mm. */
  coreM?: number;
}

export interface SegmentSourceSpec {
  kind: 'segment';
  from: V3;
  to: V3;
  currentA: number;
  /** Wire radius (m); default 0.5 mm. */
  wireM?: number;
}

export interface BoxSourceSpec {
  kind: 'box';
  center: V3;
  halfSize: V3;
  /** Magnetisation in the box's local axes (A/m). Br = μ0·|M|. */
  magnetization: V3;
  rotation?: Quat;
}

export interface CylinderSourceSpec {
  kind: 'cylinder';
  center: V3;
  axis: V3;
  radiusM: number;
  halfLengthM: number;
  /** Axial magnetisation (A/m) or solenoid sheet current N·I/length (A/m). */
  sheetAPerM: number;
}

export type FieldSourceSpec = DipoleSourceSpec | SegmentSourceSpec | BoxSourceSpec | CylinderSourceSpec;

const IDENTITY: Quat = [0, 0, 0, 1];

/**
 * A growable packed source list. `begin()` rewinds without reallocating, so a
 * bench repacks its sources every frame into the same array (and the GPU
 * buffer is rewritten in place, never rebuilt).
 */
export class FieldSourceList {
  data: Float32Array;
  count = 0;

  constructor(capacity = 64) {
    this.data = new Float32Array(Math.max(1, capacity) * FIELD_SOURCE_FLOATS);
  }

  get capacity(): number {
    return this.data.length / FIELD_SOURCE_FLOATS;
  }

  begin(): this {
    this.count = 0;
    return this;
  }

  /** Words in use (`count × 16`). */
  get used(): Float32Array {
    return this.data.subarray(0, this.count * FIELD_SOURCE_FLOATS);
  }

  private slot(): number {
    if (this.count >= FIELD_MAX_SOURCES) return -1;
    if (this.count >= this.capacity) {
      const next = new Float32Array(Math.min(FIELD_MAX_SOURCES, this.capacity * 2) * FIELD_SOURCE_FLOATS);
      next.set(this.data);
      this.data = next;
    }
    const o = this.count * FIELD_SOURCE_FLOATS;
    this.data.fill(0, o, o + FIELD_SOURCE_FLOATS);
    this.count++;
    return o;
  }

  dipole(at: V3, moment: V3, coreM = 1e-3): this {
    const o = this.slot();
    if (o < 0) return this;
    const d = this.data;
    d[o] = at[0]; d[o + 1] = at[1]; d[o + 2] = at[2]; d[o + 3] = FIELD_KIND_DIPOLE;
    d[o + 4] = moment[0]; d[o + 5] = moment[1]; d[o + 6] = moment[2]; d[o + 7] = Math.max(1e-6, coreM);
    return this;
  }

  segment(from: V3, to: V3, currentA: number, wireM = 5e-4): this {
    const o = this.slot();
    if (o < 0) return this;
    const d = this.data;
    d[o] = from[0]; d[o + 1] = from[1]; d[o + 2] = from[2]; d[o + 3] = FIELD_KIND_SEGMENT;
    d[o + 4] = to[0]; d[o + 5] = to[1]; d[o + 6] = to[2]; d[o + 7] = Number.isFinite(currentA) ? currentA : 0;
    d[o + 8] = Math.max(1e-6, wireM);
    return this;
  }

  /** A closed or open polyline of segments, all carrying `currentA`. */
  polyline(points: readonly V3[], currentA: number, closed = false, wireM = 5e-4): this {
    const n = points.length;
    const last = closed ? n : n - 1;
    for (let i = 0; i < last; i++) this.segment(points[i], points[(i + 1) % n], currentA, wireM);
    return this;
  }

  box(center: V3, halfSize: V3, magnetization: V3, rotation: Quat = IDENTITY): this {
    const o = this.slot();
    if (o < 0) return this;
    const d = this.data;
    d[o] = center[0]; d[o + 1] = center[1]; d[o + 2] = center[2]; d[o + 3] = FIELD_KIND_BOX;
    d[o + 4] = Math.abs(halfSize[0]); d[o + 5] = Math.abs(halfSize[1]); d[o + 6] = Math.abs(halfSize[2]);
    const [qx, qy, qz, qw] = rotation;
    const ql = Math.hypot(qx, qy, qz, qw) || 1;
    d[o + 8] = qx / ql; d[o + 9] = qy / ql; d[o + 10] = qz / ql; d[o + 11] = qw / ql;
    d[o + 12] = magnetization[0]; d[o + 13] = magnetization[1]; d[o + 14] = magnetization[2];
    return this;
  }

  cylinder(center: V3, axis: V3, radiusM: number, halfLengthM: number, sheetAPerM: number): this {
    const o = this.slot();
    if (o < 0) return this;
    const d = this.data;
    const al = Math.hypot(axis[0], axis[1], axis[2]) || 1;
    d[o] = center[0]; d[o + 1] = center[1]; d[o + 2] = center[2]; d[o + 3] = FIELD_KIND_CYLINDER;
    d[o + 4] = axis[0] / al; d[o + 5] = axis[1] / al; d[o + 6] = axis[2] / al; d[o + 7] = Math.max(1e-6, radiusM);
    d[o + 8] = Math.max(1e-6, halfLengthM); d[o + 9] = Number.isFinite(sheetAPerM) ? sheetAPerM : 0;
    return this;
  }

  add(spec: FieldSourceSpec): this {
    switch (spec.kind) {
      case 'dipole': return this.dipole(spec.at, spec.moment, spec.coreM);
      case 'segment': return this.segment(spec.from, spec.to, spec.currentA, spec.wireM);
      case 'box': return this.box(spec.center, spec.halfSize, spec.magnetization, spec.rotation);
      case 'cylinder': return this.cylinder(spec.center, spec.axis, spec.radiusM, spec.halfLengthM, spec.sheetAPerM);
    }
  }
}

/** Rotation about +y by `angle` rad, as (x, y, z, w). */
export function yawQuat(angle: number): Quat {
  return [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)];
}

/** Rotate v by unit quaternion q (local → world). */
export function quatRotate(q: ArrayLike<number>, v: V3): [number, number, number] {
  const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
  // t = 2 q.xyz × v ; v' = v + w t + q.xyz × t
  const tx = 2 * (qy * v[2] - qz * v[1]);
  const ty = 2 * (qz * v[0] - qx * v[2]);
  const tz = 2 * (qx * v[1] - qy * v[0]);
  return [
    v[0] + qw * tx + (qy * tz - qz * ty),
    v[1] + qw * ty + (qz * tx - qx * tz),
    v[2] + qw * tz + (qx * ty - qy * tx)
  ];
}

/** Inverse rotation (world → local). */
export function quatRotateInv(q: ArrayLike<number>, v: V3): [number, number, number] {
  return quatRotate([-q[0], -q[1], -q[2], q[3]], v);
}

/** Fingerprint of a packed list: max |Δ| against another, for "did the sources move?" checks. */
export function maxSourceDelta(a: Float32Array, aCount: number, b: Float32Array, bCount: number): number {
  if (aCount !== bCount) return Infinity;
  let m = 0;
  const n = aCount * FIELD_SOURCE_FLOATS;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(a[i] - b[i]) / (1e-9 + Math.max(Math.abs(a[i]), Math.abs(b[i])));
    if (d > m) m = d;
  }
  return m;
}
