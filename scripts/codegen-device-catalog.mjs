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
    return `  {
    id: '${d.id}',
    label: ${JSON.stringify(d.label)},
    category: '${d.category}',
    shaderMode: ${d.shaderMode},
    wasmMode: ${wasm} as number | null,
    telemetryKeys: [${keys}] as const,
    fidelity: ${JSON.stringify(d.fidelity)},
  }`;
  }).join(',\n');

  const wasmPlants = devices
    .filter((d) => d.wasmMode != null)
    .sort((a, b) => a.wasmMode - b.wasmMode);
  const wasmPairs = wasmPlants.map((d) => `  '${d.id}': ${d.wasmMode}`).join(',\n');
  const wasmIds = wasmPlants.map((d) => `'${d.id}'`);

  return `${HEADER_TS}
export interface DeviceCatalogEntry {
  id: string;
  label: string;
  category: string;
  shaderMode: number;
  wasmMode: number | null;
  telemetryKeys: readonly string[];
  fidelity: string;
}

export const DEVICE_CATALOG = [
${entries},
] as const;

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
`;
}

function emitWgsl(devices) {
  const lines = devices.map((d) => `const ${wgslConst(d.id)}: u32 = ${d.shaderMode}u;`);
  return `${HEADER_WGSL}
${lines.join('\n')}
`;
}

function emitModeMatrix(devices, reserved) {
  const rows = devices.map((d) => {
    const wasm =
      d.wasmMode == null
        ? 'none (`wasmMode: null`)'
        : `${d.wasmMode} (\`${simEnum(d.id)}\`)`;
    const keys = (d.telemetryKeys || []).map((k) => `\`${k}\``).join(', ');
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
\`reservedWasmModes\` (${reserved.join(', ')}), then bump that list — do not
invent a plant by silently reclaiming pulse-coil's shader slot 7.

## Matrix

| Device \`id\` | \`shaderMode\` (JS/WGSL) | \`wasmMode\` / \`SimMode\` | Telemetry keys | Fidelity |
|---|---|---|---|---|
${rows.join('\n')}

## How to add a device

1. Add a row to \`physics/devices.json\` (new unused \`shaderMode\`; \`wasmMode\` next reserved or \`null\`).
2. Register a plugin that spreads \`catalogIdentity('id')\`.
3. Add a C++ plant + \`case\` **only if** \`wasmMode\` is set.
4. \`npm run codegen:catalog\` (and nameplates in \`physics/constants.json\` if the energy bus needs a watt rating).

## Source of truth pointers

- Catalog JSON: \`physics/devices.json\`
- Generated: \`generated/device-catalog.ts\`, \`generated/device-catalog.h\`, \`src/shaders/generated/device-catalog.wgsl\`
- Registry: \`src/devices/device-registry.ts\` (\`getDeviceModeIndex\` = shader; \`getDeviceWasmMode\` = wasm)
- WASM bridge: \`src/wasm/seg-physics-bridge.ts\` \`setMode(deviceId: string)\` only
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

  const ts = emitTs(data, devices, reserved, wasmCount);
  const h = emitH(devices, reserved, wasmCount);
  const wgsl = emitWgsl(devices);
  const md = emitModeMatrix(devices, reserved);

  const wgslErrors = checkWgslNamedConstants(devices, wgsl);
  const errors = [...pluginErrors, ...(CHECK || true ? wgslErrors : [])];

  // When generating the first time, particle-compute may not yet include MODE_*.
  // Fail WGSL refs only in --check, or after we know the pass was updated.
  // Always fail plugin/catalog integrity.
  const hard = [...pluginErrors];
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
