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
  const en = data.energyNetwork;
  const k = data.kelvin;
  const vdg = data.vdg;
  const hall = data.hall;
  const tf = data.transformer;
  const pel = data.peltier;
  const mhd = data.mhd;
  const mag = data.maglev;
  const homo = data.homopolar;
  const lz = data.lorentzSled;
  const hs = hall.carrierProfiles.semiconductor;
  const hm = hall.carrierProfiles.metal;
  const tau = p.PI * 2;

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

struct KelvinConstants {
  static constexpr float E_BREAKDOWN_VM = ${f32(k.eBreakdownVm)};
};

struct VdgConstants {
  static constexpr float SPHERE_RADIUS_M     = ${f32(vdg.sphereRadiusM)};
  static constexpr float COLUMN_HEIGHT_M     = ${f32(vdg.columnHeightM)};
  static constexpr float GAP_M               = ${f32(vdg.gapM)};
  static constexpr float BELT_MAX_MPS        = ${f32(vdg.beltMaxMps)};
  static constexpr float BELT_MAX_CURRENT_A  = ${f32(vdg.beltMaxCurrentA)};
  static constexpr float LEAKAGE_R_OHM       = ${f32(vdg.leakageROhm)};
  static constexpr float SPARK_DISCHARGE_FRAC = ${f32(vdg.sparkDischargeFrac)};
  static constexpr float SPARK_DUR_S         = ${f32(vdg.sparkDurS)};
  static constexpr float SPARK_RATE_WINDOW_S = ${f32(vdg.sparkRateWindowS)};
};

struct HallConstants {
  static constexpr float I_MAX_A        = ${f32(hall.iMaxA)};
  static constexpr float B_MAX_T        = ${f32(hall.bMaxT)};
  static constexpr float SMOOTHING_TAU  = ${f32(hall.smoothingTau)};
  static constexpr float N_SEMICONDUCTOR = ${f32(hs.n)};
  static constexpr float T_SEMICONDUCTOR_M = ${f32(hs.tM)};
  static constexpr float N_METAL        = ${f32(hm.n)};
  static constexpr float T_METAL_M      = ${f32(hm.tM)};
};

struct TransformerConstants {
  static constexpr float F_HZ      = ${f32(tf.fHz)};
  static constexpr float NP        = ${f32(tf.np)};
  static constexpr float NS        = ${f32(tf.ns)};
  static constexpr float L1_H      = ${f32(tf.lpH)};
  static constexpr float L2_H      = ${f32(tf.lsH)};
  static constexpr float K_IDEAL   = ${f32(tf.kIdeal)};
  static constexpr float K_LEAKAGE = ${f32(tf.kLeakage)};
  static constexpr float R1_OHM    = ${f32(tf.rpOhm)};
  static constexpr float R2_OHM    = ${f32(tf.rsOhm)};
  static constexpr float R_LOAD_OHM = ${f32(tf.rLoadOhm)};
  static constexpr float V_PEAK    = ${f32(tf.vPrimaryPeak)};
};

struct PeltierConstants {
  static constexpr float SEEBECK_VK        = ${f32(pel.seebeckVK)};
  static constexpr float COUPLES           = ${f32(pel.couples)};
  static constexpr float R_INTERNAL_OHM    = ${f32(pel.rInternalOhm)};
  static constexpr float R_LOAD_OHM        = ${f32(pel.rLoadOhm)};
  static constexpr float CONDUCTANCE_WK    = ${f32(pel.conductanceWK)};
  static constexpr float HEAT_CAP_HOT_JK   = ${f32(pel.heatCapHotJK)};
  static constexpr float HEAT_CAP_COLD_JK  = ${f32(pel.heatCapColdJK)};
  static constexpr float SINK_WK           = ${f32(pel.sinkWK)};
  static constexpr float HEATER_MAX_W      = ${f32(pel.heaterMaxW)};
  static constexpr float AMBIENT_K         = ${f32(pel.ambientK)};
  static constexpr float DELTA_T_REF_K     = ${f32(pel.deltaTRefK)};
  static constexpr float CLAMP_BELOW_AMBIENT_K     = ${f32(pel.clampBelowAmbientK)};
  static constexpr float HOT_CLAMP_ABOVE_AMBIENT_K  = ${f32(pel.hotClampAboveAmbientK)};
  static constexpr float COLD_CLAMP_ABOVE_AMBIENT_K = ${f32(pel.coldClampAboveAmbientK)};
};

