/**
 * Thomson jumping ring — Quanta classroom bench for **Lenz's law as motion**.
 *
 * This is the one device in the lab where the induced current does something
 * you can watch from across the room: an aluminium ring dropped over an AC
 * pole is thrown off it. `hall` shows V_H, `homopolar` shows a Faraday-disc
 * EMF, `transformer` shows mutual inductance as coupled L–M, `pulse-coil`
 * shows an R–L discharge — none of them move a conductor because of the
 * current they induced in it.
 *
 * **Educational Thomson-ring model, not an induction furnace and not a
 * launcher.** There is no projectile. There is also **no thermal state at
 * all**: a real ring heats (and a shorted one can glow or melt), and this
 * model does not represent that in any way — σ is constant, nothing warms up.
 *
 * Lumped model — an AC primary and the ring as a shorted single turn, coupled
 * by a mutual inductance that falls as the ring rises:
 *
 *   k(h)  = k0 · exp(−h / λ)
 *   M(h)  = k(h) · √(Lp·Lr)          dM/dh = −M(h) / λ
 *
 *   Vp = Lp dIp/dt + M dIr/dt + (dM/dh)·v·Ir + Rp·Ip
 *   0  = Lr dIr/dt + M dIp/dt + (dM/dh)·v·Ip + Rr·Ir    (ring is shorted)
 *   m dv/dt = Ip·Ir·(dM/dh) − m·g − b·v                 (coenergy gradient)
 *   dh/dt   = v
 *
 * The motional EMF and the force are the *same* dM/dh, so the model is
 * energy-consistent and Lenz is a result rather than a sign convention: the
 * ring current comes out opposing the primary, so Ip·Ir is negative on
 * average, dM/dh is negative, and the force is up.
 *
 * Because the coupling decays with height, so does the lift. The ring does not
 * fly away — it settles where the cycle-averaged force equals its weight, and
 * that balance is the thing the tour points at. `poleHeightM` is a rigid stop
 * at the top of the pole; h = 0 is the core shoulder it rests on.
 *
 * The primary runs at the lab mains frequency `TRANSFORMER.fHz` rather than a
 * frequency literal of its own, so the two AC benches cannot drift apart.
 *
 * Integrated with RK4 over adaptive substeps, mirroring
 * `cpp/src/plant/thomson_plant.cpp` term for term — the JS↔native golden
 * (`npm run test:golden`) holds the two plants together.
 *
 * Shader/wasm indices: physics/devices.json (codegen) — do not hardcode.
 *
 * References: Thomson (1887) "jumping ring"; Elliott's and Hall's standard
 * lumped-circuit treatments of the demonstration.
 */

import { packInstance, type InstanceArray } from '../../device-mesh-layouts';
import {
  MATERIAL_STEEL_BASE,
  MATERIAL_STRUCTURAL,
  MATERIAL_COPPER,
  MATERIAL_QUANTA_COIL,
  MATERIAL_QUANTA_FLOATER
} from '../material-roles';
import { writeMeshCylinders } from '../update-helpers';
import { PHYSICAL_CONSTANTS, JUMPING_RING, TRANSFORMER } from '../../../generated/physics-constants';
import type { DevicePlugin } from '../types';
import type { DevicePhysicsState } from '../../renderers/shared/device-physics';
import { catalogIdentity } from '../../../generated/device-catalog';

const G = PHYSICAL_CONSTANTS.G;

/**
 * Classroom Thomson-ring bench parameters — the single set shared with
 * `ThomsonState` in cpp/src/plant/thomson_plant.h. Generated from
 * physics/constants.json (`jumpingRing` block) into `JUMPING_RING` (TS) and
 * `power_gen::JumpingRingConstants` (C++). Do not re-literal SI numbers here;
 * edit the JSON and rerun `npm run codegen:constants`.
 *
 * `iPrimaryMaxA` / `iRingMaxA` / `heightRefM` are display normalisers (also
 * used by the WGSL/particle uniform packers), carried in the same block so the
 * renderer and the plant cannot drift apart either.
 */
