/**
 * Lenz drop tube — Quanta classroom bench for **Lenz's law as braking**.
 *
 * A strong magnet dropped down a copper tube falls slowly: as it moves, the
 * flux through every slice of the wall changes, each slice carries a current
 * that opposes the change (Lenz), and those currents push back on the magnet.
 * `jumping-ring` shows the same law as *lift*; this bench shows it as *drag*,
 * and the drag grows with speed until it balances the magnet's weight.
 *
 * **Educational point-dipole model, not a brake-design tool and not a maglev
 * launcher.** The magnet is a point dipole p = Br·V/μ0 on the axis of a
 * thin-walled tube (wall w ≪ mean radius a). Treating the wall as a stack of
 * shorted rings and summing the force on each gives the textbook result
 *
 *   F = k·v,   k = (45/1024)·μ0²·p²·σ·w / a⁴ = (45/1024)·(Br·V)²·σ·w / a⁴
 *
 * (μ0 cancels against the moment). The terminal velocity is therefore
 * algebraic, v_t = m·g/k, and m dv/dt = m·g − k·v relaxes to it with
 * τ = m/k. Taking the same integral over the tube's extent instead of to
 * infinity gives the end taper f(depth) in closed form, so the drag fades in
 * at the mouth and out at the bottom rather than switching on.
 *
 * Stepped with the *exact* solution of that linear ODE over each substep
 * (f frozen per substep, substeps sized to the bore), so there is nothing for
 * RK4 to improve and the step is stable at any dt. No FEM, no skin depth (the
 * magnet is far too slow for one), no off-axis wobble, no contact model — and
 * **no thermal state**: at terminal velocity all of m·g·v goes into heating
 * the wall, and nothing here tracks where it goes.
 *
 * Cycle: the drive slider arms a release clamp above the mouth (drive 0 keeps
 * it closed) and sets its height. The magnet falls through, lands on the catch
 * pad, rests, and is re-clamped — so the bench repeats the demo on its own.
 *
 * JS-only by design (`wasmMode: null`): an algebraic model gains nothing from
 * a C++ mirror. Shader indices: physics/devices.json (codegen) — do not
 * hardcode.
 *
 * References: Levin, da Silveira & Rizzato (2006), the stack-of-rings
 * derivation this bench uses; MacLatchy, Backman & Bogan (1993), the classroom
 * measurement it is compared against.
 */

import { packInstance, type InstanceArray } from '../../device-mesh-layouts';
import {
  MATERIAL_COPPER,
  MATERIAL_LAB_BASE,
  MATERIAL_QUANTA_MAGNET,
  MATERIAL_STRUCTURAL
} from '../material-roles';
import { writeMeshCylinders } from '../update-helpers';
import { PHYSICAL_CONSTANTS, DROP_TUBE } from '../../../generated/physics-constants';
import type { DevicePlugin } from '../types';
import type { DevicePhysicsState } from '../../renderers/shared/device-physics';
import { catalogIdentity } from '../../../generated/device-catalog';

const G = PHYSICAL_CONSTANTS.G;

/**
 * Classroom drop-tube parameters, generated from physics/constants.json
 * (`dropTube` block). Do not re-literal SI numbers here; edit the JSON and
 * rerun `npm run codegen:constants`. `iEddyMaxA` / `vRefMps` are display
 * normalisers for the mesh glow and the particle uniforms.
 */
export const TUBE = DROP_TUBE;
export { DROP_TUBE };

const MAGNET_VOLUME_M3 = Math.PI * TUBE.magnetRadiusM * TUBE.magnetRadiusM * TUBE.magnetLengthM;
/** Magnet mass, kg — NdFeB density × cylinder volume. */
export const MAGNET_MASS_KG = TUBE.magnetDensityKgM3 * MAGNET_VOLUME_M3;
/** μ0·p = Br·V, T·m³. Every μ0 in the drag law arrives paired with a p. */
const MU0_P = TUBE.magnetBrT * MAGNET_VOLUME_M3;

