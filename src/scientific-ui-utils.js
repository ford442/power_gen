/**
 * SEG WebGPU Visualizer - Scientific UI Utilities
 * Utility functions for number formatting and color operations
 */

/**
 * Format a number with specified decimal places
 */
export function formatNumber(value, decimals = 2) {
  return value.toFixed(decimals);
}

/**
 * Format a large number with K/M suffix
 */
export function formatCompact(value) {
  if (value >= 1e6) return (value / 1e6).toFixed(1) + 'M';
  if (value >= 1e3) return (value / 1e3).toFixed(1) + 'K';
  return value.toString();
}

/**
 * Clamp a value between min and max
 */
export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Interpolate between two colors
 */
export function lerpColor(color1, color2, factor) {
  const r1 = parseInt(color1.slice(1, 3), 16);
  const g1 = parseInt(color1.slice(3, 5), 16);
  const b1 = parseInt(color1.slice(5, 7), 16);
  
  const r2 = parseInt(color2.slice(1, 3), 16);
  const g2 = parseInt(color2.slice(3, 5), 16);
  const b2 = parseInt(color2.slice(5, 7), 16);
  
  const r = Math.round(r1 + (r2 - r1) * factor);
  const g = Math.round(g1 + (g2 - g1) * factor);
  const b = Math.round(b1 + (b2 - b1) * factor);
  
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

/**
 * Format current with sign and unit
 */
export function formatCurrent(mA) {
  const sign = mA >= 0 ? '+' : '';
  return `${sign}${mA.toFixed(0)}mA`;
}

/**
 * LED + Solar Constants - Physical specifications and efficiency data
 */
export const LED_SOLAR_CONSTANTS = {
  // Battery: Li-ion 3.0V (0%) to 4.2V (100%)
  BATTERY: {
    VOLTAGE_MIN: 3.0,
    VOLTAGE_MAX: 4.2,
    VOLTAGE_NOMINAL: 3.7,
    TEMP_MIN: -20,
    TEMP_MAX: 60,
    TEMP_OPTIMAL: 25,
  },
  
  // Solar Panel: AM1.5G standard = 1000 W/m²
  SOLAR: {
    IRRADIANCE_MAX: 1200,
    IRRADIANCE_STANDARD: 1000, // AM1.5G
    EFFICIENCY_MIN: 0.15,
    EFFICIENCY_MAX: 0.26,
  },
  
  // LED Forward Voltages by color
  LED: {
    RED: { vf: 2.0, wavelength: 625, lumensPerWatt: 120 },
    GREEN: { vf: 3.2, wavelength: 525, lumensPerWatt: 180 },
    BLUE: { vf: 3.3, wavelength: 470, lumensPerWatt: 70 },
    WHITE: { vf: 3.5, wavelength: null, lumensPerWatt: 150 },
    YELLOW: { vf: 2.1, wavelength: 590, lumensPerWatt: 130 },
  },
  
  // Energy Flow Efficiency Chain
  EFFICIENCY: {
    BATTERY_DISCHARGE: 0.95,
    LED_CONVERSION: 0.30,
    TRANSMISSION: 0.85,
    SOLAR_CONVERSION: 0.22,
    BATTERY_CHARGE: 0.95,
    get ROUND_TRIP() {
      return this.BATTERY_DISCHARGE * this.LED_CONVERSION * 
             this.TRANSMISSION * this.SOLAR_CONVERSION * this.BATTERY_CHARGE;
    }
  }
};
