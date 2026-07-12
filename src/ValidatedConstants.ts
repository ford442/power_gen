/**
 * Validated Physics Constants
 *
 * Numeric values are generated from physics/constants.json (see generated/).
 * This module adds uncertainty metadata, Wolfram cache integration, and
 * derived SEG physics helpers used by the UI and telemetry.
 */

import type { UncertaintyFlag, PhysicsConstants, SEGMagnetSpec } from './types';
import { FallbackPhysics, createUncertainValue, UNCERTAINTY_LEVELS } from './fallback-physics';
import {
  PHYSICAL_CONSTANTS as GEN_PHYSICAL,
  SEG_MAGNET as GEN_SEG_MAGNET,
  SEG_CONFIG as GEN_SEG_CONFIG,
  KELVIN_CONSTANTS as GEN_KELVIN,
  HERON_CONSTANTS as GEN_HERON,
  MATERIALS,
  PARTICLE_LAYOUTS,
  SILICON_REFRACTIVE_INDEX as GEN_SILICON_N,
  assertParticleLayouts,
} from '../generated/physics-constants';

export { PARTICLE_LAYOUTS, assertParticleLayouts };

// ============================================
// CODATA physical constants (generated)
// ============================================

export const PHYSICAL_CONSTANTS: PhysicsConstants = { ...GEN_PHYSICAL };

export const MU_0: UncertaintyFlag = {
  value: GEN_PHYSICAL.MU_0,
  uncertainty: 0,
  isValidated: true,
  source: 'wolfram',
};

export const EPSILON_0: UncertaintyFlag = {
  value: GEN_PHYSICAL.EPSILON_0,
  uncertainty: 1.5e-10,
  isValidated: true,
  source: 'wolfram',
};

export const K_B: UncertaintyFlag = {
  value: GEN_PHYSICAL.K_B,
  uncertainty: 0,
  isValidated: true,
  source: 'wolfram',
};

// ============================================
// SEG Magnet Specifications (NdFeB N52)
// ============================================

export const SEG_MAGNET: SEGMagnetSpec = { ...GEN_SEG_MAGNET };

export const MAGNET_BR: UncertaintyFlag = {
  value: GEN_SEG_MAGNET.Br,
  uncertainty: 0.02,
  isValidated: true,
  source: 'wolfram',
};

export const MAGNETIC_MOMENT: UncertaintyFlag = {
  value: 5.635e6,
  uncertainty: 0.03,
  isValidated: false,
  source: 'calculated',
};

// ============================================
// SEG Configuration (reference geometry — layouts live in seg-layout.js)
// ============================================

export const SEG_CONFIG = { ...GEN_SEG_CONFIG };

// ============================================
// SEG Roller Layer Composition (4 concentric shells)
// ============================================
export const SEG_ROLLER_LAYERS = [
  { name: 'Neodymium', density: 7500, rInner: 0.00, rOuter: 0.30 },
  { name: 'Nylon66',   density: 1150, rInner: 0.30, rOuter: 0.45 },
  { name: 'Iron',      density: 7870, rInner: 0.45, rOuter: 0.62 },
  { name: 'Copper',    density: 8960, rInner: 0.62, rOuter: 1.00 },
] as const;

export function computeRollerInertia(
  radius: number = SEG_CONFIG.rollerRadius,
  height: number = SEG_CONFIG.rollerHeight,
): { mass: number; inertia: number } {
  let mass = 0;
  let inertia = 0;
  for (const layer of SEG_ROLLER_LAYERS) {
    const rIn = layer.rInner * radius;
    const rOut = layer.rOuter * radius;
    const m = Math.PI * height * layer.density * (rOut * rOut - rIn * rIn);
    mass += m;
    inertia += 0.5 * m * (rOut * rOut + rIn * rIn);
  }
  return { mass, inertia };
}

export const SILICON_REFRACTIVE_INDEX = GEN_SILICON_N;

// ============================================
// Pre-calculated SEG Physics Values
// ============================================

