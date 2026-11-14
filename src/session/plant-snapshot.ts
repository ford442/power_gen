/**
 * Plant snapshots (#224 §2) — the pure half: device state ⇄ numbers.
 *
 * Every device's `state` block in physics/devices.json (codegen'd to
 * `DEVICE_STATE_LAYOUT`) lists, in order, each `physicsState` key a step reads
 * before it writes, and the C++ plant field it maps to. That one table drives
 * three conversions:
 *
 *   physicsState  ⇄ keyed values   `saveDeviceState` / `loadDeviceState`
 *   physicsState  →  Float64Array   `packDeviceState` (layout order, NaN = absent)
 *   keyed values  ⇄ C++ vector     `cppStateFromKeys` / `keysFromCppState`
 *
 * The C++ vector is what `SEGSimulator::plantSave` writes: `[_time, _drive,
 * …fields]` (`PLANT_STATE_PREFIX`), versioned by `PLANT_STATE_LAYOUT_HASH`.
 *
 * Value encoding, all plain numbers so a snapshot is JSON: `bool` 0/1, `enum`
 * the index into `values`, `nullable` −1 for null (nullable fields are
 * non-negative setpoints; any negative value reads back as null). NaN survives
 * as NaN here and as JSON `null` in a file.
 *
 * No DOM, no wasm: `npm run test:snapshots` runs this in Node. The browser glue
 * (capture / restore the whole lab) is lab-snapshot.ts. Simulated, not
 * metrology — a snapshot replays this model, it does not record an instrument.
 */
import {
  DEVICE_CATALOG_HASH,
  DEVICE_STATE_LAYOUT,
  PLANT_STATE_LAYOUT_HASH,
  PLANT_STATE_PREFIX,
  type DeviceStateField
} from '../../generated/device-state';

export { DEVICE_CATALOG_HASH, DEVICE_STATE_LAYOUT, PLANT_STATE_LAYOUT_HASH, PLANT_STATE_PREFIX };

/** One device's saved state: `physicsState` key → encoded number. */
export type DeviceStateValues = Record<string, number>;

/** Loose view of a device plant — any `DevicePhysicsState`, or a test double. */
export type PhysicsStateLike = object;

export type SnapshotBackend = 'js' | 'wasm' | 'wasm-worker';

/** SEG operator inputs and smoothed outputs (`SEGOperatorState`). */
export interface OperatorSnapshot {
  status: string;
  isRunning: boolean;
  targetDrive: number;
  magneticFieldStrength: number;
  loadResistance: number;
  totalEnergy: number;
  efficiency: number;
  displayRpm: number;
  displayField: number;
  /** `segOperator.physics` through the `seg` layout. */
  physics: DeviceStateValues;
}

/** `window.lab.captureSnapshot()` — see docs/SNAPSHOTS.md. */
export interface PlantSnapshot {
  format: 'seg-plant-snapshot';
  version: 1;
  /** `PLANT_STATE_LAYOUT_HASH` the writer was built with. */
  layoutHash: number;
  /** `DEVICE_CATALOG_HASH` the writer was built with (informational). */
  catalogHash: string;
  /** Which plant owned the focus device when it was taken. */
  backend: SnapshotBackend;
  /** Plant focus (`overview` steps the SEG plant, so this is `seg` there). */
  focus: string;
  /** Session sim clock (s). */
  t: number;
  /** Simulation RNG seed, null when the run was unseeded. */
  seed: number | null;
  /** Non-default LabConfig share fields at capture time. */
  config: Record<string, unknown>;
  /** Every JS device plant, through its layout. */
  devices: Record<string, DeviceStateValues>;
  /** The C++ focus plant's `plantSave` vector (absent on the JS backend). */
  wasm?: { mode: number; values: number[] };
  /** The selected view (`overview` or a device id). */
  view?: string;
  operator?: OperatorSnapshot;
  /** Speed multiplier (sim-rate slider). */
  speed?: number;
}

export const SNAPSHOT_FORMAT = 'seg-plant-snapshot';
export const SNAPSHOT_VERSION = 1;

