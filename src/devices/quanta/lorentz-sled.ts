/**
 * Lorentz rail sled — Quanta classroom rail-motor demo. Pairs with MHD
 * (both are `F = I ℓ × B` on a conductor carrying current across a
 * transverse field; MHD runs it as a generator, this runs it as a motor).
 *
 * **Educational Lorentz-force model, not a railgun design tool.** There is
 * no projectile, no muzzle energy, no ballistics: the sled is a sliding
 * armature on a low-voltage bench track, and every reported quantity is a
 * lumped-circuit / rigid-body number.
 *
 * Lumped model — a series R–L drive loop closed through the armature:
 *
 *   L dI/dt = V_drive(drive) − I·R − B·ℓ·v        (back-EMF B·ℓ·v)
 *   m dv/dt = I·ℓ·B − μ·m·g·tanh(v/v_eps) − b·v   (Lorentz force vs friction)
 *   dx/dt   = v                                    (reported modulo rail length)
 *
 * Neither branch uses explicit Euler. τ = L/R ≈ 100 µs is far shorter than a
 * render substep, so the current branch is advanced with its analytic
 * (exponential) solution, and the velocity update takes both linear-in-v
 * terms — viscous drag and the back-EMF reaction (Bℓ)²/R — implicitly. Both
 * are then stable at any substep length, including a long dropped frame.
 *
 * Coulomb friction is regularised with `tanh(v/v_eps)` so the sign flip at
 * v = 0 does not chatter; there is no static-friction latch, so the sled
 * creeps rather than sticking at very small force. Position wraps at the
 * rail length — the ODE state is continuous, only the *reported* position
 * folds back so the classroom track reads as a loop.
 *
 * B is a local bench parameter (a slider in the device panel), not a live
 * coupling to `halbach-viz` / `mhd` field estimates — the same
 * self-contained choice `hall` makes, documented rather than implied
 * (see docs/DEVICE_GALLERY.md).
 *
 * Shader/wasm indices: physics/devices.json (codegen) — do not hardcode.
 *
 * References: undergraduate Lorentz-force / rail-motor treatments
 * (Griffiths ch. 5; Halliday–Resnick–Walker "rod on rails").
 */

import { packInstance, type InstanceArray } from '../../device-mesh-layouts';
import {
  MATERIAL_STEEL_BASE,
  MATERIAL_STRUCTURAL,
  MATERIAL_COPPER,
  MATERIAL_QUANTA_COIL,
  MATERIAL_QUANTA_MAGNET
} from '../material-roles';
import { writeMeshCylinders } from '../update-helpers';
import { PHYSICAL_CONSTANTS, LORENTZ_SLED } from '../../../generated/physics-constants';
import type { DevicePlugin } from '../types';
import type { DevicePhysicsState } from '../../renderers/shared/device-physics';
import { catalogIdentity } from '../../../generated/device-catalog';

const G = PHYSICAL_CONSTANTS.G;

/**
 * Classroom-scale rail-sled bench parameters — the single set shared with
 * `LorentzState` in cpp/src/plant/lorentz_plant.h. Generated from
 * physics/constants.json (`lorentzSled` block) into `LORENTZ_SLED` (TS) and
 * `power_gen::LorentzSledConstants` (C++). Do not re-literal SI numbers
 * here; edit the JSON and rerun `npm run codegen:constants`.
 *
 * `vMaxMps` / `iMaxA` are display normalisers (also used by the
 * WGSL/particle uniform packers), carried in the same block so the
 * renderer and the plant cannot drift apart either.
 */
export const LORENTZ = LORENTZ_SLED;
export { LORENTZ_SLED };

/** Clamp + apply the bench field slider (T). Mirrors setLorentzFieldT in the C++ plant. */
export function setLorentzFieldT(
  state: Partial<DevicePhysicsState> | null | undefined,
  fieldT: number
): void {
  if (!state) return;
  const t = Number.isFinite(fieldT) ? fieldT : LORENTZ.fieldTDefault;
  state.lorentzFieldT = Math.max(0, Math.min(LORENTZ.fieldTMax, t));
}

