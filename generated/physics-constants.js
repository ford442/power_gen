/**
 * AUTO-GENERATED from physics/constants.json — do not edit.
 * Regenerate: npm run codegen:constants
 */

export const PHYSICAL_CONSTANTS = {
  MU_0: 1.2566370614e-7,
  EPSILON_0: 8.854187817e-12,
  C: 299792458,
  K_B: 1.380649e-23,
  T_ROOM: 300,
  E_CHARGE: 1.602176634e-19,
  G: 9.80665,
  RHO_WATER: 1000,
  PI: 3.141592653589793,
};

export const SEG_MAGNET = {
  Br: 1.48,
  mu_r: 1.05,
  radius: 0.8,
  height: 2.5,
  volume: 5.02655,
  magnetization: 1121660,
};

export const SEG_CONFIG = {
  numRollers: 12,
  innerRingRadius: 2,
  middleRingRadius: 4,
  outerRingRadius: 6,
  rollerHeight: 2.5,
  rollerRadius: 0.8,
  angularSeparation: Math.PI / 6,
};

export const MATERIALS = {
  siliconRefractiveIndex: 3.96,
  nAir: 1.000293,
  nSiliconLedSolar: 3.97,
};

export const KELVIN_CONSTANTS = {
  BUCKET_CAPACITANCE_F: 4.01e-11,
  DROPLET_CHARGE_C: 1e-9,
  E_BREAKDOWN_VM: 3000000,
  BUCKET_DISTANCE_M: 6,
};

export const HERON_CONSTANTS = {
  REST_DENSITY: 1000,
  GAS_CONSTANT: 560571,
  GAMMA: 7,
  SMOOTHING_LENGTH: 0.012,
  GRAVITY: 9.80665,
  ATMOSPHERIC_PRESSURE: 101325,
};

export const LED_SOLAR_CORE = {
  wallPlugEfficiency: 0.3,
  siEfficiency: 0.22,
  geometricEfficiency: 0.85,
  chargeEfficiency: 0.95,
  planckJ: 6.62607015e-34,
  speedOfLight: 299792458,
};

export const PARTICLE_LAYOUTS = {
  gpuBytes: 16,
  simBytes: 32,
  pipeBytes: 32,
  fieldLineBytes: 32,
  rollerExportStride: 4,
  gpuFloats: 4,
  simFloats: 8,
};

export const WASM_SEG_DEFAULTS = {
  ringCounts: [12, 22, 32],
  ringRadiiScene: [3.5, 5.5, 7.5],
  maxRollers: 66,
  maxParticles: 50000,
};

/** Simulated nameplate watts — order-of-magnitude lab bus estimates, not metrology. */
export const VDG = {
  sphereRadiusM: 0.14,
  columnHeightM: 1.05,
  gapM: 0.05,
  beltMaxMps: 6,
  beltMaxCurrentA: 0.0000022,
  leakageROhm: 50000000000000,
  sparkDischargeFrac: 0.05,
  sparkDurS: 0.15,
  sparkRateWindowS: 1,
};

export const HALL = {
  stripLengthM: 0.5,
  stripWidthM: 0.08,
  iMaxA: 1.2,
  bMaxT: 0.65,
  smoothingTau: 0.25,
};

export const HALL_CARRIER_PROFILES = {
  semiconductor: { n: 1e+21, tM: 0.0005 },
  metal: { n: 8.5e+28, tM: 0.0001 },
};

export const TRANSFORMER = {
  fHz: 60,
  np: 120,
  ns: 40,
  lpH: 0.85,
  lsH: 0.095,
  kIdeal: 0.97,
  kLeakage: 0.72,
  rpOhm: 1.8,
  rsOhm: 0.45,
  rLoadOhm: 12,
  vPrimaryPeak: 28,
};

/** Two-node thermoelectric stack — mirrored by PeltierState / PeltierConstants in C++. */
export const PELTIER = {
  seebeckVK: 0.00044,
  couples: 127,
  rInternalOhm: 2.5,
  rLoadOhm: 2.5,
  conductanceWK: 0.5,
  heatCapHotJK: 40,
  heatCapColdJK: 60,
  sinkWK: 1.6,
  heaterMaxW: 60,
  ambientK: 293,
  deltaTRefK: 80,
  clampBelowAmbientK: 5,
  hotClampAboveAmbientK: 250,
  coldClampAboveAmbientK: 150,
};