/** The `SEGOperatorState` fields a snapshot carries, its private smoothed outputs included. */
interface OperatorFields {
  status: string;
  isRunning: boolean;
  targetDrive: number;
  magneticFieldStrength: number;
  loadResistance: number;
  totalEnergy: number;
  physics: object;
  _efficiency: number;
  _displayRpm: number;
  _displayField: number;
}

/** Snapshot one operator — the page's `segOperator`, or an experiment bench's own. */
export function captureOperatorState(op: object): OperatorSnapshot {
  const o = op as OperatorFields;
  return {
    status: o.status,
    isRunning: o.isRunning,
    targetDrive: o.targetDrive,
    magneticFieldStrength: o.magneticFieldStrength,
    loadResistance: o.loadResistance,
    totalEnergy: o.totalEnergy,
    efficiency: o._efficiency,
    displayRpm: o._displayRpm,
    displayField: o._displayField,
    physics: saveDeviceState('seg', o.physics)
  };
}

/** Inverse of {@link captureOperatorState}; a status outside `statuses` is left as it is. */
export function restoreOperatorState(op: object, snap: OperatorSnapshot, statuses: readonly string[]): void {
  const o = op as OperatorFields;
  if (statuses.includes(snap.status)) o.status = snap.status;
  o.isRunning = snap.isRunning;
  o.targetDrive = snap.targetDrive;
  o.magneticFieldStrength = snap.magneticFieldStrength;
  o.loadResistance = snap.loadResistance;
  o.totalEnergy = snap.totalEnergy;
  o._efficiency = snap.efficiency;
  o._displayRpm = snap.displayRpm;
  o._displayField = snap.displayField;
  loadDeviceState('seg', o.physics, snap.physics);
}

function keyedFields(deviceId: string): readonly DeviceStateField[] {
  return DEVICE_STATE_LAYOUT[deviceId]?.fields.filter((f) => f.key !== null) ?? [];
}

/** The `physicsState` keys a device saves, in layout order. */
export function deviceStateKeys(deviceId: string): string[] {
  return keyedFields(deviceId).map((f) => f.key as string);
}

function encode(field: DeviceStateField, raw: unknown): number | undefined {
  switch (field.type) {
    case 'number':
      return typeof raw === 'number' ? raw : undefined;
    case 'bool':
      return typeof raw === 'boolean' || typeof raw === 'number' ? (raw ? 1 : 0) : undefined;
    case 'enum': {
      const i = field.values?.indexOf(String(raw)) ?? -1;
      return i >= 0 ? i : undefined;
    }
    case 'nullable':
      if (raw === null) return -1;
      return typeof raw === 'number' ? raw : undefined;
  }
}

function decode(field: DeviceStateField, v: number): unknown {
  switch (field.type) {
    case 'number':
      return v;
    case 'bool':
      return v !== 0;
    case 'enum':
      return field.values?.[v];
    case 'nullable':
      return v >= 0 ? v : null;
  }
}

/** Save a device plant's layout fields (keys the plant has not set yet are skipped). */
export function saveDeviceState(deviceId: string, state: PhysicsStateLike): DeviceStateValues {
  const src = state as Record<string, unknown>;
  const out: DeviceStateValues = {};
  for (const f of keyedFields(deviceId)) {
    const v = encode(f, src[f.key as string]);
    if (v !== undefined) out[f.key as string] = v;
  }
  return out;
}

/** {@link saveDeviceState} as a vector in {@link deviceStateKeys} order — NaN for an absent key. */
export function packDeviceState(deviceId: string, state: PhysicsStateLike): Float64Array {
  const keyed = saveDeviceState(deviceId, state);
  return Float64Array.from(deviceStateKeys(deviceId), (k) => (k in keyed ? keyed[k] : NaN));
}

/**
 * Write saved values back into a device plant. A packed vector (from
 * {@link packDeviceState}) skips NaN slots; keyed values apply as given. Keys
 * the layout marks `clearOnLoad` (derived geometry) are reset to null so the
 * next step rebuilds them. Returns the keys written.
 */
