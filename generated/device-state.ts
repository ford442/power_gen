/**
 * AUTO-GENERATED from physics/devices.json — do not edit.
 * Regenerate: npm run codegen:catalog
 */

/**
 * Plant snapshot layout (#224 §2) — each device's `state` block in
 * physics/devices.json. Imported only by the lazy snapshot chunk
 * (src/session/plant-snapshot.ts); the entry chunk never loads it.
 */

export type DeviceStateFieldType = 'number' | 'bool' | 'enum' | 'nullable';

export interface DeviceStateField {
  /** DevicePhysicsState key (null: C++-only). */
  key: string | null;
  /** C++ path: a field of the mode's plant struct, or `@member` (null: TS-only). */
  cpp: string | null;
  type: DeviceStateFieldType;
  /** enum: the value for index 0, 1, … */
  values?: readonly string[];
  /** Floats this cpp path takes (arrays only). */
  count?: number;
  /** nullable: what the C++ plant stores for "none". */
  cppNull?: number;
  /** Index into the C++ float vector (-1 when there is no cpp path). */
  offset: number;
}

export interface DeviceStateLayout {
  wasmMode: number | null;
  /** C++ vector length — `SEGSimulator::plantStateSize(wasmMode)` (0 for JS-only). */
  cppSize: number;
  /** physicsState keys set to null after a load (derived geometry the next step rebuilds). */
  clearOnLoad?: readonly string[];
  fields: readonly DeviceStateField[];
}

/** C++ vector indices every mode saves first: [simulator time, drive setpoint]. */
export const PLANT_STATE_PREFIX = { time: 0, drive: 1, length: 2 } as const;

/** FNV-1a of every state block — `PLANT_STATE_LAYOUT_HASH` in generated/plant-state.h. */
export const PLANT_STATE_LAYOUT_HASH = 0x21801834;

/** First 12 hex of sha256(physics/devices.json) — which catalog wrote a snapshot. */
export const DEVICE_CATALOG_HASH = '81caf605beca';

