/**
 * Fallback Physics Calculator
 * Analytical formulas for when Wolfram MCP is unavailable
 * All formulas include uncertainty estimates
 */

import type { Vec3, UncertaintyFlag, PhysicsValueType, ValidationResult } from './types';

/**
 * Uncertainty levels for different calculation types
 */
export const UNCERTAINTY_LEVELS = {
  DIPOLE_FIELD: 0.05,      // ±5% - Dipole field approximation
  ENERGY_DENSITY: 0.02,    // ±2% - Well-known formula
  TORQUE_DIPOLE: 0.10,     // ±10% - Torque on dipole
  AXIAL_FIELD: 0.03,       // ±3% - Axial field formula
  FORCE_ADJACENT: 0.08,    // ±8% - Force between magnets
} as const;

/**
 * Physical bounds for validation
 */
export const PHYSICAL_BOUNDS: Record<PhysicsValueType, { min: number; max: number }> = {
  field: { min: 0, max: 10 },           // Tesla (max for permanent magnets)
  energy: { min: 0, max: 1e6 },         // J/m³
  torque: { min: 0, max: 1000 },        // N·m (for SEG scale)
  voltage: { min: 0, max: 1e6 },        // V
  force: { min: 0, max: 1e8 },          // N
};

/**
 * Create an uncertainty-flagged value
 */
export function createUncertainValue(
  value: number,
  uncertainty: number,
  source: 'wolfram' | 'calculated' | 'estimated' = 'calculated'
): UncertaintyFlag {
  return {
    value,
    uncertainty,
    isValidated: source === 'wolfram',
    source,
  };
}

/**
 * Validate a physics value against physical bounds
 */
export function validatePhysics(value: number, type: PhysicsValueType): ValidationResult {
  const bounds = PHYSICAL_BOUNDS[type];
  const isValid = value >= bounds.min && value <= bounds.max;
  return {
    isValid,
    value,
    bounds,
    message: isValid ? undefined : `Value ${value} outside bounds [${bounds.min}, ${bounds.max}]`,
  };
}

/**
 * Physics constants with fallback values
 * From CODATA 2018
 */
export const FALLBACK_CONSTANTS = {
  MU_0: 1.2566370614e-7,      // H/m - Vacuum permeability
  EPSILON_0: 8.854187817e-12, // F/m - Vacuum permittivity
  C: 299792458,               // m/s - Speed of light
  K_B: 1.380649e-23,          // J/K - Boltzmann constant
  T_ROOM: 300,                // K - Room temperature
  E_CHARGE: 1.602176634e-19,  // C - Elementary charge
  G: 9.80665,                 // m/s² - Standard gravity
  PI: Math.PI,
} as const;

/**
 * SEG Magnet specifications (NdFeB N52)
 */
export const FALLBACK_SEG_SPECS = {
  Br: 1.48,                   // Tesla - Remanence
  mu_r: 1.05,                 // Relative permeability
  radius: 0.8,                // m
  height: 2.5,                // m
  volume: 5.02655,            // m³
  magnetization: 1.12166e6,   // A/m
  magneticMoment: 5.635e6,    // A·m²
  ringRadius: 4.0,            // m
  numRollers: 12,
} as const;

/**
 * Fallback physics calculations
 * All functions return UncertaintyFlag to indicate reliability
 */