/** Stage codes for `dropTubeStage`. */
export const STAGE_HELD = 0;
export const STAGE_FALLING = 1;
export const STAGE_LANDED = 2;

/** Browser first frames can deliver dt ≫ 1/60; clamp like the other plants. */
const DT_CLAMP_S = 0.05;
/** Substep bounds: the taper varies over a bore radius, so h ≈ a/(4·v). */
const H_MIN_S = 2e-4;
const H_MAX_S = 5e-3;

/** ∫ sin²θ·cos⁶θ dθ — the antiderivative behind the end taper. */
function taperG(theta: number): number {
  return 5 * theta / 128
    + Math.sin(2 * theta) / 64
    - Math.sin(4 * theta) / 128
    - Math.sin(6 * theta) / 192
    - Math.sin(8 * theta) / 1024;
}
/** taperG over (−π/2, π/2): the infinite-tube value the taper is normalised by. */
const TAPER_FULL = 5 * Math.PI / 128;

/** σ in effect, MS/m: the pinned setpoint clamped to the slider range, else the catalog tube. */
export function dropTubeSigmaMSm(state: Pick<DevicePhysicsState, 'dropTubeSigmaSetpointMSm'>): number {
  const sp = state.dropTubeSigmaSetpointMSm;
  if (typeof sp !== 'number' || !Number.isFinite(sp)) return TUBE.tubeSigmaMSm;
  return Math.max(0, Math.min(TUBE.sigmaMaxMSm, sp));
}

/** Full-tube drag coefficient k = (45/1024)·(Br·V)²·σ·w/a⁴, N·s/m. */
export function dropTubeDragCoeff(sigmaMSm: number): number {
  const a = TUBE.tubeMeanRadiusM;
  return (45 / 1024) * MU0_P * MU0_P * (sigmaMSm * 1e6) * TUBE.tubeWallM / (a * a * a * a);
}

/** Algebraic terminal velocity m·g/k, m/s — NaN for a non-conducting tube, which has none. */
export function dropTubeTerminalVelocity(sigmaMSm: number): number {
  const k = dropTubeDragCoeff(sigmaMSm);
  return k > 0 ? (MAGNET_MASS_KG * G) / k : Number.NaN;
}

/**
 * Fraction of the infinite-tube drag at magnet depth `depthM` (0 at the mouth,
 * tubeLengthM at the bottom): ∫ z²/(z²+a²)⁵ dz over the wall that exists,
 * divided by the same integral over an endless tube. 0.5 at either end, → 1
 * a few bore radii inside, → 0 a few bore radii outside.
 */
export function dropTubeDragFraction(depthM: number): number {
  const a = TUBE.tubeMeanRadiusM;
  const top = Math.atan(-depthM / a);
  const bottom = Math.atan((TUBE.tubeLengthM - depthM) / a);
  return Math.max(0, Math.min(1, (taperG(bottom) - taperG(top)) / TAPER_FULL));
}

/**
 * The two eddy-current loops, A — `[ahead, behind]` of a magnet moving down
 * at `vMps`. dI = σ·w·v·B_ρ dz, and ∫ z/(z²+a²)^{5/2} has a closed form, so
 * each is σ·w·v·(Br·V)·a/(4π)·[(z₁²+a²)^{−3/2} − (z₂²+a²)^{−3/2}] over the
 * part of the wall on that side. Deep inside both equal σ·w·v·Br·V/(4π·a²);
 * the loops circulate in opposite senses (the one ahead repels, the one
 * behind attracts — both brake).
 */
export function dropTubeEddyLoops(depthM: number, vMps: number, sigmaMSm: number): [number, number] {
  const a = TUBE.tubeMeanRadiusM;
  const a2 = a * a;
  const L = TUBE.tubeLengthM;
  const scale = (sigmaMSm * 1e6) * TUBE.tubeWallM * Math.abs(vMps) * MU0_P * a / (4 * Math.PI);
  const side = (z1: number, z2: number): number => (z2 > z1
    ? Math.pow(z1 * z1 + a2, -1.5) - Math.pow(z2 * z2 + a2, -1.5)
    : 0);
  // Wall points at depth u sit at z = u − depth relative to the magnet; the
  // tube is u ∈ [0, L]. Ahead (below) is z > 0, behind (above) is z < 0.
  const ahead = side(Math.max(0, -depthM), Math.max(0, L - depthM));
  const behind = side(Math.max(0, depthM - L), Math.max(0, depthM));
  return [scale * ahead, scale * behind];
}