export function loadDeviceState(
  deviceId: string,
  state: PhysicsStateLike,
  values: DeviceStateValues | ArrayLike<number>
): string[] {
  const dst = state as Record<string, unknown>;
  const fields = keyedFields(deviceId);
  const packed = isPacked(values);
  const written: string[] = [];
  fields.forEach((f, i) => {
    const key = f.key as string;
    let v: number | undefined;
    if (packed) {
      v = (values as ArrayLike<number>)[i];
      if (Number.isNaN(v)) return;
    } else {
      v = (values as DeviceStateValues)[key];
    }
    if (typeof v !== 'number') return;
    const decoded = decode(f, v);
    if (decoded === undefined) return;
    dst[key] = decoded;
    written.push(key);
  });
  for (const key of DEVICE_STATE_LAYOUT[deviceId]?.clearOnLoad ?? []) dst[key] = null;
  return written;
}

function isPacked(values: DeviceStateValues | ArrayLike<number>): values is ArrayLike<number> {
  return ArrayBuffer.isView(values) || Array.isArray(values);
}

/**
 * Build a C++ `plantLoad` vector from keyed TS values — the JS ⇄ C++
 * cross-load. Starts from `base` (the live plant's own `plantSave` vector, so
 * C++-only fields keep their values) and overwrites every mapped field. Null
 * for a device with no C++ plant, or a `base` of the wrong length.
 */
export function cppStateFromKeys(
  deviceId: string,
  keyed: DeviceStateValues,
  base: ArrayLike<number> | null = null,
  prefix: { time?: number; drive?: number } = {}
): Float32Array | null {
  const layout = DEVICE_STATE_LAYOUT[deviceId];
  if (!layout || layout.wasmMode === null || layout.cppSize <= 0) return null;
  if (base && base.length !== layout.cppSize) return null;
  const out = new Float32Array(layout.cppSize);
  if (base) out.set(base);
  if (prefix.time !== undefined) out[PLANT_STATE_PREFIX.time] = prefix.time;
  if (prefix.drive !== undefined) out[PLANT_STATE_PREFIX.drive] = prefix.drive;
  for (const f of layout.fields) {
    if (f.key === null || f.offset < 0 || f.count !== undefined) continue;
    let v = keyed[f.key];
    if (typeof v !== 'number') continue;
    if (f.type === 'nullable' && !(v >= 0)) v = f.cppNull ?? -1;
    else if (f.type === 'bool') v = v ? 1 : 0;
    out[f.offset] = v;
  }
  return out;
}

/** Keyed TS values for every mapped field of a C++ `plantSave` vector. */
export function keysFromCppState(deviceId: string, cpp: ArrayLike<number>): DeviceStateValues {
  const layout = DEVICE_STATE_LAYOUT[deviceId];
  const out: DeviceStateValues = {};
  if (!layout || cpp.length !== layout.cppSize) return out;
  for (const f of layout.fields) {
    if (f.key === null || f.offset < 0 || f.count !== undefined) continue;
    const v = cpp[f.offset];
    out[f.key] = f.type === 'nullable' && (v === (f.cppNull ?? -1) || v < 0) ? -1 : v;
  }
  return out;
}

/** The device whose C++ plant runs as `mode`, or null. */
export function deviceIdForWasmMode(mode: number): string | null {
  for (const [id, layout] of Object.entries(DEVICE_STATE_LAYOUT)) {
    if (layout.wasmMode === mode) return id;
  }
  return null;
}

// ── JSON validation ─────────────────────────────────────────────────────────

function finiteOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** JSON → numbers: `null` was NaN on the way out. */
function parseValues(raw: unknown, errors: string[], where: string): DeviceStateValues | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(`${where}: not an object`);
    return null;
  }
  const out: DeviceStateValues = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v === null) out[k] = NaN;
    else if (typeof v === 'number') out[k] = v;
    else errors.push(`${where}.${k}: not a number`);
  }
  return out;
}

