/**
 * AUTO-GENERATED from physics/devices.json — do not edit.
 * Regenerate: npm run codegen:catalog
 */

/** '' = plain fixed-point, 'si' = SI-prefix the unit, 'exp' = exponential. */
export type TelemetryValueFormat = '' | 'si' | 'exp';

/** Display schema for one telemetry key (units live in the catalog, not the UI). */
export interface TelemetryFieldMeta {
  label: string;
  unit: string;
  digits: number;
  /** Multiply the raw hub value before formatting (e.g. 0–1 → %). */
  scale?: number;
  format?: TelemetryValueFormat;
}

export interface DeviceCatalogEntry {
  id: string;
  label: string;
  category: string;
  shaderMode: number;
  wasmMode: number | null;
  telemetryKeys: readonly string[];
  telemetry: Record<string, TelemetryFieldMeta>;
  fidelity: string;
}

export const DEVICE_CATALOG = [
  {
    id: 'seg',
    label: "SEG",
    category: 'core',
    shaderMode: 0,
    wasmMode: 0 as number | null,
    telemetryKeys: ['rpm', 'omega', 'corona', 'voltage', 'current', 'power', 'fieldSim', 'energyDensity'] as const,
    telemetry: {
      "rpm": { label: "RPM", unit: "RPM", digits: 0 },
      "omega": { label: "omega", unit: "rad/s", digits: 3 },
      "corona": { label: "Corona", unit: "%", digits: 0, scale: 100 },
      "voltage": { label: "V", unit: "V", digits: 2 },
      "current": { label: "I", unit: "A", digits: 3 },
      "power": { label: "P", unit: "W", digits: 1 },
      "fieldSim": { label: "B_sim", unit: "T", digits: 3 },
      "energyDensity": { label: "u_E", unit: "J/m³", digits: 1 },
    } as Record<string, TelemetryFieldMeta>,
    fidelity: "WASM RK4 (full plant)",
  },
  {
    id: 'heron',
    label: "Heron's Fountain",
    category: 'core',
    shaderMode: 1,
    wasmMode: 1 as number | null,
    telemetryKeys: ['heronHead', 'heronHeadMax', 'heronVExit', 'heronFlowRateLmin', 'heronPressureKPa'] as const,
    telemetry: {
      "heronHead": { label: "Head", unit: "m", digits: 2 },
      "heronHeadMax": { label: "Head_max", unit: "m", digits: 2 },
      "heronVExit": { label: "v_exit", unit: "m/s", digits: 2 },
      "heronFlowRateLmin": { label: "Q", unit: "L/min", digits: 1 },
      "heronPressureKPa": { label: "p", unit: "kPa", digits: 1 },
    } as Record<string, TelemetryFieldMeta>,
    fidelity: "WASM (Bernoulli/Swamee–Jain)",
  },
  {
    id: 'kelvin',
    label: "Kelvin's Thunderstorm",
    category: 'core',
    shaderMode: 2,
    wasmMode: 2 as number | null,
    telemetryKeys: ['kelvinV', 'kelvinVoltageN', 'kelvinVbreak', 'kelvinE', 'kelvinSparkTimer'] as const,
    telemetry: {
      "kelvinV": { label: "V", unit: "V", digits: 0 },
      "kelvinVoltageN": { label: "V/V_break", unit: "%", digits: 0, scale: 100 },
      "kelvinVbreak": { label: "V_break", unit: "V", digits: 0 },
      "kelvinE": { label: "E", unit: "V/m", digits: 3, format: 'si' as TelemetryValueFormat },
      "kelvinSparkTimer": { label: "spark", unit: "s", digits: 3 },
    } as Record<string, TelemetryFieldMeta>,
    fidelity: "WASM (capacitive + spark)",
  },
  {
    id: 'solar',
    label: "Solar / LED",
    category: 'core',
    shaderMode: 3,
    wasmMode: 3 as number | null,
    telemetryKeys: ['batteryCharge'] as const,
    telemetry: {
      "batteryCharge": { label: "SOC", unit: "%", digits: 0, scale: 100 },
    } as Record<string, TelemetryFieldMeta>,
    fidelity: "WASM (battery SOC)",
  },
  {
    id: 'peltier',
    label: "Peltier",
    category: 'core',
    shaderMode: 4,
    wasmMode: 4 as number | null,
    telemetryKeys: ['peltierHotK', 'peltierColdK', 'peltierDeltaT', 'peltierVoltage', 'peltierCurrent', 'peltierPowerW', 'peltierCOP'] as const,
    telemetry: {
      "peltierHotK": { label: "T_h", unit: "K", digits: 1 },
      "peltierColdK": { label: "T_c", unit: "K", digits: 1 },
      "peltierDeltaT": { label: "ΔT", unit: "K", digits: 1 },
      "peltierVoltage": { label: "V", unit: "V", digits: 3 },
      "peltierCurrent": { label: "I", unit: "A", digits: 3 },
      "peltierPowerW": { label: "P", unit: "W", digits: 2 },
      "peltierCOP": { label: "COP", unit: "", digits: 3 },
    } as Record<string, TelemetryFieldMeta>,
    fidelity: "WASM (two-node Seebeck/Peltier stack)",
  },
  {
    id: 'mhd',
    label: "MHD Channel",
    category: 'core',
    shaderMode: 5,
    wasmMode: 5 as number | null,
    telemetryKeys: ['mhdFlowU', 'mhdBFieldT', 'mhdHartmann', 'mhdVoltage', 'mhdCurrent', 'mhdPowerW'] as const,
    telemetry: {
      "mhdFlowU": { label: "U", unit: "m/s", digits: 2 },
      "mhdBFieldT": { label: "B", unit: "T", digits: 2 },
      "mhdHartmann": { label: "Ha", unit: "", digits: 1 },
      "mhdVoltage": { label: "V", unit: "V", digits: 3 },
      "mhdCurrent": { label: "I", unit: "A", digits: 3 },
      "mhdPowerW": { label: "P", unit: "W", digits: 2 },
    } as Record<string, TelemetryFieldMeta>,
    fidelity: "WASM (Hartmann channel)",
  },
  {
    id: 'maglev',
    label: "Magnetic Levitation",
    category: 'quanta',
    shaderMode: 6,
    wasmMode: 6 as number | null,
    telemetryKeys: ['maglevGapMm', 'maglevFieldT', 'maglevLiftN', 'maglevRpm'] as const,
    telemetry: {
      "maglevGapMm": { label: "gap", unit: "mm", digits: 2 },
      "maglevFieldT": { label: "B", unit: "T", digits: 3 },
      "maglevLiftN": { label: "F_z", unit: "N", digits: 2 },
      "maglevRpm": { label: "RPM", unit: "RPM", digits: 0 },
    } as Record<string, TelemetryFieldMeta>,
    fidelity: "WASM (spring–damper gap ODE), JS fallback mirrors it",
  },
  {
    id: 'pulse-coil',
    label: "Pulse Coil (R–L)",
    category: 'quanta',
    shaderMode: 7,
    wasmMode: null as number | null,
    telemetryKeys: ['pulseCoilCurrentA', 'pulseCoilVCap', 'pulseCoilBPeakT', 'pulseCoilArmatureMm'] as const,
    telemetry: {
      "pulseCoilCurrentA": { label: "I", unit: "A", digits: 2 },
      "pulseCoilVCap": { label: "V_cap", unit: "V", digits: 1 },
      "pulseCoilBPeakT": { label: "B_pk", unit: "T", digits: 3 },
      "pulseCoilArmatureMm": { label: "x", unit: "mm", digits: 2 },
    } as Record<string, TelemetryFieldMeta>,
    fidelity: "JS-only (fallback-physics for pulseCoilBPeakT)",
  },
  {
    id: 'homopolar',
    label: "Homopolar Generator",
    category: 'quanta',
    shaderMode: 8,
    wasmMode: 7 as number | null,
    telemetryKeys: ['homopolarRpm', 'homopolarEmfV', 'homopolarCurrentA', 'homopolarFieldT'] as const,
    telemetry: {
      "homopolarRpm": { label: "RPM", unit: "RPM", digits: 0 },
      "homopolarEmfV": { label: "EMF", unit: "V", digits: 3, format: 'si' as TelemetryValueFormat },
      "homopolarCurrentA": { label: "I", unit: "A", digits: 3 },
      "homopolarFieldT": { label: "B", unit: "T", digits: 3 },
    } as Record<string, TelemetryFieldMeta>,
    fidelity: "WASM (Faraday disc L–R + back-EMF)",
  },
  {
    id: 'halbach-viz',
    label: "Halbach Field Viz",
    category: 'quanta',
    shaderMode: 9,
    wasmMode: null as number | null,
    telemetryKeys: ['halbachSegmentCount', 'halbachMagAngleDeg', 'halbachPeakBT', 'halbachPeriodM', 'halbachDipoleForceN'] as const,
    telemetry: {
      "halbachSegmentCount": { label: "N", unit: "", digits: 0 },
      "halbachMagAngleDeg": { label: "θ", unit: "°", digits: 1 },
      "halbachPeakBT": { label: "|B|", unit: "T", digits: 4 },
      "halbachPeriodM": { label: "λ", unit: "m", digits: 3, format: 'si' as TelemetryValueFormat },
      "halbachDipoleForceN": { label: "F", unit: "N", digits: 3, format: 'si' as TelemetryValueFormat },
    } as Record<string, TelemetryFieldMeta>,
    fidelity: "JS-only (CPU field-line viz); estimateHalbachFieldT is a free WASM helper, not a plant",
  },
  {
    id: 'transformer',
    label: "Mutual Induction",
    category: 'quanta',
    shaderMode: 10,
    wasmMode: 8 as number | null,
    telemetryKeys: ['transformerVp', 'transformerVs', 'transformerIpA', 'transformerIsA', 'transformerK', 'transformerFluxN'] as const,
    telemetry: {
      "transformerVp": { label: "V_p", unit: "V", digits: 2 },
      "transformerVs": { label: "V_s", unit: "V", digits: 2 },
      "transformerIpA": { label: "I_p", unit: "A", digits: 3 },
      "transformerIsA": { label: "I_s", unit: "A", digits: 3 },
      "transformerK": { label: "k", unit: "", digits: 3 },
      "transformerFluxN": { label: "Φ", unit: "Wb", digits: 3, format: 'si' as TelemetryValueFormat },
    } as Record<string, TelemetryFieldMeta>,
    fidelity: "WASM coupled-inductor ODE (?wasmPhysics=1); JS phasor fallback",
  },
  {
    id: 'vdg',
    label: "Van de Graaff",
    category: 'quanta',
    shaderMode: 12,
    wasmMode: 9 as number | null,
    telemetryKeys: ['vdgVoltage', 'vdgBeltMps', 'vdgChargeC', 'vdgSparkHz'] as const,
    telemetry: {
      "vdgVoltage": { label: "V", unit: "V", digits: 0 },
      "vdgBeltMps": { label: "belt", unit: "m/s", digits: 2 },
      "vdgChargeC": { label: "Q", unit: "C", digits: 2, format: 'si' as TelemetryValueFormat },
      "vdgSparkHz": { label: "spark", unit: "Hz", digits: 2 },
    } as Record<string, TelemetryFieldMeta>,
    fidelity: "WASM belt-charge/sphere-capacitance/spark-gap ODE (?wasmPhysics=1); JS fallback",
  },
  {
    id: 'hall',
    label: "Hall-Effect Bench",
    category: 'quanta',
    shaderMode: 13,
    wasmMode: 10 as number | null,
    telemetryKeys: ['hallVoltage', 'hallCurrent', 'hallFieldT', 'hallCoeff'] as const,
    telemetry: {
      "hallVoltage": { label: "V_H", unit: "V", digits: 2, format: 'si' as TelemetryValueFormat },
      "hallCurrent": { label: "I", unit: "A", digits: 3 },
      "hallFieldT": { label: "B", unit: "T", digits: 3 },
      "hallCoeff": { label: "R_H", unit: "m³/C", digits: 3, format: 'exp' as TelemetryValueFormat },
    } as Record<string, TelemetryFieldMeta>,
    fidelity: "WASM I·B→Hall-voltage ODE (?wasmPhysics=1); JS fallback",
  },
  {
    id: 'lorentz-sled',
    label: "Lorentz Rail Sled",
    category: 'quanta',
    shaderMode: 14,
    wasmMode: 11 as number | null,
    telemetryKeys: ['lorentzSledVms', 'lorentzCurrentA', 'lorentzFieldT', 'lorentzForceN', 'lorentzPositionM'] as const,
    telemetry: {
      "lorentzSledVms": { label: "v", unit: "m/s", digits: 2 },
      "lorentzCurrentA": { label: "I", unit: "A", digits: 2 },
      "lorentzFieldT": { label: "B", unit: "T", digits: 3 },
      "lorentzForceN": { label: "F", unit: "N", digits: 3 },
      "lorentzPositionM": { label: "x", unit: "m", digits: 3 },
    } as Record<string, TelemetryFieldMeta>,
    fidelity: "WASM R–L + back-EMF + Lorentz force ODE (?wasmPhysics=1); JS fallback mirrors it",
  },
] as const;

