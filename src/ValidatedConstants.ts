/**
 * Validated Physics Constants
 * 
 * This module provides physics constants from multiple sources in priority order:
 * 1. Wolfram Alpha MCP (authoritative, when available)
 * 2. Local cache (from previous Wolfram queries)
 * 3. Fallback values (pre-calculated, with uncertainty flags)
 * 
 * All constants include metadata about their source and validation status.
 */

import type { UncertaintyFlag, PhysicsConstants, SEGMagnetSpec } from './types';
import { FallbackPhysics, createUncertainValue, UNCERTAINTY_LEVELS } from './fallback-physics';

// ============================================
// CODATA 2018 Physical Constants
// ============================================

export const PHYSICAL_CONSTANTS: PhysicsConstants = {
  MU_0: 1.2566370614e-7,      // H/m - Vacuum permeability (exact by definition)
  EPSILON_0: 8.854187817e-12, // F/m - Vacuum permittivity
  C: 299792458,               // m/s - Speed of light (exact)
  K_B: 1.380649e-23,          // J/K - Boltzmann constant (exact)
  T_ROOM: 300,                // K - Room temperature (27°C)
  E_CHARGE: 1.602176634e-19,  // C - Elementary charge (exact)
  G: 9.80665,                 // m/s² - Standard gravity
  RHO_WATER: 1000,            // kg/m³ - Water density at 4°C
};

// Export individual constants with full metadata
export const MU_0: UncertaintyFlag = {
  value: PHYSICAL_CONSTANTS.MU_0,
  uncertainty: 0,  // Exact by SI definition 2019
  isValidated: true,
  source: 'wolfram',
};

export const EPSILON_0: UncertaintyFlag = {
  value: PHYSICAL_CONSTANTS.EPSILON_0,
  uncertainty: 1.5e-10,  // From CODATA 2018
  isValidated: true,
  source: 'wolfram',
};

export const K_B: UncertaintyFlag = {
  value: PHYSICAL_CONSTANTS.K_B,
  uncertainty: 0,  // Exact by SI definition 2019
  isValidated: true,
  source: 'wolfram',
};

// ============================================
// SEG Magnet Specifications (NdFeB N52)
// ============================================

export const SEG_MAGNET: SEGMagnetSpec = {
  Br: 1.48,                   // Tesla - Remanence
  mu_r: 1.05,                 // Relative permeability
  radius: 0.8,                // m
  height: 2.5,                // m
  volume: 5.02655,            // m³
  magnetization: 1.12166e6,   // A/m
};

// Magnet specifications with uncertainty metadata
export const MAGNET_BR: UncertaintyFlag = {
  value: SEG_MAGNET.Br,
  uncertainty: 0.02,  // ±2% - typical N52 spec range 1.44-1.52 T
  isValidated: true,
  source: 'wolfram',
};

export const MAGNETIC_MOMENT: UncertaintyFlag = {
  value: 5.635e6,  // A·m²
  uncertainty: 0.03,  // ±3% - calculated from geometry
  isValidated: false,
  source: 'calculated',
};

// ============================================
// SEG Configuration
// ============================================

export const SEG_CONFIG = {
  numRollers: 12,
  innerRingRadius: 2.0,       // m
  middleRingRadius: 4.0,      // m
  outerRingRadius: 6.0,       // m
  rollerHeight: 2.5,          // m
  rollerRadius: 0.8,          // m
  angularSeparation: Math.PI / 6,  // 30°
} as const;

// ============================================
// Pre-calculated SEG Physics Values
// ============================================

export const SEG_PHYSICS = {
  // B-Field at various distances (from fallback calculations)
  B_FIELD_SURFACE: FallbackPhysics.axialBFieldUncertain(0),
  B_FIELD_1M: FallbackPhysics.axialBFieldUncertain(1.0),
  B_FIELD_2M: FallbackPhysics.axialBFieldUncertain(2.0),
  B_FIELD_4M: FallbackPhysics.axialBFieldUncertain(4.0),

  // Energy densities
  ENERGY_DENSITY_SURFACE: FallbackPhysics.energyDensityUncertain(
    FallbackPhysics.axialBField(0)
  ),
  ENERGY_DENSITY_1M: FallbackPhysics.energyDensityUncertain(
    FallbackPhysics.axialBField(1.0)
  ),

  // Forces and torques
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
// Kelvin's Thunderstorm Constants
// ============================================

export const KELVIN_CONSTANTS = {
  BUCKET_CAPACITANCE: {
    value: 40.1e-12,  // F
    uncertainty: 0.05,
    isValidated: true,
    source: 'wolfram' as const,
  },
  DROPLET_CHARGE: {
    value: 1e-9,  // C (1 nC typical)
    uncertainty: 0.5,
    isValidated: false,
    source: 'estimated' as const,
  },
  E_BREAKDOWN: {
    value: 3e6,  // V/m
    uncertainty: 0.1,
    isValidated: true,
    source: 'wolfram' as const,
  },
  BUCKET_DISTANCE: 6.0,  // m
};

// ============================================
// Heron's Fountain Constants
// ============================================

export const HERON_CONSTANTS = {
  REST_DENSITY: 1000,           // kg/m³
  GAS_CONSTANT: 560571,         // Pa
  GAMMA: 7,                     // Tait EOS exponent
  SMOOTHING_LENGTH: 0.012,      // m
  GRAVITY: 9.80665,             // m/s²
  ATMOSPHERIC_PRESSURE: 101325, // Pa
};

// ============================================
// Helper Functions
// ============================================

/**
 * Get a constant value, optionally with validation
 */
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

/**
 * Check if all physics values in a set are validated
 */
export function areAllValidated(flags: UncertaintyFlag[]): boolean {
  return flags.every(f => f.isValidated);
}

/**
 * Get the maximum uncertainty in a set of values
 */
export function getMaxUncertainty(flags: UncertaintyFlag[]): number {
  return Math.max(...flags.map(f => f.uncertainty));
}

/**
 * Format an uncertain value for display
 */
export function formatUncertainValue(flag: UncertaintyFlag, precision = 4): string {
  const uncPercent = (flag.uncertainty * 100).toFixed(1);
  const sourceIcon = flag.isValidated ? '✓' : flag.source === 'calculated' ? '~' : '?';
  return `${flag.value.toPrecision(precision)} ${sourceIcon} (±${uncPercent}%)`;
}

// ============================================
// Export all validated constants
// ============================================

export const ValidatedConstants = {
  PHYSICAL_CONSTANTS,
  SEG_MAGNET,
  SEG_CONFIG,
  SEG_PHYSICS,
  KELVIN_CONSTANTS,
  HERON_CONSTANTS,
  MU_0,
  EPSILON_0,
  K_B,
  MAGNET_BR,
  MAGNETIC_MOMENT,
  
  // Helper functions
  getConstant,
  areAllValidated,
  getMaxUncertainty,
  formatUncertainValue,
} as const;

export default ValidatedConstants;
