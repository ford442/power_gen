/**
 * catalog-field-sources.mjs — the `fieldSources` half of codegen-device-catalog
 * (#255 §1, ADR-0017).
 *
 * A bench whose magnetostatic field the lab can draw declares it in
 * physics/devices.json:
 *
 *   "fieldSources": {
 *     "unitM": 0.1,                         // metres per device-local scene unit
 *     "bounds": [[x0, y0, z0], [x1, y1, z1]],  // volume AABB, scene units
 *     "probe": [x, y, z],                   // default probe point, scene units
 *     "model": "one line the UI shows",     // what is idealised
 *     "efield": { "dir": [1, 0, 0], "key": "<stateKey>", "factor": 1 },  // optional uniform E (V/m)
 *     "groups": [
 *       { "kind": "dipole",   "at": […], "moment": […] (A·m²), "coreM"?, "drive"? },
 *       { "kind": "segment",  "points": [[…], …], "closed"?, "currentA", "drive"? },
 *       { "kind": "box",      "center": […], "halfSize": […], "brT": [bx, by, bz] (local), "yawDeg"?, "drive"? },
 *       { "kind": "cylinder", "center": […], "axis": […], "radius", "halfLength",
 *                             "brT" | ("turns" + "currentA"), "drive"? },
 *       { "builder": "<name>", "params": { … }, "drive"? }
 *     ]
 *   }
 *
 * Geometry is in scene units (what the meshes draw), strengths are SI. A
 * `drive` — { "key": "<physicsState key>", "factor"?: 1, "abs"?: false } —
 * multiplies the group's strength by the live plant value every frame; the
 * key must be a telemetry key or a state field of that device. A `builder` is
 * a named generator in src/physics/field-builders.ts (procedural geometry:
 * SEG rollers, Halbach segments, toroid windings); codegen checks the name
 * exists there.
 *
 * Emits generated/field-sources.ts (kind ids, builder names, the per-bench
 * table) and src/shaders/generated/field-sources.wgsl (kind ids).
 */

export const FIELD_KINDS = { dipole: 0, segment: 1, box: 2, cylinder: 3 };
const V3_KEYS = { dipole: ['at', 'moment'], segment: [], box: ['center', 'halfSize', 'brT'], cylinder: ['center', 'axis'] };
const GROUP_KEYS = {
  dipole: ['kind', 'at', 'moment', 'coreM', 'drive', 'label'],
  segment: ['kind', 'points', 'closed', 'currentA', 'wireM', 'drive', 'label'],
  box: ['kind', 'center', 'halfSize', 'brT', 'yawDeg', 'drive', 'label'],
  cylinder: ['kind', 'center', 'axis', 'radius', 'halfLength', 'brT', 'turns', 'currentA', 'drive', 'label'],
  builder: ['builder', 'params', 'drive', 'label']
};
const TOP_KEYS = ['unitM', 'bounds', 'probe', 'model', 'efield', 'groups'];

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isV3 = (v) => Array.isArray(v) && v.length === 3 && v.every(isNum);

function deviceKeys(d) {
  const keys = new Set(d.telemetryKeys ?? []);
  for (const f of d.state?.fields ?? []) if (typeof f.key === 'string') keys.add(f.key);
  return keys;
}

function validateDrive(where, drive, keys, errors) {
  if (drive == null) return;
  if (typeof drive !== 'object') return void errors.push(`${where}.drive: an object { key, factor?, abs? }`);
  for (const k of Object.keys(drive)) {
    if (!['key', 'factor', 'abs', 'offset'].includes(k)) errors.push(`${where}.drive: unknown property "${k}"`);
  }
  if (typeof drive.key !== 'string' || !keys.has(drive.key)) {
    errors.push(`${where}.drive.key: "${drive.key}" is not a telemetry key or state field of this device`);
  }
  if (drive.factor != null && !isNum(drive.factor)) errors.push(`${where}.drive.factor: a number`);
  if (drive.offset != null && !isNum(drive.offset)) errors.push(`${where}.drive.offset: a number`);
  if (drive.abs != null && typeof drive.abs !== 'boolean') errors.push(`${where}.drive.abs: a boolean`);
}

/**
 * @param devices catalog rows
 * @param builderNames names exported by src/physics/field-builders.ts (FIELD_BUILDER_NAMES)
 */