/**
 * Validate an untrusted snapshot (a `.lab.json` `state`, a replay keyframe, a
 * console paste). Unknown devices / keys are dropped on load, not here; a
 * newer `version` is read best-effort with a warning.
 */
export function parsePlantSnapshot(input: unknown): { snapshot: PlantSnapshot | null; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const o = (typeof input === 'string' ? safeJson(input, errors) : input) as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') {
    if (!errors.length) errors.push('snapshot is not an object');
    return { snapshot: null, errors, warnings };
  }
  if (o.format !== SNAPSHOT_FORMAT) errors.push(`format is not '${SNAPSHOT_FORMAT}'`);
  const version = finiteOr(o.version, NaN);
  if (!(version >= 1)) errors.push('version missing');
  else if (version > SNAPSHOT_VERSION) warnings.push(`snapshot version ${version} is newer than ${SNAPSHOT_VERSION}; reading what this build knows`);

  const devices: Record<string, DeviceStateValues> = {};
  if (o.devices && typeof o.devices === 'object') {
    for (const [id, raw] of Object.entries(o.devices as Record<string, unknown>)) {
      const vals = parseValues(raw, errors, `devices.${id}`);
      if (vals) devices[id] = vals;
    }
  } else {
    errors.push('devices missing');
  }

  let wasm: PlantSnapshot['wasm'];
  if (o.wasm !== undefined && o.wasm !== null) {
    const w = o.wasm as { mode?: unknown; values?: unknown };
    const ok = Number.isInteger(w.mode)
      && Array.isArray(w.values)
      && w.values.every((v) => typeof v === 'number' && Number.isFinite(v));
    if (ok) wasm = { mode: w.mode as number, values: w.values as number[] };
    else errors.push('wasm: needs an integer mode and finite values');
  }

  let operator: OperatorSnapshot | undefined;
  if (o.operator && typeof o.operator === 'object') {
    const op = o.operator as Record<string, unknown>;
    operator = {
      status: typeof op.status === 'string' ? op.status : 'standby',
      isRunning: op.isRunning === true,
      targetDrive: finiteOr(op.targetDrive, 0.5),
      magneticFieldStrength: finiteOr(op.magneticFieldStrength, 0.5),
      loadResistance: finiteOr(op.loadResistance, 100),
      totalEnergy: finiteOr(op.totalEnergy, 0),
      efficiency: finiteOr(op.efficiency, 0),
      displayRpm: finiteOr(op.displayRpm, 0),
      displayField: finiteOr(op.displayField, 0),
      physics: parseValues(op.physics ?? {}, errors, 'operator.physics') ?? {}
    };
  }

  if (errors.length) return { snapshot: null, errors, warnings };
  const layoutHash = finiteOr(o.layoutHash, 0) >>> 0;
  if (wasm && layoutHash !== PLANT_STATE_LAYOUT_HASH) {
    warnings.push('layout hash differs from this build: the C++ vector is skipped, devices load by key');
  }
  const snapshot: PlantSnapshot = {
    format: SNAPSHOT_FORMAT,
    version: 1,
    layoutHash,
    catalogHash: typeof o.catalogHash === 'string' ? o.catalogHash : '',
    backend: o.backend === 'wasm' || o.backend === 'wasm-worker' ? o.backend : 'js',
    focus: typeof o.focus === 'string' ? o.focus : 'seg',
    t: finiteOr(o.t, 0),
    seed: typeof o.seed === 'number' && Number.isFinite(o.seed) ? o.seed : null,
    config: o.config && typeof o.config === 'object' ? (o.config as Record<string, unknown>) : {},
    devices
  };
  if (wasm) snapshot.wasm = wasm;
  if (typeof o.view === 'string') snapshot.view = o.view;
  if (operator) snapshot.operator = operator;
  if (typeof o.speed === 'number' && Number.isFinite(o.speed)) snapshot.speed = o.speed;
  return { snapshot, errors, warnings };
}

function safeJson(text: string, errors: string[]): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    errors.push(`not JSON: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
