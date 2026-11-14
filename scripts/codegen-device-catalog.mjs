#!/usr/bin/env node
/**
 * codegen-device-catalog.mjs
 *
 * Reads physics/devices.json and emits:
 *   generated/device-catalog.ts
 *   generated/device-catalog.h
 *   generated/device-catalog.wgsl
 *   generated/device-state.ts        (plant snapshot layout, #224 §2 — lazy chunk)
 *   generated/plant-state.h          (PLANT_STATE_LAYOUT_HASH + sizes)
 *   generated/plant-state-impl.h     (SEGSimulator::plantSave / plantLoad bodies)
 *   src/shaders/generated/device-catalog.wgsl
 *   docs/MODE_MATRIX.md
 *
 * Usage:
 *   node scripts/codegen-device-catalog.mjs
 *   node scripts/codegen-device-catalog.mjs --check
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC_JSON = join(ROOT, 'physics', 'devices.json');
const OUT_DIR = join(ROOT, 'generated');
const SHADER_OUT = join(ROOT, 'src', 'shaders', 'generated', 'device-catalog.wgsl');
const PARTICLE_COMPUTE = join(ROOT, 'src', 'shaders', 'passes', 'particle-compute.wgsl');
const MODE_MATRIX = join(ROOT, 'docs', 'MODE_MATRIX.md');
const TELEMETRY_TYPES = join(ROOT, 'src', 'telemetry', 'types.ts');
const TELEMETRY_HUB = join(ROOT, 'src', 'telemetry-hub.ts');
const APPLY_WASM_PLANT = join(ROOT, 'src', 'session', 'apply-wasm-plant.ts');
const TELEMETRY_SCHEMA = join(ROOT, 'src', 'telemetry', 'telemetry-schema.ts');
const DEVICE_PHYSICS = join(ROOT, 'src', 'renderers', 'shared', 'device-physics.ts');

/**
 * 'seg' publishes its telemetryKeys across SegOperatorTelemetry (rpm/voltage/
 * current/power/fieldSim/energyDensity) rather than DeviceTelemetrySnap — the
 * two namespaces documented in MODE_MATRIX.md. Every other device's keys are
 * literal DeviceTelemetrySnap field names, enforced below.
 */
const TELEMETRY_SNAP_EXEMPT_IDS = new Set(['seg']);

const CHECK = process.argv.includes('--check');

const HEADER_TS = `/**
 * AUTO-GENERATED from physics/devices.json — do not edit.
 * Regenerate: npm run codegen:catalog
 */
`;

const HEADER_H = `// AUTO-GENERATED from physics/devices.json — do not edit.
// Regenerate: npm run codegen:catalog
#pragma once
`;

const HEADER_WGSL = `// AUTO-GENERATED from physics/devices.json — do not edit.
// Regenerate: npm run codegen:catalog
// shaderMode namespace (WGSL / device uniforms). Independent of SimMode.
`;

function loadJson() {
  return JSON.parse(readFileSync(SRC_JSON, 'utf8'));
}

function identFromId(id) {
  return id.replace(/-/g, '_').toUpperCase();
}

function wgslConst(id) {
  return `MODE_${identFromId(id)}`;
}

function simEnum(id) {
  return `SIM_MODE_${identFromId(id)}`;
}

/**
 * CSV column name for a telemetry key: camelCase → snake_case, keeping acronym
 * runs together (`heronPressureKPa` → `heron_pressure_kpa`, not `..._k_pa`).
 */