/** One catalog telemetry key bound to its device, CSV column and display schema. */
export interface DeviceTelemetryField extends TelemetryFieldMeta {
  deviceId: string;
  /** DeviceTelemetrySnap field name. */
  key: string;
  /** CSV / JSON export column name (snake_case of `key`). */
  column: string;
}

/**
 * Every catalog telemetry key that is a `DeviceTelemetrySnap` field, in catalog
 * order. `'seg'` is excluded: its keys live on SegOperatorTelemetry
 * (see MODE_MATRIX.md), and the SEG gauges read those directly.
 */
export const DEVICE_TELEMETRY_FIELDS: readonly DeviceTelemetryField[] = [
  { deviceId: 'heron', key: 'heronHead', column: 'heron_head', label: "Head", unit: "m", digits: 2 },
  { deviceId: 'heron', key: 'heronHeadMax', column: 'heron_head_max', label: "Head_max", unit: "m", digits: 2 },
  { deviceId: 'heron', key: 'heronVExit', column: 'heron_vexit', label: "v_exit", unit: "m/s", digits: 2 },
  { deviceId: 'heron', key: 'heronFlowRateLmin', column: 'heron_flow_rate_lmin', label: "Q", unit: "L/min", digits: 1 },
  { deviceId: 'heron', key: 'heronPressureKPa', column: 'heron_pressure_kpa', label: "p", unit: "kPa", digits: 1 },
  { deviceId: 'kelvin', key: 'kelvinV', column: 'kelvin_v', label: "V", unit: "V", digits: 0 },
  { deviceId: 'kelvin', key: 'kelvinVoltageN', column: 'kelvin_voltage_n', label: "V/V_break", unit: "%", digits: 0, scale: 100 },
  { deviceId: 'kelvin', key: 'kelvinVbreak', column: 'kelvin_vbreak', label: "V_break", unit: "V", digits: 0 },
  { deviceId: 'kelvin', key: 'kelvinE', column: 'kelvin_e', label: "E", unit: "V/m", digits: 3, format: 'si' },
  { deviceId: 'kelvin', key: 'kelvinSparkTimer', column: 'kelvin_spark_timer', label: "spark", unit: "s", digits: 3 },
  { deviceId: 'solar', key: 'batteryCharge', column: 'battery_charge', label: "SOC", unit: "%", digits: 0, scale: 100 },
  { deviceId: 'peltier', key: 'peltierHotK', column: 'peltier_hot_k', label: "T_h", unit: "K", digits: 1 },
  { deviceId: 'peltier', key: 'peltierColdK', column: 'peltier_cold_k', label: "T_c", unit: "K", digits: 1 },
  { deviceId: 'peltier', key: 'peltierDeltaT', column: 'peltier_delta_t', label: "ΔT", unit: "K", digits: 1 },
  { deviceId: 'peltier', key: 'peltierVoltage', column: 'peltier_voltage', label: "V", unit: "V", digits: 3 },
  { deviceId: 'peltier', key: 'peltierCurrent', column: 'peltier_current', label: "I", unit: "A", digits: 3 },
  { deviceId: 'peltier', key: 'peltierPowerW', column: 'peltier_power_w', label: "P", unit: "W", digits: 2 },
  { deviceId: 'peltier', key: 'peltierCOP', column: 'peltier_cop', label: "COP", unit: "", digits: 3 },
  { deviceId: 'mhd', key: 'mhdFlowU', column: 'mhd_flow_u', label: "U", unit: "m/s", digits: 2 },
  { deviceId: 'mhd', key: 'mhdBFieldT', column: 'mhd_bfield_t', label: "B", unit: "T", digits: 2 },
  { deviceId: 'mhd', key: 'mhdHartmann', column: 'mhd_hartmann', label: "Ha", unit: "", digits: 1 },
  { deviceId: 'mhd', key: 'mhdVoltage', column: 'mhd_voltage', label: "V", unit: "V", digits: 3 },
  { deviceId: 'mhd', key: 'mhdCurrent', column: 'mhd_current', label: "I", unit: "A", digits: 3 },
  { deviceId: 'mhd', key: 'mhdPowerW', column: 'mhd_power_w', label: "P", unit: "W", digits: 2 },
  { deviceId: 'maglev', key: 'maglevGapMm', column: 'maglev_gap_mm', label: "gap", unit: "mm", digits: 2 },
  { deviceId: 'maglev', key: 'maglevFieldT', column: 'maglev_field_t', label: "B", unit: "T", digits: 3 },
  { deviceId: 'maglev', key: 'maglevLiftN', column: 'maglev_lift_n', label: "F_z", unit: "N", digits: 2 },
  { deviceId: 'maglev', key: 'maglevRpm', column: 'maglev_rpm', label: "RPM", unit: "RPM", digits: 0 },
  { deviceId: 'pulse-coil', key: 'pulseCoilCurrentA', column: 'pulse_coil_current_a', label: "I", unit: "A", digits: 2 },
  { deviceId: 'pulse-coil', key: 'pulseCoilVCap', column: 'pulse_coil_vcap', label: "V_cap", unit: "V", digits: 1 },
  { deviceId: 'pulse-coil', key: 'pulseCoilBPeakT', column: 'pulse_coil_bpeak_t', label: "B_pk", unit: "T", digits: 3 },
  { deviceId: 'pulse-coil', key: 'pulseCoilArmatureMm', column: 'pulse_coil_armature_mm', label: "x", unit: "mm", digits: 2 },
  { deviceId: 'homopolar', key: 'homopolarRpm', column: 'homopolar_rpm', label: "RPM", unit: "RPM", digits: 0 },
  { deviceId: 'homopolar', key: 'homopolarEmfV', column: 'homopolar_emf_v', label: "EMF", unit: "V", digits: 3, format: 'si' },
  { deviceId: 'homopolar', key: 'homopolarCurrentA', column: 'homopolar_current_a', label: "I", unit: "A", digits: 3 },
  { deviceId: 'homopolar', key: 'homopolarFieldT', column: 'homopolar_field_t', label: "B", unit: "T", digits: 3 },
  { deviceId: 'halbach-viz', key: 'halbachSegmentCount', column: 'halbach_segment_count', label: "N", unit: "", digits: 0 },
  { deviceId: 'halbach-viz', key: 'halbachMagAngleDeg', column: 'halbach_mag_angle_deg', label: "θ", unit: "°", digits: 1 },
  { deviceId: 'halbach-viz', key: 'halbachPeakBT', column: 'halbach_peak_bt', label: "|B|", unit: "T", digits: 4 },
  { deviceId: 'halbach-viz', key: 'halbachPeriodM', column: 'halbach_period_m', label: "λ", unit: "m", digits: 3, format: 'si' },
  { deviceId: 'halbach-viz', key: 'halbachDipoleForceN', column: 'halbach_dipole_force_n', label: "F", unit: "N", digits: 3, format: 'si' },
  { deviceId: 'transformer', key: 'transformerVp', column: 'transformer_vp', label: "V_p", unit: "V", digits: 2 },
  { deviceId: 'transformer', key: 'transformerVs', column: 'transformer_vs', label: "V_s", unit: "V", digits: 2 },
  { deviceId: 'transformer', key: 'transformerIpA', column: 'transformer_ip_a', label: "I_p", unit: "A", digits: 3 },
  { deviceId: 'transformer', key: 'transformerIsA', column: 'transformer_is_a', label: "I_s", unit: "A", digits: 3 },
  { deviceId: 'transformer', key: 'transformerK', column: 'transformer_k', label: "k", unit: "", digits: 3 },
  { deviceId: 'transformer', key: 'transformerFluxN', column: 'transformer_flux_n', label: "Φ", unit: "Wb", digits: 3, format: 'si' },
  { deviceId: 'vdg', key: 'vdgVoltage', column: 'vdg_voltage', label: "V", unit: "V", digits: 0 },
  { deviceId: 'vdg', key: 'vdgBeltMps', column: 'vdg_belt_mps', label: "belt", unit: "m/s", digits: 2 },
  { deviceId: 'vdg', key: 'vdgChargeC', column: 'vdg_charge_c', label: "Q", unit: "C", digits: 2, format: 'si' },
  { deviceId: 'vdg', key: 'vdgSparkHz', column: 'vdg_spark_hz', label: "spark", unit: "Hz", digits: 2 },
  { deviceId: 'hall', key: 'hallVoltage', column: 'hall_voltage', label: "V_H", unit: "V", digits: 2, format: 'si' },
  { deviceId: 'hall', key: 'hallCurrent', column: 'hall_current', label: "I", unit: "A", digits: 3 },
  { deviceId: 'hall', key: 'hallFieldT', column: 'hall_field_t', label: "B", unit: "T", digits: 3 },
  { deviceId: 'hall', key: 'hallCoeff', column: 'hall_coeff', label: "R_H", unit: "m³/C", digits: 3, format: 'exp' },
  { deviceId: 'lorentz-sled', key: 'lorentzSledVms', column: 'lorentz_sled_vms', label: "v", unit: "m/s", digits: 2 },
  { deviceId: 'lorentz-sled', key: 'lorentzCurrentA', column: 'lorentz_current_a', label: "I", unit: "A", digits: 2 },
  { deviceId: 'lorentz-sled', key: 'lorentzFieldT', column: 'lorentz_field_t', label: "B", unit: "T", digits: 3 },
  { deviceId: 'lorentz-sled', key: 'lorentzForceN', column: 'lorentz_force_n', label: "F", unit: "N", digits: 3 },
  { deviceId: 'lorentz-sled', key: 'lorentzPositionM', column: 'lorentz_position_m', label: "x", unit: "m", digits: 3 },
];

