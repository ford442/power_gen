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

import { packInstance, type InstanceArray } from '../../device-mesh-layouts';
import { MATERIAL_QUANTA_COIL, MATERIAL_QUANTA_FLOATER, MATERIAL_QUANTA_FLOATER_POST, MATERIAL_STEEL_BASE } from '../material-roles';
import { writeMeshCylinders } from '../update-helpers';
import { estimateHalbachFieldT, MAGNET_BR } from './halbach-field';
import { MAGLEV, PHYSICAL_CONSTANTS } from '../../../generated/physics-constants';
import type { DevicePlugin } from '../types';
import type { DevicePhysicsState } from '../../renderers/shared/device-physics';
import { catalogIdentity } from '../../../generated/device-catalog';

/**
 * Gap spring–damper parameters — the single set shared with the C++ plant.
 * Generated from physics/constants.json (`maglev` block) into `MAGLEV` (TS)
 * and `power_gen::MaglevConstants` (C++). Do not re-literal SI numbers here.
 */
export { MAGLEV };

/** Ring magnet segments in a simplified Halbach-like azimuthal pattern. */
function buildHalbachRingInstances(): InstanceArray {
  const segments = 12;
  const majorR = 2.8;
  const out: InstanceArray = [];
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
    out.push(packInstance([x, 0.35, z], MATERIAL_QUANTA_COIL, rot, color, emissive));
  }
  return out;
}

function buildBaseInstances(): InstanceArray {
  const steel = [0.45, 0.48, 0.52];
  return [
    packInstance([0, -0.6, 0], MATERIAL_STEEL_BASE, [0, 0, 0, 1], steel, 0.04),
    packInstance([0, 0.05, 0], MATERIAL_STEEL_BASE, [0, 0, 0, 1], [0.35, 0.38, 0.42], 0.02)
  ];
}

/** Levitating disc + centre post (updated each frame via physics gap). */
function buildFloaterInstances(gapM: number = MAGLEV.gapInitialM): InstanceArray {
  const discColor = [0.72, 0.74, 0.78];
  const y = 0.55 + gapM;
  return [
    packInstance([0, y, 0], MATERIAL_QUANTA_FLOATER, [0, 0, 0, 1], discColor, 0.18),
    packInstance([0, y - 0.12, 0], MATERIAL_QUANTA_FLOATER_POST, [0, 0, 0, 1], [0.55, 0.58, 0.62], 0.08)
  ];
}

export function buildMagLevMesh(gapM: number = MAGLEV.gapInitialM): { cylinders: () => InstanceArray } {
  return {
    cylinders: (): InstanceArray => [
      ...buildBaseInstances(),
      ...buildHalbachRingInstances(),
      ...buildFloaterInstances(gapM)
    ]
  };
}

/**
 * Estimate surface B for a Halbach-like ring (order-of-magnitude, educational).
 */
export { estimateHalbachFieldT } from './halbach-field';

/**
 * @param drive 0..1 from speed slider
 */
export const stepMagLevPhysics: NonNullable<DevicePlugin['stepPhysics']> = (state, dt, drive) => {
  const m = MAGLEV;
  const gapTarget = m.gapTargetBaseM + m.gapTargetSpanM * drive;

  const gap = state.maglevGap ?? gapTarget;
  const vel = state.maglevGapVel ?? 0;
  const lift = m.kSpringNm * (gapTarget - gap) * (m.liftDriveBase + m.liftDriveSpan * drive);
  const grav = m.massKg * PHYSICAL_CONSTANTS.G;
  const accel = (lift - grav) / m.massKg;
  // Semi-implicit Euler with the eddy-damping term taken *implicitly* (the
  // same treatment the Lorentz sled gives its linear-in-v terms), plus wall
  // restitution — zero outward velocity at the clamps. Explicit damping is
  // unstable here: c·dt/m = 14·(1/60)/0.045 ≈ 5.2 ≫ 2, which turned the
  // floater into a period-2 orbit slapping the 4 mm / 60 mm clamps every
  // frame instead of levitating. Mirrors _stepMaglev in
  // cpp/src/plant/maglev_plant.cpp.
  let newVel = (vel + accel * dt) / (1 + (m.cDampNsm / m.massKg) * dt);
  let newGap = gap + newVel * dt;
  if (newGap < m.gapMinM) { newGap = m.gapMinM; newVel = Math.max(0, newVel); }
  if (newGap > m.gapMaxM) { newGap = m.gapMaxM; newVel = Math.min(0, newVel); }

  const err = Math.abs(newGap - gapTarget) / Math.max(gapTarget, 0.01);
  state.maglevGap = newGap;
  state.maglevGapVel = newVel;
  state.maglevGapMm = newGap * 1000;
  state.maglevFieldT = estimateHalbachFieldT(newGap);
  state.maglevLiftN = Math.max(0, lift);
  state.maglevRpm = drive * m.rpmMax * (m.rpmErrBase + m.rpmErrSpan * (1 - err));
  state.energyLevel = Math.min(1, drive * 0.55 + (1 - err) * 0.45);
};

export function createMagLevPhysicsState(): Partial<DevicePhysicsState> {
  return {
    maglevGap: MAGLEV.gapInitialM,
    maglevGapVel: 0,
    maglevGapMm: MAGLEV.gapInitialM * 1000,
    maglevFieldT: estimateHalbachFieldT(MAGLEV.gapInitialM),
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
    note: `Remanence B_r ≈ ${MAGNET_BR.toFixed(2)} T (CODATA-backed constants module)`
  }
];

const maglevUpdateMesh: NonNullable<DevicePlugin['updateMesh']> = (instance) => {
  const gap = instance.physicsState?.maglevGap ?? MAGLEV.gapInitialM;
  writeMeshCylinders(instance, buildMagLevMesh(gap));
};

const maglevComputeRawEnergy: NonNullable<DevicePlugin['computeRawEnergy']> = (instance, ctx) => {
  const gapN = instance.physicsState?.energyLevel ?? instance.energyLevel;
  return Math.min(1.0, gapN * 0.7 + ctx.speedNorm * 0.3);
};

const maglevUpdateEffects: NonNullable<DevicePlugin['updateEffects']> = (instance, ctx) => {
  const { budget, energy, gate, pushParticle, time } = ctx;
  const fieldGate = Math.pow(gate(energy, 0.2, 0.75), 1.3);
  const gap = instance.physicsState?.maglevGap ?? MAGLEV.gapInitialM;
  const orbitCount = Math.floor(budget * 0.42 * fieldGate);
  for (let i = 0; i < orbitCount; i++) {
    const a = (i / Math.max(1, orbitCount)) * Math.PI * 2 + time * 1.2;
    const r = 1.0 + Math.random() * 2.0;
    const y = 0.55 + gap + Math.sin(time * 4 + i * 0.31) * 0.12;
    pushParticle(Math.cos(a) * r, y, Math.sin(a) * r, 3.0 + Math.random());
  }
  return true;
};

export const magneticLevitationPlugin: DevicePlugin = {
  ...catalogIdentity('maglev'),
  needsPhysicsState: true,
  wasmSkipsJsPhysics: true,
  defaults: {
    particleCount: 5000,
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
    cylinders: () => buildMagLevMesh(MAGLEV.gapInitialM).cylinders()
  },
  createPhysicsState: createMagLevPhysicsState,
  stepPhysics: stepMagLevPhysics,
  updateMesh: maglevUpdateMesh,
  computeRawEnergy: maglevComputeRawEnergy,
  updateEffects: maglevUpdateEffects,
  wantsThermalHaze: true
};