export const RING = JUMPING_RING;
export { JUMPING_RING };

/** Substep target and cap — the same values the C++ plant uses. */
const H_TARGET_S = 5.0e-5;
const SUB_MAX = 800;
/** Browser first frames can deliver dt ≫ 1/60; clamp like the C++ plant. */
const DT_CLAMP_S = 0.05;
/**
 * D = Lp·Lr − M² is ~1.5e-9 H² for a ring this small, so the transformer's
 * 1e-8 floor would swamp it. Guard only against an actual degenerate k.
 */
const D_MIN = 1e-13;

const TWO_PI = 2 * Math.PI;

/** k(h) = k0·exp(−h/λ) — the coupling the whole demo turns on. */
export function ringCouplingAt(heightM: number): number {
  return RING.couplingK0 * Math.exp(-heightM / RING.couplingLambdaM);
}

/**
 * Scene layout, in device-local render units — deliberately separate from the
 * SI numbers in `RING`. The shared instance cylinder is r = 0.8, h = 2.5
 * (mesh-renderer `deviceCylinder`) and carries no per-instance scale, so the
 * pole is drawn as a stack of segments and the ring as a chain of tangential
 * ones, at a size that reads next to the other benches rather than at
 * 1 unit = 1 m. Particle paths (`posJumpingRing` in particle-compute.wgsl and
 * `integrateJumpingRing` in shared/particle-physics.ts) use the same numbers
 * so the flux packets track the pole they are drawn on.
 */
export const RING_SCENE = Object.freeze({
  baseY: -1.0,        // core shoulder — ringHeightM 0 sits here, clear of the winding
  poleU: 12.5,        // pole run above the shoulder (maps to poleHeightM)
  poleBottomY: -7.0,  // core foot, below the winding
  poleSegments: 8,    // stacked instance cylinders making the core
  ringRadiusU: 2.8,   // aluminium ring radius (tube radius is the shared 0.8)
  ringSegments: 8,    // tangential cylinders making the ring
  windingSegments: 8, // cylinders per winding course
  windingRadiusU: 1.7 // primary winding bundle radius around the core
});

const SIN45 = Math.SQRT1_2;

/** +Y → ±X: quarter turn about Z. Yawing this about Y lays a ring segment. */
const ALONG_X: number[] = [0, 0, SIN45, SIN45];

/**
 * Quaternion for a cylinder laid *tangentially* at angle `theta` in the XZ
 * plane — the segments have to run along the ring, not stick out of it like
 * spokes. ALONG_X puts the axis on ±X; a yaw of `π/2 − theta` about Y then
 * carries ±X onto the tangent (−sin θ, 0, cos θ). The expansion below is
 * q_yaw(π/2 − theta) ⊗ ALONG_X.
 */
function tangentQuat(theta: number): number[] {
  const half = (Math.PI * 0.5 - theta) * 0.5;
  const sy = Math.sin(half);
  const cy = Math.cos(half);
  return [sy * SIN45, sy * SIN45, cy * SIN45, cy * SIN45];
}

/**
 * Base + laminated core pole + primary winding + the aluminium ring at its
 * current height.
 *
 * @param heightNorm  ringHeightM / poleHeightM, 0..1
 * @param ringNorm  |I_ring| / iRingMaxA, 0..1 (ring glow — this is the current
 *                  doing the lifting, so it is the thing to look at)
 * @param primaryNorm  |I_p| / iPrimaryMaxA, 0..1 (winding glow)
 * @param kNorm  k(h) / k0, 0..1 (core glow — the coupling falling with height)
 */
