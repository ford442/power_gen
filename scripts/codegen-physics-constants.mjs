#!/usr/bin/env node
/**
 * codegen-physics-constants.mjs
 *
 * Reads physics/constants.json and emits:
 *   generated/constants.h
 *   generated/constants.wgsl
 *   generated/physics-constants.ts
 *   generated/physics-constants.js
 *   src/shaders/generated/constants.wgsl  (copy for #include)
 *
 * Usage:
 *   node scripts/codegen-physics-constants.mjs
 *   node scripts/codegen-physics-constants.mjs --check
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC_JSON = join(ROOT, 'physics', 'constants.json');
const OUT_DIR = join(ROOT, 'generated');
const SHADER_OUT = join(ROOT, 'src', 'shaders', 'generated', 'constants.wgsl');

const CHECK = process.argv.includes('--check');

const HEADER_TS = `/**
 * AUTO-GENERATED from physics/constants.json — do not edit.
 * Regenerate: npm run codegen:constants
 */
`;

const HEADER_H = `// AUTO-GENERATED from physics/constants.json — do not edit.
// Regenerate: npm run codegen:constants
#pragma once
`;

const HEADER_WGSL = `// AUTO-GENERATED from physics/constants.json — do not edit.
// Regenerate: npm run codegen:constants
`;

function loadJson() {
  return JSON.parse(readFileSync(SRC_JSON, 'utf8'));
}

function f32(n) {
  if (typeof n !== 'number') throw new Error(`Expected number, got ${n}`);
  const s = String(n);
  return s.includes('.') || s.includes('e') || s.includes('E') ? `${s}f` : `${s}.0f`;
}

function wgslF32(n) {
  if (typeof n !== 'number') throw new Error(`Expected number, got ${n}`);
  return String(n);
}

function emitH(data) {
  const p = data.physical;
  const m = data.segMagnet;
  const pl = data.particleLayouts;
  const w = data.wasmSegDefaults;
  const tau = p.PI * 2;
  const magnetization = m.Br / p.MU_0;

  return `${HEADER_H}
namespace power_gen {

struct PhysicalConstants {
  static constexpr float MU_0       = ${f32(p.MU_0)};
  static constexpr float EPSILON_0  = ${f32(p.EPSILON_0)};
  static constexpr float G          = ${f32(p.G)};
  static constexpr float PI         = ${f32(p.PI)};
  static constexpr float TAU        = ${f32(tau)};
  static constexpr float Br_DEFAULT = ${f32(m.Br)};
  static constexpr float MU_R       = ${f32(m.mu_r)};
  static constexpr float E_CHARGE   = ${f32(p.E_CHARGE)};
  static constexpr float K_B        = ${f32(p.K_B)};
  static constexpr float C          = ${f32(p.C)};
};

struct ParticleLayouts {
  static constexpr int GPU_PARTICLE_BYTES        = ${pl.gpuParticleBytes};
  static constexpr int SIM_PARTICLE_BYTES        = ${pl.simParticleBytes};
  static constexpr int PIPE_PARTICLE_BYTES       = ${pl.pipeParticleBytes};
  static constexpr int FIELD_LINE_PARTICLE_BYTES = ${pl.fieldLineParticleBytes};
  static constexpr int ROLLER_EXPORT_STRIDE      = ${pl.rollerExportStride};
  static_assert(GPU_PARTICLE_BYTES == 16, "GpuParticle must remain 16 bytes (vec3f + phase)");
  static_assert(SIM_PARTICLE_BYTES == 32, "SimParticle must remain 32 bytes (8 floats)");
};

struct WasmSegDefaults {
  static constexpr int RING_COUNTS[3]  = { ${w.ringCounts.join(', ')} };
  static constexpr float RING_RADII[3] = { ${w.ringRadiiScene.map(f32).join(', ')} };
  static constexpr int MAX_ROLLERS   = ${w.maxRollers};
  static constexpr int MAX_PARTICLES = ${w.maxParticles};
};

} // namespace power_gen

