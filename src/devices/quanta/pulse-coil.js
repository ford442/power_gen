/**
 * Pulsed electromagnet / pulse-coil — Quanta Magnetics classroom demo.
 *
 * Sandboxed series R–L circuit with a capacitor-bank discharge metaphor and a
 * peak B estimate from coil amp-turns. Armature travel is an educational
 * attraction proxy — not a weapons or projectile model.
 *
 * References: textbook series R–L / RLC discharge (standard undergrad EM).
 */

import { packInstance } from '../../device-mesh-layouts.js';
import { writeMeshCylinders } from '../update-helpers';
import { ValidatedConstants } from '../../ValidatedConstants';

const MU0 = ValidatedConstants.MU_0?.value ?? 1.2566370614e-7;

/** Educational lab-scale coil parameters (classroom-safe energies). */
export const PULSE_COIL = Object.freeze({
  R_ohm: 0.18,
  L_H: 0.0012,
  C_F: 0.0022,
  turns: 48,
  coilRadiusM: 0.045,
  armatureMassKg: 0.085,
  armatureTravelMaxM: 0.12,
  vChargeMax: 48, // low-voltage lab bank metaphor
  kAttract: 0.035, // I² attraction proxy (N / A²)
  cDamp: 1.4
});

function yawQuat(angleRad) {
  const half = angleRad * 0.5;
  return [0, Math.sin(half), 0, Math.cos(half)];
}

function buildBaseInstances() {
  const steel = [0.4, 0.42, 0.46];
  return [
    packInstance([0, -0.55, 0], 1, [0, 0, 0, 1], steel, 0.04),
    packInstance([0, -0.28, 0], 1, [0, 0, 0, 1], [0.32, 0.34, 0.38], 0.03)
  ];
}

/** Multi-turn coil stack (visual only — physics uses lumped L, R, N). */
function buildCoilInstances(currentA = 0) {
  const copper = [0.82, 0.52, 0.2];
  const glow = Math.min(0.55, 0.08 + Math.abs(currentA) * 0.012);
  const out = [];
  const layers = 5;
  for (let i = 0; i < layers; i++) {
    const y = 0.05 + i * 0.07;
    out.push(packInstance([0, y, 0], 14, [0, 0, 0, 1], copper, glow));
  }
  // Vertical posts
  out.push(packInstance([0.55, 0.2, 0], 15, [0, 0, 0, 1], [0.5, 0.52, 0.56], 0.06));
  out.push(packInstance([-0.55, 0.2, 0], 15, [0, 0, 0, 1], [0.5, 0.52, 0.56], 0.06));
  return out;
}

/** Capacitor bank visual (two cans). */
function buildCapBankInstances(vNorm = 0) {
  const blue = [0.2, 0.45, 0.85];
  const emissive = 0.05 + vNorm * 0.35;
  return [
    packInstance([0.95, 0.15, 0.35], 17, [0, 0, 0, 1], blue, emissive),
    packInstance([0.95, 0.15, -0.35], 17, [0, 0, 0, 1], blue, emissive)
  ];
}

/**
 * Soft-iron armature slug on the coil axis; travelM is distance from rest
 * toward the coil (0 = far, max = near bore).
 */
function buildArmatureInstances(travelM = 0) {
  const iron = [0.55, 0.58, 0.62];
  const max = PULSE_COIL.armatureTravelMaxM;
  const frac = Math.max(0, Math.min(1, travelM / max));
  const y = 0.95 - frac * 0.55;
  return [
    packInstance([0, y, 0], 15, [0, 0, 0, 1], iron, 0.12 + frac * 0.2),
    packInstance([0, y + 0.18, 0], 16, yawQuat(0), [0.7, 0.72, 0.75], 0.08)
  ];
}

export function buildPulseCoilMesh(travelM = 0, currentA = 0, vCap = 0) {
  const vNorm = Math.min(1, Math.abs(vCap) / PULSE_COIL.vChargeMax);
  return {
    cylinders: () => [
      ...buildBaseInstances(),
      ...buildCoilInstances(currentA),
      ...buildCapBankInstances(vNorm),
      ...buildArmatureInstances(travelM)
    ]
  };
}

/**
 * Peak on-axis B estimate for a short coil (amp-turns / length metaphor).
 * B ≈ μ₀ N I / (2 R) — order-of-magnitude classroom formula.
 */
export function estimatePulseCoilPeakBT(currentA, turns = PULSE_COIL.turns, radiusM = PULSE_COIL.coilRadiusM) {
  const I = Math.abs(currentA);
  const B = (MU0 * turns * I) / (2 * Math.max(radiusM, 0.01));
  return Math.min(2.5, B);
}

