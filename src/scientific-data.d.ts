export const SEG_DATA: {
  B_FIELD: { surface: number };
  ENERGY_DENSITY: { surface: number };
  MAGNET?: { Br?: number };
  MAGNETIC_MOMENT: number;
  ADJACENT_FORCE: number;
};

export const KELVIN_DATA: {
  BUCKET: { capacitance: number };
  DROPLET: { charge: number };
  VOLTAGE_BUILDUP: { at1s: number };
  SPARK_GAPS: { at10kV: number };
};

export const HERON_DATA: {
  SPH: { smoothingLength: number; gasConstant: number };
  SIPHON_VELOCITY: { at1m: number };
  PRESSURE: { at2m: number };
};

export const MICROVOLT_DATA: {
  THERMAL_NOISE: { at1Hz_1MOhm: number };
  SINGLE_ELECTRON: { at1pF: number };
  SIMULATION: { minVoltageStep: number };
};