export const DEVICE_STATE_LAYOUT: Readonly<Record<string, DeviceStateLayout>> = {
  'seg': {
    wasmMode: 0,
    cppSize: 137,
    fields: [
      { key: "segOmega", cpp: null, type: 'number', offset: -1 },
      { key: "corona", cpp: null, type: 'number', offset: -1 },
      { key: "energyLevel", cpp: null, type: 'number', offset: -1 },
      { key: "magneticFieldStrength", cpp: null, type: 'number', offset: -1 },
      { key: null, cpp: "@_rollers[].omega", type: 'number', count: 66, offset: 2 },
      { key: null, cpp: "@_rollers[].angle", type: 'number', count: 66, offset: 68 },
      { key: null, cpp: "@_ringLoadTorques[]", type: 'number', count: 3, offset: 134 }
    ]
  },
  'heron': {
    wasmMode: 1,
    cppSize: 8,
    fields: [
      { key: "heronHead", cpp: "head", type: 'number', offset: 2 },
      { key: "heronVExit", cpp: "vExit", type: 'number', offset: 3 },
      { key: "heronFlowRateLmin", cpp: "flowLmin", type: 'number', offset: 4 },
      { key: "heronPressureKPa", cpp: "pressureKPa", type: 'number', offset: 5 },
      { key: "heronReynolds", cpp: "reynolds", type: 'number', offset: 6 },
      { key: "heronHeadMax", cpp: null, type: 'number', offset: -1 },
      { key: "energyLevel", cpp: null, type: 'number', offset: -1 },
      { key: null, cpp: "drive", type: 'number', offset: 7 }
    ]
  },
  'kelvin': {
    wasmMode: 2,
    cppSize: 8,
    fields: [
      { key: "kelvinV", cpp: "voltage", type: 'number', offset: 2 },
      { key: "kelvinSparkTimer", cpp: "sparkTimer", type: 'number', offset: 3 },
      { key: "kelvinVoltageN", cpp: "voltageN", type: 'number', offset: 4 },
      { key: "kelvinE", cpp: "E", type: 'number', offset: 5 },
      { key: "kelvinSeedCoupledV", cpp: "seedV", type: 'nullable', cppNull: 0, offset: 6 },
      { key: "energyLevel", cpp: null, type: 'number', offset: -1 },
      { key: null, cpp: "drive", type: 'number', offset: 7 }
    ]
  },
  'solar': {
    wasmMode: 3,
    cppSize: 4,
    fields: [
      { key: "batteryCharge", cpp: "batteryCharge", type: 'number', offset: 2 },
      { key: "energyLevel", cpp: null, type: 'number', offset: -1 },
      { key: null, cpp: "ledPower", type: 'number', offset: 3 }
    ]
  },
  'peltier': {
    wasmMode: 4,
    cppSize: 10,
    fields: [
      { key: "peltierHotK", cpp: "hotK", type: 'number', offset: 2 },
      { key: "peltierColdK", cpp: "coldK", type: 'number', offset: 3 },
      { key: "peltierDeltaT", cpp: "deltaTK", type: 'number', offset: 4 },
      { key: "peltierVoltage", cpp: "voltageV", type: 'number', offset: 5 },
      { key: "peltierCurrent", cpp: "currentA", type: 'number', offset: 6 },
      { key: "peltierPowerW", cpp: "powerW", type: 'number', offset: 7 },
      { key: "peltierCOP", cpp: "cop", type: 'number', offset: 8 },
      { key: "energyLevel", cpp: null, type: 'number', offset: -1 },
      { key: null, cpp: "drive", type: 'number', offset: 9 }
    ]
  },
  'mhd': {
    wasmMode: 5,
    cppSize: 9,
    fields: [
      { key: "mhdFlowU", cpp: "flowU", type: 'number', offset: 2 },
      { key: "mhdBFieldT", cpp: "bFieldT", type: 'number', offset: 3 },
      { key: "mhdHartmann", cpp: "hartmann", type: 'number', offset: 4 },
      { key: "mhdVoltage", cpp: "voltageV", type: 'number', offset: 5 },
      { key: "mhdCurrent", cpp: "currentA", type: 'number', offset: 6 },
      { key: "mhdPowerW", cpp: "powerW", type: 'number', offset: 7 },
      { key: "energyLevel", cpp: null, type: 'number', offset: -1 },
      { key: null, cpp: "drive", type: 'number', offset: 8 }
    ]
  },
  'maglev': {
    wasmMode: 6,
    cppSize: 9,
    fields: [
      { key: "maglevGap", cpp: "gap", type: 'number', offset: 2 },
      { key: "maglevGapVel", cpp: "gapVel", type: 'number', offset: 3 },
      { key: "maglevGapMm", cpp: "gapMm", type: 'number', offset: 4 },
      { key: "maglevFieldT", cpp: "fieldT", type: 'number', offset: 5 },
      { key: "maglevLiftN", cpp: "liftN", type: 'number', offset: 6 },
      { key: "maglevRpm", cpp: "rpm", type: 'number', offset: 7 },
      { key: "energyLevel", cpp: null, type: 'number', offset: -1 },
      { key: null, cpp: "drive", type: 'number', offset: 8 }
    ]
  },
  'pulse-coil': {
    wasmMode: null,
    cppSize: 0,
    fields: [
      { key: "pulseCoilVCap", cpp: null, type: 'number', offset: -1 },
      { key: "pulseCoilChargeSetpointV", cpp: null, type: 'nullable', cppNull: -1, offset: -1 },
      { key: "pulseCoilCurrent", cpp: null, type: 'number', offset: -1 },
      { key: "pulseCoilCurrentA", cpp: null, type: 'number', offset: -1 },
      { key: "pulseCoilPeakIA", cpp: null, type: 'number', offset: -1 },
      { key: "pulseCoilBPeakT", cpp: null, type: 'number', offset: -1 },
      { key: "pulseCoilArmatureM", cpp: null, type: 'number', offset: -1 },
      { key: "pulseCoilArmatureMm", cpp: null, type: 'number', offset: -1 },
      { key: "pulseCoilArmatureVel", cpp: null, type: 'number', offset: -1 },
      { key: "pulseCoilPulseT", cpp: null, type: 'number', offset: -1 },
      { key: "pulseCoilFiring", cpp: null, type: 'bool', offset: -1 },
      { key: "energyLevel", cpp: null, type: 'number', offset: -1 }
    ]
  },
  'homopolar': {
    wasmMode: 7,
    cppSize: 9,
    fields: [
      { key: "homopolarOmega", cpp: "omega", type: 'number', offset: 2 },
      { key: "homopolarAngle", cpp: "angle", type: 'number', offset: 3 },
      { key: "homopolarRpm", cpp: "rpm", type: 'number', offset: 4 },
      { key: "homopolarEmfV", cpp: "emfV", type: 'number', offset: 5 },
      { key: "homopolarCurrentA", cpp: "currentA", type: 'number', offset: 6 },
      { key: "homopolarCurrent", cpp: null, type: 'number', offset: -1 },
      { key: "homopolarFieldT", cpp: "fieldT", type: 'number', offset: 7 },
      { key: "energyLevel", cpp: null, type: 'number', offset: -1 },
      { key: null, cpp: "drive", type: 'number', offset: 8 }
    ]
  },
  'halbach-viz': {
    wasmMode: null,
    cppSize: 0,
    clearOnLoad: ["halbachFieldLines"],
    fields: [
      { key: "halbachSegmentCount", cpp: null, type: 'number', offset: -1 },
      { key: "halbachSegmentSetpoint", cpp: null, type: 'nullable', cppNull: -1, offset: -1 },
      { key: "halbachMagAngleDeg", cpp: null, type: 'number', offset: -1 },
      { key: "halbachLayout", cpp: null, type: 'enum', values: ["ring","linear"], offset: -1 },
      { key: "halbachPeakBT", cpp: null, type: 'number', offset: -1 },
      { key: "halbachPeriodM", cpp: null, type: 'number', offset: -1 },
      { key: "halbachDipoleForceN", cpp: null, type: 'number', offset: -1 },
      { key: "energyLevel", cpp: null, type: 'number', offset: -1 }
    ]
  },
  'transformer': {
    wasmMode: 8,
    cppSize: 11,
    fields: [
      { key: "transformerPhase", cpp: "phase", type: 'number', offset: 2 },
      { key: "transformerLeakage", cpp: "leakage", type: 'bool', offset: 3 },
      { key: "transformerVp", cpp: "v1", type: 'number', offset: 4 },
      { key: "transformerVs", cpp: "v2", type: 'number', offset: 5 },
      { key: "transformerIpA", cpp: "i1", type: 'number', offset: 6 },
      { key: "transformerIsA", cpp: "i2", type: 'number', offset: 7 },
      { key: "transformerK", cpp: "k", type: 'number', offset: 8 },
      { key: "transformerFluxN", cpp: "fluxN", type: 'number', offset: 9 },
      { key: "energyLevel", cpp: null, type: 'number', offset: -1 },
      { key: null, cpp: "drive", type: 'number', offset: 10 }
    ]
  },
  'vdg': {
    wasmMode: 9,
    cppSize: 10,
    fields: [
      { key: "vdgChargeC", cpp: "chargeC", type: 'number', offset: 2 },
      { key: "vdgVoltage", cpp: "voltage", type: 'number', offset: 3 },
      { key: "vdgBeltMps", cpp: "beltMps", type: 'number', offset: 4 },
      { key: "vdgSparkTimer", cpp: "sparkTimer", type: 'number', offset: 5 },
      { key: "vdgSparkAccum", cpp: "sparkAccum", type: 'number', offset: 6 },
      { key: "vdgSparkWindowT", cpp: "sparkWindowT", type: 'number', offset: 7 },
      { key: "vdgSparkHz", cpp: "sparkHz", type: 'number', offset: 8 },
      { key: "energyLevel", cpp: null, type: 'number', offset: -1 },
      { key: null, cpp: "drive", type: 'number', offset: 9 }
    ]
  },
  'hall': {
    wasmMode: 10,
    cppSize: 9,
    fields: [
      { key: "hallCurrent", cpp: "current", type: 'number', offset: 2 },
      { key: "hallFieldT", cpp: "fieldT", type: 'number', offset: 3 },
      { key: "hallVoltage", cpp: "voltage", type: 'number', offset: 4 },
      { key: "hallCoeff", cpp: "coeff", type: 'number', offset: 5 },
      { key: "hallCarrierType", cpp: "carrierMetal", type: 'enum', values: ["semiconductor","metal"], offset: 6 },
      { key: "hallFieldCoupledT", cpp: "fieldCoupledT", type: 'nullable', cppNull: -1, offset: 7 },
      { key: "energyLevel", cpp: null, type: 'number', offset: -1 },
      { key: null, cpp: "drive", type: 'number', offset: 8 }
    ]
  },
  'lorentz-sled': {
    wasmMode: 11,
    cppSize: 8,
    fields: [
      { key: "lorentzSledVms", cpp: "velocityMps", type: 'number', offset: 2 },
      { key: "lorentzCurrentA", cpp: "currentA", type: 'number', offset: 3 },
      { key: "lorentzPositionM", cpp: "positionM", type: 'number', offset: 4 },
      { key: "lorentzForceN", cpp: "forceN", type: 'number', offset: 5 },
      { key: "lorentzFieldT", cpp: "fieldT", type: 'number', offset: 6 },
      { key: "lorentzFieldLocalT", cpp: null, type: 'number', offset: -1 },
      { key: "energyLevel", cpp: null, type: 'number', offset: -1 },
      { key: null, cpp: "drive", type: 'number', offset: 7 }
    ]
  },
  'jumping-ring': {
    wasmMode: 12,
    cppSize: 10,
    fields: [
      { key: "ringPrimaryIA", cpp: "primaryIA", type: 'number', offset: 2 },
      { key: "ringCurrentA", cpp: "ringCurrentA", type: 'number', offset: 3 },
      { key: "ringVelocityMps", cpp: "velocityMps", type: 'number', offset: 4 },
      { key: "ringHeightM", cpp: "heightM", type: 'number', offset: 5 },
      { key: "ringPhase", cpp: "phase", type: 'number', offset: 6 },
      { key: "ringForceN", cpp: "forceN", type: 'number', offset: 7 },
      { key: "ringCouplingK", cpp: "couplingK", type: 'number', offset: 8 },
      { key: "energyLevel", cpp: null, type: 'number', offset: -1 },
      { key: null, cpp: "drive", type: 'number', offset: 9 }
    ]
  },
  'drop-tube': {
    wasmMode: null,
    cppSize: 0,
    fields: [
      { key: "dropTubeDepthM", cpp: null, type: 'number', offset: -1 },
      { key: "dropTubeVMps", cpp: null, type: 'number', offset: -1 },
      { key: "dropTubeStage", cpp: null, type: 'number', offset: -1 },
      { key: "dropTubeTimerS", cpp: null, type: 'number', offset: -1 },
      { key: "dropTubeClampDepthM", cpp: null, type: 'number', offset: -1 },
      { key: "dropTubeSigmaMSm", cpp: null, type: 'number', offset: -1 },
      { key: "dropTubeSigmaSetpointMSm", cpp: null, type: 'nullable', cppNull: -1, offset: -1 },
      { key: "dropTubeInTube", cpp: null, type: 'number', offset: -1 },
      { key: "dropTubeTerminalVMps", cpp: null, type: 'number', offset: -1 },
      { key: "dropTubeDragN", cpp: null, type: 'number', offset: -1 },
      { key: "dropTubeEddyIA", cpp: null, type: 'number', offset: -1 },
      { key: "dropTubeEddyTrailIA", cpp: null, type: 'number', offset: -1 },
      { key: "energyLevel", cpp: null, type: 'number', offset: -1 }
    ]
  }
};
