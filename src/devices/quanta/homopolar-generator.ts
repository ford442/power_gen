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

import { packInstance, type InstanceArray } from '../../device-mesh-layouts';
import { writeMeshCylinders } from '../update-helpers';
import type { DevicePlugin } from '../types';
import type { DevicePhysicsState } from '../../renderers/shared/device-physics';
import { catalogIdentity } from '../../../generated/device-catalog';
import { HOMOPOLAR } from '../../../generated/physics-constants';
import { HomopolarState, PLANT_ODE } from '../../../generated/plant-ode';
import {
  addStats,
  advanceAdaptive,
  eulerFixed,
  integratorFor,
  isAdaptive,
  odeStats,
  rk4Fixed,
  toleranceOf,
  type OdePlant,
  type StepperState
} from '../../renderers/shared/integrate';

/**
 * Disc / circuit parameters — the single set shared with the C++ plant.
 * Generated from physics/constants.json (`homopolar` block) into
 * `HOMOPOLAR` (TS) and `power_gen::HomopolarConstants` (C++). Do not
 * re-literal SI numbers here.
 *
 * `bAxialT` used to be derived here as `min(0.55, SEG Br × 0.28)` = 0.414 T
 * while the C++ plant defaulted to 0.55 T; the classroom set is now the
 * C++ value on both sides (see the JSON block's comment).
 */
export { HOMOPOLAR };

const DISC_RADIUS = HOMOPOLAR.discRadiusM;
const B_AXIAL = HOMOPOLAR.bAxialT;
const R_COIL = HOMOPOLAR.rOhm;
const L_COIL = HOMOPOLAR.lHenry;
const J_DISC = HOMOPOLAR.inertiaKgM2;
const B_DRAG = HOMOPOLAR.dragNmsPerRad;
const TAU_DRIVE_MAX = HOMOPOLAR.tauDriveMaxNm;

function yawQuat(angleRad: number): number[] {
  const half = angleRad * 0.5;
  return [0, Math.sin(half), 0, Math.cos(half)];
}

function buildBaseInstances(): InstanceArray {
  const steel = [0.42, 0.44, 0.48];
  return [
    packInstance([0, -0.55, 0], 1, [0, 0, 0, 1], steel, 0.04),
    packInstance([0, -0.35, 0], 1, [0, 0, 0, 1], [0.32, 0.34, 0.38], 0.02)
  ];
}

function buildMagnetPoleInstances(): InstanceArray {
  const north = [0.18, 0.48, 0.92];
  const south = [0.88, 0.22, 0.18];
  return [
    packInstance([0, 0.42, 0], 17, [0, 0, 0, 1], north, 0.28),
    packInstance([0, -0.08, 0], 17, [0, 0, 0, 1], south, 0.22)
  ];
}

function buildBrushInstances(): InstanceArray {
  const brush = [0.62, 0.64, 0.68];
  const rim = DISC_RADIUS * 3.2;
  return [
    packInstance([rim * 0.02, 0.18, 0], 18, [0, 0, 0, 1], brush, 0.08),
    packInstance([0, 0.18, 0], 18, [0, 0, 0, 1], brush, 0.06),
    packInstance([rim, 0.18, 0], 18, [0, 0, 0, 1], brush, 0.1)
  ];
}

/** Rotating copper disc + axle; angle in radians about Y. */
function buildDiscInstances(angleRad = 0): InstanceArray {
  const copper = [0.86, 0.56, 0.24];
  const axle = [0.55, 0.58, 0.62];
  const rot = yawQuat(angleRad);
  return [
    packInstance([0, 0.16, 0], 16, rot, copper, 0.14),
    packInstance([0, 0.16, 0], 15, rot, axle, 0.05)
  ];
}

export function buildHomopolarMesh(angleRad = 0): { cylinders: () => InstanceArray } {
  return {
    cylinders: (): InstanceArray => [
      ...buildBaseInstances(),
      ...buildMagnetPoleInstances(),
      ...buildBrushInstances(),
      ...buildDiscInstances(angleRad)
    ]
  };
}

/**
 * Faraday disc EMF (uniform axial B, solid disc): ε = ½ B ω r².
 */
export function estimateHomopolarEmfV(omegaRadS: number, fieldT: number = B_AXIAL, radiusM: number = DISC_RADIUS): number {
  return 0.5 * fieldT * omegaRadS * radiusM * radiusM;
}

interface DiscInput {
  drive: number;
  fieldT: number;
}

const DISC_ODE = PLANT_ODE.homopolar;
const DISC_TOL = toleranceOf(DISC_ODE);
const HS = HomopolarState;

/**
 * The disc as an {@link OdePlant}: x = [ω, I] (generated `HomopolarState`
 * order). Mirrors `HomopolarPlant` in cpp/src/plant/homopolar_plant.cpp.
 */
export const HOMOPOLAR_PLANT: OdePlant<DiscInput> = {
  stateSize: DISC_ODE.state.length,
  derivs(_t, x, u, dx) {
    const omega = x[HS.omega];
    const current = x[HS.currentA];
    const omegaTarget = u.drive * HOMOPOLAR.rpmMax * (Math.PI / 30);
    const tauDrive = TAU_DRIVE_MAX * u.drive
      * (HOMOPOLAR.tauDriveBase
         + HOMOPOLAR.tauDriveSpan
           * Math.tanh((omegaTarget - omega) * HOMOPOLAR.tauDriveTanhGain));
    const emf = estimateHomopolarEmfV(omega, u.fieldT);
    const tauLoad = current * u.fieldT * DISC_RADIUS * 0.5;
    dx[HS.currentA] = (emf - R_COIL * current) / L_COIL;
    dx[HS.omega] = (tauDrive - tauLoad - B_DRAG * omega) / J_DISC;
  },
  // ω, I ≥ 0 after every step — the clamp both plants have always applied.
  constrain(x) {
    const o = Math.max(0, x[HS.omega]);
    const i = Math.max(0, x[HS.currentA]);
    const changed = o !== x[HS.omega] || i !== x[HS.currentA];
    x[HS.omega] = o;
    x[HS.currentA] = i;
    return changed;
  }
};

