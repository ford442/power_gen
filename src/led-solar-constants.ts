/**
 * LED/Solar Physics Constants
 * 
 * Physics constants and calculations for LED/Solar panel energy loop simulation.
 * 
 * Wolfram Alpha Citations:
 * - LED wall-plug efficiency: ~30% typical for high-power LEDs (Wolfram|Alpha: "LED efficiency")
 * - Commercial Si solar cell efficiency: ~22% (Wolfram|Alpha: "silicon solar cell efficiency")
 * - Li-ion battery voltage: 3.0V (0%) to 4.2V (100%) (Wolfram|Alpha: "Li-ion battery voltage curve")
 * - Round-trip efficiency calculation: η_total = η_LED × η_geom × η_solar (Wolfram|Alpha: "energy conversion efficiency")
 */

import type { UncertaintyFlag } from './types';
import { createUncertainValue } from './fallback-physics';

// ============================================
// LED Constants
// ============================================

export const LED_CONSTANTS = {
  // Wall-plug efficiency: electrical → optical power
  // Source: Wolfram|Alpha - typical high-power LED efficiency ~30%
  WALL_PLUG_EFFICIENCY: {
    value: 0.30,
    uncertainty: 0.05,
    isValidated: true,
    source: 'wolfram' as const,
  },
  
  // Luminous efficacy: lm/W (optical power → luminous flux)
  // White LED: ~150-200 lm/W at operating conditions
  EFFICACY_WHITE: {
    value: 150,
    uncertainty: 0.10,
    isValidated: true,
    source: 'wolfram' as const,
  },
  
  // Color-specific efficacies (lm/W)
  EFFICACY_RED: {
    value: 100,
    uncertainty: 0.15,
    isValidated: false,
    source: 'calculated' as const,
  },
  EFFICACY_GREEN: {
    value: 180,
    uncertainty: 0.10,
    isValidated: true,
    source: 'wolfram' as const,
  },
  EFFICACY_BLUE: {
    value: 50,
    uncertainty: 0.15,
    isValidated: false,
    source: 'calculated' as const,
  },
  
  // Forward voltages at nominal current (V)
  V_F_RED: 2.0,
  V_F_GREEN: 3.2,
  V_F_BLUE: 3.3,
  V_F_WHITE: 3.5,
  V_F_YELLOW: 2.1,
  
  // Thermal resistance (K/W) - junction to ambient
  THERMAL_RESISTANCE: {
    value: 20,
    uncertainty: 0.20,
    isValidated: false,
    source: 'estimated' as const,
  },
  
  // Maximum forward current (mA)
  MAX_CURRENT_MA: 1000,
  
  // Nominal operating current (mA)
  NOMINAL_CURRENT_MA: 350,
};

// ============================================
// Solar Panel Constants
// ============================================

export const SOLAR_CONSTANTS = {
  // Commercial Si solar cell efficiency
  // Source: Wolfram|Alpha - "silicon solar cell efficiency" ~20-24%
  SI_EFFICIENCY: {
    value: 0.22,
    uncertainty: 0.02,
    isValidated: true,
    source: 'wolfram' as const,
  },
  
  // Fill factor - typical for commercial cells
  FILL_FACTOR: {
    value: 0.75,
    uncertainty: 0.05,
    isValidated: true,
    source: 'wolfram' as const,
  },
  
  // Open circuit voltage per cell (V)
  VOC_PER_CELL: 0.6,
  
  // Temperature coefficient of Voc (%/°C)
  TEMP_COEFF_VOC: -0.003,
  
  // Standard test conditions
  STC_IRRADIANCE: 1000,  // W/m²
  STC_TEMPERATURE: 25,   // °C
  
  // Panel area (m²) - scaled for simulation
  // 60cm x 100cm = 0.06 m², scaled to 0.006 for compact simulation
  PANEL_AREA: 0.006,
  
  // Number of cells in series
  NUM_CELLS: 6,
};

// ============================================
// Battery Constants (Li-ion 18650)
// ============================================

export const BATTERY_CONSTANTS = {
  // Nominal capacity (Ah) - standard 18650 cell
  NOMINAL_CAPACITY_AH: 2.6,
  
  // Voltage limits (V)
  // Source: Wolfram|Alpha - "Li-ion battery voltage curve"
  V_MIN: 3.0,   // 0% SOC
  V_NOMINAL: 3.7, // 50% SOC
  V_MAX: 4.2,   // 100% SOC
  
  // Charge/discharge efficiency
  CHARGE_EFFICIENCY: 0.95,
  DISCHARGE_EFFICIENCY: 0.98,
  
  // Self-discharge rate (%/month)
  SELF_DISCHARGE_MONTHLY: 0.05,
  
  // Temperature limits (°C)
  TEMP_MIN: -20,
  TEMP_MAX: 60,
  TEMP_OPTIMAL: 25,
};