export function buildJumpingRingMesh(
  heightNorm = 0,
  ringNorm = 0,
  primaryNorm = 0,
  kNorm = 1
): { cylinders: () => InstanceArray } {
  const {
    baseY, poleU, poleBottomY, poleSegments, ringRadiusU, ringSegments,
    windingSegments, windingRadiusU
  } = RING_SCENE;
  const h = Math.max(0, Math.min(1, heightNorm));
  const yRing = baseY + h * poleU;
  const coreGlow = 0.04 + Math.max(0, Math.min(1, kNorm)) * 0.3;
  const windingGlow = 0.05 + Math.max(0, Math.min(1, primaryNorm)) * 0.55;
  const ringGlow = 0.06 + Math.max(0, Math.min(1, ringNorm)) * 0.7;
  const aluminium = [0.78, 0.8, 0.84];

  return {
    cylinders: (): InstanceArray => {
      const out: InstanceArray = [];
      // Bench plinth
      out.push(packInstance([0, poleBottomY - 1.6, 0], MATERIAL_STEEL_BASE, [0, 0, 0, 1], [0.4, 0.42, 0.46], 0.02));
      // Laminated core pole — one stack from the foot up past the top of travel
      const poleTop = baseY + poleU;
      for (let i = 0; i < poleSegments; i++) {
        const y = poleBottomY + (i + 0.5) * ((poleTop - poleBottomY) / poleSegments);
        out.push(packInstance([0, y, 0], MATERIAL_STRUCTURAL, [0, 0, 0, 1], [0.46, 0.48, 0.52], coreGlow));
      }
      // Primary winding bundle around the base of the core — two stacked
      // courses so it reads as a wound former rather than a single collar.
      for (let course = 0; course < 2; course++) {
        for (let i = 0; i < windingSegments; i++) {
          const a = ((i + course * 0.5) / windingSegments) * TWO_PI;
          out.push(packInstance(
            [Math.cos(a) * windingRadiusU, poleBottomY + 1.4 + course * 2.4, Math.sin(a) * windingRadiusU],
            MATERIAL_QUANTA_COIL,
            [0, 0, 0, 1],
            [0.85, 0.5, 0.2],
            windingGlow
          ));
        }
      }
      // Supply leads at the foot
      out.push(packInstance([-windingRadiusU - 2.0, poleBottomY + 0.2, 0], MATERIAL_COPPER, ALONG_X, [0.9, 0.7, 0.3], windingGlow));
      out.push(packInstance([windingRadiusU + 2.0, poleBottomY + 0.2, 0], MATERIAL_COPPER, ALONG_X, [0.3, 0.7, 0.9], windingGlow));
      // The aluminium ring — a chain of tangential segments whose Y is the
      // plant's ringHeightM. This is the only thing on the bench that moves.
      for (let i = 0; i < ringSegments; i++) {
        const a = (i / ringSegments) * TWO_PI;
        out.push(packInstance(
          [Math.cos(a) * ringRadiusU, yRing, Math.sin(a) * ringRadiusU],
          MATERIAL_QUANTA_FLOATER,
          tangentQuat(a),
          aluminium,
          ringGlow
        ));
      }
      return out;
    }
  };
}

/**
 * One frame of the Thomson-ring plant. Mirrors `_stepThomson` in
 * `cpp/src/plant/thomson_plant.cpp` term for term, including the substep
 * schedule, the double-precision phase accumulator and the rigid stops.
 *
 * @param drive 0..1 from the speed slider (scales the mains supply voltage)
 */
