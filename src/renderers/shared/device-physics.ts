/**
 * Per-device CPU physics state shared between renderers.
 * Mirrors per-device physics state from device-instance energy proxies.
 */

import { ValidatedConstants } from '../../ValidatedConstants';
import { extendPhysicsState, getDeviceModeIndex, stepPluginPhysics } from '../../devices/device-registry.js';
import {
  computeHeronHydraulics,
  getHeronLayout,
  HERON_LAYOUT_PRESETS
} from '../../heron-layout.js';

/** Heron layout fields used by the hydraulic step. */
export interface HeronLayout {
  id: string;
  headMaxM: number;
  pumpRate?: number;
  drainCoeff?: number;
  dischargeCoeff?: number;
  pipeLengthM: number;
  pipeDiameterM: number;
  roughness?: number;
  nozzleDiameterM?: number;
}

/** Core plant state shared by built-in devices. */
export interface BaseDevicePhysicsState {
  deviceId: string;
  segOmega: number;
  corona: number;
  heronHead: number;
  heronVExit: number;
  heronHeadMax: number;
  heronLayoutId: string;
  heronFlowRateLmin: number;
  heronPressureKPa: number;
  heronReynolds: number;
  kelvinV: number;
  kelvinSparkTimer: number;
  kelvinSparkDur: number;
  kelvinVbreak: number;
  kelvinE: number;
  kelvinVoltageN: number;
  batteryCharge: number;
  rollerHeft: number;
  solarN2: number;
  energyLevel: number;
  magneticFieldStrength: number;
}

/** Quanta maglev plugin extension fields. */
export interface MaglevPhysicsExtension {
  maglevGap?: number;
  maglevGapVel?: number;
  maglevGapMm?: number;
  maglevFieldT?: number;
  maglevLiftN?: number;
  maglevRpm?: number;
}

/** Quanta homopolar plugin extension fields. */
export interface HomopolarPhysicsExtension {
  homopolarRpm?: number;
  homopolarEmfV?: number;
  homopolarCurrentA?: number;
  homopolarFieldT?: number;
  homopolarAngle?: number;
}

/** Full per-device physics plant state (built-in + plugin extensions). */
export type DevicePhysicsState = BaseDevicePhysicsState &
  Partial<MaglevPhysicsExtension> &
  Partial<HomopolarPhysicsExtension>;

export interface CreateDevicePhysicsOpts {
  heronLayout?: HeronLayout;
  heronLayoutId?: string;
}

export interface StepDevicePhysicsOpts {
  heronLayout?: HeronLayout;
}

export function createDevicePhysicsState(
  deviceId: string,
  opts: CreateDevicePhysicsOpts = {}
): DevicePhysicsState {
  const roller = ValidatedConstants.computeRollerInertia();
  const rhoCu = 8960;
  const R = ValidatedConstants.SEG_CONFIG.rollerRadius;
  const h = ValidatedConstants.SEG_CONFIG.rollerHeight;
  const inertiaSolidCu = 0.5 * Math.PI * rhoCu * h * R * R * R * R;
  const gap = 0.02;

  const heronLayout = deviceId === 'heron'
    ? (opts.heronLayout || getHeronLayout(opts.heronLayoutId || HERON_LAYOUT_PRESETS.classic))
    : null;

  const base: BaseDevicePhysicsState = {
    deviceId,
    segOmega: 0,
    corona: 0,
    heronHead: 0,
    heronVExit: 0,
    heronHeadMax: heronLayout?.headMaxM ?? 4.5,
    heronLayoutId: heronLayout?.id ?? HERON_LAYOUT_PRESETS.classic,
    heronFlowRateLmin: 0,
    heronPressureKPa: 0,
    heronReynolds: 0,
    kelvinV: 0,
    kelvinSparkTimer: 0,
    kelvinSparkDur: 0.18,
    kelvinVbreak: ValidatedConstants.KELVIN_CONSTANTS.E_BREAKDOWN.value * gap,
    kelvinE: 0,
    kelvinVoltageN: 0,
    batteryCharge: deviceId === 'solar' ? 0.5 : 0.5,
    rollerHeft: roller.inertia / inertiaSolidCu,
    solarN2: ValidatedConstants.SILICON_REFRACTIVE_INDEX,
    energyLevel: 0,
    magneticFieldStrength: 0.5
  };
  return extendPhysicsState(deviceId, base) as DevicePhysicsState;
}