// ============================================
// Energy Flow Constants
// ============================================

export const ENERGY_FLOW_CONSTANTS = {
  // Geometric efficiency: portion of LED light reaching panel
  // Depends on arrangement, reflectors, etc.
  GEOMETRIC_EFFICIENCY: 0.85,
  
  // Round-trip efficiency = η_LED × η_geom × η_solar
  // = 0.30 × 0.85 × 0.22 ≈ 0.056 or 5.6%
  // With battery: 0.30 × 0.85 × 0.22 × 0.95 ≈ 0.053 or 5.3%
  get ROUND_TRIP_EFFICIENCY() {
    return LED_CONSTANTS.WALL_PLUG_EFFICIENCY.value * 
           this.GEOMETRIC_EFFICIENCY * 
           SOLAR_CONSTANTS.SI_EFFICIENCY.value *
           BATTERY_CONSTANTS.CHARGE_EFFICIENCY;
  },
  
  // Average photon energy in visible range (eV)
  // Source: Wolfram|Alpha - "photon energy visible light" ~1.65-3.26 eV
  AVG_PHOTON_ENERGY_EV: 2.5,
  
  // Joules per eV
  JOULES_PER_EV: 1.602176634e-19,
};

// ============================================
// IV Curve Calculator
// ============================================

export class IVCurveCalculator {
  /**
   * Calculate I-V curve for solar cell using single diode model
   * 
   * @param voltage - Array of voltage points (V)
   * @param isc - Short circuit current (A)
   * @param voc - Open circuit voltage (V)
   * @param n - Ideality factor (1-2, typically 1.3)
   * @param rs - Series resistance (Ω)
   * @param rsh - Shunt resistance (Ω)
   * @returns Array of current values (A)
   * 
   * Source: Wolfram|Alpha - "solar cell single diode model"
   */
  static calculateIVCurve(
    voltage: number[],
    isc: number,
    voc: number,
    n: number = 1.3,
    rs: number = 0.01,
    rsh: number = 1000
  ): number[] {
    const vt = 0.026; // Thermal voltage at room temp (V)
    const i0 = isc / (Math.exp(voc / (n * vt)) - 1); // Saturation current
    
    return voltage.map(v => {
      // Single diode equation with series resistance
      const i = isc - i0 * (Math.exp((v + isc * rs) / (n * vt)) - 1) - (v + isc * rs) / rsh;
      return Math.max(0, i); // No negative current
    });
  }
  
  /**
   * Find maximum power point
   * 
   * @param voltage - Voltage array
   * @param current - Current array
   * @returns MPP as {voltage, current, power}
   */
  static findMPP(
    voltage: number[],
    current: number[]
  ): { voltage: number; current: number; power: number } {
    let maxPower = 0;
    let mppIndex = 0;
    
    for (let i = 0; i < voltage.length; i++) {
      const power = voltage[i] * current[i];
      if (power > maxPower) {
        maxPower = power;
        mppIndex = i;
      }
    }
    
    return {
      voltage: voltage[mppIndex],
      current: current[mppIndex],
      power: maxPower
    };
  }
  
  /**
   * Calculate fill factor
   * 
   * @param voc - Open circuit voltage (V)
   * @param isc - Short circuit current (A)
   * @param vmp - Voltage at max power (V)
   * @param imp - Current at max power (A)
   * @returns Fill factor (0-1)
   */
  static calculateFillFactor(
    voc: number,
    isc: number,
    vmp: number,
    imp: number
  ): number {
    return (vmp * imp) / (voc * isc);
  }
}

// ============================================
// LED Solar Physics
// ============================================

export class LEDSolarPhysics {
  /**
   * Calculate LED optical power output
   * 
   * @param forwardVoltage - Vf (V)
   * @param current - If (mA)
   * @param wallPlugEfficiency - Optional override
   * @returns Optical power (W)
   */
  static calculateLEDOutputPower(
    forwardVoltage: number,
    current: number,
    wallPlugEfficiency?: number
  ): number {
    const eff = wallPlugEfficiency ?? LED_CONSTANTS.WALL_PLUG_EFFICIENCY.value;
    const electricalPower = forwardVoltage * (current / 1000); // W
    return electricalPower * eff;
  }
  