// Back-compat alias used throughout sim_core.*
namespace PhysicsConstants {
  static constexpr float MU_0       = power_gen::PhysicalConstants::MU_0;
  static constexpr float EPSILON_0  = power_gen::PhysicalConstants::EPSILON_0;
  static constexpr float G          = power_gen::PhysicalConstants::G;
  static constexpr float PI         = power_gen::PhysicalConstants::PI;
  static constexpr float TAU        = power_gen::PhysicalConstants::TAU;
  static constexpr float Br_DEFAULT = power_gen::PhysicalConstants::Br_DEFAULT;
  static constexpr float MU_R       = power_gen::PhysicalConstants::MU_R;
}
`;
}

function emitWgsl(data) {
  const p = data.physical;
  const m = data.segMagnet;
  const mat = data.materials;
  const k = data.kelvin;
  const h = data.heron;
  const ls = data.ledSolar;
  const pl = data.particleLayouts;
  const magnetization = m.Br / p.MU_0;

  return `${HEADER_WGSL}
// Particle layouts (see docs/PHYSICS_CONSTANTS.md)
// GpuParticle: ${pl.gpuParticleBytes} B | SimParticle: ${pl.simParticleBytes} B

const PI: f32 = ${wgslF32(p.PI)};
const TAU: f32 = ${wgslF32(p.PI * 2)};
const MU_0: f32 = ${wgslF32(p.MU_0)};
const EPSILON_0: f32 = ${wgslF32(p.EPSILON_0)};
const K_B: f32 = ${wgslF32(p.K_B)};
const E_CHARGE: f32 = ${wgslF32(p.E_CHARGE)};
const G: f32 = ${wgslF32(p.G)};
const SPEED_OF_LIGHT: f32 = ${wgslF32(p.C)};

const SEG_BR: f32 = ${wgslF32(m.Br)};
const BR_N52: f32 = SEG_BR;
const SEG_MU_R: f32 = ${wgslF32(m.mu_r)};
const SEG_MAGNETIZATION: f32 = ${wgslF32(magnetization)};

const N_SILICON: f32 = ${wgslF32(mat.siliconRefractiveIndex)};
const N_SILICON_LED: f32 = ${wgslF32(mat.nSiliconLedSolar)};
const N_AIR: f32 = ${wgslF32(mat.nAir)};

const KELVIN_BUCKET_CAP: f32 = ${wgslF32(k.bucketCapacitanceF)};
const KELVIN_DROPLET_CHARGE: f32 = ${wgslF32(k.dropletChargeC)};
const KELVIN_E_BREAKDOWN: f32 = ${wgslF32(k.eBreakdownVm)};

const HERON_RHO_0: f32 = ${wgslF32(h.restDensity)};
const HERON_GAS_CONST: f32 = ${wgslF32(h.gasConstant)};
const HERON_GAMMA: f32 = ${wgslF32(h.gamma)};

const LED_WALL_PLUG_EFF: f32 = ${wgslF32(ls.wallPlugEfficiency)};
const SOLAR_SI_EFFICIENCY: f32 = ${wgslF32(ls.siEfficiency)};
const PLANCK_J: f32 = ${wgslF32(ls.planckJ)};
`;
}

function emitTs(data) {
  const p = data.physical;
  const m = data.segMagnet;
  const rc = data.segRollerComposite;
  const mat = data.materials;
  const k = data.kelvin;
  const h = data.heron;
  const ls = data.ledSolar;
  const pl = data.particleLayouts;
  const w = data.wasmSegDefaults;
  const scene = data.sceneScaling;

  return `${HEADER_TS}
export const PHYSICAL_CONSTANTS = {
  MU_0: ${p.MU_0},
  EPSILON_0: ${p.EPSILON_0},
  C: ${p.C},
  K_B: ${p.K_B},
  T_ROOM: ${p.T_ROOM},
  E_CHARGE: ${p.E_CHARGE},
  G: ${p.G},
  RHO_WATER: ${p.RHO_WATER},
  PI: ${p.PI},
} as const;

export const SEG_MAGNET = {
  Br: ${m.Br},
  mu_r: ${m.mu_r},
  radius: ${m.radiusM},
  height: ${m.heightM},
  volume: ${m.volumeM3},
  magnetization: ${m.magnetizationAm},
} as const;

export const SEG_CONFIG = {
  numRollers: ${rc.numRollersReference},
  innerRingRadius: ${rc.innerRingRadiusM},
  middleRingRadius: ${rc.middleRingRadiusM},
  outerRingRadius: ${rc.outerRingRadiusM},
  rollerHeight: ${rc.defaultHeightM},
  rollerRadius: ${rc.defaultRadiusM},
  angularSeparation: Math.PI / 6,
} as const;

