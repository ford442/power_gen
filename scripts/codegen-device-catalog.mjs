#!/usr/bin/env node
/**
 * codegen-device-catalog.mjs
 *
 * Reads physics/devices.json and emits:
 *   generated/device-catalog.ts
 *   generated/device-catalog.h
 *   generated/device-catalog.wgsl
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

function emitModeMatrix(devices, reserved) {
  const reservedText = reserved.length ? reserved.join(', ') : 'none';
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

## How to add a device

1. Add a row to \`physics/devices.json\` (new unused \`shaderMode\`; \`wasmMode\` next reserved or \`null\`), including a \`telemetry\` entry (label / unit / digits) for every \`telemetryKeys\` entry.
2. Register a plugin that spreads \`catalogIdentity('id')\`.
3. Add a C++ plant + \`case\` **only if** \`wasmMode\` is set.
4. \`npm run codegen:catalog\` (and nameplates in \`physics/constants.json\` if the energy bus needs a watt rating).

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

  const ts = emitTs(data, devices, reserved, wasmCount);
  const h = emitH(devices, reserved, wasmCount);
  const wgsl = emitWgsl(devices);
  const md = emitModeMatrix(devices, reserved);

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