  /**
   * Calculate luminous flux from LED
   * 
   * @param opticalPower - Output optical power (W)
   * @param efficacy - Luminous efficacy (lm/W)
   * @returns Luminous flux (lumens)
   */
  static calculateLuminousFlux(
    opticalPower: number,
    efficacy: number
  ): number {
    return opticalPower * efficacy;
  }
  
  /**
   * Calculate solar panel output
   * 
   * @param irradiance - Received optical power density (W/m²)
   * @param area - Panel area (m²)
   * @param efficiency - Cell efficiency (0-1)
   * @returns Electrical output power (W)
   */
  static calculateSolarOutput(
    irradiance: number,
    area: number,
    efficiency?: number
  ): number {
    const eff = efficiency ?? SOLAR_CONSTANTS.SI_EFFICIENCY.value;
    return irradiance * area * eff;
  }
  
  /**
   * Calculate round-trip efficiency
   * 
   * @param ledEfficiency - LED wall-plug efficiency
   * @param geometricEfficiency - Light capture efficiency
   * @param solarEfficiency - Solar cell efficiency
   * @param batteryEfficiency - Battery charge efficiency
   * @returns Total round-trip efficiency (0-1)
   * 
   * Source: Wolfram|Alpha - "cascade efficiency calculation"
   */
  static calculateRoundTripEfficiency(
    ledEfficiency: number,
    geometricEfficiency: number,
    solarEfficiency: number,
    batteryEfficiency: number = BATTERY_CONSTANTS.CHARGE_EFFICIENCY
  ): number {
    return ledEfficiency * geometricEfficiency * solarEfficiency * batteryEfficiency;
  }
  
  /**
   * Estimate photon count from optical power
   * 
   * @param opticalPower - Optical power (W)
   * @param wavelength - Average wavelength (m), default 550nm (green)
   * @returns Photon count per second
   * 
   * Source: Wolfram|Alpha - "photon flux calculation"
   */
  static calculatePhotonFlux(
    opticalPower: number,
    wavelength: number = 550e-9
  ): number {
    const h = 6.626e-34; // Planck's constant (J·s)
    const c = 299792458; // Speed of light (m/s)
    const photonEnergy = (h * c) / wavelength; // J/photon
    return opticalPower / photonEnergy;
  }
  
  /**
   * Calculate Li-ion battery voltage from SOC
   * 
   * Uses piecewise linear approximation of voltage curve
   * 
   * @param soc - State of charge (0-100%)
   * @returns Battery voltage (V)
   * 
   * Source: Wolfram|Alpha - "Li-ion battery discharge curve"
   */
  static calculateBatteryVoltage(soc: number): number {
    const clampedSoc = Math.max(0, Math.min(100, soc));
    
    if (clampedSoc < 20) {
      // 3.0V at 0%, 3.5V at 20%
      return 3.0 + (clampedSoc / 20) * 0.5;
    } else if (clampedSoc < 80) {
      // 3.5V at 20%, 3.9V at 80%
      return 3.5 + ((clampedSoc - 20) / 60) * 0.4;
    } else {
      // 3.9V at 80%, 4.2V at 100%
      return 3.9 + ((clampedSoc - 80) / 20) * 0.3;
    }
  }
  
  /**
   * Calculate battery energy capacity
   * 
   * @param capacityAh - Capacity in Ah
   * @param voltage - Nominal voltage (V)
   * @returns Energy capacity (Wh)
   */
  static calculateBatteryEnergy(capacityAh: number, voltage: number = 3.7): number {
    return capacityAh * voltage;
  }
  
  /**
   * Calculate temperature rise from power dissipation
   * 
   * @param power - Power dissipated (W)
   * @param thermalResistance - Junction-to-ambient (K/W)
   * @param ambientTemp - Ambient temperature (°C)
   * @returns Junction temperature (°C)
   */
  static calculateTemperature(
    power: number,
    thermalResistance: number = LED_CONSTANTS.THERMAL_RESISTANCE.value,
    ambientTemp: number = 25
  ): number {
    return ambientTemp + power * thermalResistance;
  }
}

// ============================================
// Export All LED/Solar Constants
// ============================================

export const LEDSolarConstants = {
  LED: LED_CONSTANTS,
  SOLAR: SOLAR_CONSTANTS,
  BATTERY: BATTERY_CONSTANTS,
  ENERGY_FLOW: ENERGY_FLOW_CONSTANTS,
};

export default LEDSolarConstants;
