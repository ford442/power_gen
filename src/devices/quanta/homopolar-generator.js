/**
 * Homopolar / Faraday disc generator — Quanta Magnetics catalog entry.
 *
 * Simplified educational model: rotating copper disc in axial B-field;
 * back-EMF from ε ≈ ½ B ω r² drives an L–R brushed radial circuit.
 *
 * References:
 *   - M. Faraday — electromagnetic induction (1831)
 *   - J. A. Wheeler, R. P. Feynman — homopolar generator literature
 */

import { packInstance } from '../../device-mesh-layouts.js';
import { ValidatedConstants } from '../../ValidatedConstants';

const BR = ValidatedConstants.MAGNET_BR?.value ?? 1.48;
const DISC_RADIUS = 0.14;
const B_AXIAL = Math.min(0.55, BR * 0.28);
const R_COIL = 0.008;
const L_COIL = 0.0015;
const J_DISC = 0.002;
const B_DRAG = 0.0008;
const TAU_DRIVE_MAX = 0.15;

function yawQuat(angleRad) {
  const half = angleRad * 0.5;
  return [0, Math.sin(half), 0, Math.cos(half)];
}

function buildBaseInstances() {
  const steel = [0.42, 0.44, 0.48];
  return [
    packInstance([0, -0.55, 0], 1, [0, 0, 0, 1], steel, 0.04),
    packInstance([0, -0.35, 0], 1, [0, 0, 0, 1], [0.32, 0.34, 0.38], 0.02)
  ];
}

function buildMagnetPoleInstances() {
  const north = [0.18, 0.48, 0.92];
  const south = [0.88, 0.22, 0.18];
  return [
    packInstance([0, 0.42, 0], 17, [0, 0, 0, 1], north, 0.28),
    packInstance([0, -0.08, 0], 17, [0, 0, 0, 1], south, 0.22)
  ];
}

function buildBrushInstances() {
  const brush = [0.62, 0.64, 0.68];
  const rim = DISC_RADIUS * 3.2;
  return [
    packInstance([rim * 0.02, 0.18, 0], 18, [0, 0, 0, 1], brush, 0.08),
    packInstance([0, 0.18, 0], 18, [0, 0, 0, 1], brush, 0.06),
    packInstance([rim, 0.18, 0], 18, [0, 0, 0, 1], brush, 0.1)
  ];
}

/** Rotating copper disc + axle; angle in radians about Y. */
function buildDiscInstances(angleRad = 0) {
  const copper = [0.86, 0.56, 0.24];
  const axle = [0.55, 0.58, 0.62];
  const rot = yawQuat(angleRad);
  return [
    packInstance([0, 0.16, 0], 16, rot, copper, 0.14),
    packInstance([0, 0.16, 0], 15, rot, axle, 0.05)
  ];
}

export function buildHomopolarMesh(angleRad = 0) {
  return {
    cylinders: () => [
      ...buildBaseInstances(),
      ...buildMagnetPoleInstances(),
      ...buildBrushInstances(),
      ...buildDiscInstances(angleRad)
    ]
  };
}

/**
 * Faraday disc EMF (uniform axial B, solid disc): ε = ½ B ω r².
 * @param {number} omegaRadS
 * @param {number} [fieldT]
 * @param {number} [radiusM]
 */
export function estimateHomopolarEmfV(omegaRadS, fieldT = B_AXIAL, radiusM = DISC_RADIUS) {
  return 0.5 * fieldT * omegaRadS * radiusM * radiusM;
}

/**
 * @param {object} state
 * @param {number} dt
 * @param {number} drive 0..1 from speed slider
 */
export function stepHomopolarPhysics(state, dt, drive) {
  const B = state.homopolarFieldT ?? B_AXIAL;
  let omega = state.homopolarOmega ?? 0;
  let current = state.homopolarCurrent ?? 0;

  const omegaTarget = drive * 3600 * (Math.PI / 30);
  const tauDrive = TAU_DRIVE_MAX * drive * (0.6 + 0.4 * Math.tanh((omegaTarget - omega) * 2));

  const emf = estimateHomopolarEmfV(omega, B);
  const tauLoad = current * B * DISC_RADIUS * 0.5;

  const dI = (emf - R_COIL * current) / L_COIL * dt;
  current = Math.max(0, current + dI);

  const dOmega = (tauDrive - tauLoad - B_DRAG * omega) / J_DISC * dt;
  omega = Math.max(0, omega + dOmega);

  const rpm = omega * 30 / Math.PI;

  state.homopolarOmega = omega;
  state.homopolarAngle = (state.homopolarAngle ?? 0) + omega * dt;
  state.homopolarRpm = rpm;
  state.homopolarEmfV = emf;
  state.homopolarCurrentA = current;
  state.homopolarFieldT = B;
  state.energyLevel = Math.min(1, drive * 0.45 + (rpm / 3600) * 0.55);
}

export function createHomopolarPhysicsState() {
  return {
    homopolarOmega: 0,
    homopolarAngle: 0,
    homopolarRpm: 0,
    homopolarEmfV: 0,
    homopolarCurrentA: 0,
    homopolarFieldT: B_AXIAL,
    homopolarCurrent: 0
  };
}

export const HOMOPOLAR_REFERENCES = [
  {
    title: 'Experimental researches in electricity',
    authors: 'M. Faraday',
    year: 1831,
    note: 'First demonstration of electromagnetic induction — includes rotating disc experiments'
  },
  {
    title: 'The homopolar generator',
    authors: 'J. A. Wheeler, R. P. Feynman',
    year: 1967,
    note: 'Classic treatment of unipolar EMF and motional induction in a spinning conductor'
  },
  {
    title: 'Unipolar machines: steady-state and transient analysis',
    authors: 'H. D. Algie',
    year: 1989,
    note: 'Modern homopolar generator circuit models (L–R–back-EMF coupling)'
  }
];

export const homopolarGeneratorPlugin = {
  id: 'homopolar',
  label: 'Homopolar Generator',
  category: 'quanta',
  modeIndex: 8,
  defaults: {
    particleCount: 14000,
    color: [1.0, 0.72, 0.28],
    cameraOffset: [0, 3.2, 10]
  },
  references: HOMOPOLAR_REFERENCES,
  telemetrySchema: {
    homopolarRpm: { label: 'Disc RPM', unit: 'RPM', source: 'sim' },
    homopolarEmfV: { label: 'EMF (est.)', unit: 'V', source: 'fallback-physics' },
    homopolarCurrentA: { label: 'Disc current', unit: 'A', source: 'sim' },
    homopolarFieldT: { label: 'B-field (axial)', unit: 'T', source: 'sim' }
  },
  meshLayout: {
    cylinders: () => buildHomopolarMesh(0).cylinders()
  },
  createPhysicsState: createHomopolarPhysicsState,
  stepPhysics: stepHomopolarPhysics
};