export const stepJumpingRingPhysics: NonNullable<DevicePlugin['stepPhysics']> = (state, dt, drive) => {
  if (!(dt > 0) || !Number.isFinite(dt)) return;

  const r = RING;
  const Lp = r.primaryLH;
  const Lr = r.ringLH;
  const lpLr = Lp * Lr;
  const sqrtLpLr = Math.sqrt(lpLr > 1e-24 ? lpLr : 1e-24);
  const invLambda = 1 / r.couplingLambdaM;

  const omega = TWO_PI * TRANSFORMER.fHz;
  const d = Math.max(0, Math.min(1, drive));
  let remaining = Math.min(dt, DT_CLAMP_S);

  let ip = state.ringPrimaryIA ?? 0;
  let ir = state.ringCurrentA ?? 0;
  let vel = state.ringVelocityMps ?? 0;
  let h = state.ringHeightM ?? 0;
  let phase = state.ringPhase ?? 0;

  const vPeakDrive = r.primaryVPeak * d;
  const driveV = (ph: number): number => vPeakDrive * Math.sin(ph);

  // Derivatives written into a shared quad so the RK4 stages allocate nothing.
  let dip = 0;
  let dir = 0;
  let dvel = 0;
  let dh = 0;
  const deriv = (ips: number, irs: number, vels: number, hs: number, vps: number): void => {
    const k = r.couplingK0 * Math.exp(-hs * invLambda);
    const M = k * sqrtLpLr;
    const dMdh = -M * invLambda;
    let D = lpLr - M * M;
    if (D < D_MIN) D = D_MIN;
    // Motional EMF: the coupling itself changes as the ring moves, so the
    // same dM/dh that produces the force also loads both circuits.
    const motional = dMdh * vels;
    const rhsP = vps - r.primaryROhm * ips - motional * irs;
    const rhsR = -r.ringROhm * irs - motional * ips;
    dip = (Lr * rhsP - M * rhsR) / D;
    dir = (Lp * rhsR - M * rhsP) / D;
    const f = ips * irs * dMdh;
    dvel = (f - r.ringMassKg * G - r.dragNsm * vels) / r.ringMassKg;
    dh = vels;
  };

  while (remaining > 1e-8) {
    let nSub = Math.ceil(remaining / H_TARGET_S);
    if (nSub < 8) nSub = 8;
    if (nSub > SUB_MAX) nSub = SUB_MAX;
    const chunk = remaining > H_TARGET_S * SUB_MAX ? H_TARGET_S * SUB_MAX : remaining;
    const hStep = chunk / nSub;

    let ok = true;
    const omegaH = omega * hStep;
    for (let sub = 0; sub < nSub; sub++) {
      const vp = driveV(phase);

      deriv(ip, ir, vel, h, vp);
      const k1a = dip, k1b = dir, k1c = dvel, k1d = dh;
      const vpm = driveV(phase + 0.5 * omegaH);
      deriv(ip + 0.5 * hStep * k1a, ir + 0.5 * hStep * k1b,
            vel + 0.5 * hStep * k1c, h + 0.5 * hStep * k1d, vpm);
      const k2a = dip, k2b = dir, k2c = dvel, k2d = dh;
      deriv(ip + 0.5 * hStep * k2a, ir + 0.5 * hStep * k2b,
            vel + 0.5 * hStep * k2c, h + 0.5 * hStep * k2d, vpm);
      const k3a = dip, k3b = dir, k3c = dvel, k3d = dh;
      const vpe = driveV(phase + omegaH);
      deriv(ip + hStep * k3a, ir + hStep * k3b,
            vel + hStep * k3c, h + hStep * k3d, vpe);
      const k4a = dip, k4b = dir, k4c = dvel, k4d = dh;

      const sixth = hStep / 6;
      const nIp = ip + sixth * (k1a + 2 * k2a + 2 * k3a + k4a);
      const nIr = ir + sixth * (k1b + 2 * k2b + 2 * k3b + k4b);
      const nVel = vel + sixth * (k1c + 2 * k2c + 2 * k3c + k4c);
      const nH = h + sixth * (k1d + 2 * k2d + 2 * k3d + k4d);
      if (!Number.isFinite(nIp) || !Number.isFinite(nIr)
          || !Number.isFinite(nVel) || !Number.isFinite(nH)) {
        ok = false;
        break;
      }
      ip = nIp;
      ir = nIr;
      vel = nVel;
      h = nH;

      // Rigid stops: the core shoulder the ring starts on, and the top of the
      // pole. Only the velocity component pushing into the stop is removed, so
      // a ring pressed down by the negative half of the force cycle stays put
      // instead of sinking through the core.
      if (h < 0) {
        h = 0;
        if (vel < 0) vel = 0;
      } else if (h > r.poleHeightM) {
        h = r.poleHeightM;
        if (vel > 0) vel = 0;
      }
      phase += omegaH;
    }
    if (!ok) break;
    remaining -= chunk;
  }

  // Wrap to one period: sin() is unchanged, and the C++ plant (which stores
  // the phase as a float) keeps full precision however long the bench runs.
  phase = phase % TWO_PI;
  if (phase < 0) phase += TWO_PI;

  const kEnd = r.couplingK0 * Math.exp(-h * invLambda);
  state.ringPrimaryIA = ip;
  state.ringCurrentA = ir;
  state.ringVelocityMps = vel;
  state.ringHeightM = h;
  state.ringPhase = phase;
  // Reported force is the instantaneous one at the state just stored, so the
  // telemetry row and the height it explains are the same sample.
  state.ringForceN = ip * ir * (-kEnd * sqrtLpLr * invLambda);
  state.ringCouplingK = kEnd;
  state.energyLevel = Math.max(0, Math.min(1, h / Math.max(r.heightRefM, 0.001)));
};