/** Release-clamp depth for a drive setting, m (negative: above the mouth). */
export function dropTubeReleaseDepthM(drive: number): number {
  const d = Math.max(0, Math.min(1, drive));
  return -(TUBE.releaseMinM + d * (TUBE.releaseMaxM - TUBE.releaseMinM));
}

/** Catch-pad depth, m — where a magnet that has left the tube comes to rest. */
export const CATCH_DEPTH_M = TUBE.tubeLengthM + TUBE.catchBelowM;

/**
 * One frame of the drop-tube plant.
 *
 * @param drive 0..1 from the speed slider: 0 keeps the release clamp closed;
 *              above that it opens the clamp, and sets its height.
 */
export const stepDropTubePhysics: NonNullable<DevicePlugin['stepPhysics']> = (state, dt, drive) => {
  if (!(dt > 0) || !Number.isFinite(dt)) return;

  const d = Math.max(0, Math.min(1, Number.isFinite(drive) ? drive : 0));
  const sigma = dropTubeSigmaMSm(state);
  const k0 = dropTubeDragCoeff(sigma);
  const m = MAGNET_MASS_KG;
  const releaseDepth = dropTubeReleaseDepthM(d);
  const a = TUBE.tubeMeanRadiusM;

  let x = state.dropTubeDepthM ?? releaseDepth;
  let v = state.dropTubeVMps ?? 0;
  let stage = state.dropTubeStage ?? STAGE_HELD;
  let timer = state.dropTubeTimerS ?? 0;
  if (!Number.isFinite(x) || !Number.isFinite(v) || !Number.isFinite(timer)) {
    // Corrupt state is contained, not propagated: back into the clamp.
    x = releaseDepth;
    v = 0;
    stage = STAGE_HELD;
    timer = 0;
  }

  let remaining = Math.min(dt, DT_CLAMP_S);
  while (remaining > 1e-9) {
    if (stage === STAGE_HELD) {
      // The clamp follows the drive slider while it holds the magnet.
      x = releaseDepth;
      v = 0;
      if (d <= 0) {
        timer = 0;
        break;
      }
      const wait = TUBE.holdS - timer;
      if (remaining < wait) {
        timer += remaining;
        break;
      }
      remaining -= Math.max(0, wait);
      timer = 0;
      stage = STAGE_FALLING;
      continue;
    }

    if (stage === STAGE_LANDED) {
      x = CATCH_DEPTH_M;
      v = 0;
      const wait = TUBE.dwellS - timer;
      if (remaining < wait) {
        timer += remaining;
        break;
      }
      remaining -= Math.max(0, wait);
      timer = 0;
      stage = STAGE_HELD;
      continue;
    }

    // Falling. With f frozen, m dv/dt = m·g − k0·f·v is linear, and its exact
    // solution over h is v → v_t + (v − v_t)·e^{−λh}, λ = k0·f/m.
    let h = (0.25 * a) / Math.max(Math.abs(v), 0.01);
    h = Math.min(remaining, Math.max(H_MIN_S, Math.min(H_MAX_S, h)));
    const lambda = (k0 * dropTubeDragFraction(x)) / m;
    let nx: number;
    let nv: number;
    if (lambda * h < 1e-9) {
      nv = v + G * h;
      nx = x + v * h + 0.5 * G * h * h;
    } else {
      const decay = -Math.expm1(-lambda * h); // 1 − e^{−λh}, accurate for small λh
      const vt = G / lambda;
      nv = vt + (v - vt) * (1 - decay);
      nx = x + vt * h + ((v - vt) * decay) / lambda;
    }
    remaining -= h;
    if (nx >= CATCH_DEPTH_M) {
      x = CATCH_DEPTH_M;
      v = 0;
      stage = STAGE_LANDED;
      timer = 0;
      continue;
    }
    x = nx;
    v = nv;
  }

  const f = dropTubeDragFraction(x);
  const [ahead, behind] = dropTubeEddyLoops(x, v, sigma);
  state.dropTubeDepthM = x;
  state.dropTubeVMps = v;
  state.dropTubeStage = stage;
  state.dropTubeTimerS = timer;
  state.dropTubeClampDepthM = releaseDepth;
  state.dropTubeSigmaMSm = sigma;
  state.dropTubeInTube = f;
  state.dropTubeTerminalVMps = dropTubeTerminalVelocity(sigma);
  // Reported at the state just stored, so the drag row and the speed it
  // explains are the same sample.
  state.dropTubeDragN = k0 * f * v;
  state.dropTubeEddyIA = ahead;
  state.dropTubeEddyTrailIA = behind;
  state.energyLevel = Math.max(0, Math.min(1, Math.max(ahead, behind) / TUBE.iEddyMaxA));
};