function snakeCase(key) {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

const TELEMETRY_FORMATS = new Set(['', 'si', 'exp']);

/**
 * Optional operator-chrome metadata (mode-button emoji/label/order). Devices
 * without a `chrome` block simply have no mode button generated for them.
 */
function validateChrome(devices) {
  const errors = [];
  const sorts = new Map();
  for (const d of devices) {
    const c = d.chrome;
    if (c == null) continue;
    if (typeof c.emoji !== 'string' || !c.emoji) {
      errors.push(`${d.id}: chrome.emoji must be a non-empty string`);
    }
    if (typeof c.label !== 'string' || !c.label) {
      errors.push(`${d.id}: chrome.label must be a non-empty string`);
    }
    if (typeof c.sort !== 'number' || !Number.isFinite(c.sort)) {
      errors.push(`${d.id}: chrome.sort must be a finite number`);
    }
    if (sorts.has(c.sort)) {
      errors.push(`chrome.sort collision ${c.sort}: ${sorts.get(c.sort)} and ${d.id}`);
    }
    sorts.set(c.sort, d.id);
  }
  return errors;
}

/**
 * Optional per-device `setpoints[]` — the sliders the operator panel generates
 * at boot (src/setpoint-sliders.ts). `id` also names the DOM ids
 * (`<id>Slider`, `<id>Value`, `<id>Source`), so it must be unique catalog-wide
 * and a plain identifier. START/STOP/drive are session-level and never listed.
 */
function validateSetpoints(devices) {
  const errors = [];
  const seen = new Map();
  for (const d of devices) {
    const list = d.setpoints;
    if (list == null) continue;
    if (!Array.isArray(list)) {
      errors.push(`${d.id}: setpoints must be an array`);
      continue;
    }
    for (const sp of list) {
      const where = `${d.id}.setpoints[${sp && sp.id}]`;
      if (typeof sp.id !== 'string' || !/^[a-z][A-Za-z0-9]*$/.test(sp.id)) {
        errors.push(`${where}: id must be a camelCase identifier`);
        continue;
      }
      if (seen.has(sp.id)) errors.push(`${where}: id also used by ${seen.get(sp.id)}`);
      seen.set(sp.id, d.id);
      if (typeof sp.label !== 'string' || !sp.label) errors.push(`${where}: label required`);
      if (![sp.min, sp.max, sp.step].every(Number.isFinite)) {
        errors.push(`${where}: min/max/step must be finite numbers`);
      } else {
        if (!(sp.min < sp.max)) errors.push(`${where}: min must be < max`);
        if (!(sp.step > 0) || sp.step > sp.max - sp.min) errors.push(`${where}: step must be in (0, max-min]`);
      }
      if (typeof sp.unit !== 'string') errors.push(`${where}: unit required (use "" for dimensionless)`);
      if (!Number.isInteger(sp.digits) || sp.digits < 0 || sp.digits > 6) errors.push(`${where}: digits must be 0..6`);
      if (typeof sp.stateKey !== 'string' || !sp.stateKey) errors.push(`${where}: stateKey required`);
      for (const opt of ['liveKey', 'api', 'note']) {
        if (sp[opt] != null && (typeof sp[opt] !== 'string' || !sp[opt])) errors.push(`${where}: ${opt} must be a non-empty string`);
      }
      if (sp.releasable != null && typeof sp.releasable !== 'boolean') errors.push(`${where}: releasable must be boolean`);
    }
  }
  return errors;
}

/**
 * Per-device `state` — what a plant snapshot (#224 §2) saves and restores.
 *
 *   { "plant": "_heron" | null, "clearOnLoad"?: ["<key>"…], "fields": [
 *       { "key": "heronHead", "cpp": "head" },          // both sides
 *       { "key": "energyLevel", "cpp": null },          // TS physicsState only
 *       { "cpp": "drive" },                              // C++ plant struct only
 *       { "cpp": "@_rollers[].omega", "count": 66 } ] } // SEGSimulator member array
 *
 * `key` is a DevicePhysicsState field; `cpp` is a field of the SEGSimulator
 * member named by `plant`, or (leading `@`) a SEGSimulator member itself. The
 * order is the wire order on both sides. `type` (default number) says how a
 * non-number value becomes a float: bool → 0/1, enum → index into `values`,
 * nullable → -1 for null on the TS side and `cppNull` (default -1) in C++.
 * The list has to cover every field a step reads before it writes, or a
 * restored plant diverges — `npm run test:snapshots` is what proves it.
 */
const STATE_TYPES = new Set(['number', 'bool', 'enum', 'nullable']);
const STATE_CPP_RE = /^@?[A-Za-z_]\w*(\[\])?(\.[A-Za-z_]\w*)?$/;
const STATE_KEY_RE = /^[a-z][A-Za-z0-9]*$/;

function validateState(devices) {
  const errors = [];
  let physicsText = '';
  try {
    physicsText = readFileSync(DEVICE_PHYSICS, 'utf8');
  } catch (e) {
    return [`state key check: ${e.message}`];
  }
  for (const d of devices) {
    const s = d.state;
    if (!s || typeof s !== 'object' || !Array.isArray(s.fields) || s.fields.length === 0) {
      errors.push(`${d.id}: state.fields[] required (what a plant snapshot saves — see docs/SNAPSHOTS.md)`);
      continue;
    }
    const wasm = d.wasmMode != null;
    if (s.plant != null && (typeof s.plant !== 'string' || !/^_[a-z]\w*$/.test(s.plant))) {
      errors.push(`${d.id}: state.plant must be a SEGSimulator member name like "_heron", or null`);
    }
    if (!wasm && s.plant != null) errors.push(`${d.id}: state.plant set on a JS-only device (wasmMode null)`);
    const keys = new Set();
    const cpps = new Set();
    for (const [i, f] of s.fields.entries()) {
      const where = `${d.id}.state.fields[${i}]`;
      const hasKey = f.key != null;
      const hasCpp = f.cpp != null;
      if (!hasKey && !hasCpp) errors.push(`${where}: needs a key, a cpp field, or both`);
      if (hasKey) {
        if (typeof f.key !== 'string' || !STATE_KEY_RE.test(f.key)) errors.push(`${where}: key must be a camelCase identifier`);
        else if (keys.has(f.key)) errors.push(`${where}: duplicate key "${f.key}"`);
        else if (!fileContainsKey(physicsText, f.key)) errors.push(`${where}: "${f.key}" is not a DevicePhysicsState field (${DEVICE_PHYSICS})`);
        keys.add(f.key);
      }
      if (hasCpp) {
        if (!wasm) errors.push(`${where}: cpp field on a JS-only device`);
        if (typeof f.cpp !== 'string' || !STATE_CPP_RE.test(f.cpp)) errors.push(`${where}: cpp "${f.cpp}" is not field / @member / @member[].field`);
        else if (cpps.has(f.cpp)) errors.push(`${where}: duplicate cpp "${f.cpp}"`);
        else if (!f.cpp.startsWith('@') && s.plant == null) errors.push(`${where}: cpp "${f.cpp}" needs state.plant (or an @member path)`);
        cpps.add(f.cpp);
        const isArray = typeof f.cpp === 'string' && f.cpp.includes('[]');
        if (isArray !== (f.count != null)) errors.push(`${where}: count goes with (and only with) a [] cpp path`);
        if (f.count != null && (!Number.isInteger(f.count) || f.count < 1)) errors.push(`${where}: count must be a positive integer`);
        if (isArray && hasKey) errors.push(`${where}: an array cpp field cannot map to a single key`);
      }
      const type = f.type ?? 'number';
      if (!STATE_TYPES.has(type)) errors.push(`${where}: type must be one of ${[...STATE_TYPES].join(', ')}`);
      if (type === 'enum' && (!Array.isArray(f.values) || f.values.length < 2 || !f.values.every((v) => typeof v === 'string'))) {
        errors.push(`${where}: an enum needs values: [≥2 strings]`);
      }
      if (type !== 'enum' && f.values != null) errors.push(`${where}: values only goes with type enum`);
      if (f.cppNull != null && (type !== 'nullable' || !Number.isFinite(f.cppNull))) errors.push(`${where}: cppNull is a finite number on a nullable field`);
      const known = new Set(['key', 'cpp', 'type', 'values', 'count', 'cppNull']);
      for (const k of Object.keys(f)) if (!known.has(k)) errors.push(`${where}: unknown property "${k}"`);
    }
    for (const k of s.clearOnLoad ?? []) {
      if (typeof k !== 'string' || !fileContainsKey(physicsText, k)) errors.push(`${d.id}: state.clearOnLoad "${k}" is not a DevicePhysicsState field`);
    }
  }
  return errors;
}

/** Saved before every mode's own fields: the simulator clock and drive setpoint. */
const STATE_CPP_PREFIX = [{ cpp: '@_time' }, { cpp: '@_drive' }];

/** 32-bit FNV-1a — a stable number C++ and JS can both compare. */
function fnv1a32(text) {
  let h = 0x811c9dc5;
  for (const b of Buffer.from(text, 'utf8')) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Wire layouts derived from the `state` blocks: TS keys in order, and for
 * each wasm plant the C++ float vector `[prefix…, cpp fields…]` with offsets.
 */
function stateLayout(devices) {
  const rows = devices.map((d) => {
    const fields = d.state.fields.map((f) => ({
      key: f.key ?? null,
      cpp: f.cpp ?? null,
      type: f.type ?? 'number',
      values: f.values ?? null,
      count: f.count ?? 1,
      cppNull: f.type === 'nullable' ? (f.cppNull ?? -1) : null,
      offset: -1,
    }));
    let cppSize = 0;
    if (d.wasmMode != null) {
      cppSize = STATE_CPP_PREFIX.length;
      for (const f of fields) {
        if (f.cpp == null) continue;
        f.offset = cppSize;
        cppSize += f.count;
      }
    }
    return { id: d.id, wasmMode: d.wasmMode, plant: d.state.plant ?? null, clearOnLoad: d.state.clearOnLoad ?? [], fields, cppSize };
  });
  const canonical = JSON.stringify({
    prefix: STATE_CPP_PREFIX.map((f) => f.cpp),
    devices: rows.map((r) => [r.id, r.wasmMode, r.plant, r.fields.map((f) => [f.key, f.cpp, f.type, f.values, f.count, f.cppNull])]),
  });
  return { rows, hash: fnv1a32(canonical) };
}

/** C++ lvalue for a cpp path (`i` is the loop index of an array path). */
function cppLvalue(plant, path) {
  const expr = path.startsWith('@') ? path.slice(1) : `${plant}.${path}`;
  return expr.replace('[]', '[i]');
}

function emitPlantStateH(layout) {
  const wasmRows = layout.rows.filter((r) => r.wasmMode != null).sort((a, b) => a.wasmMode - b.wasmMode);
  const sizes = wasmRows.map((r) => `    ${r.cppSize}, // ${simEnum(r.id)}`).join('\n');
  const hex = `0x${layout.hash.toString(16).padStart(8, '0')}u`;
  const catalogHash = sha256(readFileSync(SRC_JSON, 'utf8')).slice(0, 12);
  return `${HEADER_H}
// Plant snapshot layout (#224 §2), from each device's \`state\` block.
// Every mode saves [_time, _drive, <its state.fields with a cpp path>…] as
// floats into the SEGSimulator scratch (getScratchPtr) — see
// SEGSimulator::plantSave / plantLoad and docs/SNAPSHOTS.md.

#include <cstdint>

static constexpr uint32_t PLANT_STATE_LAYOUT_HASH = ${hex};
static constexpr const char* DEVICE_CATALOG_HASH = "${catalogHash}";

static constexpr int PLANT_STATE_SIZES[] = {
${sizes}
};

static_assert(sizeof(PLANT_STATE_SIZES) / sizeof(PLANT_STATE_SIZES[0]) == ${wasmRows.length},
              "PLANT_STATE_SIZES must cover every SimMode");
`;
}

function emitPlantStateImplH(layout) {
  const wasmRows = layout.rows.filter((r) => r.wasmMode != null).sort((a, b) => a.wasmMode - b.wasmMode);
  const prefixSave = STATE_CPP_PREFIX.map((f, i) => `    s[${i}] = ${cppLvalue(null, f.cpp)};`).join('\n');
  const prefixLoad = STATE_CPP_PREFIX.map((f, i) => `    ${cppLvalue(null, f.cpp)} = s[${i}];`).join('\n');
  // An array path's count must be the member array's length, or a resized
  // array would silently save a prefix (or read past the end).
  const arrayAsserts = new Map();
  const cases = (load) => wasmRows.map((r) => {
    const lines = [];
    for (const f of r.fields) {
      if (f.cpp == null) continue;
      const lv = cppLvalue(r.plant, f.cpp);
      const isBool = f.type === 'bool' || f.type === 'enum';
      if (f.cpp.includes('[]')) {
        const arr = cppLvalue(r.plant, f.cpp.split('[]')[0]);
        if (!load && !arrayAsserts.has(`${arr}#${f.count}`)) {
          arrayAsserts.set(`${arr}#${f.count}`, `    static_assert(sizeof(${arr}) / sizeof(${arr}[0]) == ${f.count},\n`
            + `                  "physics/devices.json ${r.id} state: ${f.cpp} count must match the array length");`);
        }
        lines.push(load
          ? `            for (int i = 0; i < ${f.count}; ++i) ${lv} = s[${f.offset} + i];`
          : `            for (int i = 0; i < ${f.count}; ++i) s[${f.offset} + i] = ${lv};`);
      } else if (isBool) {
        lines.push(load ? `            ${lv} = s[${f.offset}] != 0.f;` : `            s[${f.offset}] = ${lv} ? 1.f : 0.f;`);
      } else {
        lines.push(load ? `            ${lv} = s[${f.offset}];` : `            s[${f.offset}] = ${lv};`);
      }
    }
    return `        case ${simEnum(r.id)}:\n${lines.join('\n')}\n            break;`;
  }).join('\n');
  const saveCases = cases(false);
  const loadCases = cases(true);
  return `// AUTO-GENERATED from physics/devices.json — do not edit.
// Regenerate: npm run codegen:catalog
//
// SEGSimulator::plantSave / plantLoad bodies (#224 §2). Included once, by
// cpp/src/plant/plant_state.cpp; the layout is in generated/plant-state.h.

int SEGSimulator::plantStateSize(int mode) const {
    return (mode >= 0 && mode < SIM_MODE_COUNT) ? PLANT_STATE_SIZES[mode] : 0;
}

int SEGSimulator::plantSave(int mode) {
${[...arrayAsserts.values()].join('\n')}
    const int n = plantStateSize(mode);
    if (n <= 0) return 0;
    float* s = reinterpret_cast<float*>(getScratchPtr(n));
${prefixSave}
    switch (mode) {
${saveCases}
        default:
            break;
    }
    return n;
}

bool SEGSimulator::plantLoad(int mode, int count, uint32_t layoutHash) {
    const int n = plantStateSize(mode);
    if (layoutHash != PLANT_STATE_LAYOUT_HASH || n <= 0 || count != n) return false;
    if (static_cast<int>(_scratch.size()) < n) return false;
    const float* s = _scratch.data();
    for (int i = 0; i < n; ++i) {
        if (!std::isfinite(s[i])) return false;
    }
${prefixLoad}
    switch (mode) {
${loadCases}
        default:
            break;
    }
    packRollerState();
    return true;
}
`;
}

function emitDeviceStateTs(layout) {
  const hash = layout.hash;
  const catalogHash = sha256(readFileSync(SRC_JSON, 'utf8')).slice(0, 12);
  const rows = layout.rows.map((r) => {
    const fields = r.fields.map((f) => {
      const parts = [`key: ${JSON.stringify(f.key)}`, `cpp: ${JSON.stringify(f.cpp)}`, `type: '${f.type}'`];
      if (f.values) parts.push(`values: ${JSON.stringify(f.values)}`);
      if (f.count !== 1) parts.push(`count: ${f.count}`);
      if (f.cppNull != null) parts.push(`cppNull: ${f.cppNull}`);
      parts.push(`offset: ${f.offset}`);
      return `      { ${parts.join(', ')} }`;
    }).join(',\n');
    const clear = r.clearOnLoad.length ? `\n    clearOnLoad: ${JSON.stringify(r.clearOnLoad)},` : '';
    return `  '${r.id}': {
    wasmMode: ${r.wasmMode == null ? 'null' : r.wasmMode},
    cppSize: ${r.cppSize},${clear}
    fields: [
${fields}
    ]
  }`;
  }).join(',\n');
  return `${HEADER_TS}
/**
 * Plant snapshot layout (#224 §2) — each device's \`state\` block in
 * physics/devices.json. Imported only by the lazy snapshot chunk
 * (src/session/plant-snapshot.ts); the entry chunk never loads it.
 */

export type DeviceStateFieldType = 'number' | 'bool' | 'enum' | 'nullable';

export interface DeviceStateField {
  /** DevicePhysicsState key (null: C++-only). */
  key: string | null;
  /** C++ path: a field of the mode's plant struct, or \`@member\` (null: TS-only). */
  cpp: string | null;
  type: DeviceStateFieldType;
  /** enum: the value for index 0, 1, … */
  values?: readonly string[];
  /** Floats this cpp path takes (arrays only). */
  count?: number;
  /** nullable: what the C++ plant stores for "none". */
  cppNull?: number;
  /** Index into the C++ float vector (-1 when there is no cpp path). */
  offset: number;
}

export interface DeviceStateLayout {
  wasmMode: number | null;
  /** C++ vector length — \`SEGSimulator::plantStateSize(wasmMode)\` (0 for JS-only). */
  cppSize: number;
  /** physicsState keys set to null after a load (derived geometry the next step rebuilds). */
  clearOnLoad?: readonly string[];
  fields: readonly DeviceStateField[];
}

/** C++ vector indices every mode saves first: [simulator time, drive setpoint]. */
export const PLANT_STATE_PREFIX = { time: 0, drive: 1, length: ${STATE_CPP_PREFIX.length} } as const;

/** FNV-1a of every state block — \`PLANT_STATE_LAYOUT_HASH\` in generated/plant-state.h. */
export const PLANT_STATE_LAYOUT_HASH = 0x${hash.toString(16).padStart(8, '0')};

/** First 12 hex of sha256(physics/devices.json) — which catalog wrote a snapshot. */
export const DEVICE_CATALOG_HASH = '${catalogHash}';

export const DEVICE_STATE_LAYOUT: Readonly<Record<string, DeviceStateLayout>> = {
${rows}
};
`;
}

/**
 * Every telemetryKey must carry label/unit/digits in `telemetry` so operator
 * chrome, the generic gauge strip and CSV headers all read the same schema.
 */
function validateTelemetryMeta(devices) {
  const errors = [];
  const columns = new Map();
  for (const d of devices) {
    const keys = d.telemetryKeys || [];
    const meta = d.telemetry || {};
    for (const key of keys) {
      const m = meta[key];
      if (!m) {
        errors.push(`${d.id}: telemetryKey "${key}" has no telemetry[] label/unit entry`);
        continue;
      }
      if (typeof m.label !== 'string' || !m.label) {
        errors.push(`${d.id}.${key}: telemetry.label required`);
      }
      if (typeof m.unit !== 'string') {
        errors.push(`${d.id}.${key}: telemetry.unit required (use "" for dimensionless)`);
      }
      if (typeof m.digits !== 'number' || m.digits < 0 || m.digits > 8) {
        errors.push(`${d.id}.${key}: telemetry.digits must be 0..8`);
      }
      if (m.scale != null && (typeof m.scale !== 'number' || !Number.isFinite(m.scale))) {
        errors.push(`${d.id}.${key}: telemetry.scale must be a finite number`);
      }
      if (m.format != null && !TELEMETRY_FORMATS.has(m.format)) {
        errors.push(`${d.id}.${key}: telemetry.format must be one of ${[...TELEMETRY_FORMATS].map((f) => `"${f}"`).join(', ')}`);
      }
    }
    for (const key of Object.keys(meta)) {
      if (!keys.includes(key)) {
        errors.push(`${d.id}: telemetry["${key}"] is not in telemetryKeys`);
      }
    }
    if (TELEMETRY_SNAP_EXEMPT_IDS.has(d.id)) continue;
    for (const key of keys) {
      const col = snakeCase(key);
      if (columns.has(col)) {
        errors.push(`CSV column collision "${col}": ${columns.get(col)} and ${d.id}.${key}`);
      }
      columns.set(col, `${d.id}.${key}`);
    }
  }
  return errors;
}

/**
 * telemetry-schema.ts must build its per-device CSV columns from the generated
 * catalog, not a hand-maintained list — otherwise a new device's keys silently
 * drop out of export and replay.
 */
function checkTelemetrySchemaUsesCatalog() {
  let text;
  try {
    text = readFileSync(TELEMETRY_SCHEMA, 'utf8');
  } catch (e) {
    return [`telemetry schema catalog usage check: ${e.message}`];
  }
  if (!/TELEMETRY_CSV_DEVICE_COLUMNS/.test(text)
      || !/from ['"].*generated\/device-catalog['"]/.test(text)) {
    return [`${TELEMETRY_SCHEMA} must import TELEMETRY_CSV_DEVICE_COLUMNS from generated/device-catalog (no hand-rolled device column list)`];
  }
  return [];
}

function validateCatalog(data) {
  const devices = data.devices;
  if (!Array.isArray(devices) || devices.length === 0) {
    throw new Error('devices.json: devices[] required');
  }
  const shaderSeen = new Map();
  const wasmSeen = new Map();
  const ids = new Set();
  for (const d of devices) {
    if (!d.id || typeof d.shaderMode !== 'number') {
      throw new Error(`devices.json: invalid row ${JSON.stringify(d)}`);
    }
    if (ids.has(d.id)) throw new Error(`duplicate id ${d.id}`);
    ids.add(d.id);
    if (shaderSeen.has(d.shaderMode)) {
      throw new Error(`duplicate shaderMode ${d.shaderMode} (${shaderSeen.get(d.shaderMode)} and ${d.id})`);
    }
    shaderSeen.set(d.shaderMode, d.id);
    if (d.wasmMode != null) {
      if (typeof d.wasmMode !== 'number') throw new Error(`${d.id}: wasmMode must be number or null`);
      if (wasmSeen.has(d.wasmMode)) {
        throw new Error(`duplicate wasmMode ${d.wasmMode} (${wasmSeen.get(d.wasmMode)} and ${d.id})`);
      }
      wasmSeen.set(d.wasmMode, d.id);
    }
  }
  const reserved = data.reservedWasmModes || [];
  for (const r of reserved) {
    if (wasmSeen.has(r)) {
      throw new Error(`reservedWasmModes ${r} collides with assigned plant ${wasmSeen.get(r)}`);
    }
  }
  const wasmValues = [...wasmSeen.keys()].sort((a, b) => a - b);
  for (let i = 0; i < wasmValues.length; i++) {
    if (wasmValues[i] !== i) {
      throw new Error(`wasmMode hole: expected dense 0..${wasmValues.length - 1}, got ${wasmValues.join(',')}`);
    }
  }
  return { devices, reserved, wasmCount: wasmValues.length };
}

function collectPluginIds() {
  const dirs = [
    join(ROOT, 'src', 'devices', 'core'),
    join(ROOT, 'src', 'devices', 'quanta'),
  ];
  const ids = new Set();
  const idRe = /^\s*id:\s*'([a-z0-9-]+)'\s*,?\s*$/;
  const catalogRe = /catalogIdentity\(\s*'([a-z0-9-]+)'\s*\)/g;
  for (const dir of dirs) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.ts') && !name.endsWith('.js')) continue;
      if (name === 'index.ts') continue;
      const text = readFileSync(join(dir, name), 'utf8');
      for (const line of text.split('\n')) {
        const m = line.match(idRe);
        if (m) ids.add(m[1]);
      }
      for (const m of text.matchAll(catalogRe)) {
        ids.add(m[1]);
      }
    }
  }
  return ids;
}

function fileContainsKey(text, key) {
  const re = new RegExp(`\\b${key}\\b`);
  return re.test(text);
}

function pluginSourceForId(id) {
  const quantaMap = {
    maglev: 'magnetic-levitation.ts',
    homopolar: 'homopolar-generator.ts',
    'halbach-viz': 'halbach-viz.ts',
    'pulse-coil': 'pulse-coil.ts',
    transformer: 'transformer.ts',
    vdg: 'van-de-graaff.ts',
    hall: 'hall-effect.ts',
    'lorentz-sled': 'lorentz-sled.ts',
    'jumping-ring': 'jumping-ring.ts',
    'drop-tube': 'drop-tube.ts',
  };
  if (quantaMap[id]) {
    return join(ROOT, 'src', 'devices', 'quanta', quantaMap[id]);
  }
  return join(ROOT, 'src', 'devices', 'core', 'register-core.ts');
}

function checkPlugins(devices) {
  const pluginIds = collectPluginIds();
  const catalogIds = new Set(devices.map((d) => d.id));
  const errors = [];
  for (const id of pluginIds) {
    if (!catalogIds.has(id)) {
      errors.push(`plugin id "${id}" is not in physics/devices.json`);
    }
  }
  for (const d of devices) {
    if (!pluginIds.has(d.id)) {
      errors.push(`catalog id "${d.id}" has no plugin registration (id: '${d.id}')`);
    }
    const src = pluginSourceForId(d.id);
    let text;
    try {
      text = readFileSync(src, 'utf8');
    } catch {
      errors.push(`missing plugin file for ${d.id}: ${src}`);
      continue;
    }
    for (const key of d.telemetryKeys || []) {
      if (!fileContainsKey(text, key) && d.category === 'quanta') {
        errors.push(`${d.id}: telemetryKey "${key}" not found in ${src}`);
      }
    }
  }
  return errors;
}

/**
 * DeviceTelemetrySnap (src/telemetry/types.ts) and the hub's empty/derived
 * snapshots (src/telemetry-hub.ts) are hand-written, not codegen'd — but
 * every catalog telemetryKey must appear as a field in both, or a device's
 * operator-panel readout silently reads `undefined`.
 */
function checkTelemetrySnapCoverage(devices) {
  const errors = [];
  let typesText, hubText;
  try {
    typesText = readFileSync(TELEMETRY_TYPES, 'utf8');
    hubText = readFileSync(TELEMETRY_HUB, 'utf8');
  } catch (e) {
    return [`telemetry snap coverage check: ${e.message}`];
  }
  for (const d of devices) {
    if (TELEMETRY_SNAP_EXEMPT_IDS.has(d.id)) continue;
    for (const key of d.telemetryKeys || []) {
      if (!fileContainsKey(typesText, key)) {
        errors.push(`${d.id}: telemetryKey "${key}" missing from DeviceTelemetrySnap (${TELEMETRY_TYPES})`);
      }
      if (!fileContainsKey(hubText, key)) {
        errors.push(`${d.id}: telemetryKey "${key}" missing from telemetry-hub.ts snap builders`);
      }
    }
  }
  return errors;
}

/**
 * apply-wasm-plant.ts must derive its wasm-plant device list from the
 * generated catalog, not a hand-rolled array — otherwise a new wasmMode
 * device silently misses the shared focus ladder.
 */
function checkWasmPlantUsesCatalog() {
  let text;
  try {
    text = readFileSync(APPLY_WASM_PLANT, 'utf8');
  } catch (e) {
    return [`wasm plant catalog usage check: ${e.message}`];
  }
  if (!/from ['"].*generated\/device-catalog['"]/.test(text)) {
    return [`${APPLY_WASM_PLANT} must import its wasm-plant device list from generated/device-catalog (no hand-rolled id array)`];
  }
  return [];
}

function checkWgslNamedConstants(devices, wgslBody) {
  const particle = readFileSync(PARTICLE_COMPUTE, 'utf8');
  const errors = [];
  for (const d of devices) {
    const name = wgslConst(d.id);
    if (!wgslBody.includes(`const ${name}:`)) {
      errors.push(`generated WGSL missing ${name}`);
    }
    if (!particle.includes(name)) {
      errors.push(`particle-compute.wgsl does not reference ${name} (shaderMode ${d.shaderMode})`);
    }
  }
  return errors;
}

function emitTs(data, devices, reserved, wasmCount) {
  const entries = devices.map((d) => {
    const wasm = d.wasmMode == null ? 'null' : String(d.wasmMode);
    const keys = (d.telemetryKeys || []).map((k) => `'${k}'`).join(', ');
    const meta = (d.telemetryKeys || []).map((k) => {
      const m = d.telemetry[k];
      const parts = [
        `label: ${JSON.stringify(m.label)}`,
        `unit: ${JSON.stringify(m.unit)}`,
        `digits: ${m.digits}`,
      ];
      if (m.scale != null) parts.push(`scale: ${m.scale}`);
      if (m.format) parts.push(`format: '${m.format}' as TelemetryValueFormat`);
      return `      ${JSON.stringify(k)}: { ${parts.join(', ')} }`;
    }).join(',\n');
    const chrome = d.chrome
      ? `{ emoji: ${JSON.stringify(d.chrome.emoji)}, label: ${JSON.stringify(d.chrome.label)}, sort: ${d.chrome.sort} }`
      : 'undefined';
    return `  {
    id: '${d.id}',
    label: ${JSON.stringify(d.label)},
    category: '${d.category}',
    chrome: ${chrome} as DeviceChrome | undefined,
    shaderMode: ${d.shaderMode},
    wasmMode: ${wasm} as number | null,
    telemetryKeys: [${keys}] as const,
    telemetry: {
${meta},
    } as Record<string, TelemetryFieldMeta>,
    fidelity: ${JSON.stringify(d.fidelity)},
  }`;
  }).join(',\n');

  const chromeDevices = devices
    .filter((d) => d.chrome)
    .sort((a, b) => a.chrome.sort - b.chrome.sort);
  const chromeRows = chromeDevices.map((d) =>
    `  { id: '${d.id}', emoji: ${JSON.stringify(d.chrome.emoji)}, label: ${JSON.stringify(d.chrome.label)}, sort: ${d.chrome.sort} }`
  ).join(',\n');

  const setpointRows = devices.flatMap((d) => (d.setpoints || []).map((sp) => {
    const parts = [
      `deviceId: '${d.id}'`,
      `id: '${sp.id}'`,
      `label: ${JSON.stringify(sp.label)}`,
      `min: ${sp.min}`,
      `max: ${sp.max}`,
      `step: ${sp.step}`,
      `unit: ${JSON.stringify(sp.unit)}`,
      `digits: ${sp.digits}`,
      `stateKey: '${sp.stateKey}'`,
    ];
    if (sp.liveKey) parts.push(`liveKey: '${sp.liveKey}'`);
    if (sp.api) parts.push(`api: '${sp.api}'`);
    if (sp.releasable) parts.push('releasable: true');
    if (sp.note) parts.push(`note: ${JSON.stringify(sp.note)}`);
    return `  { ${parts.join(', ')} }`;
  })).join(',\n');

  const snapDevices = devices.filter((d) => !TELEMETRY_SNAP_EXEMPT_IDS.has(d.id));
  const fieldRows = snapDevices.flatMap((d) =>
    (d.telemetryKeys || []).map((k) => {
      const m = d.telemetry[k];
      return `  { deviceId: '${d.id}', key: '${k}', column: '${snakeCase(k)}', label: ${JSON.stringify(m.label)}, unit: ${JSON.stringify(m.unit)}, digits: ${m.digits}`
        + (m.scale != null ? `, scale: ${m.scale}` : '')
        + (m.format ? `, format: '${m.format}'` : '')
        + ' }';
    })
  ).join(',\n');
  const segMetaId = TELEMETRY_SNAP_EXEMPT_IDS.size
    ? [...TELEMETRY_SNAP_EXEMPT_IDS].map((id) => `'${id}'`).join(', ')
    : '';

  const wasmPlants = devices
    .filter((d) => d.wasmMode != null)
    .sort((a, b) => a.wasmMode - b.wasmMode);
  const wasmPairs = wasmPlants.map((d) => `  '${d.id}': ${d.wasmMode}`).join(',\n');
  const wasmIds = wasmPlants.map((d) => `'${d.id}'`);

  return `${HEADER_TS}
/** '' = plain fixed-point, 'si' = SI-prefix the unit, 'exp' = exponential. */
export type TelemetryValueFormat = '' | 'si' | 'exp';

/** Display schema for one telemetry key (units live in the catalog, not the UI). */
export interface TelemetryFieldMeta {
  label: string;
  unit: string;
  digits: number;
  /** Multiply the raw hub value before formatting (e.g. 0–1 → %). */
  scale?: number;
  format?: TelemetryValueFormat;
}

/** Operator-chrome metadata for a device's mode button (index.html has none hand-listed). */
export interface DeviceChrome {
  emoji: string;
  label: string;
  sort: number;
}

export interface DeviceCatalogEntry {
  id: string;
  label: string;
  category: string;
  chrome?: DeviceChrome;
  shaderMode: number;
  wasmMode: number | null;
  telemetryKeys: readonly string[];
  telemetry: Record<string, TelemetryFieldMeta>;
  fidelity: string;
}

export const DEVICE_CATALOG = [
${entries},
] as const;

/** Mode-button chrome for devices that have one, in display order. */
export const MODE_BUTTON_CHROME: readonly { id: string; emoji: string; label: string; sort: number }[] = [
${chromeRows},
];

/**
 * One operator setpoint slider (physics/devices.json \`setpoints\`). The panel
 * generates the control; it only ever *writes* \`api(value)\` or
 * \`physicsState[stateKey] = value\` — the plant clock reads it on its next step.
 */
export interface DeviceSetpoint {
  deviceId: string;
  /** camelCase; also the DOM id stem (\`<id>Slider\`, \`<id>Value\`, \`<id>Source\`). */
  id: string;
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
  digits: number;
  /** \`physicsState\` field the slider writes (when no \`api\`). */
  stateKey: string;
  /** \`physicsState\` field shown while the setpoint is unset. */
  liveKey?: string;
  /** \`window\` function that already owns this write (e.g. setLorentzFieldT). */
  api?: string;
  /** Show a release control that hands the quantity back to the plant. */
  releasable?: boolean;
  note?: string;
}

/** Catalog-declared setpoint sliders, in catalog order. */
export const DEVICE_SETPOINTS: readonly DeviceSetpoint[] = [
${setpointRows},
];

/** One catalog telemetry key bound to its device, CSV column and display schema. */
export interface DeviceTelemetryField extends TelemetryFieldMeta {
  deviceId: string;
  /** DeviceTelemetrySnap field name. */
  key: string;
  /** CSV / JSON export column name (snake_case of \`key\`). */
  column: string;
}

/**
 * Every catalog telemetry key that is a \`DeviceTelemetrySnap\` field, in catalog
 * order. \`${segMetaId}\` is excluded: its keys live on SegOperatorTelemetry
 * (see MODE_MATRIX.md), and the SEG gauges read those directly.
 */
export const DEVICE_TELEMETRY_FIELDS: readonly DeviceTelemetryField[] = [
${fieldRows},
];

const FIELDS_BY_DEVICE: Record<string, DeviceTelemetryField[]> = {};
for (const f of DEVICE_TELEMETRY_FIELDS) {
  (FIELDS_BY_DEVICE[f.deviceId] ||= []).push(f);
}

export const TELEMETRY_FIELD_BY_COLUMN: Record<string, DeviceTelemetryField> =
  Object.fromEntries(DEVICE_TELEMETRY_FIELDS.map((f) => [f.column, f]));

/** CSV/JSON export columns for per-device telemetry, in catalog order. */
export const TELEMETRY_CSV_DEVICE_COLUMNS: readonly string[] =
  DEVICE_TELEMETRY_FIELDS.map((f) => f.column);

/** Snap-backed telemetry fields for one device id ([] for seg / unknown ids). */
export function telemetryFieldsForDevice(id: string): readonly DeviceTelemetryField[] {
  return FIELDS_BY_DEVICE[id] || [];
}

export const DEVICE_BY_ID: Record<string, DeviceCatalogEntry> = Object.fromEntries(
  DEVICE_CATALOG.map((d) => [d.id, d])
);

/** C++ SimMode index by device id. JS-only devices are omitted. */
export const WASM_MODE_BY_ID: Record<string, number> = {
${wasmPairs},
};

export const WASM_DEVICE_IDS = [${wasmIds.join(', ')}] as const;

export const SIM_MODE_COUNT = ${wasmCount};

export const RESERVED_WASM_MODES = [${reserved.join(', ')}] as const;

export const NEXT_SHADER_MODE = ${Math.max(...devices.map((d) => d.shaderMode)) + 1};

/** Identity fields for DevicePlugin registration (modeIndex = shaderMode). */
export function catalogIdentity(id: string): {
  id: string;
  label: string;
  category: string;
  modeIndex: number;
  wasmMode?: number;
} {
  const d = DEVICE_BY_ID[id];
  if (!d) throw new Error('[device-catalog] unknown id: ' + id);
  return {
    id: d.id,
    label: d.label,
    category: d.category,
    modeIndex: d.shaderMode,
    ...(d.wasmMode != null ? { wasmMode: d.wasmMode } : {}),
  };
}

export function wasmModeForDevice(id: string): number | null {
  const d = DEVICE_BY_ID[id];
  return d ? d.wasmMode : null;
}

export function shaderModeForDevice(id: string): number | null {
  const d = DEVICE_BY_ID[id];
  return d ? d.shaderMode : null;
}
`;
}

function emitH(devices, reserved, wasmCount) {
  const deviceColumns = devices
    .filter((d) => !TELEMETRY_SNAP_EXEMPT_IDS.has(d.id))
    .flatMap((d) => (d.telemetryKeys || []).map((k) => snakeCase(k)));
  const enumLines = devices
    .filter((d) => d.wasmMode != null)
    .sort((a, b) => a.wasmMode - b.wasmMode)
    .map((d) => `    ${simEnum(d.id)} = ${d.wasmMode}`)
    .join(',\n');

  const catalogRows = devices.map((d) => {
    const wasm = d.wasmMode == null ? -1 : d.wasmMode;
    return `    { "${d.id}", ${d.shaderMode}, ${wasm} }`;
  }).join(',\n');

  const reservedArr = reserved.length ? reserved.join(', ') : '0';
  const reservedCount = reserved.length;

  return `${HEADER_H}
enum SimMode {
${enumLines}
};

static constexpr int SIM_MODE_COUNT = ${wasmCount};

struct DeviceCatalogRow {
    const char* id;
    int shaderMode;
    int wasmMode; // -1 = JS-only (no SimMode plant)
};

static constexpr DeviceCatalogRow DEVICE_CATALOG[] = {
${catalogRows}
};

static constexpr int DEVICE_CATALOG_COUNT = ${devices.length};

static constexpr int RESERVED_WASM_MODES[] = { ${reservedArr} };
static constexpr int RESERVED_WASM_MODE_COUNT = ${reservedCount};

static_assert(SIM_MODE_COUNT == ${wasmCount}, "SIM_MODE_COUNT must match physics/devices.json wasm plants");

// Per-device telemetry CSV columns, catalog order. Native SEG-only export emits
// the base columns and leaves these empty (see cpp/src/telemetry_export.h).
static constexpr const char* TELEMETRY_CSV_DEVICE_COLUMNS =
    "${deviceColumns.join(',')}";

static constexpr int TELEMETRY_CSV_DEVICE_COLUMN_COUNT = ${deviceColumns.length};
`;
}

function emitWgsl(devices) {
  const lines = devices.map((d) => `const ${wgslConst(d.id)}: u32 = ${d.shaderMode}u;`);
  return `${HEADER_WGSL}
${lines.join('\n')}
`;
}

function emitModeMatrix(devices, reserved, layout) {
  const reservedText = reserved.length ? reserved.join(', ') : 'none';
  const stateRows = layout.rows.map((r) => {
    const keys = r.fields.filter((f) => f.key).length;
    const shared = r.fields.filter((f) => f.key && f.cpp).length;
    const cpp = r.wasmMode == null ? '—' : `${r.cppSize} floats`;
    return `| \`${r.id}\` | ${keys} | ${cpp} | ${r.wasmMode == null ? '—' : shared} |`;
  });
  const rows = devices.map((d) => {
    const wasm =
      d.wasmMode == null
        ? 'none (`wasmMode: null`)'
        : `${d.wasmMode} (\`${simEnum(d.id)}\`)`;
    const keys = (d.telemetryKeys || []).map((k) => {
      const unit = d.telemetry?.[k]?.unit;
      return unit ? `\`${k}\` (${unit})` : `\`${k}\``;
    }).join(', ');
    return `| \`${d.id}\` | ${d.shaderMode} | ${wasm} | ${keys} | ${d.fidelity} |`;
  });

  return `# Mode Contract Matrix

<!-- AUTO-GENERATED from physics/devices.json — do not edit the table by hand. -->
<!-- Regenerate: npm run codegen:catalog -->

Single source of truth: [\`physics/devices.json\`](../physics/devices.json).
Codegen emits TypeScript, C++ \`enum SimMode\`, WGSL \`MODE_*\` constants, and this table.

**\`shaderMode\` (JS/WGSL uniforms) and \`wasmMode\` / \`SimMode\` (C++) are two
intentional namespaces.** They agree for the six core devices and diverge after
that (e.g. \`homopolar\` shader **8** vs wasm **7**). Do not pass \`shaderMode\`
to \`sim.setMode()\`. The WASM bridge accepts a **device id string** and looks
up \`wasmMode\`; JS-only devices (\`wasmMode: null\`) do not call into C++.

Never reuse a retired \`shaderMode\`. New WASM plants take the next value in
\`reservedWasmModes\` (${reservedText}), then bump that list — do not
invent a plant by silently reclaiming pulse-coil's shader slot 7.

## Matrix

| Device \`id\` | \`shaderMode\` (JS/WGSL) | \`wasmMode\` / \`SimMode\` | Telemetry keys (unit) | Fidelity |
|---|---|---|---|---|
${rows.join('\n')}

## Snapshot state

Each device's \`state\` block lists what a plant snapshot saves (see
[\`SNAPSHOTS.md\`](SNAPSHOTS.md)). The C++ vector is \`[_time, _drive, …]\`
followed by the block's \`cpp\` fields; layout hash
\`0x${layout.hash.toString(16).padStart(8, '0')}\` (\`PLANT_STATE_LAYOUT_HASH\`).

| Device \`id\` | TS keys | C++ \`plantStateSize\` | Keys shared with C++ |
|---|---|---|---|
${stateRows.join('\n')}

## How to add a device

1. Add a row to \`physics/devices.json\` (new unused \`shaderMode\`; \`wasmMode\` next reserved or \`null\`), including a \`telemetry\` entry (label / unit / digits) for every \`telemetryKeys\` entry, and a \`state\` block listing every field the plant's step reads before it writes.
2. Register a plugin that spreads \`catalogIdentity('id')\`.
3. Add a C++ plant + \`case\` **only if** \`wasmMode\` is set.
4. \`npm run codegen:catalog\` (and nameplates in \`physics/constants.json\` if the energy bus needs a watt rating), then \`npm run test:snapshots\`.

## Source of truth pointers

- Catalog JSON: \`physics/devices.json\`
- Generated: \`generated/device-catalog.ts\`, \`generated/device-catalog.h\`, \`src/shaders/generated/device-catalog.wgsl\`
- Registry: \`src/devices/device-registry.ts\` (\`getDeviceModeIndex\` = shader; \`getDeviceWasmMode\` = wasm)
- WASM bridge: \`src/wasm/seg-physics-bridge.ts\` \`setMode(deviceId: string)\` only
- Telemetry display + export schema: \`DEVICE_TELEMETRY_FIELDS\` / \`TELEMETRY_CSV_DEVICE_COLUMNS\` in \`generated/device-catalog.ts\` (see [\`TELEMETRY.md\`](TELEMETRY.md))
`;
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function writeOrCheck(path, content) {
  if (CHECK) {
    let existing;
    try {
      existing = readFileSync(path, 'utf8');
    } catch {
      console.error(`[catalog] missing ${path} — run npm run codegen:catalog`);
      process.exit(1);
    }
    if (existing !== content) {
      console.error(`[catalog] stale: ${path}`);
      process.exit(1);
    }
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function main() {
  const data = loadJson();
  const { devices, reserved, wasmCount } = validateCatalog(data);

  const pluginErrors = checkPlugins(devices);
  const telemetrySnapErrors = checkTelemetrySnapCoverage(devices);
  const wasmPlantUsageErrors = checkWasmPlantUsesCatalog();
  const telemetryMetaErrors = validateTelemetryMeta(devices);
  const telemetrySchemaErrors = checkTelemetrySchemaUsesCatalog();
  const chromeErrors = validateChrome(devices);
  const setpointErrors = validateSetpoints(devices);
  const stateErrors = validateState(devices);
  if (stateErrors.length) {
    for (const e of stateErrors) console.error(`[catalog] ${e}`);
    process.exit(1);
  }
  const layout = stateLayout(devices);

  const ts = emitTs(data, devices, reserved, wasmCount);
  const h = emitH(devices, reserved, wasmCount);
  const wgsl = emitWgsl(devices);
  const md = emitModeMatrix(devices, reserved, layout);

  const wgslErrors = checkWgslNamedConstants(devices, wgsl);
  const errors = [...pluginErrors, ...(CHECK || true ? wgslErrors : [])];

  // When generating the first time, particle-compute may not yet include MODE_*.
  // Fail WGSL refs only in --check, or after we know the pass was updated.
  // Always fail plugin/catalog/telemetry-meta/telemetry-snap/wasm-plant integrity.
  const hard = [
    ...pluginErrors,
    ...telemetryMetaErrors,
    ...telemetrySnapErrors,
    ...wasmPlantUsageErrors,
    ...telemetrySchemaErrors,
    ...chromeErrors,
    ...setpointErrors,
  ];
  if (CHECK) hard.push(...wgslErrors);

  if (hard.length) {
    for (const e of hard) console.error(`[catalog] ${e}`);
    process.exit(1);
  }

  mkdirSync(OUT_DIR, { recursive: true });

  const outputs = [
    [join(OUT_DIR, 'device-catalog.ts'), ts],
    [join(OUT_DIR, 'device-catalog.h'), h],
    [join(OUT_DIR, 'device-catalog.wgsl'), wgsl],
    [join(OUT_DIR, 'device-state.ts'), emitDeviceStateTs(layout)],
    [join(OUT_DIR, 'plant-state.h'), emitPlantStateH(layout)],
    [join(OUT_DIR, 'plant-state-impl.h'), emitPlantStateImplH(layout)],
    [SHADER_OUT, wgsl],
    [MODE_MATRIX, md],
  ];

  for (const [path, content] of outputs) {
    writeOrCheck(path, content);
  }

  if (CHECK) {
    if (wgslErrors.length) {
      for (const e of wgslErrors) console.error(`[catalog] ${e}`);
      process.exit(1);
    }
    console.log(`[catalog] OK — ${outputs.length} files match physics/devices.json`);
  } else {
    const hash = sha256(readFileSync(SRC_JSON, 'utf8'));
    console.log(`[catalog] wrote ${outputs.length} files (source sha256 ${hash.slice(0, 12)}…)`);
    if (wgslErrors.length) {
      console.warn('[catalog] WGSL particle-compute still missing named MODE_* (update the shader):');
      for (const e of wgslErrors) console.warn('  ', e);
    }
  }
}

main();
