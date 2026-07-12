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