export function createDropTubePhysicsState(): Partial<DevicePhysicsState> {
  const sigma = TUBE.tubeSigmaMSm;
  return {
    dropTubeDepthM: dropTubeReleaseDepthM(0),
    dropTubeVMps: 0,
    dropTubeStage: STAGE_HELD,
    dropTubeTimerS: 0,
    dropTubeClampDepthM: dropTubeReleaseDepthM(0),
    dropTubeSigmaMSm: sigma,
    dropTubeSigmaSetpointMSm: null,
    dropTubeInTube: 0,
    dropTubeTerminalVMps: dropTubeTerminalVelocity(sigma),
    dropTubeDragN: 0,
    dropTubeEddyIA: 0,
    dropTubeEddyTrailIA: 0,
    energyLevel: 0
  };
}

/**
 * Scene layout, in device-local render units — deliberately separate from the
 * SI numbers in `TUBE`. Travel along the tube is drawn at `unitsPerM`; the
 * bore and the magnet are drawn far larger than that (the shared instance
 * cylinder is r = 0.8, h = 2.5 and carries no per-instance scale), so near the
 * magnet distances are in bore radii, as in any textbook figure. The tube is a
 * stack of rings — the same rings the drag law is derived from — which also
 * leaves gaps to see the magnet through. Particle paths (`posDropTube` in
 * particle-compute.wgsl and `integrateDropTube` in shared/particle-physics.ts)
 * mirror these numbers.
 */
export const DROP_SCENE = Object.freeze({
  unitsPerM: 16,
  tubeTopY: 4.8,      // tube mouth (depth 0); the bottom is tubeLengthM below
  hoopCount: 4,       // rings making the tube
  hoopRadiusU: 2.6,   // ring radius (tube radius is the shared 0.8)
  hoopSegments: 8,    // tangential cylinders per ring
  magnetHalfU: 1.25,  // half the shared cylinder height
  loopOffsetU: 1.8,   // eddy loops sit just beyond the magnet's faces
  clampGapU: 0.9      // how far the clamp jaws part once they let go
});

/** Scene Y of the magnet centre for a plant depth (m). */
export function dropTubeSceneY(depthM: number): number {
  return DROP_SCENE.tubeTopY - depthM * DROP_SCENE.unitsPerM;
}

/** Scene Y of the drawn tube's bottom edge. */
const TUBE_BOTTOM_Y = dropTubeSceneY(TUBE.tubeLengthM);
/** Scene Y travel range — the highest clamp to the catch pad. */
export const DROP_Y_TOP = dropTubeSceneY(-TUBE.releaseMaxM);
export const DROP_Y_BOTTOM = dropTubeSceneY(CATCH_DEPTH_M);

/** Depth (m) → 0..1 along the full travel, highest clamp to catch pad. */
export function dropTubeTravelNorm(depthM: number): number {
  const span = CATCH_DEPTH_M + TUBE.releaseMaxM;
  return Math.max(0, Math.min(1, (depthM + TUBE.releaseMaxM) / span));
}