/** Hartmann MHD channel — mirrored by MHDState / MhdConstants in C++. */
export const MHD = {
  pumpAccelMs2: 6,
  lorentzK: 2.5,
  frictionK: 0.8,
  flowUMaxMps: 5,
  widthM: 0.1,
  halfGapM: 0.05,
  sigmaSm: 1000000,
  rhoKgM3: 870,
  nuM2s: 8e-7,
  rInternalOhm: 0.05,
  rLoadOhm: 0.05,
  bFieldBaseT: 0.2,
  bFieldSpanT: 0.8,
};

/** Maglev gap spring–damper — mirrored by MaglevState / MaglevConstants in C++. */
export const MAGLEV = {
  kSpringNm: 180,
  cDampNsm: 14,
  massKg: 0.045,
  gapInitialM: 0.018,
  gapTargetBaseM: 0.012,
  gapTargetSpanM: 0.022,
  gapMinM: 0.004,
  gapMaxM: 0.06,
  liftDriveBase: 0.6,
  liftDriveSpan: 0.4,
  rpmMax: 4200,
  rpmErrBase: 0.3,
  rpmErrSpan: 0.7,
};

/** Faraday-disc generator — mirrored by HomopolarState / HomopolarConstants in C++. */
export const HOMOPOLAR = {
  discRadiusM: 0.14,
  bAxialT: 0.55,
  rOhm: 0.008,
  lHenry: 0.0015,
  inertiaKgM2: 0.002,
  dragNmsPerRad: 0.0008,
  tauDriveMaxNm: 0.15,
  rpmMax: 3600,
  tauDriveBase: 0.6,
  tauDriveSpan: 0.4,
  tauDriveTanhGain: 2,
};

/** Rail sled — mirrored by LorentzState / LorentzSledConstants in C++. */
export const LORENTZ_SLED = {
  railLengthM: 2,
  railGapM: 0.25,
  sledMassKg: 0.15,
  supplyVMax: 12,
  circuitROhm: 0.6,
  circuitLH: 0.00006,
  frictionMu: 0.25,
  viscousDampingNsm: 0.3,
  vEpsMps: 0.05,
  fieldTDefault: 0.8,
  fieldTMax: 1.2,
  vMaxMps: 12,
  iMaxA: 22,
};

/** Pulse coil — JS-only plant (no wasmMode), so TS is the only target. */
export const PULSE_COIL_CORE = {
  rOhm: 0.18,
  lHenry: 0.0012,
  capF: 0.0022,
  turns: 48,
  coilRadiusM: 0.045,
  armatureMassKg: 0.085,
  armatureTravelMaxM: 0.12,
  vChargeMax: 48,
  kAttractNA2: 0.035,
  cDampNsm: 1.4,
};

/** Halbach viewer — JS-only plant (no wasmMode), so TS is the only target. */
export const HALBACH_VIZ = {
  radiusM: 0.14,
  thicknessM: 0.028,
  segmentMin: 4,
  segmentMax: 24,
  segmentSpan: 20,
  magAngleBase: 0.65,
  magAngleSpan: 0.7,
};

export const ENERGY_NETWORK_NAMEPLATES = {
  simulatedOrderOfMagnitude: true,
  deviceNameplateWatts: {
    seg: 2000,
    heron: 400,
    kelvin: 150,
    solar: 300,
    peltier: 120,
    mhd: 350,
    maglev: 200,
    homopolar: 250,
    transformer: 110,
    'halbach-viz': 80,
    vdg: 60,
    hall: 30,
    'lorentz-sled': 180,
  },
};

export const SCENE_SCALING = {
  "baseUnitLabel": "scene_unit",
  "notes": "Visualization layouts in src/seg-layout.js map real metres to scene units via per-preset worldScale. Plant integrators may apply additional scene gravity scaling in WASM (see sim_core.cpp).",
  "layoutPresetsSource": "src/seg-layout.js PRESET_DEFS",
  "presetExamples": {
    "searl": {
      "rollerCounts": [
        10,
        25,
        35
      ],
      "worldScale": 2
    },
    "roschin": {
      "rollerCounts": [
        12
      ],
      "worldScale": 4
    },
    "legacy": {
      "rollerCounts": [
        8,
        12,
        16
      ],
      "worldScale": 1
    }
  }
};

/** Runtime guard — call once during bootstrap if desired. */
export function assertParticleLayouts() {
  if (PARTICLE_LAYOUTS.gpuBytes !== PARTICLE_LAYOUTS.gpuFloats * 4) {
    throw new Error('GpuParticle byte stride mismatch');
  }
  if (PARTICLE_LAYOUTS.simBytes !== PARTICLE_LAYOUTS.simFloats * 4) {
    throw new Error('SimParticle byte stride mismatch');
  }
}

export const SILICON_REFRACTIVE_INDEX = MATERIALS.siliconRefractiveIndex;
