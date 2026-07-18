/** SEG operator telemetry from segOperator.computeTelemetry(). */
export interface SegOperatorTelemetry {
  status: string;
  segOmega: number;
  corona: number;
  rpmInner: number;
  rpmDisplay: number;
  rpmPct: number;
  voltage: number;
  current: number;
  power: number;
  fieldSim: number;
  fieldClaimedRef: number;
  temperature: number;
  efficiency: number;
  totalEnergy: number;
  drive: number;
  excitationPct: number;
}

/** Per-device telemetry snapshot published each frame. */
export interface DeviceTelemetrySnap {
  id: string;
  energyLevel: number;
  segOmega: number;
  corona: number;
  heronHead: number;
  heronHeadMax: number;
  heronVExit: number;
  heronFlowRateLmin: number;
  heronPressureKPa: number;
  kelvinV: number;
  kelvinVoltageN: number;
  kelvinVbreak: number;
  kelvinSparkTimer: number;
  kelvinE: number;
  batteryCharge: number;
  maglevGapMm: number;
  maglevFieldT: number;
  maglevLiftN: number;
  maglevRpm: number;
  homopolarRpm: number;
  homopolarEmfV: number;
  homopolarCurrentA: number;
  homopolarFieldT: number;
}

/** Literature refs with uncertainty metadata for gauges */
export interface TelemetryMetaEntry {
  value: number;
  unit: string;
  uncertainty: number;
  isValidated: boolean;
  source: string;
}

export type TelemetryMeta = {
  B_surface: TelemetryMetaEntry;
  energyDensity_surface: TelemetryMetaEntry;
  torque_inner: TelemetryMetaEntry;
};

/** Derived scientific telemetry layer. */
export interface ScientificTelemetry {
  particleFlux: number;
  maxFieldMagnitude: number;
  avgEnergyDensity: number;
  innerRingTorque: number;
  middleRingTorque: number;
  outerRingTorque: number;
}

export interface TelemetrySnapshot {
  frameId: number;
  timeMs: number;
  dt: number;
  simTimeS: number;
  view: string;
  renderer: string | null;
  seg: SegOperatorTelemetry | null;
  devices: Record<string, DeviceTelemetrySnap>;
  scientific: ScientificTelemetry;
  meta: TelemetryMeta;
}

export interface PublishFrameScientific {
  particleFlux?: number;
  maxFieldMagnitude?: number;
  avgEnergyDensity?: number;
  innerRingTorque?: number;
  middleRingTorque?: number;
  outerRingTorque?: number;
}

export type TelemetrySubscriber = (snap: TelemetrySnapshot) => void;
