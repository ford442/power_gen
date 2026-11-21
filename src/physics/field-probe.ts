/**
 * The field probe as experiment record keys and knobs (ADR-0017, #255 §4).
 * CPU only, from plant state — works headless (test:experiments) and live,
 * WebGPU or WebGL2, and is the number every probe readout shows: the exact
 * kernel sum at the point (field-eval.ts), not a volume sample.
 *
 *   <bench>.field.probe.Bx|By|Bz|B   tesla at the probe point (record key)
 *   <bench>.field.drive.<group>      a source group's drive as the field model
 *                                    saw it — e.g. the coil's signed current (A)
 *   <bench>.field.probe.x|y|z        probe position, device-local scene units
 *                                    (knob; default the catalog `probe`)
 *
 * Simulated, not metrology: the sources are the catalog's idealised model.
 */

import { BenchField, driveValue, FIELD_SOURCE_CATALOG, type BenchFieldInputs } from './field-bench';
import { FIELD_DEVICE_IDS } from '../../generated/field-sources';
import type { SegLayout } from '../devices/types';

export const FIELD_PROBE_COMPONENTS = ['Bx', 'By', 'Bz', 'B'] as const;
export type FieldProbeComponent = (typeof FIELD_PROBE_COMPONENTS)[number];

type State = Readonly<Record<string, unknown>>;
type V3 = [number, number, number];

/** Probe overrides, keyed by the bench's physicsState object (no extra state fields, so snapshots stay bit-identical). */
const overrides = new WeakMap<object, V3>();
const benches = new Map<string, BenchField>();

/** Live-only inputs a bench rebuild needs beyond its state (SEG roller layout and phase). */
export interface FieldProbeContext {
  time: number;
  segLayout: SegLayout | null;
  segOmega: number;
}
let contextProvider: (() => FieldProbeContext | null) | null = null;

/** The visualizer registers this so SEG probes see the drawn roller phase. */
export function setFieldProbeContext(provider: (() => FieldProbeContext | null) | null): void {
  contextProvider = provider;
}

function bench(deviceId: string): BenchField | null {
  if (!FIELD_SOURCE_CATALOG[deviceId]) return null;
  let b = benches.get(deviceId);
  if (!b) {
    b = new BenchField(deviceId);
    benches.set(deviceId, b);
  }
  return b;
}

export function fieldProbePoint(deviceId: string, state: State | null | undefined): V3 {
  const o = state ? overrides.get(state) : undefined;
  if (o) return [o[0], o[1], o[2]];
  const p = FIELD_SOURCE_CATALOG[deviceId]?.probe ?? [0, 0, 0];
  return [p[0], p[1], p[2]];
}

/** Move the probe (clamped to the bench bounds); `null` restores the catalog point. */
export function setFieldProbePoint(deviceId: string, state: object, p: ArrayLike<number> | null): void {
  if (!p) {
    overrides.delete(state);
    return;
  }
  const b = FIELD_SOURCE_CATALOG[deviceId]?.bounds;
  const out: V3 = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const v = Number.isFinite(p[c]) ? p[c] : 0;
    out[c] = b ? Math.min(b[1][c], Math.max(b[0][c], v)) : v;
  }
  overrides.set(state, out);
}

export function setFieldProbeAxis(deviceId: string, state: object, axis: 0 | 1 | 2, value: number): void {
  const p = fieldProbePoint(deviceId, state as State);
  p[axis] = value;
  setFieldProbePoint(deviceId, state, p);
}

/** Rebuild inputs for a headless or live read. SEG needs the live layout; without it, null. */
function inputs(deviceId: string, state: State): BenchFieldInputs | null {
  const ctx = contextProvider?.() ?? null;
  if (deviceId === 'seg') {
    if (!ctx?.segLayout) return null;
    return { state, time: ctx.time, segLayout: ctx.segLayout, segOmega: ctx.segOmega, unitM: 1 / ctx.segLayout.worldScale };
  }
  return { state, time: ctx?.time ?? 0 };
}

/**
 * B (T) and |B| at the bench's probe point, from its state now. NaN when the
 * bench has no field row or (SEG, headless) no layout to build from.
 */
export function readFieldProbe(deviceId: string, state: State | null | undefined, out: number[] = [0, 0, 0, 0]): number[] {
  const b = bench(deviceId);
  const inp = b && state ? inputs(deviceId, state) : null;
  if (!b || !inp) {
    out[0] = out[1] = out[2] = out[3] = Number.NaN;
    return out;
  }
  b.rebuild(inp);
  const [x, y, z] = fieldProbePoint(deviceId, state);
  const B = b.probeT(x, y, z);
  out[0] = B[0]; out[1] = B[1]; out[2] = B[2]; out[3] = Math.hypot(B[0], B[1], B[2]);
  return out;
}

/** Group labels as record-key segments (`pole pair` → `pole-pair`). */
export function fieldGroupKey(label: string | undefined, index: number): string {
  return (label ?? `g${index}`).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `g${index}`;
}

export interface FieldRecordKey {
  deviceId: string;
  kind: 'probe' | 'drive';
  /** probe: component index 0..3; drive: group index. */
  index: number;
  unit: string;
}

function buildKeys(): Map<string, FieldRecordKey> {
  const m = new Map<string, FieldRecordKey>();
  for (const id of FIELD_DEVICE_IDS) {
    FIELD_PROBE_COMPONENTS.forEach((c, i) => m.set(`${id}.field.probe.${c}`, { deviceId: id, kind: 'probe', index: i, unit: 'T' }));
    FIELD_SOURCE_CATALOG[id].groups.forEach((g, i) => {
      if (g.drive) m.set(`${id}.field.drive.${fieldGroupKey(g.label, i)}`, { deviceId: id, kind: 'drive', index: i, unit: '' });
    });
  }
  return m;
}

export const FIELD_RECORD_KEYS: ReadonlyMap<string, FieldRecordKey> = buildKeys();

const scratch = [0, 0, 0, 0];

/** Value of a field record key now (NaN when unavailable). */
export function readFieldRecordKey(key: string, state: State | null | undefined): number {
  const k = FIELD_RECORD_KEYS.get(key);
  if (!k || !state) return Number.NaN;
  if (k.kind === 'drive') {
    const v = driveValue(FIELD_SOURCE_CATALOG[k.deviceId].groups[k.index].drive, state);
    return Number.isFinite(v) ? v : Number.NaN;
  }
  const v = readFieldProbe(k.deviceId, state, scratch)[k.index];
  return Number.isFinite(v) ? v : Number.NaN;
}