/**
 * Series R–L with capacitor discharge (underdamped / overdamped handled by Euler).
 * Drive 0..1 sets charge target; when charged, discharge through the coil.
 *
 * @param {object} state
 * @param {number} dt
 * @param {number} drive 0..1 from speed slider
 */
export function stepPulseCoilPhysics(state, dt, drive) {
  const { R_ohm: R, L_H: L, C_F: C, vChargeMax, armatureMassKg: m,
    armatureTravelMaxM: xMax, kAttract, cDamp } = PULSE_COIL;

  let vCap = state.pulseCoilVCap ?? 0;
  let current = state.pulseCoilCurrent ?? 0;
  let x = state.pulseCoilArmatureM ?? 0;
  let vArm = state.pulseCoilArmatureVel ?? 0;
  let pulseT = state.pulseCoilPulseT ?? 0;
  let firing = state.pulseCoilFiring ?? false;

  const vTarget = drive * vChargeMax;

  // Charge bank while idle; auto-fire when near target and drive is on.
  if (!firing) {
    const chargeTau = 0.35;
    vCap += (vTarget - vCap) * Math.min(1, dt / chargeTau);
    current *= Math.max(0, 1 - 8 * dt); // bleed residual
    if (drive > 0.08 && vCap > 0.85 * vTarget && vTarget > 4) {
      firing = true;
      pulseT = 0;
    }
  } else {
    // Capacitor discharges into series R–L: L di/dt = V_c − R i; C dV/dt = −i
    const dI = ((vCap - R * current) / L) * dt;
    current += dI;
    vCap += (-current / C) * dt;
    pulseT += dt;
    // End pulse when bank is depleted or ring-down finishes
    if (pulseT > 0.55 || (Math.abs(vCap) < 0.8 && Math.abs(current) < 0.4)) {
      firing = false;
      current *= 0.5;
    }
  }

  // Armature attraction proxy ∝ I² (classroom metaphor for soft-iron pull-in)
  const F = kAttract * current * current;
  const spring = 22 * x; // restoring spring toward rest (x=0 far)
  const accel = (F - spring - cDamp * vArm) / m;
  vArm += accel * dt;
  x = Math.max(0, Math.min(xMax, x + vArm * dt));
  if (x <= 0 && vArm < 0) vArm = 0;
  if (x >= xMax && vArm > 0) vArm = 0;

  const bPeak = estimatePulseCoilPeakBT(current);
  // Latch peak |I| / B so short discharge spikes remain readable in telemetry
  const peakI = Math.max(Math.abs(current), (state.pulseCoilPeakIA ?? 0) * Math.exp(-1.2 * dt));
  const peakBHold = Math.max(bPeak, (state.pulseCoilBPeakT ?? 0) * Math.exp(-1.2 * dt));

  state.pulseCoilVCap = vCap;
  state.pulseCoilCurrent = current;
  state.pulseCoilCurrentA = Math.abs(current) > 1 ? current : (peakI > 0.5 ? peakI : current);
  state.pulseCoilPeakIA = peakI;
  state.pulseCoilBPeakT = peakBHold;
  state.pulseCoilArmatureM = x;
  state.pulseCoilArmatureMm = x * 1000;
  state.pulseCoilArmatureVel = vArm;
  state.pulseCoilPulseT = pulseT;
  state.pulseCoilFiring = firing;
  // Oscilloscope-style discharge trace (last ~128 samples of I and Vcap)
  const histN = 128;
  if (!state.pulseCoilHistI || state.pulseCoilHistI.length !== histN) {
    state.pulseCoilHistI = new Float32Array(histN);
    state.pulseCoilHistV = new Float32Array(histN);
    state.pulseCoilHistIdx = 0;
  }
  const hi = state.pulseCoilHistIdx | 0;
  state.pulseCoilHistI[hi] = current;
  state.pulseCoilHistV[hi] = vCap;
  state.pulseCoilHistIdx = (hi + 1) % histN;
  state.energyLevel = Math.min(1,
    drive * 0.25
    + Math.min(1, peakI / 80) * 0.45
    + Math.min(1, Math.abs(vCap) / vChargeMax) * 0.3);
}

export function createPulseCoilPhysicsState() {
  return {
    pulseCoilVCap: 0,
    pulseCoilCurrent: 0,
    pulseCoilCurrentA: 0,
    pulseCoilBPeakT: 0,
    pulseCoilArmatureM: 0,
    pulseCoilArmatureMm: 0,
    pulseCoilArmatureVel: 0,
    pulseCoilPulseT: 0,
    pulseCoilFiring: false
  };
}

