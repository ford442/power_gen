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
  halbachSegmentCount: number;
  halbachMagAngleDeg: number;
  halbachPeakBT: number;
  halbachPeriodM: number;
  halbachDipoleForceN: number;
  pulseCoilCurrentA: number;
  pulseCoilVCap: number;
  pulseCoilBPeakT: number;
  pulseCoilArmatureMm: number;
  peltierHotK: number;
  peltierColdK: number;
  peltierDeltaT: number;
  peltierVoltage: number;
  peltierCurrent: number;
  peltierPowerW: number;
  peltierCOP: number;
  mhdFlowU: number;
  mhdBFieldT: number;
  mhdHartmann: number;
  mhdVoltage: number;
  mhdCurrent: number;
  mhdPowerW: number;
  transformerVp: number;
  transformerVs: number;
  transformerIpA: number;
  transformerIsA: number;
  transformerK: number;
  transformerFluxN: number;
  vdgVoltage: number;
  vdgBeltMps: number;
  vdgChargeC: number;
  vdgSparkHz: number;
  hallVoltage: number;
  hallCurrent: number;
  hallFieldT: number;
  hallCoeff: number;
  lorentzSledVms: number;
  lorentzCurrentA: number;
  lorentzFieldT: number;
  lorentzForceN: number;
  lorentzPositionM: number;
  ringHeightM: number;
  ringCurrentA: number;
  ringPrimaryIA: number;
  ringForceN: number;
  ringCouplingK: number;
  /** Lab bus accounting (EnergyNetwork, W) — simulated, not metrology. */
  powerInW: number;
  powerOutW: number;
  efficiency: number;
}

/** Shared lab power bus snapshot (ADR-0004 phase A). */
export interface EnergyNetworkTelemetry {
  couplingEnabled: boolean;
  labBudgetW: number;
  totalAllocatedW: number;
  residualW: number;
}

/**
 * Shared lab **field** bus snapshot (ADR-0011). One entry per coupling edge,
 * keyed `from->to`. Every value is a simulated estimate propagated between
 * plants — not Maxwell, not metrology.
 */
export interface FieldCouplingLinkTelemetry {
  from: string;
  to: string;
  label: string;
  /** Raw source estimate (T) before the destination clamp. */
  sourceT: number;
  /** B in effect on the destination plant (T). */
  appliedT: number;
  clamped: boolean;
  active: boolean;
}

export interface FieldNetworkTelemetry {
  couplingEnabled: boolean;
  links: Record<string, FieldCouplingLinkTelemetry>;
}

/** Sim vs hardware residual in shadow twin mode (ADR-0005). */
export interface HardwareShadowResidual {
  phaseErrorDeg: number;
  rpmError: number;
  /** Plant V − sensor V (mock lag on mock transport; 0 on serial until firmware adds sensors). */
  voltageError: number;
  /** Plant I − sensor I */
  currentError: number;
}

/** Optional hardware digital twin snapshot on the hub. */
export interface HardwareTwinTelemetry {
  connected: boolean;
  mock: boolean;
  /** disconnected | mock | serial — explicit connection state machine */
  connectionState: 'disconnected' | 'mock' | 'serial';
  twinMode: 'open' | 'closed' | 'shadow';
  sensorRpm: number;
  sensorPhase: number;
  sensorVoltage: number;
  sensorCurrent: number;
  /** Present when connected; primary e2e assertion field. */
  shadowResidual: HardwareShadowResidual;
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
  labEnergySum?: number;
  labEnergyRms?: number;
  choresBackend?: string;
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
  energyNetwork: EnergyNetworkTelemetry | null;
  fieldNetwork: FieldNetworkTelemetry | null;
  /** Null when twin disconnected / unused. */
  hardwareTwin: HardwareTwinTelemetry | null;
  meta: TelemetryMeta;
  /** Present only while the replay player owns the hub (never mixed into live recording). */
  replay?: {
    active: true;
    t: number;
    duration: number;
    filename: string;
  } | null;
}

export interface PublishFrameScientific {
  particleFlux?: number;
  maxFieldMagnitude?: number;
  avgEnergyDensity?: number;
  innerRingTorque?: number;
  middleRingTorque?: number;
  outerRingTorque?: number;
  labEnergySum?: number;
  labEnergyRms?: number;
  choresBackend?: string;
}

export interface PublishFrameEnergyNetwork {
  couplingEnabled: boolean;
  labBudgetW: number;
  totalAllocatedW: number;
  residualW: number;
  devices?: Record<string, { powerInW: number; powerOutW: number; efficiency: number }>;
}

export type PublishFrameFieldNetwork = FieldNetworkTelemetry;

export type PublishFrameHardwareTwin = HardwareTwinTelemetry;

export type TelemetrySubscriber = (snap: TelemetrySnapshot) => void;