export function createJumpingRingPhysicsState(): Partial<DevicePhysicsState> {
  return {
    ringPrimaryIA: 0,
    ringCurrentA: 0,
    ringHeightM: 0,
    ringVelocityMps: 0,
    ringForceN: 0,
    ringCouplingK: JUMPING_RING.couplingK0,
    ringPhase: 0,
    energyLevel: 0
  };
}

export const JUMPING_RING_REFERENCES = [
  {
    title: 'Recent Researches in Electricity and Magnetism — the jumping ring',
    authors: 'E. Thomson (reported in J. J. Thomson)',
    year: 1893,
    note: 'The original demonstration this bench lumps: a shorted ring thrown off an AC pole'
  },
  {
    title: 'Elihu Thomson\'s jumping ring in a levitated closed-loop configuration',
    authors: 'P. J. H. Tjossem, E. C. Brost',
    year: 2011,
    note: 'Am. J. Phys. — the coupled-circuit model and why the ring hovers rather than leaves'
  },
  {
    title: 'Analysis of the jumping ring experiment',
    authors: 'C. S. Schneider, J. P. Ertel',
    year: 1998,
    note: 'Am. J. Phys. — mutual inductance falling with height and the resulting force law'
  }
];

const ringUpdateMesh: NonNullable<DevicePlugin['updateMesh']> = (instance) => {
  const s = instance.physicsState;
  const hNorm = Math.min(1, (s?.ringHeightM ?? 0) / RING.poleHeightM);
  const irNorm = Math.min(1, Math.abs(s?.ringCurrentA ?? 0) / RING.iRingMaxA);
  const ipNorm = Math.min(1, Math.abs(s?.ringPrimaryIA ?? 0) / RING.iPrimaryMaxA);
  const kNorm = Math.min(1, (s?.ringCouplingK ?? RING.couplingK0) / RING.couplingK0);
  writeMeshCylinders(instance, buildJumpingRingMesh(hNorm, irNorm, ipNorm, kNorm));
};

const ringComputeRawEnergy: NonNullable<DevicePlugin['computeRawEnergy']> = (instance, ctx) => {
  const e = instance.physicsState?.energyLevel ?? instance.energyLevel;
  return Math.min(1.0, e * 0.7 + ctx.speedNorm * 0.3);
};