const SIN45 = Math.SQRT1_2;

/** +Y → ±X: quarter turn about Z (horizontal clamp jaw). */
const ALONG_X: number[] = [0, 0, SIN45, SIN45];

/** Cylinder laid tangentially at `theta` in the XZ plane (see jumping-ring.ts). */
function tangentQuat(theta: number): number[] {
  const half = (Math.PI * 0.5 - theta) * 0.5;
  const sy = Math.sin(half);
  const cy = Math.cos(half);
  return [sy * SIN45, sy * SIN45, cy * SIN45, cy * SIN45];
}

const COPPER = [0.86, 0.52, 0.28];
const NON_CONDUCTOR = [0.78, 0.82, 0.86];

/**
 * Magnet + catch pad + release clamp + the ring-stack tube.
 *
 * Instance order is the overview LOD prefix (`meshLodInstanceCount` draws the
 * first N): the magnet and the pad survive `proxy`, and the rings are emitted
 * even segments first, so `simplified` keeps every ring at half its segments
 * rather than dropping the bottom of the tube.
 *
 * @param travelNorm  dropTubeTravelNorm(depth), 0..1
 * @param aheadNorm   loop current ahead of the magnet / iEddyMaxA, 0..1
 * @param behindNorm  loop current behind it / iEddyMaxA, 0..1
 * @param sigmaNorm   σ / sigmaMaxMSm, 0..1 (wall tint: copper → plastic grey)
 * @param clampNorm   dropTubeTravelNorm(clamp depth), 0..1
 * @param held        clamp jaws closed on the magnet
 */
export function buildDropTubeMesh(
  travelNorm = dropTubeTravelNorm(dropTubeReleaseDepthM(0)),
  aheadNorm = 0,
  behindNorm = 0,
  sigmaNorm = TUBE.tubeSigmaMSm / TUBE.sigmaMaxMSm,
  clampNorm = travelNorm,
  held = true
): { cylinders: () => InstanceArray } {
  const { tubeTopY, hoopCount, hoopRadiusU, hoopSegments, magnetHalfU, loopOffsetU, clampGapU } = DROP_SCENE;
  const yAt = (n: number): number => DROP_Y_TOP + Math.max(0, Math.min(1, n)) * (DROP_Y_BOTTOM - DROP_Y_TOP);
  const yMag = yAt(travelNorm);
  const yClamp = yAt(clampNorm);
  const ahead = Math.max(0, Math.min(1, aheadNorm));
  const behind = Math.max(0, Math.min(1, behindNorm));
  const s = Math.max(0, Math.min(1, sigmaNorm));
  const wall = COPPER.map((c, i) => NON_CONDUCTOR[i] + (c - NON_CONDUCTOR[i]) * Math.sqrt(s));
  const padTop = DROP_Y_BOTTOM - magnetHalfU;

  // Ring centres: the stack spans the drawn tube exactly (each ring is 1.6 thick).
  const hoopY: number[] = [];
  const pitch = (tubeTopY - TUBE_BOTTOM_Y - 1.6) / Math.max(1, hoopCount - 1);
  for (let i = 0; i < hoopCount; i++) hoopY.push(tubeTopY - 0.8 - i * pitch);

  return {
    cylinders: (): InstanceArray => {
      const out: InstanceArray = [];
      // The magnet — the only thing on the bench that moves.
      out.push(packInstance([0, yMag, 0], MATERIAL_QUANTA_MAGNET, [0, 0, 0, 1], [0.72, 0.74, 0.8], 0.05));
      // Catch pad / pedestal under the tube.
      out.push(packInstance([0, padTop - 1.25, 0], MATERIAL_LAB_BASE, [0, 0, 0, 1], [0.2, 0.21, 0.24], 0.02));
      // Release clamp: a bar across the magnet's top face at the clamp height,
      // which parts into two jaws once it lets go.
      const jawY = yClamp + magnetHalfU + 0.5;
      const jawX = 1.25 + (held ? 0 : clampGapU);
      out.push(packInstance([-jawX, jawY, 0], MATERIAL_STRUCTURAL, ALONG_X, [0.5, 0.52, 0.56], 0.02));
      out.push(packInstance([jawX, jawY, 0], MATERIAL_STRUCTURAL, ALONG_X, [0.5, 0.52, 0.56], 0.02));
      // The tube as a stack of shorted rings. A ring glows with the eddy loop
      // nearest it, widened to the ring pitch so it reads (illustrative: the
      // real loops sit within a bore radius or two of the magnet).
      const glowFor = (y: number): number => {
        const kAhead = Math.exp(-(((y - (yMag - loopOffsetU)) / 2.2) ** 2));
        const kBehind = Math.exp(-(((y - (yMag + loopOffsetU)) / 2.2) ** 2));
        return 0.04 + 0.75 * Math.max(ahead * kAhead, behind * kBehind);
      };
      for (let pass = 0; pass < 2; pass++) {
        for (let r = 0; r < hoopCount; r++) {
          const glow = glowFor(hoopY[r]);
          for (let i = pass; i < hoopSegments; i += 2) {
            const a = (i / hoopSegments) * Math.PI * 2;
            out.push(packInstance(
              [Math.cos(a) * hoopRadiusU, hoopY[r], Math.sin(a) * hoopRadiusU],
              MATERIAL_COPPER,
              tangentQuat(a),
              wall,
              glow
            ));
          }
        }
      }
      return out;
    }
  };
}