struct MhdConstants {
  static constexpr float PUMP_ACCEL_MS2 = ${f32(mhd.pumpAccelMs2)};
  static constexpr float LORENTZ_K      = ${f32(mhd.lorentzK)};
  static constexpr float FRICTION_K     = ${f32(mhd.frictionK)};
  static constexpr float FLOW_U_MAX_MPS = ${f32(mhd.flowUMaxMps)};
  static constexpr float WIDTH_M        = ${f32(mhd.widthM)};
  static constexpr float HALF_GAP_M     = ${f32(mhd.halfGapM)};
  static constexpr float SIGMA_SM       = ${f32(mhd.sigmaSm)};
  static constexpr float RHO_KG_M3      = ${f32(mhd.rhoKgM3)};
  static constexpr float NU_M2S         = ${f32(mhd.nuM2s)};
  static constexpr float R_INTERNAL_OHM = ${f32(mhd.rInternalOhm)};
  static constexpr float R_LOAD_OHM     = ${f32(mhd.rLoadOhm)};
  static constexpr float B_FIELD_BASE_T = ${f32(mhd.bFieldBaseT)};
  static constexpr float B_FIELD_SPAN_T = ${f32(mhd.bFieldSpanT)};
};

struct MaglevConstants {
  static constexpr float K_SPRING_NM      = ${f32(mag.kSpringNm)};
  static constexpr float C_DAMP_NSM       = ${f32(mag.cDampNsm)};
  static constexpr float MASS_KG          = ${f32(mag.massKg)};
  static constexpr float GAP_INITIAL_M    = ${f32(mag.gapInitialM)};
  static constexpr float GAP_TARGET_BASE_M = ${f32(mag.gapTargetBaseM)};
  static constexpr float GAP_TARGET_SPAN_M = ${f32(mag.gapTargetSpanM)};
  static constexpr float GAP_MIN_M        = ${f32(mag.gapMinM)};
  static constexpr float GAP_MAX_M        = ${f32(mag.gapMaxM)};
  static constexpr float LIFT_DRIVE_BASE  = ${f32(mag.liftDriveBase)};
  static constexpr float LIFT_DRIVE_SPAN  = ${f32(mag.liftDriveSpan)};
  static constexpr float RPM_MAX          = ${f32(mag.rpmMax)};
  static constexpr float RPM_ERR_BASE     = ${f32(mag.rpmErrBase)};
  static constexpr float RPM_ERR_SPAN     = ${f32(mag.rpmErrSpan)};
};

struct HomopolarConstants {
  static constexpr float DISC_RADIUS_M      = ${f32(homo.discRadiusM)};
  static constexpr float B_AXIAL_T          = ${f32(homo.bAxialT)};
  static constexpr float R_OHM              = ${f32(homo.rOhm)};
  static constexpr float L_HENRY            = ${f32(homo.lHenry)};
  static constexpr float INERTIA_KG_M2      = ${f32(homo.inertiaKgM2)};
  static constexpr float DRAG_NMS_PER_RAD   = ${f32(homo.dragNmsPerRad)};
  static constexpr float TAU_DRIVE_MAX_NM   = ${f32(homo.tauDriveMaxNm)};
  static constexpr float RPM_MAX            = ${f32(homo.rpmMax)};
  static constexpr float TAU_DRIVE_BASE     = ${f32(homo.tauDriveBase)};
  static constexpr float TAU_DRIVE_SPAN     = ${f32(homo.tauDriveSpan)};
  static constexpr float TAU_DRIVE_TANH_GAIN = ${f32(homo.tauDriveTanhGain)};
};

struct LorentzSledConstants {
  static constexpr float RAIL_LENGTH_M        = ${f32(lz.railLengthM)};
  static constexpr float RAIL_GAP_M           = ${f32(lz.railGapM)};
  static constexpr float SLED_MASS_KG         = ${f32(lz.sledMassKg)};
  static constexpr float SUPPLY_V_MAX         = ${f32(lz.supplyVMax)};
  static constexpr float CIRCUIT_R_OHM        = ${f32(lz.circuitROhm)};
  static constexpr float CIRCUIT_L_H          = ${f32(lz.circuitLH)};
  static constexpr float FRICTION_MU          = ${f32(lz.frictionMu)};
  static constexpr float VISCOUS_DAMPING_NSM  = ${f32(lz.viscousDampingNsm)};
  static constexpr float V_EPS_MPS            = ${f32(lz.vEpsMps)};
  static constexpr float FIELD_T_DEFAULT      = ${f32(lz.fieldTDefault)};
  static constexpr float FIELD_T_MAX          = ${f32(lz.fieldTMax)};
  static constexpr float V_MAX_MPS            = ${f32(lz.vMaxMps)};
  static constexpr float I_MAX_A              = ${f32(lz.iMaxA)};
};