const discX = new Float64Array(DISC_ODE.state.length);
const discU: DiscInput = { drive: 0, fieldT: B_AXIAL };
const discStepper: StepperState = { h: 0, errOld: 1e-4 };

/**
 * One frame of the Faraday disc on the catalog integrator ("euler": one
 * explicit step per frame), or `state.integratorOverride`.
 *
 * @param drive 0..1 from speed slider
 */
export const stepHomopolarPhysics: NonNullable<DevicePlugin['stepPhysics']> = (state, dt, drive) => {
  const B = state.homopolarFieldT ?? B_AXIAL;
  const x = discX;
  x[HS.omega] = state.homopolarOmega ?? 0;
  // `homopolarCurrentA` is the catalog telemetry key; `homopolarCurrent` is
  // an older alias the WASM bridge still fills (apply-wasm-plant.ts writes
  // both). This step used to *read* the alias and *write* only the catalog
  // key, so the loop current never fed back and the disc ran unloaded —
  // no back-EMF braking at all. Read the key, keep the alias in sync.
  x[HS.currentA] = state.homopolarCurrentA ?? state.homopolarCurrent ?? 0;
  discU.drive = drive;
  discU.fieldT = B;
  // The reported EMF is the one this step integrated from (start of step).
  const emf = estimateHomopolarEmfV(x[HS.omega], B);

  const method = integratorFor(DISC_ODE, state.integratorOverride);
  if (isAdaptive(method)) {
    discStepper.h = state.homopolarStepH ?? 0;
    discStepper.errOld = state.homopolarStepErrOld ?? 1e-4;
    addStats(odeStats, advanceAdaptive(method, HOMOPOLAR_PLANT, x, discU, dt, DISC_TOL, discStepper));
    state.homopolarStepH = discStepper.h;
    state.homopolarStepErrOld = discStepper.errOld;
  } else {
    addStats(odeStats, (method === 'rk4' ? rk4Fixed : eulerFixed)(HOMOPOLAR_PLANT, 0, dt, x, discU));
  }

  const omega = x[HS.omega];
  const current = x[HS.currentA];
  const rpm = omega * 30 / Math.PI;

  state.homopolarOmega = omega;
  state.homopolarAngle = (state.homopolarAngle ?? 0) + omega * dt;
  state.homopolarRpm = rpm;
  state.homopolarEmfV = emf;
  state.homopolarCurrentA = current;
  state.homopolarCurrent = current;
  state.homopolarFieldT = B;
  state.energyLevel = Math.min(1, drive * 0.45 + (rpm / HOMOPOLAR.rpmMax) * 0.55);
};

export function createHomopolarPhysicsState(): Partial<DevicePhysicsState> {
  return {
    homopolarOmega: 0,
    homopolarAngle: 0,
    homopolarRpm: 0,
    homopolarEmfV: 0,
    homopolarCurrentA: 0,
    homopolarFieldT: B_AXIAL,
    homopolarStepH: 0,
    homopolarStepErrOld: 1e-4,
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

const homopolarUpdateMesh: NonNullable<DevicePlugin['updateMesh']> = (instance) => {
  const angle = instance.physicsState?.homopolarAngle ?? 0;
  writeMeshCylinders(instance, buildHomopolarMesh(angle));
};

const homopolarComputeRawEnergy: NonNullable<DevicePlugin['computeRawEnergy']> = (instance, ctx) => {
  const spinN = (instance.physicsState?.homopolarRpm ?? 0) / HOMOPOLAR.rpmMax;
  return Math.min(1.0, spinN * 0.75 + ctx.speedNorm * 0.25);
};

const homopolarUpdateEffects: NonNullable<DevicePlugin['updateEffects']> = (instance, ctx) => {
  const { budget, energy, gate, pushParticle, time } = ctx;
  const currentGate = Math.pow(gate(energy, 0.18, 0.8), 1.25);
  const arcCount = Math.floor(budget * 0.38 * currentGate);
  const rim = 0.45;
  for (let i = 0; i < arcCount; i++) {
    const frac = i / Math.max(1, arcCount);
    const x = frac * rim;
    const y = 0.18 + Math.sin(time * 6 + i * 0.4) * 0.05;
    const z = Math.sin(frac * Math.PI * 2 + time * 2) * 0.08;
    pushParticle(x, y, z, 3.0 + Math.random());
  }
  return true;
};

export const homopolarGeneratorPlugin: DevicePlugin = {
  ...catalogIdentity('homopolar'),
  needsPhysicsState: true,
  wasmSkipsJsPhysics: true,
  defaults: {
    particleCount: 5500,
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
  stepPhysics: stepHomopolarPhysics,
  updateMesh: homopolarUpdateMesh,
  computeRawEnergy: homopolarComputeRawEnergy,
  updateEffects: homopolarUpdateEffects,
  wantsThermalHaze: true
};