/** Mesh for a plant state — shared by the WebGPU hot-update and the WebGL2 draw. */
export function dropTubeMeshFromState(s: Partial<DevicePhysicsState> | null | undefined): { cylinders: () => InstanceArray } {
  const depth = s?.dropTubeDepthM ?? dropTubeReleaseDepthM(0);
  return buildDropTubeMesh(
    dropTubeTravelNorm(depth),
    Math.min(1, (s?.dropTubeEddyIA ?? 0) / TUBE.iEddyMaxA),
    Math.min(1, (s?.dropTubeEddyTrailIA ?? 0) / TUBE.iEddyMaxA),
    (s?.dropTubeSigmaMSm ?? TUBE.tubeSigmaMSm) / TUBE.sigmaMaxMSm,
    dropTubeTravelNorm(s?.dropTubeClampDepthM ?? depth),
    (s?.dropTubeStage ?? STAGE_HELD) === STAGE_HELD
  );
}

/**
 * The four particle uniforms (`physics0..3`) for `posDropTube` /
 * `integrateDropTube`: travel 0..1, speed / vRefMps, and the loop currents
 * ahead of and behind the magnet / iEddyMaxA. One function, so the WebGPU
 * packer and the WebGL2 mirror normalise identically.
 */
export function dropTubeParticleUniforms(
  s: Pick<Partial<DevicePhysicsState>, 'dropTubeDepthM' | 'dropTubeVMps' | 'dropTubeEddyIA' | 'dropTubeEddyTrailIA'>
): [number, number, number, number] {
  return [
    dropTubeTravelNorm(s.dropTubeDepthM ?? dropTubeReleaseDepthM(0)),
    Math.min(1, Math.abs(s.dropTubeVMps ?? 0) / TUBE.vRefMps),
    Math.min(1, (s.dropTubeEddyIA ?? 0) / TUBE.iEddyMaxA),
    Math.min(1, (s.dropTubeEddyTrailIA ?? 0) / TUBE.iEddyMaxA)
  ];
}

export const DROP_TUBE_REFERENCES = [
  {
    title: 'Electromagnetic braking: a simple quantitative model',
    authors: 'Y. Levin, F. L. da Silveira, F. B. Rizzato',
    year: 2006,
    note: 'Am. J. Phys. — the tube as a stack of rings and the dipole drag law this bench evaluates'
  },
  {
    title: 'A quantitative magnetic braking experiment',
    authors: 'C. S. MacLatchy, P. Backman, L. Bogan',
    year: 1993,
    note: 'Am. J. Phys. — measured terminal velocities of magnets falling in copper and aluminium tubes'
  },
  {
    title: 'Electrodynamics of a magnet moving through a conducting pipe',
    authors: 'M. H. Partovi, E. J. Morris',
    year: 2006,
    note: 'Can. J. Phys. — where the thin-wall, low-speed (no skin depth) limit used here holds'
  }
];

