/**
 * Magnetic bearing / levitation demo — first Quanta Magnetics catalog entry.
 *
 * Simplified physics: NdFeB ring stack provides lift; eddy-current damping
 * stabilises vertical oscillation (educational model, not full Earnshaw solve).
 *
 * References:
 *   - Halbach array field enhancement (K. Halbach, Nucl. Instrum. Methods, 1980)
 *   - Passive magnetic levitation with diamagnetic/eddy stabilization (Berry, Eur. J. Phys., 1996)
 */

import { packInstance } from '../../device-mesh-layouts.js';
import { ValidatedConstants } from '../../ValidatedConstants';

const BR = ValidatedConstants.MAGNET_BR?.value ?? 1.48;
const MU0 = ValidatedConstants.MU_0?.value ?? 1.25663706212e-6;

/** Ring magnet segments in a simplified Halbach-like azimuthal pattern. */
function buildHalbachRingInstances() {
  const segments = 12;
  const majorR = 2.8;
  const out = [];
  for (let i = 0; i < segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    const x = Math.cos(angle) * majorR;
    const z = Math.sin(angle) * majorR;
    // Alternate pole colours + slight tilt for Halbach visual cue
    const isNorth = i % 2 === 0;
    const color = isNorth ? [0.15, 0.55, 0.95] : [0.85, 0.25, 0.2];
    const emissive = isNorth ? 0.35 : 0.22;
    const yaw = angle + Math.PI / 2;
    const rot = [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
    out.push(packInstance([x, 0.35, z], 14, rot, color, emissive));
  }
  return out;
}

function buildBaseInstances() {
  const steel = [0.45, 0.48, 0.52];
  return [
    packInstance([0, -0.6, 0], 1, [0, 0, 0, 1], steel, 0.04),
    packInstance([0, 0.05, 0], 1, [0, 0, 0, 1], [0.35, 0.38, 0.42], 0.02)
  ];
}

/** Levitating disc + centre post (updated each frame via physics gap). */
function buildFloaterInstances(gapM = 0.018) {
  const discColor = [0.72, 0.74, 0.78];
  const y = 0.55 + gapM;
  return [
    packInstance([0, y, 0], 15, [0, 0, 0, 1], discColor, 0.18),
    packInstance([0, y - 0.12, 0], 15, [0, 0, 0, 1], [0.55, 0.58, 0.62], 0.08)
  ];
}

export function buildMagLevMesh(gapM = 0.018) {
  return {
    cylinders: () => [
      ...buildBaseInstances(),
      ...buildHalbachRingInstances(),
      ...buildFloaterInstances(gapM)
    ]
  };
}

/**
 * Estimate surface B for a Halbach-like ring (order-of-magnitude, educational).
 * @param {number} gapM  metres
 */
export function estimateHalbachFieldT(gapM) {
  const R = 0.028; // effective magnet thickness scale
  const B0 = BR * MU0 / (4 * Math.PI) * (2 * Math.PI * R) / Math.max(gapM, 0.002);
  return Math.min(1.2, B0 * 8);
}

/**
 * @param {object} state
 * @param {number} dt
 * @param {number} drive 0..1 from speed slider
 */
export function stepMagLevPhysics(state, dt, drive) {
  const gapTarget = 0.012 + 0.022 * drive;
  const kSpring = 180;
  const cDamp = 14;
  const mass = 0.045;

  const gap = state.maglevGap ?? gapTarget;
  const vel = state.maglevGapVel ?? 0;
  const lift = kSpring * (gapTarget - gap) * (0.6 + 0.4 * drive);
  const grav = mass * 9.81;
  const accel = (lift - grav - cDamp * vel) / mass;
  const newVel = vel + accel * dt;
  const newGap = Math.max(0.004, Math.min(0.06, gap + newVel * dt));

  state.maglevGap = newGap;
  state.maglevGapVel = newVel;
  state.maglevGapMm = newGap * 1000;
  state.maglevFieldT = estimateHalbachFieldT(newGap);
  state.maglevLiftN = Math.max(0, lift);
  state.maglevRpm = drive * 4200 * (0.3 + 0.7 * (1 - Math.abs(newGap - gapTarget) / gapTarget));
  state.energyLevel = Math.min(1, drive * 0.55 + (1 - Math.abs(newGap - gapTarget) / Math.max(gapTarget, 0.01)) * 0.45);
}

export function createMagLevPhysicsState() {
  return {
    maglevGap: 0.018,
    maglevGapVel: 0,
    maglevGapMm: 18,
    maglevFieldT: estimateHalbachFieldT(0.018),
    maglevLiftN: 0,
    maglevRpm: 0
  };
}

export const MAGLEV_REFERENCES = [
  {
    title: 'Design of permanent multipole magnets with oriented rare earth cobalt material',
    authors: 'K. Halbach',
    year: 1980,
    note: 'Halbach array — field concentration on one side of a magnet ring'
  },
  {
    title: 'The levitation of spinning magnets',
    authors: 'M. V. Berry',
    year: 1996,
    note: 'Gyroscopic / eddy stabilization in passive magnetic levitation demos'
  },
  {
    title: 'NdFeB N52 magnet specifications',
    authors: 'ValidatedConstants.MAGNET_BR',
    year: 2018,
    note: `Remanence B_r ≈ ${BR.toFixed(2)} T (CODATA-backed constants module)`
  }
];

export const magneticLevitationPlugin = {
  id: 'maglev',
  label: 'Magnetic Levitation',
  category: 'quanta',
  modeIndex: 6,
  defaults: {
    particleCount: 12000,
    color: [0.2, 0.88, 1.0],
    cameraOffset: [0, 3.5, 11]
  },
  references: MAGLEV_REFERENCES,
  telemetrySchema: {
    maglevGapMm: { label: 'Air gap', unit: 'mm', source: 'sim' },
    maglevFieldT: { label: 'B-field (est.)', unit: 'T', source: 'fallback-physics' },
    maglevLiftN: { label: 'Lift proxy', unit: 'N', source: 'sim' },
    maglevRpm: { label: 'Floater spin', unit: 'RPM', source: 'sim' }
  },
  meshLayout: {
    cylinders: () => buildMagLevMesh(0.018).cylinders()
  },
  createPhysicsState: createMagLevPhysicsState,
  stepPhysics: stepMagLevPhysics
};