const SIN45 = Math.SQRT1_2;

// The instance cylinder's long axis is +Y, so tipping it onto another axis
// needs a quarter turn about a *perpendicular* axis — a yaw about Y would
// leave it standing upright.

/** +Y → +X: quarter turn about Z (rails run along the track). */
const ALONG_X: number[] = [0, 0, SIN45, SIN45];
/** +Y → +Z: quarter turn about X (the armature bridges the rail gap). */
const ALONG_Z: number[] = [SIN45, 0, 0, SIN45];

/**
 * Scene layout, in device-local render units — deliberately separate from the
 * SI numbers in `LORENTZ`. The shared instance cylinder is r = 0.8, h = 2.5
 * (mesh-renderer `deviceCylinder`) and carries no per-instance scale, so a rail
 * is drawn as a chain of segments rather than one stretched primitive, and the
 * bench is laid out at a size that reads next to the other devices instead of
 * at 1 unit = 1 m. Particle paths (`posLorentzSled` in particle-compute.wgsl
 * and `integrateLorentzSled` in shared/particle-physics.ts) use the same
 * numbers so the current packets track the rails they are drawn on.
 */
export const LORENTZ_SCENE = Object.freeze({
  railLenU: 12,       // total rail run along X
  railHalfGapU: 2.6,  // rail offset in ±Z
  segLenU: 2.4,       // one instance cylinder laid along X
  segments: 5         // segments per rail (segments × segLenU = railLenU)
});

/**
 * Base + two segmented rails + the sliding armature at its current position,
 * with a pole-piece pair standing in for the transverse bench field.
 *
 * @param posNorm  x / railLength, 0..1
 * @param currentNorm  |I| / iMax, 0..1 (rail + lead glow)
 * @param fieldNorm  B / fieldTMax, 0..1 (pole-piece glow)
 */
export function buildLorentzSledMesh(posNorm = 0, currentNorm = 0, fieldNorm = 0): { cylinders: () => InstanceArray } {
  const { railLenU, railHalfGapU, segLenU, segments } = LORENTZ_SCENE;
  const halfLen = railLenU * 0.5;
  const x = -halfLen + Math.max(0, Math.min(1, posNorm)) * railLenU;
  const railGlow = 0.04 + currentNorm * 0.55;
  const poleGlow = 0.04 + fieldNorm * 0.4;
  const copper = [0.85, 0.5, 0.2];

  return {
    cylinders: (): InstanceArray => {
      const out: InstanceArray = [];
      // Bench plinths under the track
      for (let i = 0; i < 3; i++) {
        const bx = -halfLen * 0.8 + (i / 2) * halfLen * 1.6;
        out.push(packInstance([bx, -3.0, 0], MATERIAL_STEEL_BASE, [0, 0, 0, 1], [0.4, 0.42, 0.46], 0.02));
      }
      // Two conducting rails, each a chain of segments laid along X
      for (const z of [railHalfGapU, -railHalfGapU]) {
        for (let i = 0; i < segments; i++) {
          const sx = -halfLen + (i + 0.5) * segLenU;
          out.push(packInstance([sx, 0, z], MATERIAL_COPPER, ALONG_X, copper, railGlow));
        }
      }
      // Sliding armature (the "sled") bridging the rails at x — three
      // segments, since one instance cylinder is shorter than the rail gap
      for (const az of [-railHalfGapU * 0.66, 0, railHalfGapU * 0.66]) {
        out.push(packInstance([x, 0.5, az], MATERIAL_STRUCTURAL, ALONG_Z, [0.72, 0.76, 0.82], 0.05 + currentNorm * 0.5));
      }
      // Pole pieces above / below the track — the transverse bench field B
      out.push(packInstance([0, 2.0, 0], MATERIAL_QUANTA_MAGNET, ALONG_X, [0.35, 0.55, 0.95], poleGlow));
      out.push(packInstance([0, -2.0, 0], MATERIAL_QUANTA_MAGNET, ALONG_X, [0.95, 0.4, 0.4], poleGlow));
      // Supply leads at the feed end
      out.push(packInstance([-halfLen - 1.0, 0, railHalfGapU], MATERIAL_QUANTA_COIL, [0, 0, 0, 1], [0.9, 0.7, 0.3], railGlow));
      out.push(packInstance([-halfLen - 1.0, 0, -railHalfGapU], MATERIAL_QUANTA_COIL, [0, 0, 0, 1], [0.3, 0.7, 0.9], railGlow));
      return out;
    }
  };
}

