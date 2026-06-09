/**
 * Per-device CPU physics state shared between renderers.
 * Mirrors stepPhysics() from main.js SEGVisualizer and device-instance energy proxies.
 */

import { ValidatedConstants } from '../../ValidatedConstants';

export function createDevicePhysicsState(deviceId) {
  const roller = ValidatedConstants.computeRollerInertia();
  const rhoCu = 8960;
  const R = ValidatedConstants.SEG_CONFIG.rollerRadius;
  const h = ValidatedConstants.SEG_CONFIG.rollerHeight;
  const inertiaSolidCu = 0.5 * Math.PI * rhoCu * h * R * R * R * R;
  const gap = 0.02;

  return {
    deviceId,
    segOmega: 0,
    corona: 0,
    heronHead: 0,
    heronVExit: 0,
    heronHeadMax: 4.5,
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
}

function heronExitVelocity(head) {
  const g = 9.81;
  const L = 4.0, D = 0.08, f = 0.02;
  const vIdeal = Math.sqrt(2 * g * Math.max(head, 0));
  const Re = vIdeal * D / 1e-6;
  const fSwamee = 0.25 / Math.pow(Math.log10(f / 3.7 + 5.74 / Math.pow(Math.max(Re, 1), 0.9)), 2);
  const headLoss = fSwamee * (L / D) * (vIdeal * vIdeal / (2 * g));
  return Math.sqrt(2 * g * Math.max(head - headLoss, 0)) * 0.35;
}

/**
 * @param {ReturnType<createDevicePhysicsState>} state
 * @param {number} dt
 * @param {number} drive 0..1 from speed slider
 */
export function stepDevicePhysics(state, dt, drive) {
  const field = 0.4 + 0.6 * state.magneticFieldStrength;

  if (state.deviceId === 'seg') {
    const tauDrive = drive * field;
    const w = state.segOmega;
    const wArm = 2.5, eddyK = 1.33, visc = 0.05, tScale = 2.5;
    const tauEddy = eddyK * w / (1 + w / wArm) + visc * w;
    state.segOmega = Math.max(0, w + (tauDrive - tauEddy) / (state.rollerHeft * tScale) * dt);
    state.corona = Math.max(0, Math.min(1, (state.segOmega - 0.6) / 0.4)) * field;
    state.energyLevel = state.segOmega;
  } else if (state.deviceId === 'heron') {
    const pump = 2.2, drain = 0.30;
    state.heronHead = Math.max(0, Math.min(state.heronHeadMax,
      state.heronHead + (pump * drive - drain * state.heronVExit) * dt));
    state.heronVExit = heronExitVelocity(state.heronHead);
    state.energyLevel = Math.min(1, state.heronVExit / 8);
  } else if (state.deviceId === 'kelvin') {
    const chargeRate = 8000, feedback = 2.0, leak = 0.3;
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

/** Mode index matching WGSL: 0=SEG 1=Heron 2=Kelvin 3=Solar 4=Peltier 5=MHD */
export function deviceModeIndex(deviceId) {
  const map = { seg: 0, heron: 1, kelvin: 2, solar: 3, peltier: 4, mhd: 5 };
  return map[deviceId] ?? 0;
}

/**
 * Compute roller positions for SEG (36 rollers).
 * @returns {Float32Array} [x0,z0, x1,z1, ...]
 */
export function computeRollerPositions(time, speedMult = 1) {
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