const tubeUpdateMesh: NonNullable<DevicePlugin['updateMesh']> = (instance) => {
  writeMeshCylinders(instance, dropTubeMeshFromState(instance.physicsState));
};

const tubeComputeRawEnergy: NonNullable<DevicePlugin['computeRawEnergy']> = (instance) => {
  return instance.physicsState?.energyLevel ?? instance.energyLevel;
};

const tubeUpdateEffects: NonNullable<DevicePlugin['updateEffects']> = (instance, ctx) => {
  const { budget, energy, gate, pushParticle, time } = ctx;
  const s = instance.physicsState;
  const vN = Math.min(1, Math.abs(s?.dropTubeVMps ?? 0) / TUBE.vRefMps);
  const count = Math.floor(budget * 0.4 * Math.max(gate(energy, 0.02, 0.5), vN));
  const yMag = dropTubeSceneY(s?.dropTubeDepthM ?? dropTubeReleaseDepthM(0));
  const { hoopRadiusU, loopOffsetU, magnetHalfU } = DROP_SCENE;
  const aheadN = Math.min(1, (s?.dropTubeEddyIA ?? 0) / TUBE.iEddyMaxA);
  const behindN = Math.min(1, (s?.dropTubeEddyTrailIA ?? 0) / TUBE.iEddyMaxA);
  // Sparks riding the two eddy loops, plus a short wake above the magnet.
  // Illustrative — the particles are kinematic, the plant above is the physics.
  for (let k = 0; k < count; k++) {
    const u = (k / Math.max(1, count) + time * 0.7) % 1;
    if (k % 3 === 2) {
      pushParticle(
        Math.sin(k * 2.39) * 0.35,
        yMag + magnetHalfU + u * (0.6 + vN * 6),
        Math.cos(k * 2.39) * 0.35,
        2.0 + Math.random()
      );
      continue;
    }
    const isAhead = k % 3 === 0;
    const strength = isAhead ? aheadN : behindN;
    if (strength < 0.02) continue;
    const dir = isAhead ? 1 : -1;
    const a = u * Math.PI * 2 * dir + time * (1 + strength * 5) * dir;
    pushParticle(
      Math.cos(a) * hoopRadiusU,
      yMag + (isAhead ? -loopOffsetU : loopOffsetU),
      Math.sin(a) * hoopRadiusU,
      2.5 + Math.random()
    );
  }
  return true;
};

export const dropTubePlugin: DevicePlugin = {
  ...catalogIdentity('drop-tube'),
  needsPhysicsState: true,
  defaults: {
    particleCount: 2400,
    color: [0.95, 0.6, 0.3],
    cameraOffset: [0, 6, 30]
  },
  references: DROP_TUBE_REFERENCES,
  telemetrySchema: {
    dropTubeVMps: { label: 'Magnet speed', unit: 'm/s', source: 'sim' },
    dropTubeTerminalVMps: { label: 'Terminal velocity m·g/k', unit: 'm/s', source: 'sim' },
    dropTubeDragN: { label: 'Eddy drag', unit: 'N', source: 'sim' },
    dropTubeEddyIA: { label: 'Eddy loop ahead of the magnet', unit: 'A', source: 'sim' },
    dropTubeDepthM: { label: 'Depth below the mouth', unit: 'm', source: 'sim' }
  },
  meshLayout: {
    cylinders: () => buildDropTubeMesh().cylinders()
  },
  createPhysicsState: createDropTubePhysicsState,
  stepPhysics: stepDropTubePhysics,
  updateMesh: tubeUpdateMesh,
  computeRawEnergy: tubeComputeRawEnergy,
  updateEffects: tubeUpdateEffects,
  wantsThermalHaze: false
};
