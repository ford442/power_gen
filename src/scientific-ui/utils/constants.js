/**
 * LED + Solar Constants Module
 * Physical constants for LED and Solar cell calculations
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

// Default export for convenience
export default LED_SOLAR_CONSTANTS;