/** Simulated nameplate watts per SimMode (order-of-magnitude — not metrology). */
struct EnergyNetworkNameplates {
  static constexpr int MODE_COUNT = 12;
  static constexpr float WATTS[MODE_COUNT] = {
    ${f32(en.deviceNameplateWatts.seg)}, ${f32(en.deviceNameplateWatts.heron)}, ${f32(en.deviceNameplateWatts.kelvin)},
    ${f32(en.deviceNameplateWatts.solar)}, ${f32(en.deviceNameplateWatts.peltier)}, ${f32(en.deviceNameplateWatts.mhd)},
    ${f32(en.deviceNameplateWatts.maglev)}, ${f32(en.deviceNameplateWatts.homopolar)},
    ${f32(en.deviceNameplateWatts.transformer)}, ${f32(en.deviceNameplateWatts.vdg)}, ${f32(en.deviceNameplateWatts.hall)},
    ${f32(en.deviceNameplateWatts['lorentz-sled'])}
  };
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
  static constexpr float E_CHARGE   = power_gen::PhysicalConstants::E_CHARGE;
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
  const en = data.energyNetwork;
  const np = en.deviceNameplateWatts;
  const vdg = data.vdg;
  const hall = data.hall;
  const tf = data.transformer;
  const pel = data.peltier;
  const mhdc = data.mhd;
  const mag = data.maglev;
  const homo = data.homopolar;
  const lz = data.lorentzSled;
  const pc = data.pulseCoil;
  const hv = data.halbachViz;
  const hs = hall.carrierProfiles.semiconductor;
  const hm = hall.carrierProfiles.metal;

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

/** Simulated nameplate watts — order-of-magnitude lab bus estimates, not metrology. */
export const VDG = {
  sphereRadiusM: ${vdg.sphereRadiusM},
  columnHeightM: ${vdg.columnHeightM},
  gapM: ${vdg.gapM},
  beltMaxMps: ${vdg.beltMaxMps},
  beltMaxCurrentA: ${vdg.beltMaxCurrentA},
  leakageROhm: ${vdg.leakageROhm},
  sparkDischargeFrac: ${vdg.sparkDischargeFrac},
  sparkDurS: ${vdg.sparkDurS},
  sparkRateWindowS: ${vdg.sparkRateWindowS},
} as const;

export const HALL = {
  stripLengthM: ${hall.stripLengthM},
  stripWidthM: ${hall.stripWidthM},
  iMaxA: ${hall.iMaxA},
  bMaxT: ${hall.bMaxT},
  smoothingTau: ${hall.smoothingTau},
} as const;

export const HALL_CARRIER_PROFILES = {
  semiconductor: { n: ${hs.n}, tM: ${hs.tM} },
  metal: { n: ${hm.n}, tM: ${hm.tM} },
} as const;

export const TRANSFORMER = {
  fHz: ${tf.fHz},
  np: ${tf.np},
  ns: ${tf.ns},
  lpH: ${tf.lpH},
  lsH: ${tf.lsH},
  kIdeal: ${tf.kIdeal},
  kLeakage: ${tf.kLeakage},
  rpOhm: ${tf.rpOhm},
  rsOhm: ${tf.rsOhm},
  rLoadOhm: ${tf.rLoadOhm},
  vPrimaryPeak: ${tf.vPrimaryPeak},
} as const;

/** Two-node thermoelectric stack — mirrored by PeltierState / PeltierConstants in C++. */
export const PELTIER = {
  seebeckVK: ${pel.seebeckVK},
  couples: ${pel.couples},
  rInternalOhm: ${pel.rInternalOhm},
  rLoadOhm: ${pel.rLoadOhm},
  conductanceWK: ${pel.conductanceWK},
  heatCapHotJK: ${pel.heatCapHotJK},
  heatCapColdJK: ${pel.heatCapColdJK},
  sinkWK: ${pel.sinkWK},
  heaterMaxW: ${pel.heaterMaxW},
  ambientK: ${pel.ambientK},
  deltaTRefK: ${pel.deltaTRefK},
  clampBelowAmbientK: ${pel.clampBelowAmbientK},
  hotClampAboveAmbientK: ${pel.hotClampAboveAmbientK},
  coldClampAboveAmbientK: ${pel.coldClampAboveAmbientK},
} as const;

/** Hartmann MHD channel — mirrored by MHDState / MhdConstants in C++. */
export const MHD = {
  pumpAccelMs2: ${mhdc.pumpAccelMs2},
  lorentzK: ${mhdc.lorentzK},
  frictionK: ${mhdc.frictionK},
  flowUMaxMps: ${mhdc.flowUMaxMps},
  widthM: ${mhdc.widthM},
  halfGapM: ${mhdc.halfGapM},
  sigmaSm: ${mhdc.sigmaSm},
  rhoKgM3: ${mhdc.rhoKgM3},
  nuM2s: ${mhdc.nuM2s},
  rInternalOhm: ${mhdc.rInternalOhm},
  rLoadOhm: ${mhdc.rLoadOhm},
  bFieldBaseT: ${mhdc.bFieldBaseT},
  bFieldSpanT: ${mhdc.bFieldSpanT},
} as const;

/** Maglev gap spring–damper — mirrored by MaglevState / MaglevConstants in C++. */
export const MAGLEV = {
  kSpringNm: ${mag.kSpringNm},
  cDampNsm: ${mag.cDampNsm},
  massKg: ${mag.massKg},
  gapInitialM: ${mag.gapInitialM},
  gapTargetBaseM: ${mag.gapTargetBaseM},
  gapTargetSpanM: ${mag.gapTargetSpanM},
  gapMinM: ${mag.gapMinM},
  gapMaxM: ${mag.gapMaxM},
  liftDriveBase: ${mag.liftDriveBase},
  liftDriveSpan: ${mag.liftDriveSpan},
  rpmMax: ${mag.rpmMax},
  rpmErrBase: ${mag.rpmErrBase},
  rpmErrSpan: ${mag.rpmErrSpan},
} as const;

/** Faraday-disc generator — mirrored by HomopolarState / HomopolarConstants in C++. */
export const HOMOPOLAR = {
  discRadiusM: ${homo.discRadiusM},
  bAxialT: ${homo.bAxialT},
  rOhm: ${homo.rOhm},
  lHenry: ${homo.lHenry},
  inertiaKgM2: ${homo.inertiaKgM2},
  dragNmsPerRad: ${homo.dragNmsPerRad},
  tauDriveMaxNm: ${homo.tauDriveMaxNm},
  rpmMax: ${homo.rpmMax},
  tauDriveBase: ${homo.tauDriveBase},
  tauDriveSpan: ${homo.tauDriveSpan},
  tauDriveTanhGain: ${homo.tauDriveTanhGain},
} as const;

/** Rail sled — mirrored by LorentzState / LorentzSledConstants in C++. */
export const LORENTZ_SLED = {
  railLengthM: ${lz.railLengthM},
  railGapM: ${lz.railGapM},
  sledMassKg: ${lz.sledMassKg},
  supplyVMax: ${lz.supplyVMax},
  circuitROhm: ${lz.circuitROhm},
  circuitLH: ${lz.circuitLH},
  frictionMu: ${lz.frictionMu},
  viscousDampingNsm: ${lz.viscousDampingNsm},
  vEpsMps: ${lz.vEpsMps},
  fieldTDefault: ${lz.fieldTDefault},
  fieldTMax: ${lz.fieldTMax},
  vMaxMps: ${lz.vMaxMps},
  iMaxA: ${lz.iMaxA},
} as const;

/** Pulse coil — JS-only plant (no wasmMode), so TS is the only target. */
export const PULSE_COIL_CORE = {
  rOhm: ${pc.rOhm},
  lHenry: ${pc.lHenry},
  capF: ${pc.capF},
  turns: ${pc.turns},
  coilRadiusM: ${pc.coilRadiusM},
  armatureMassKg: ${pc.armatureMassKg},
  armatureTravelMaxM: ${pc.armatureTravelMaxM},
  vChargeMax: ${pc.vChargeMax},
  kAttractNA2: ${pc.kAttractNA2},
  cDampNsm: ${pc.cDampNsm},
} as const;

/** Halbach viewer — JS-only plant (no wasmMode), so TS is the only target. */
export const HALBACH_VIZ = {
  radiusM: ${hv.radiusM},
  thicknessM: ${hv.thicknessM},
  segmentMin: ${hv.segmentMin},
  segmentMax: ${hv.segmentMax},
  segmentSpan: ${hv.segmentSpan},
  magAngleBase: ${hv.magAngleBase},
  magAngleSpan: ${hv.magAngleSpan},
} as const;

export const ENERGY_NETWORK_NAMEPLATES = {
  simulatedOrderOfMagnitude: ${en.simulatedOrderOfMagnitude},
  deviceNameplateWatts: {
    seg: ${np.seg},
    heron: ${np.heron},
    kelvin: ${np.kelvin},
    solar: ${np.solar},
    peltier: ${np.peltier},
    mhd: ${np.mhd},
    maglev: ${np.maglev},
    homopolar: ${np.homopolar},
    transformer: ${np.transformer},
    'halbach-viz': ${np['halbach-viz']},
    vdg: ${np.vdg},
    hall: ${np.hall},
    'lorentz-sled': ${np['lorentz-sled']},
  },
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