const ringUpdateEffects: NonNullable<DevicePlugin['updateEffects']> = (instance, ctx) => {
  const { budget, energy, gate, pushParticle, time } = ctx;
  const flowGate = Math.pow(gate(energy, 0.03, 0.55), 1.1);
  const count = Math.floor(budget * 0.6 * flowGate);
  const s = instance.physicsState;
  const { baseY, poleU, ringRadiusU } = RING_SCENE;
  const hNorm = Math.min(1, (s?.ringHeightM ?? 0) / RING.poleHeightM);
  const irNorm = Math.min(1, Math.abs(s?.ringCurrentA ?? 0) / RING.iRingMaxA);
  const kNorm = Math.min(1, (s?.ringCouplingK ?? RING.couplingK0) / RING.couplingK0);
  const yRing = baseY + hNorm * poleU;
  // Flux packets running up the core and back down outside it, plus a ring of
  // current packets riding the aluminium. Illustrative — the particles are
  // kinematic, the ODE above is the physics (ADR-0002).
  for (let k = 0; k < count; k++) {
    const u = ((k / Math.max(1, count)) + time * (0.3 + irNorm * 0.9)) % 1;
    if (k % 5 === 0) {
      // Ring current: packets orbiting the aluminium at its live height.
      const a = u * TWO_PI + time * (1.0 + irNorm * 4.0);
      pushParticle(
        Math.cos(a) * ringRadiusU,
        yRing + Math.sin(time * 9 + k) * 0.12 * irNorm,
        Math.sin(a) * ringRadiusU,
        2.5 + Math.random()
      );
      continue;
    }
    const a = (k * 0.618) % 1 * TWO_PI;
    let y: number;
    let radius: number;
    if (u < 0.45) {
      y = baseY + (u / 0.45) * poleU;
      radius = 0.55;
    } else if (u < 0.55) {
      const t01 = (u - 0.45) / 0.1;
      y = baseY + poleU;
      radius = 0.55 + t01 * (ringRadiusU * 1.5 - 0.55);
    } else if (u < 0.95) {
      const t01 = (u - 0.55) / 0.4;
      y = baseY + poleU - t01 * poleU;
      radius = ringRadiusU * 1.5;
    } else {
      const t01 = (u - 0.95) / 0.05;
      y = baseY;
      radius = ringRadiusU * 1.5 - t01 * (ringRadiusU * 1.5 - 0.55);
    }
    // The ring squeezes the return path where it sits — a cartoon of the flux
    // it is excluding, scaled by how strongly it is still coupled.
    const near = Math.exp(-Math.abs(y - yRing) * 0.9);
    radius *= 1 + near * kNorm * 0.45;
    pushParticle(Math.cos(a) * radius, y, Math.sin(a) * radius, 3.0 + Math.random());
  }
  return true;
};

export const jumpingRingPlugin: DevicePlugin = {
  ...catalogIdentity('jumping-ring'),
  needsPhysicsState: true,
  wasmSkipsJsPhysics: true,
  defaults: {
    particleCount: 3600,
    color: [0.7, 0.8, 0.95],
    cameraOffset: [0, 7, 30]
  },
  references: JUMPING_RING_REFERENCES,
  telemetrySchema: {
    ringHeightM: { label: 'Ring height', unit: 'm', source: 'sim' },
    ringCurrentA: { label: 'Induced ring current', unit: 'A', source: 'sim' },
    ringPrimaryIA: { label: 'Primary current', unit: 'A', source: 'sim' },
    ringForceN: { label: 'Net force on ring', unit: 'N', source: 'sim' },
    ringCouplingK: { label: 'Coupling k(h)', unit: '', source: 'sim' }
  },
  meshLayout: {
    cylinders: () => buildJumpingRingMesh(0, 0, 0, 1).cylinders()
  },
  createPhysicsState: createJumpingRingPhysicsState,
  stepPhysics: stepJumpingRingPhysics,
  updateMesh: ringUpdateMesh,
  computeRawEnergy: ringComputeRawEnergy,
  updateEffects: ringUpdateEffects,
  wantsThermalHaze: false
};
