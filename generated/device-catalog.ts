/**
 * AUTO-GENERATED from physics/devices.json — do not edit.
 * Regenerate: npm run codegen:catalog
 */

export interface DeviceCatalogEntry {
  id: string;
  label: string;
  category: string;
  shaderMode: number;
  wasmMode: number | null;
  telemetryKeys: readonly string[];
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
    fidelity: "WASM RK4 (full plant)",
  },
  {
    id: 'heron',
    label: "Heron's Fountain",
    category: 'core',
    shaderMode: 1,
    wasmMode: 1 as number | null,
    telemetryKeys: ['heronHead', 'heronVExit', 'heronFlowLmin', 'heronPressureKPa'] as const,
    fidelity: "WASM (Bernoulli/Swamee–Jain)",
  },
  {
    id: 'kelvin',
    label: "Kelvin's Thunderstorm",
    category: 'core',
    shaderMode: 2,
    wasmMode: 2 as number | null,
    telemetryKeys: ['kelvinVoltage', 'kelvinVoltageN', 'kelvinE', 'kelvinSparkTimer'] as const,
    fidelity: "WASM (capacitive + spark)",
  },
  {
    id: 'solar',
    label: "Solar / LED",
    category: 'core',
    shaderMode: 3,
    wasmMode: 3 as number | null,
    telemetryKeys: ['solarBattery'] as const,
    fidelity: "WASM (battery SOC)",
  },
  {
    id: 'peltier',
    label: "Peltier",
    category: 'core',
    shaderMode: 4,
    wasmMode: 4 as number | null,
    telemetryKeys: ['peltierHotK', 'peltierColdK', 'peltierDeltaT', 'peltierVoltage', 'peltierCurrent', 'peltierPowerW', 'peltierCOP'] as const,
    fidelity: "WASM (two-node Seebeck/Peltier stack)",
  },
  {
    id: 'mhd',
    label: "MHD Channel",
    category: 'core',
    shaderMode: 5,
    wasmMode: 5 as number | null,
    telemetryKeys: ['mhdFlowU', 'mhdBFieldT', 'mhdHartmann', 'mhdVoltage', 'mhdCurrent', 'mhdPowerW'] as const,
    fidelity: "WASM (Hartmann channel)",
  },
  {
    id: 'maglev',
    label: "Magnetic Levitation",
    category: 'quanta',
    shaderMode: 6,
    wasmMode: 6 as number | null,
    telemetryKeys: ['maglevGapMm', 'maglevFieldT', 'maglevLiftN', 'maglevRpm'] as const,
    fidelity: "WASM (spring–damper gap ODE), JS fallback mirrors it",
  },
  {
    id: 'pulse-coil',
    label: "Pulse Coil (R–L)",
    category: 'quanta',
    shaderMode: 7,
    wasmMode: null as number | null,
    telemetryKeys: ['pulseCoilCurrentA', 'pulseCoilVCap', 'pulseCoilBPeakT', 'pulseCoilArmatureMm'] as const,
    fidelity: "JS-only (fallback-physics for pulseCoilBPeakT)",
  },
  {
    id: 'homopolar',
    label: "Homopolar Generator",
    category: 'quanta',
    shaderMode: 8,
    wasmMode: 7 as number | null,
    telemetryKeys: ['homopolarRpm', 'homopolarEmfV', 'homopolarCurrentA', 'homopolarFieldT'] as const,
    fidelity: "WASM (Faraday disc L–R + back-EMF)",
  },
  {
    id: 'halbach-viz',
    label: "Halbach Field Viz",
    category: 'quanta',
    shaderMode: 9,
    wasmMode: null as number | null,
    telemetryKeys: ['halbachSegmentCount', 'halbachMagAngleDeg', 'halbachPeakBT', 'halbachPeriodM', 'halbachDipoleForceN'] as const,
    fidelity: "JS-only (CPU field-line viz); estimateHalbachFieldT is a free WASM helper, not a plant",
  },
  {
    id: 'transformer',
    label: "Mutual Induction",
    category: 'quanta',
    shaderMode: 10,
    wasmMode: 8 as number | null,
    telemetryKeys: ['transformerVp', 'transformerVs', 'transformerIpA', 'transformerIsA', 'transformerK', 'transformerFluxN'] as const,
    fidelity: "WASM coupled-inductor ODE (?wasmPhysics=1); JS phasor fallback",
  },
] as const;

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
};

export const WASM_DEVICE_IDS = ['seg', 'heron', 'kelvin', 'solar', 'peltier', 'mhd', 'maglev', 'homopolar', 'transformer'] as const;

export const SIM_MODE_COUNT = 9;

export const RESERVED_WASM_MODES = [9, 10] as const;

export const NEXT_SHADER_MODE = 11;

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