/** Draw a simple I/V discharge sparkline into a 2D canvas context (classroom). */
export function drawPulseCoilOscilloscope(ctx, state, width = 200, height = 48) {
  if (!ctx || !state?.pulseCoilHistI) return;
  const histI = state.pulseCoilHistI;
  const histV = state.pulseCoilHistV;
  const n = histI.length;
  const start = state.pulseCoilHistIdx | 0;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#0a1520';
  ctx.fillRect(0, 0, width, height);
  const draw = (arr, color, scale) => {
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.25;
    for (let i = 0; i < n; i++) {
      const v = arr[(start + i) % n] / scale;
      const x = (i / (n - 1)) * width;
      const y = height * 0.5 - v * height * 0.42;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  };
  draw(histV, '#4af', PULSE_COIL.vChargeMax);
  draw(histI, '#f84', 80);
}

export const PULSE_COIL_REFERENCES = [
  {
    title: 'Introduction to Electrodynamics (series R–L circuits)',
    authors: 'D. J. Griffiths',
    year: 2017,
    note: 'Textbook treatment of inductive transients and energy in magnetic fields'
  },
  {
    title: 'Electricity and Magnetism (Berkeley Physics Course, Vol. 2)',
    authors: 'E. M. Purcell, D. J. Morin',
    year: 2013,
    note: 'RLC discharge and amp-turn estimates for short coils'
  },
  {
    title: 'Electromagnetic Devices (solenoid force fundamentals)',
    authors: 'H. C. Roters',
    year: 1941,
    note: 'Classic engineering reference for soft-iron armature attraction proxies'
  }
];

function pulseCoilUpdateMesh(instance) {
  const travel = instance.physicsState?.pulseCoilArmatureM ?? 0;
  const iA = instance.physicsState?.pulseCoilCurrentA ?? 0;
  const vCap = instance.physicsState?.pulseCoilVCap ?? 0;
  writeMeshCylinders(instance, buildPulseCoilMesh(travel, iA, vCap));
}

function pulseCoilComputeRawEnergy(instance, ctx) {
  const iN = Math.min(1, Math.abs(instance.physicsState?.pulseCoilCurrentA ?? 0) / 80);
  return Math.min(1.0, (instance.physicsState?.energyLevel ?? iN) * 0.75 + ctx.speedNorm * 0.25);
}

function pulseCoilUpdateEffects(instance, ctx) {
  const { budget, energy, gate, pushParticle, time } = ctx;
  const pulseGate = Math.pow(gate(energy, 0.12, 0.7), 1.15);
  const burstCount = Math.floor(budget * 0.4 * pulseGate);
  const travel = instance.physicsState?.pulseCoilArmatureM ?? 0;
  for (let i = 0; i < burstCount; i++) {
    const a = (i / Math.max(1, burstCount)) * Math.PI * 2 + time * 2.4;
    const r = 0.35 + Math.random() * 1.1;
    const y = 0.2 + travel * 0.5 + Math.sin(time * 6 + i * 0.27) * 0.1;
    pushParticle(Math.cos(a) * r, y, Math.sin(a) * r, 3.0 + Math.random());
  }
  return true;
}

export const pulseCoilPlugin = {
  id: 'pulse-coil',
  label: 'Pulse Coil (R–L)',
  category: 'quanta',
  modeIndex: 7,
  needsPhysicsState: true,
  defaults: {
    particleCount: 11000,
    color: [1.0, 0.55, 0.22],
    cameraOffset: [0, 3.0, 10]
  },
  references: PULSE_COIL_REFERENCES,
  telemetrySchema: {
    pulseCoilCurrentA: { label: 'Coil current', unit: 'A', source: 'sim' },
    pulseCoilVCap: { label: 'Cap voltage', unit: 'V', source: 'sim' },
    pulseCoilBPeakT: { label: 'B peak (est.)', unit: 'T', source: 'fallback-physics' },
    pulseCoilArmatureMm: { label: 'Armature travel', unit: 'mm', source: 'sim' }
  },
  meshLayout: {
    cylinders: () => buildPulseCoilMesh(0, 0, 0).cylinders()
  },
  createPhysicsState: createPulseCoilPhysicsState,
  stepPhysics: stepPulseCoilPhysics,
  updateMesh: pulseCoilUpdateMesh,
  computeRawEnergy: pulseCoilComputeRawEnergy,
  updateEffects: pulseCoilUpdateEffects,
  wantsThermalHaze: true
};