export const MATERIALS = {
  siliconRefractiveIndex: ${mat.siliconRefractiveIndex},
  nAir: ${mat.nAir},
  nSiliconLedSolar: ${mat.nSiliconLedSolar},
} as const;

export const KELVIN_CONSTANTS = {
  BUCKET_CAPACITANCE_F: ${k.bucketCapacitanceF},
  DROPLET_CHARGE_C: ${k.dropletChargeC},
  E_BREAKDOWN_VM: ${k.eBreakdownVm},
  BUCKET_DISTANCE_M: ${k.bucketDistanceM},
} as const;

export const HERON_CONSTANTS = {
  REST_DENSITY: ${h.restDensity},
  GAS_CONSTANT: ${h.gasConstant},
  GAMMA: ${h.gamma},
  SMOOTHING_LENGTH: ${h.smoothingLengthM},
  GRAVITY: ${p.G},
  ATMOSPHERIC_PRESSURE: ${h.atmosphericPressurePa},
} as const;

export const LED_SOLAR_CORE = {
  wallPlugEfficiency: ${ls.wallPlugEfficiency},
  siEfficiency: ${ls.siEfficiency},
  geometricEfficiency: ${ls.geometricEfficiency},
  chargeEfficiency: ${ls.chargeEfficiency},
  planckJ: ${ls.planckJ},
  speedOfLight: ${ls.speedOfLight},
} as const;

export const PARTICLE_LAYOUTS = {
  gpuBytes: ${pl.gpuParticleBytes},
  simBytes: ${pl.simParticleBytes},
  pipeBytes: ${pl.pipeParticleBytes},
  fieldLineBytes: ${pl.fieldLineParticleBytes},
  rollerExportStride: ${pl.rollerExportStride},
  gpuFloats: ${pl.gpuParticleFloats},
  simFloats: ${pl.simParticleFloats},
} as const;

export const WASM_SEG_DEFAULTS = {
  ringCounts: [${w.ringCounts.join(', ')}] as const,
  ringRadiiScene: [${w.ringRadiiScene.join(', ')}] as const,
  maxRollers: ${w.maxRollers},
  maxParticles: ${w.maxParticles},
} as const;

export const SCENE_SCALING = ${JSON.stringify(scene, null, 2)} as const;

/** Runtime guard — call once during bootstrap if desired. */
export function assertParticleLayouts(): void {
  if (PARTICLE_LAYOUTS.gpuBytes !== PARTICLE_LAYOUTS.gpuFloats * 4) {
    throw new Error('GpuParticle byte stride mismatch');
  }
  if (PARTICLE_LAYOUTS.simBytes !== PARTICLE_LAYOUTS.simFloats * 4) {
    throw new Error('SimParticle byte stride mismatch');
  }
}

export const SILICON_REFRACTIVE_INDEX = MATERIALS.siliconRefractiveIndex;
`;
}

function emitJs(tsBody) {
  return tsBody
    .replace(/ as const/g, '')
    .replace(/: void/g, '')
    .replace(/export function assertParticleLayouts\(\)/g, 'export function assertParticleLayouts()');
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
      console.error(`[codegen] missing ${path} — run npm run codegen:constants`);
      process.exit(1);
    }
    if (existing !== content) {
      console.error(`[codegen] stale: ${path}`);
      process.exit(1);
    }
    return;
  }
  writeFileSync(path, content);
}

function main() {
  const data = loadJson();
  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(dirname(SHADER_OUT), { recursive: true });

  const h = emitH(data);
  const wgsl = emitWgsl(data);
  const ts = emitTs(data);
  const js = emitJs(ts);

  const outputs = [
    [join(OUT_DIR, 'constants.h'), h],
    [join(OUT_DIR, 'constants.wgsl'), wgsl],
    [join(OUT_DIR, 'physics-constants.ts'), ts],
    [join(OUT_DIR, 'physics-constants.js'), js],
    [SHADER_OUT, wgsl],
  ];

  for (const [path, content] of outputs) {
    writeOrCheck(path, content);
  }

  if (CHECK) {
    console.log(`[codegen] OK — ${outputs.length} files match physics/constants.json`);
  } else {
  const hash = sha256(readFileSync(SRC_JSON, 'utf8'));
    console.log(`[codegen] wrote ${outputs.length} files (source sha256 ${hash.slice(0, 12)}…)`);
  }
}

main();