/**
 * One substep of the rail-sled plant. Mirrors `_stepLorentz` in
 * `cpp/src/plant/lorentz_plant.cpp` term for term.
 *
 * @param drive 0..1 from the speed slider (scales the bench supply voltage)
 */
export const stepLorentzSledPhysics: NonNullable<DevicePlugin['stepPhysics']> = (state, dt, drive) => {
  const d = Math.max(0, Math.min(1, drive));
  const B = state.lorentzFieldT ?? LORENTZ.fieldTDefault;
  const bl = B * LORENTZ.railGapM;

  let i = state.lorentzCurrentA ?? 0;
  let v = state.lorentzSledVms ?? 0;
  let x = state.lorentzPositionM ?? 0;

  const vSupply = d * LORENTZ.supplyVMax;

  // Velocity first, with every term that is linear in v taken implicitly:
  // viscous drag *and* the back-EMF reaction ((Bℓ)²/R, the current's own
  // response to the sled speeding up). τ = L/R ≈ 100 µs is far shorter than a
  // render substep, so within one step the current tracks (V − Bℓv)/R and that
  // reaction behaves as extra linear damping. Backward Euler on those terms is
  // unconditionally stable; explicit Euler blows up on a long frame.
  const coulomb = LORENTZ.frictionMu * LORENTZ.sledMassKg * G * Math.tanh(v / LORENTZ.vEpsMps);
  const accel = ((vSupply * bl) / LORENTZ.circuitROhm - coulomb) / LORENTZ.sledMassKg;
  const damping = ((bl * bl) / LORENTZ.circuitROhm + LORENTZ.viscousDampingNsm) / LORENTZ.sledMassKg;
  v = (v + accel * dt) / (1 + damping * dt);

  // Analytic R–L relaxation toward the steady current at the new speed —
  // exact for constant V and v, and stable at any dt.
  const iSteady = (vSupply - bl * v) / LORENTZ.circuitROhm;
  const decay = Math.exp(-(dt * LORENTZ.circuitROhm) / LORENTZ.circuitLH);
  i = iSteady + (i - iSteady) * decay;
  const forceN = i * bl;

  x += v * dt;
  // Reported position wraps; the ODE state (i, v) stays continuous.
  const L = LORENTZ.railLengthM;
  x = ((x % L) + L) % L;

  state.lorentzCurrentA = i;
  state.lorentzSledVms = v;
  state.lorentzPositionM = x;
  state.lorentzForceN = forceN;
  state.lorentzFieldT = B;
  state.energyLevel = Math.max(0, Math.min(1, Math.abs(v) / LORENTZ.vMaxMps));
};

export function createLorentzSledPhysicsState(): Partial<DevicePhysicsState> {
  return {
    lorentzCurrentA: 0,
    lorentzSledVms: 0,
    lorentzPositionM: 0,
    lorentzForceN: 0,
    lorentzFieldT: LORENTZ.fieldTDefault,
    energyLevel: 0
  };
}

export const LORENTZ_REFERENCES = [
  {
    title: 'Introduction to Electrodynamics, ch. 5 (magnetic forces on currents)',
    authors: 'D. J. Griffiths',
    year: 2017,
    note: 'F = I ∫ dl × B for a straight conductor in a uniform transverse field'
  },
  {
    title: 'Fundamentals of Physics — conducting rod sliding on rails',
    authors: 'D. Halliday, R. Resnick, J. Walker',
    year: 2013,
    note: 'The standard rail-motor / motional-EMF worked problem this plant lumps'
  }
];