export const SEG_PHYSICS = {
  B_FIELD_SURFACE: FallbackPhysics.axialBFieldUncertain(0),
  B_FIELD_1M: FallbackPhysics.axialBFieldUncertain(1.0),
  B_FIELD_2M: FallbackPhysics.axialBFieldUncertain(2.0),
  B_FIELD_4M: FallbackPhysics.axialBFieldUncertain(4.0),
  ENERGY_DENSITY_SURFACE: FallbackPhysics.energyDensityUncertain(
    FallbackPhysics.axialBField(0)
  ),
  ENERGY_DENSITY_1M: FallbackPhysics.energyDensityUncertain(
    FallbackPhysics.axialBField(1.0)
  ),
  get ADJACENT_FORCE() {
    const distance = 2 * SEG_CONFIG.middleRingRadius *
      Math.sin(Math.PI / SEG_CONFIG.numRollers);
    return FallbackPhysics.adjacentRollerForceUncertain(distance);
  },
  get RING_TORQUE() {
    return FallbackPhysics.ringTorque(SEG_CONFIG.middleRingRadius);
  },
  get INNER_RING_TORQUE() {
    return FallbackPhysics.ringTorque(SEG_CONFIG.innerRingRadius);
  },
  get OUTER_RING_TORQUE() {
    return FallbackPhysics.ringTorque(SEG_CONFIG.outerRingRadius);
  },
};

// ============================================
// Kelvin / Heron (generated scalars + uncertainty wrappers)
// ============================================

export const KELVIN_CONSTANTS = {
  BUCKET_CAPACITANCE: {
    value: GEN_KELVIN.BUCKET_CAPACITANCE_F,
    uncertainty: 0.05,
    isValidated: true,
    source: 'wolfram' as const,
  },
  DROPLET_CHARGE: {
    value: GEN_KELVIN.DROPLET_CHARGE_C,
    uncertainty: 0.5,
    isValidated: false,
    source: 'estimated' as const,
  },
  E_BREAKDOWN: {
    value: GEN_KELVIN.E_BREAKDOWN_VM,
    uncertainty: 0.1,
    isValidated: true,
    source: 'wolfram' as const,
  },
  BUCKET_DISTANCE: GEN_KELVIN.BUCKET_DISTANCE_M,
};

export const HERON_CONSTANTS = {
  REST_DENSITY: GEN_HERON.REST_DENSITY,
  GAS_CONSTANT: GEN_HERON.GAS_CONSTANT,
  GAMMA: GEN_HERON.GAMMA,
  SMOOTHING_LENGTH: GEN_HERON.SMOOTHING_LENGTH,
  GRAVITY: GEN_HERON.GRAVITY,
  ATMOSPHERIC_PRESSURE: GEN_HERON.ATMOSPHERIC_PRESSURE,
};

export function getConstant<T extends number | UncertaintyFlag>(
  constant: T,
  requireValidated = false
): T extends UncertaintyFlag ? number : T {
  if (typeof constant === 'object' && 'value' in constant) {
    if (requireValidated && !constant.isValidated) {
      console.warn(`Using unvalidated constant from ${constant.source}`);
    }
    return constant.value as T extends UncertaintyFlag ? number : T;
  }
  return constant as T extends UncertaintyFlag ? number : T;
}

export function areAllValidated(flags: UncertaintyFlag[]): boolean {
  return flags.every(f => f.isValidated);
}

export function getMaxUncertainty(flags: UncertaintyFlag[]): number {
  return Math.max(...flags.map(f => f.uncertainty));
}

export function formatUncertainValue(flag: UncertaintyFlag, precision = 4): string {
  const uncPercent = (flag.uncertainty * 100).toFixed(1);
  const sourceIcon = flag.isValidated ? '✓' : flag.source === 'calculated' ? '~' : '?';
  return `${flag.value.toPrecision(precision)} ${sourceIcon} (±${uncPercent}%)`;
}

export const ValidatedConstants = {
  PHYSICAL_CONSTANTS,
  SEG_MAGNET,
  SEG_CONFIG,
  SEG_ROLLER_LAYERS,
  computeRollerInertia,
  SILICON_REFRACTIVE_INDEX,
  SEG_PHYSICS,
  KELVIN_CONSTANTS,
  HERON_CONSTANTS,
  PARTICLE_LAYOUTS,
  MATERIALS,
  MU_0,
  EPSILON_0,
  K_B,
  MAGNET_BR,
  MAGNETIC_MOMENT,
  getConstant,
  areAllValidated,
  getMaxUncertainty,
  formatUncertainValue,
  assertParticleLayouts,
} as const;

export default ValidatedConstants;