export const FallbackPhysics = {
  /**
   * Calculate magnetic dipole field at position r due to dipole m
   * B = (μ₀/4π)[3(m·r̂)r̂ - m]/r³
   * Uncertainty: ±5% (dipole approximation)
   */
  magneticDipoleField(pos: Vec3, dipole: Vec3): Vec3 {
    const rLen = Math.sqrt(pos.x ** 2 + pos.y ** 2 + pos.z ** 2);
    if (rLen === 0) return { x: 0, y: 0, z: 0 };

    const rNorm = { x: pos.x / rLen, y: pos.y / rLen, z: pos.z / rLen };
    const r3 = rLen ** 3;
    const factor = (FALLBACK_CONSTANTS.MU_0 / (4 * Math.PI)) / r3;

    const mDotR = dipole.x * rNorm.x + dipole.y * rNorm.y + dipole.z * rNorm.z;

    return {
      x: factor * (3 * mDotR * rNorm.x - dipole.x),
      y: factor * (3 * mDotR * rNorm.y - dipole.y),
      z: factor * (3 * mDotR * rNorm.z - dipole.z),
    };
  },

  /**
   * Calculate magnetic field magnitude with uncertainty flag
   */
  magneticDipoleFieldUncertain(pos: Vec3, dipole: Vec3): UncertaintyFlag & { field: Vec3 } {
    const field = this.magneticDipoleField(pos, dipole);
    const magnitude = Math.sqrt(field.x ** 2 + field.y ** 2 + field.z ** 2);
    return {
      field,
      ...createUncertainValue(magnitude, UNCERTAINTY_LEVELS.DIPOLE_FIELD, 'calculated'),
    };
  },

  /**
   * Axial B-field for cylindrical magnet
   * B(z) = (Br/2)[(z+h)/√((z+h)²+R²) - z/√(z²+R²)]
   * Uncertainty: ±3% (analytical formula)
   */
  axialBField(z: number, radius = FALLBACK_SEG_SPECS.radius, height = FALLBACK_SEG_SPECS.height): number {
    const Br = FALLBACK_SEG_SPECS.Br;
    const term1 = (z + height) / Math.sqrt((z + height) ** 2 + radius ** 2);
    const term2 = z / Math.sqrt(z ** 2 + radius ** 2);
    return (Br / 2) * (term1 - term2);
  },

  /**
   * Axial B-field with uncertainty flag
   */
  axialBFieldUncertain(z: number): UncertaintyFlag {
    const value = this.axialBField(z);
    return createUncertainValue(value, UNCERTAINTY_LEVELS.AXIAL_FIELD, 'calculated');
  },

  /**
   * Energy density u = B²/(2μ₀)
   * Uncertainty: ±2% (well-known formula)
   */
  energyDensity(B: number): number {
    return (B * B) / (2 * FALLBACK_CONSTANTS.MU_0);
  },

  /**
   * Energy density with uncertainty flag
   */
  energyDensityUncertain(B: number): UncertaintyFlag {
    const value = this.energyDensity(B);
    return createUncertainValue(value, UNCERTAINTY_LEVELS.ENERGY_DENSITY, 'calculated');
  },

  /**
   * Torque on dipole τ = m × B
   * Uncertainty: ±10% (depends on field accuracy)
   */
  torqueOnDipole(moment: Vec3, B: Vec3): Vec3 {
    // Cross product m × B
    return {
      x: moment.y * B.z - moment.z * B.y,
      y: moment.z * B.x - moment.x * B.z,
      z: moment.x * B.y - moment.y * B.x,
    };
  },

  /**
   * Torque magnitude with uncertainty flag
   */
  torqueOnDipoleUncertain(moment: Vec3, B: Vec3): UncertaintyFlag {
    const torque = this.torqueOnDipole(moment, B);
    const magnitude = Math.sqrt(torque.x ** 2 + torque.y ** 2 + torque.z ** 2);
    return createUncertainValue(magnitude, UNCERTAINTY_LEVELS.TORQUE_DIPOLE, 'calculated');
  },

  /**
   * Force between adjacent rollers
   * F = (3μ₀m²)/(2πd⁴)
   * Uncertainty: ±8% (depends on dipole approximation)
   */
  adjacentRollerForce(distance: number): number {
    const mu0 = FALLBACK_CONSTANTS.MU_0;
    const m = FALLBACK_SEG_SPECS.magneticMoment;
    return (3 * mu0 * m * m) / (2 * Math.PI * distance ** 4);
  },

  /**
   * Adjacent roller force with uncertainty flag
   */
  adjacentRollerForceUncertain(distance: number): UncertaintyFlag {
    const value = this.adjacentRollerForce(distance);
    return createUncertainValue(value, UNCERTAINTY_LEVELS.FORCE_ADJACENT, 'calculated');
  },

  /**
   * Calculate total torque on a ring of rollers
   * Sums contributions from all adjacent pairs
   */
  ringTorque(ringRadius: number = FALLBACK_SEG_SPECS.ringRadius): UncertaintyFlag {
    const numRollers = FALLBACK_SEG_SPECS.numRollers;
    const angularSep = (2 * Math.PI) / numRollers;
    const chordDistance = 2 * ringRadius * Math.sin(angularSep / 2);
    const force = this.adjacentRollerForce(chordDistance);
    // Torque = force × lever arm (approximate)
    const torque = force * ringRadius;
    return createUncertainValue(torque, UNCERTAINTY_LEVELS.TORQUE_DIPOLE, 'calculated');
  },

  /**
   * Thermal noise voltage (Johnson-Nyquist)
   * Vn = √(4kBTRΔf)
   * Well-established formula with low uncertainty
   */
  thermalNoise(resistance: number, bandwidth: number): UncertaintyFlag {
    const kB = FALLBACK_CONSTANTS.K_B;
    const T = FALLBACK_CONSTANTS.T_ROOM;
    const value = Math.sqrt(4 * kB * T * resistance * bandwidth);
    return createUncertainValue(value, 0.01, 'calculated'); // ±1%
  },

  /**
   * Single-electron voltage step
   * ΔV = e/C
   */
  singleElectronVoltage(capacitance: number): UncertaintyFlag {
    const value = FALLBACK_CONSTANTS.E_CHARGE / capacitance;
    return createUncertainValue(value, 0.005, 'calculated'); // ±0.5%
  },

  /**
   * Get all SEG physics with uncertainty flags
   */
  getSEGPhysicsSummary() {
    const surfaceB = this.axialBFieldUncertain(0);
    const at1mB = this.axialBFieldUncertain(1.0);
    const surfaceEnergy = this.energyDensityUncertain(surfaceB.value);
    const ringTorque = this.ringTorque();
    const adjacentForce = this.adjacentRollerForceUncertain(
      2 * FALLBACK_SEG_SPECS.ringRadius * Math.sin(Math.PI / FALLBACK_SEG_SPECS.numRollers)
    );

    return {
      surfaceBField: surfaceB,
      bFieldAt1m: at1mB,
      surfaceEnergyDensity: surfaceEnergy,
      ringTorque,
      adjacentRollerForce: adjacentForce,
      allValidated: false,
      averageUncertainty: Math.max(
        surfaceB.uncertainty,
        surfaceEnergy.uncertainty,
        ringTorque.uncertainty
      ),
    };
  },
} as const;

export default FallbackPhysics;