export function stepDevicePhysics(
  state: DevicePhysicsState,
  dt: number,
  drive: number,
  opts: StepDevicePhysicsOpts = {}
): void {
  if (stepPluginPhysics(state, dt, drive, opts)) return;

  const field = 0.4 + 0.6 * state.magneticFieldStrength;

  if (state.deviceId === 'seg') {
    const tauDrive = drive * field;
    const w = state.segOmega;
    const wArm = 2.5;
    const eddyK = 1.33;
    const visc = 0.05;
    const tScale = 2.5;
    const tauEddy = eddyK * w / (1 + w / wArm) + visc * w;
    state.segOmega = Math.max(0, w + (tauDrive - tauEddy) / (state.rollerHeft * tScale) * dt);
    state.corona = Math.max(0, Math.min(1, (state.segOmega - 0.6) / 0.4)) * field;
    state.energyLevel = state.segOmega;
  } else if (state.deviceId === 'heron') {
    const layout = opts.heronLayout || getHeronLayout(state.heronLayoutId);
    state.heronHeadMax = layout.headMaxM;
    state.heronLayoutId = layout.id;
    const pump = layout.pumpRate ?? 2.2;
    const drain = layout.drainCoeff ?? 0.30;
    state.heronHead = Math.max(0, Math.min(state.heronHeadMax,
      state.heronHead + (pump * drive - drain * state.heronVExit) * dt));
    const hydro = computeHeronHydraulics(state.heronHead, layout);
    state.heronVExit = hydro.vExit;
    state.heronFlowRateLmin = hydro.flowLmin;
    state.heronPressureKPa = hydro.pressureKPa;
    state.heronReynolds = hydro.Re;
    const vRef = Math.sqrt(2 * 9.81 * layout.headMaxM) * (layout.dischargeCoeff ?? 0.35);
    state.energyLevel = Math.min(1, state.heronVExit / Math.max(vRef, 0.5));
  } else if (state.deviceId === 'kelvin') {
    const chargeRate = 8000;
    const feedback = 2.0;
    const leak = 0.3;
    state.kelvinV += (drive * (chargeRate + feedback * state.kelvinV) - leak * state.kelvinV) * dt;
    state.kelvinV = Math.max(0, state.kelvinV);
    if (state.kelvinV >= state.kelvinVbreak && state.kelvinSparkTimer <= 0) {
      state.kelvinV *= 0.02;
      state.kelvinSparkTimer = state.kelvinSparkDur;
    }
    state.kelvinSparkTimer = Math.max(0, state.kelvinSparkTimer - dt);
    state.kelvinVoltageN = Math.max(0, Math.min(1, state.kelvinV / state.kelvinVbreak));
    state.kelvinE = 15.0 * state.kelvinVoltageN;
    state.energyLevel = state.kelvinVoltageN;
  } else if (state.deviceId === 'solar') {
    const ledPower = 0.3 + 0.7 * drive;
    const transmittance = 0.04;
    const gain = transmittance * ledPower * 0.45;
    const drainW = ledPower * 0.30;
    state.batteryCharge = Math.max(0, Math.min(1, state.batteryCharge + (gain - drainW) * dt));
    state.energyLevel = state.batteryCharge;
  } else {
    state.energyLevel = drive;
  }
}

/** Mode index matching WGSL particle/roller shaders. */
export function deviceModeIndex(deviceId: string): number {
  return getDeviceModeIndex(deviceId);
}

/**
 * Compute roller positions for SEG (36 rollers).
 * @returns [x0,z0, x1,z1, ...]
 */
export function computeRollerPositions(time: number, speedMult = 1): Float32Array {
  const positions = new Float32Array(36 * 2);
  const rings = [
    { count: 8, radius: 2.5, speed: 2.0, index: 0 },
    { count: 12, radius: 4.0, speed: 1.0, index: 1 },
    { count: 16, radius: 5.5, speed: 0.5, index: 2 }
  ];
  let offset = 0;
  for (const ring of rings) {
    const startupRamp = Math.min(time * (0.25 + ring.index * 0.1), 1.0);
    for (let i = 0; i < ring.count; i++) {
      const jitterNoise = Math.sin(offset * 127.3 + ring.index * 53.7);
      const speedJitter = 1.0 + 0.04 * Math.sin(time * 1.3 + jitterNoise * 12.7);
      const angle = (i / ring.count) * Math.PI * 2
        + time * 0.5 * ring.speed * speedJitter * startupRamp * speedMult
        + ring.index * 0.22;
      positions[offset * 2] = Math.cos(angle) * ring.radius;
      positions[offset * 2 + 1] = Math.sin(angle) * ring.radius;
      offset++;
    }
  }
  return positions;
}