const FIELDS_BY_DEVICE: Record<string, DeviceTelemetryField[]> = {};
for (const f of DEVICE_TELEMETRY_FIELDS) {
  (FIELDS_BY_DEVICE[f.deviceId] ||= []).push(f);
}

export const TELEMETRY_FIELD_BY_COLUMN: Record<string, DeviceTelemetryField> =
  Object.fromEntries(DEVICE_TELEMETRY_FIELDS.map((f) => [f.column, f]));

/** CSV/JSON export columns for per-device telemetry, in catalog order. */
export const TELEMETRY_CSV_DEVICE_COLUMNS: readonly string[] =
  DEVICE_TELEMETRY_FIELDS.map((f) => f.column);

/** Snap-backed telemetry fields for one device id ([] for seg / unknown ids). */
export function telemetryFieldsForDevice(id: string): readonly DeviceTelemetryField[] {
  return FIELDS_BY_DEVICE[id] || [];
}

export const DEVICE_BY_ID: Record<string, DeviceCatalogEntry> = Object.fromEntries(
  DEVICE_CATALOG.map((d) => [d.id, d])
);

/** C++ SimMode index by device id. JS-only devices are omitted. */
export const WASM_MODE_BY_ID: Record<string, number> = {
  'seg': 0,
  'heron': 1,
  'kelvin': 2,
  'solar': 3,
  'peltier': 4,
  'mhd': 5,
  'maglev': 6,
  'homopolar': 7,
  'transformer': 8,
  'vdg': 9,
  'hall': 10,
  'lorentz-sled': 11,
};

export const WASM_DEVICE_IDS = ['seg', 'heron', 'kelvin', 'solar', 'peltier', 'mhd', 'maglev', 'homopolar', 'transformer', 'vdg', 'hall', 'lorentz-sled'] as const;

export const SIM_MODE_COUNT = 12;

export const RESERVED_WASM_MODES = [] as const;

export const NEXT_SHADER_MODE = 15;

/** Identity fields for DevicePlugin registration (modeIndex = shaderMode). */
export function catalogIdentity(id: string): {
  id: string;
  label: string;
  category: string;
  modeIndex: number;
  wasmMode?: number;
} {
  const d = DEVICE_BY_ID[id];
  if (!d) throw new Error('[device-catalog] unknown id: ' + id);
  return {
    id: d.id,
    label: d.label,
    category: d.category,
    modeIndex: d.shaderMode,
    ...(d.wasmMode != null ? { wasmMode: d.wasmMode } : {}),
  };
}

export function wasmModeForDevice(id: string): number | null {
  const d = DEVICE_BY_ID[id];
  return d ? d.wasmMode : null;
}

export function shaderModeForDevice(id: string): number | null {
  const d = DEVICE_BY_ID[id];
  return d ? d.shaderMode : null;
}