const lorentzUpdateMesh: NonNullable<DevicePlugin['updateMesh']> = (instance) => {
  const s = instance.physicsState;
  const posNorm = ((s?.lorentzPositionM ?? 0) % LORENTZ.railLengthM) / LORENTZ.railLengthM;
  const iNorm = Math.min(1, Math.abs(s?.lorentzCurrentA ?? 0) / LORENTZ.iMaxA);
  const bNorm = Math.min(1, (s?.lorentzFieldT ?? 0) / LORENTZ.fieldTMax);
  writeMeshCylinders(instance, buildLorentzSledMesh(posNorm, iNorm, bNorm));
};

const lorentzComputeRawEnergy: NonNullable<DevicePlugin['computeRawEnergy']> = (instance, ctx) => {
  const e = instance.physicsState?.energyLevel ?? instance.energyLevel;
  return Math.min(1.0, e * 0.7 + ctx.speedNorm * 0.3);
};

const lorentzUpdateEffects: NonNullable<DevicePlugin['updateEffects']> = (instance, ctx) => {
  const { budget, energy, gate, pushParticle, time } = ctx;
  const flowGate = Math.pow(gate(energy, 0.05, 0.6), 1.1);
  const count = Math.floor(budget * 0.65 * flowGate);
  const s = instance.physicsState;
  const { railLenU, railHalfGapU } = LORENTZ_SCENE;
  const halfLen = railLenU * 0.5;
  const posNorm = (((s?.lorentzPositionM ?? 0) % LORENTZ.railLengthM) + LORENTZ.railLengthM)
    % LORENTZ.railLengthM / LORENTZ.railLengthM;
  const xSled = -halfLen + posNorm * railLenU;
  const iNorm = Math.min(1, Math.abs(s?.lorentzCurrentA ?? 0) / LORENTZ.iMaxA);
  const bNorm = Math.min(1, (s?.lorentzFieldT ?? 0) / LORENTZ.fieldTMax);
  // Current loop: out along the feed rail, across the armature, back along the
  // return rail (illustrative — not a per-particle Lorentz integrator).
  for (let k = 0; k < count; k++) {
    const u = ((k / Math.max(1, count)) + time * (0.25 + iNorm * 1.2)) % 1;
    let px: number;
    let pz: number;
    if ((k % 4) === 0) {
      px = xSled + Math.sin(time * 8 + k) * 0.12 * bNorm;
      pz = -railHalfGapU + u * (railHalfGapU * 2);
    } else if ((k & 1) === 0) {
      px = -halfLen + u * (xSled + halfLen);
      pz = -railHalfGapU;
    } else {
      px = xSled - u * (xSled + halfLen);
      pz = railHalfGapU;
    }
    pushParticle(px, Math.sin(time * 3 + k * 0.05) * 0.12, pz, 3.0 + Math.random());
  }
  return true;
};

export const lorentzSledPlugin: DevicePlugin = {
  ...catalogIdentity('lorentz-sled'),
  needsPhysicsState: true,
  wasmSkipsJsPhysics: true,
  defaults: {
    particleCount: 3400,
    color: [0.85, 0.55, 0.25],
    cameraOffset: [0, 8, 26]
  },
  references: LORENTZ_REFERENCES,
  telemetrySchema: {
    lorentzSledVms: { label: 'Sled speed', unit: 'm/s', source: 'sim' },
    lorentzCurrentA: { label: 'Armature current', unit: 'A', source: 'sim' },
    lorentzFieldT: { label: 'Field B', unit: 'T', source: 'sim' },
    lorentzForceN: { label: 'Lorentz force', unit: 'N', source: 'sim' },
    lorentzPositionM: { label: 'Position along rails', unit: 'm', source: 'sim' }
  },
  meshLayout: {
    cylinders: () => buildLorentzSledMesh(0, 0, 0).cylinders()
  },
  createPhysicsState: createLorentzSledPhysicsState,
  stepPhysics: stepLorentzSledPhysics,
  updateMesh: lorentzUpdateMesh,
  computeRawEnergy: lorentzComputeRawEnergy,
  updateEffects: lorentzUpdateEffects,
  wantsThermalHaze: false
};