export function validateFieldSources(devices, builderNames) {
  const errors = [];
  for (const d of devices) {
    const fs = d.fieldSources;
    if (fs == null) continue;
    const where = `${d.id}.fieldSources`;
    const keys = deviceKeys(d);
    for (const k of Object.keys(fs)) if (!TOP_KEYS.includes(k)) errors.push(`${where}: unknown property "${k}"`);
    if (!isNum(fs.unitM) || fs.unitM <= 0) errors.push(`${where}.unitM: metres per scene unit, > 0`);
    if (!Array.isArray(fs.bounds) || fs.bounds.length !== 2 || !fs.bounds.every(isV3)) {
      errors.push(`${where}.bounds: [[x0, y0, z0], [x1, y1, z1]]`);
    } else if (fs.bounds[0].some((v, i) => !(fs.bounds[1][i] > v))) {
      errors.push(`${where}.bounds: max must exceed min on every axis`);
    }
    if (!isV3(fs.probe)) errors.push(`${where}.probe: [x, y, z] in scene units`);
    else if (isV3(fs.bounds?.[0]) && isV3(fs.bounds?.[1])
      && fs.probe.some((v, i) => v < fs.bounds[0][i] || v > fs.bounds[1][i])) {
      errors.push(`${where}.probe: must lie inside bounds`);
    }
    if (typeof fs.model !== 'string' || fs.model.length < 8) errors.push(`${where}.model: a one-line description of what is idealised`);
    if (fs.efield != null) {
      const e = fs.efield;
      if (!isV3(e.dir)) errors.push(`${where}.efield.dir: [x, y, z]`);
      validateDrive(`${where}.efield`, { key: e.key, factor: e.factor }, keys, errors);
    }
    if (!Array.isArray(fs.groups) || fs.groups.length === 0) {
      errors.push(`${where}.groups: a non-empty array`);
      continue;
    }
    fs.groups.forEach((g, gi) => {
      const gw = `${where}.groups[${gi}]`;
      const shape = g.builder != null ? 'builder' : g.kind;
      if (!GROUP_KEYS[shape]) return void errors.push(`${gw}: "kind" must be one of ${Object.keys(FIELD_KINDS).join(', ')} (or a "builder")`);
      for (const k of Object.keys(g)) if (!GROUP_KEYS[shape].includes(k)) errors.push(`${gw}: unknown property "${k}" for ${shape}`);
      validateDrive(gw, g.drive, keys, errors);
      if (shape === 'builder') {
        if (!builderNames.includes(g.builder)) errors.push(`${gw}.builder: "${g.builder}" is not in FIELD_BUILDER_NAMES (src/physics/field-builders.ts)`);
        if (g.params != null && (typeof g.params !== 'object' || Array.isArray(g.params))) errors.push(`${gw}.params: an object`);
        return;
      }
      for (const k of V3_KEYS[shape]) if (!isV3(g[k])) errors.push(`${gw}.${k}: [x, y, z]`);
      if (shape === 'segment') {
        if (!Array.isArray(g.points) || g.points.length < 2 || !g.points.every(isV3)) errors.push(`${gw}.points: ≥ 2 [x, y, z] points`);
        if (!isNum(g.currentA)) errors.push(`${gw}.currentA: amperes`);
      }
      if (shape === 'cylinder') {
        if (!(isNum(g.radius) && g.radius > 0)) errors.push(`${gw}.radius: > 0`);
        if (!(isNum(g.halfLength) && g.halfLength > 0)) errors.push(`${gw}.halfLength: > 0`);
        const magnet = g.brT != null;
        const coil = g.turns != null || g.currentA != null;
        if (magnet === coil) errors.push(`${gw}: exactly one of "brT" (magnet) or "turns" + "currentA" (solenoid)`);
        if (magnet && !isNum(g.brT)) errors.push(`${gw}.brT: tesla`);
        if (coil && !(isNum(g.turns) && g.turns > 0 && isNum(g.currentA))) errors.push(`${gw}: "turns" > 0 and "currentA"`);
      }
      if (shape === 'box' && g.yawDeg != null && !isNum(g.yawDeg)) errors.push(`${gw}.yawDeg: degrees`);
    });
  }
  return errors;
}

const HEADER_TS = `/**
 * AUTO-GENERATED from physics/devices.json (\`fieldSources\`) — do not edit.
 * Regenerate: npm run codegen:catalog. Schema: scripts/lib/catalog-field-sources.mjs.
 */
`;

export function emitFieldSourcesTs(devices) {
  const rows = devices.filter((d) => d.fieldSources != null);
  const kinds = Object.entries(FIELD_KINDS)
    .map(([k, v]) => `export const FIELD_KIND_${k.toUpperCase()} = ${v};`).join('\n');
  const table = rows.map((d) => `  ${JSON.stringify(d.id)}: ${JSON.stringify(d.fieldSources)}`).join(',\n');
  return `${HEADER_TS}
${kinds}

export type FieldV3 = [number, number, number];

export interface FieldDrive {
  /** physicsState key whose live value multiplies the group's strength. */
  key: string;
  factor?: number;
  offset?: number;
  abs?: boolean;
}

export interface FieldGroupDecl {
  kind?: 'dipole' | 'segment' | 'box' | 'cylinder';
  builder?: string;
  params?: Record<string, unknown>;
  drive?: FieldDrive;
  label?: string;
  at?: FieldV3;
  moment?: FieldV3;
  coreM?: number;
  points?: FieldV3[];
  closed?: boolean;
  currentA?: number;
  wireM?: number;
  center?: FieldV3;
  halfSize?: FieldV3;
  brT?: FieldV3 | number;
  yawDeg?: number;
  axis?: FieldV3;
  radius?: number;
  halfLength?: number;
  turns?: number;
}

export interface FieldSourceDecl {
  unitM: number;
  bounds: [FieldV3, FieldV3];
  probe: FieldV3;
  model: string;
  efield?: { dir: FieldV3; key: string; factor?: number };
  groups: FieldGroupDecl[];
}

/** Benches with a field volume, in catalog order. */
export const FIELD_DEVICE_IDS: readonly string[] = ${JSON.stringify(rows.map((d) => d.id))};

export const FIELD_SOURCE_CATALOG: Readonly<Record<string, FieldSourceDecl>> = {
${table}
} as unknown as Readonly<Record<string, FieldSourceDecl>>;
`;
}

export function emitFieldSourcesWgsl() {
  return `// AUTO-GENERATED from scripts/lib/catalog-field-sources.mjs — do not edit.
// Regenerate: npm run codegen:catalog. FieldSource.p0.w holds one of these.
${Object.entries(FIELD_KINDS).map(([k, v]) => `const FIELD_KIND_${k.toUpperCase()}: f32 = ${v}.0;`).join('\n')}
`;
}
