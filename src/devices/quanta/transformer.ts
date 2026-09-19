/**
 * Mutual induction / transformer classroom demo — Quanta plugin.
 *
 * Ideal two-winding model with coupling coefficient k, primary drive, and
 * resistive secondary load. Leakage toggle reduces k. Not FEM.
 *
 * Shader/wasm indices: physics/devices.json (codegen) — do not hardcode.
 *
 * References: standard undergrad transformer phasor model (Chapman / Fitzgerald).
 */

import { packInstance, type InstanceArray } from '../../device-mesh-layouts';
import {
  MATERIAL_STEEL_BASE,
  MATERIAL_STRUCTURAL,
  MATERIAL_QUANTA_COIL,
  MATERIAL_COIL_FORMER
} from '../material-roles';
import { writeMeshCylinders } from '../update-helpers';
import type { DevicePlugin } from '../types';
import type { DevicePhysicsState } from '../../renderers/shared/device-physics';
import { catalogIdentity } from '../../../generated/device-catalog';
import { TRANSFORMER } from '../../../generated/physics-constants';

export { TRANSFORMER };

function yawQuat(angleRad: number): number[] {
  const half = angleRad * 0.5;
  return [0, Math.sin(half), 0, Math.cos(half)];
}

export function buildTransformerMesh(ipA = 0, isA = 0, fluxN = 0.3): { cylinders: () => InstanceArray } {
  const steel = [0.4, 0.42, 0.46];
  const copperP = [0.85, 0.5, 0.22];
  const copperS = [0.75, 0.55, 0.18];
  const ipGlow = Math.min(0.55, 0.06 + Math.abs(ipA) * 0.04);
  const isGlow = Math.min(0.55, 0.06 + Math.abs(isA) * 0.05);
  const coreGlow = 0.05 + fluxN * 0.35;
  return {
    cylinders: (): InstanceArray => [
      packInstance([0, -0.65, 0], MATERIAL_STEEL_BASE, [0, 0, 0, 1], steel, 0.03),
      // Laminated core limbs (visual)
      packInstance([-0.55, 0.2, 0], MATERIAL_STRUCTURAL, [0, 0, 0, 1], [0.48, 0.5, 0.54], coreGlow),
      packInstance([0.55, 0.2, 0], MATERIAL_STRUCTURAL, [0, 0, 0, 1], [0.48, 0.5, 0.54], coreGlow),
      packInstance([0, 0.75, 0], MATERIAL_STRUCTURAL, yawQuat(Math.PI / 2), [0.45, 0.47, 0.5], coreGlow * 0.9),
      packInstance([0, -0.25, 0], MATERIAL_STRUCTURAL, yawQuat(Math.PI / 2), [0.45, 0.47, 0.5], coreGlow * 0.8),
      // Primary winding (left limb)
      packInstance([-0.55, 0.15, 0], MATERIAL_QUANTA_COIL, [0, 0, 0, 1], copperP, ipGlow),
      packInstance([-0.55, 0.32, 0], MATERIAL_COIL_FORMER, [0, 0, 0, 1], copperP, ipGlow * 0.85),
      // Secondary winding (right limb)
      packInstance([0.55, 0.15, 0], MATERIAL_QUANTA_COIL, [0, 0, 0, 1], copperS, isGlow),
      packInstance([0.55, 0.28, 0], MATERIAL_COIL_FORMER, [0, 0, 0, 1], copperS, isGlow * 0.85),
      // Load resistor can
      packInstance([1.35, 0.05, 0], MATERIAL_STEEL_BASE, [0, 0, 0, 1], [0.25, 0.3, 0.55], 0.08 + isGlow * 0.3)
    ]
  };
}

/** Substep target and cap — same values the C++ plant uses. */
const H_TARGET_S = 5.0e-5;
const SUB_MAX = 800;
/** Browser first frames can deliver dt ≫ 1/60; clamp like the C++ plant. */
const DT_CLAMP_S = 0.05;

/**
 * Two-winding coupled-inductor ODE, RK4 — a term-for-term port of
 * `SEGSimulator::_stepTransformer` (cpp/src/plant/transformer_plant.cpp):
 *
 *   V1 = L1 dI1/dt + M dI2/dt + R1 I1
 *   V2 = L2 dI2/dt + M dI1/dt + R2 I2,   V2 = −R_load I2
 *
 * This used to be a phasor approximation, i.e. a *third* formula that
 * neither the C++ plant nor the WGSL shared — so `?wasmPhysics=1` changed
 * every transformer reading. The fallback now mirrors the plant; the
 * JS↔native golden (`npm run test:golden`) holds it there.
 *
 * @param drive 0..1
 */
export const stepTransformerPhysics: NonNullable<DevicePlugin['stepPhysics']> = (state, dt, drive) => {
  if (!(dt > 0) || !Number.isFinite(dt)) return;

  const t = TRANSFORMER;
  const k = state.transformerLeakage ? t.kLeakage : t.kIdeal;
  const L1 = t.lpH;
  const L2 = t.lsH;
  const M = k * Math.sqrt(Math.max(L1 * L2, 1e-12));
  let D = L1 * L2 - M * M;
  if (D < 1e-8) D = 1e-8;

  const omega = 2 * Math.PI * t.fHz;
  const d = Math.max(0, Math.min(1, drive));
  let remaining = Math.min(dt, DT_CLAMP_S);

  let i1 = state.transformerIpA ?? 0;
  let i2 = state.transformerIsA ?? 0;
  let phase = state.transformerPhase ?? 0;

  // di1/di2 written into a shared pair so the RK4 stages allocate nothing.
  let di1 = 0;
  let di2 = 0;
  const deriv = (i1s: number, i2s: number, v1s: number): void => {
    const v2s = -t.rLoadOhm * i2s;
    const rhs1 = v1s - t.rpOhm * i1s;
    const rhs2 = v2s - t.rsOhm * i2s;
    di1 = (L2 * rhs1 - M * rhs2) / D;
    di2 = (L1 * rhs2 - M * rhs1) / D;
  };

  let v1 = t.vPrimaryPeak * d * Math.sin(phase);
  while (remaining > 1e-8) {
    let nSub = Math.ceil(remaining / H_TARGET_S);
    if (nSub < 8) nSub = 8;
    if (nSub > SUB_MAX) nSub = SUB_MAX;
    const chunk = remaining > H_TARGET_S * SUB_MAX ? H_TARGET_S * SUB_MAX : remaining;
    const h = chunk / nSub;

    let ok = true;
    for (let sub = 0; sub < nSub; sub++) {
      v1 = t.vPrimaryPeak * d * Math.sin(phase);

      deriv(i1, i2, v1);
      const k1a = di1, k1b = di2;
      const v1m = t.vPrimaryPeak * d * Math.sin(phase + 0.5 * omega * h);
      deriv(i1 + 0.5 * h * k1a, i2 + 0.5 * h * k1b, v1m);
      const k2a = di1, k2b = di2;
      deriv(i1 + 0.5 * h * k2a, i2 + 0.5 * h * k2b, v1m);
      const k3a = di1, k3b = di2;
      const v1e = t.vPrimaryPeak * d * Math.sin(phase + omega * h);
      deriv(i1 + h * k3a, i2 + h * k3b, v1e);
      const k4a = di1, k4b = di2;

      const n1 = i1 + (h / 6) * (k1a + 2 * k2a + 2 * k3a + k4a);
      const n2 = i2 + (h / 6) * (k1b + 2 * k2b + 2 * k3b + k4b);
      if (!Number.isFinite(n1) || !Number.isFinite(n2)) {
        ok = false;
        break;
      }
      i1 = n1;
      i2 = n2;
      phase += omega * h;
    }
    if (!ok) break;
    remaining -= chunk;
  }

  // Wrap to one period: sin() is unchanged, and the C++ plant (which stores
  // the phase as a float) keeps full precision however long the bench runs.
  const TWO_PI = 2 * Math.PI;
  phase = phase % TWO_PI;
  if (phase < 0) phase += TWO_PI;

  const lambda = L1 * i1 + M * i2;
  const lambdaRef = t.vPrimaryPeak / Math.max(omega, 1);

  state.transformerIpA = i1;
  state.transformerIsA = i2;
  state.transformerPhase = phase;
  state.transformerVp = v1;
  state.transformerVs = -t.rLoadOhm * i2;
  state.transformerK = k;
  state.transformerFluxN = Math.max(0, Math.min(1, Math.abs(lambda) / lambdaRef));
  state.transformerTurnsRatio = t.ns / t.np;
  state.energyLevel = Math.min(1, drive * 0.55 + Math.abs(i2) / 3 * 0.45);
};

export function createTransformerPhysicsState(): Partial<DevicePhysicsState> {
  return {
    transformerPhase: 0,
    transformerLeakage: false,
    transformerVp: 0,
    transformerVs: 0,
    transformerIpA: 0,
    transformerIsA: 0,
    transformerK: TRANSFORMER.kIdeal,
    transformerFluxN: 0,
    transformerTurnsRatio: TRANSFORMER.ns / TRANSFORMER.np,
    energyLevel: 0
  };
}

export const TRANSFORMER_REFERENCES = [
  {
    title: 'Electric Machinery Fundamentals — ideal transformer & coupling',
    authors: 'S. J. Chapman',
    year: 2011,
    note: 'Textbook two-winding model with magnetizing / leakage reactance'
  },
  {
    title: 'Electric Machinery — coupled-circuit transformer equations',
    authors: 'A. E. Fitzgerald, C. Kingsley, S. D. Umans',
    year: 2003,
    note: 'Mutual inductance M = k√(Lp Ls); turns ratio for referred impedances'
  }
];

const transformerUpdateMesh: NonNullable<DevicePlugin['updateMesh']> = (instance) => {
  const s = instance.physicsState;
  writeMeshCylinders(
    instance,
    buildTransformerMesh(s?.transformerIpA ?? 0, s?.transformerIsA ?? 0, s?.transformerFluxN ?? 0.3)
  );
};

const transformerComputeRawEnergy: NonNullable<DevicePlugin['computeRawEnergy']> = (instance, ctx) => {
  const e = instance.physicsState?.energyLevel ?? instance.energyLevel;
  return Math.min(1.0, e * 0.75 + ctx.speedNorm * 0.25);
};

const transformerUpdateDynamics: NonNullable<DevicePlugin['updateDynamics']> = (instance) => {
  const buf = instance.transformerFluxUniformBuffer;
  if (!buf) return;
  const s = instance.physicsState;
  instance.device.queue.writeBuffer(
    buf,
    0,
    new Float32Array([
      instance.visualizer.time ?? 0,
      s?.transformerFluxN ?? 0,
      s?.transformerK ?? TRANSFORMER.kIdeal,
      instance.geometry.fluxTotalSegments ?? 1152
    ])
  );
};

const transformerDrawWebgpu: NonNullable<DevicePlugin['drawWebgpu']> = (
  instance,
  renderPass,
  _globalUniformBuffer,
  skipEffects
) => {
  if (skipEffects) return;
  if (!instance.fluxSegmentRenderBindGroup || !instance.pipelineManager?.fluxSegmentPipeline) return;
  if (instance.fieldLineEnabled === false) return;
  const qualityScale = instance.visualizer.profiler?.qualityLevel ?? 1;
  if (qualityScale <= 0.28) return;
  const totalSegments = Math.floor((instance.geometry.fluxTotalSegments ?? 0) * qualityScale);
  if (totalSegments <= 0) return;
  renderPass.setPipeline(instance.pipelineManager.fluxSegmentPipeline);
  renderPass.setBindGroup(0, instance.fluxSegmentRenderBindGroup);
  renderPass.draw(4, totalSegments);
};

const transformerUpdateEffects: NonNullable<DevicePlugin['updateEffects']> = (instance, ctx) => {
  const { budget, energy, gate, pushParticle, time } = ctx;
  const fluxGate = Math.pow(gate(energy, 0.15, 0.7), 1.25);
  const count = Math.floor(budget * 0.4 * fluxGate);
  const ip = instance.physicsState?.transformerIpA ?? 0;
  const is = instance.physicsState?.transformerIsA ?? 0;
  for (let i = 0; i < count; i++) {
    // Primary current sense (left) → flux bridge → secondary (right)
    const u = (i / Math.max(1, count) + time * (0.3 + Math.abs(ip) * 0.05)) % 1;
    let x;
    let y;
    let z;
    if (u < 0.35) {
      const a = u / 0.35 * Math.PI * 2;
      x = -0.55 + Math.cos(a) * 0.25;
      y = 0.15 + Math.sin(a) * 0.2;
      z = Math.sin(a * 2) * 0.12;
    } else if (u < 0.65) {
      const tt = (u - 0.35) / 0.3;
      x = -0.55 + tt * 1.1;
      y = 0.55 + Math.sin(time * 4 + i) * 0.05 * Math.abs(is);
      z = 0;
    } else {
      const a = ((u - 0.65) / 0.35) * Math.PI * 2;
      x = 0.55 + Math.cos(a) * 0.22;
      y = 0.15 + Math.sin(a) * 0.18;
      z = Math.sin(a * 2 + 1) * 0.1;
    }
    pushParticle(x, y, z, 3.0 + Math.random());
  }
  return true;
};

/** Toggle ideal (high-k) vs leakage coupling — classroom switch. */
export function setTransformerLeakage(state: Partial<DevicePhysicsState> | null | undefined, enabled: boolean): void {
  if (!state) return;
  state.transformerLeakage = !!enabled;
}

export const transformerPlugin: DevicePlugin = {
  ...catalogIdentity('transformer'),
  needsPhysicsState: true,
  wasmSkipsJsPhysics: true,
  defaults: {
    particleCount: 5000,
    color: [0.95, 0.7, 0.25],
    cameraOffset: [0, 3.2, 11]
  },
  references: TRANSFORMER_REFERENCES,
  telemetrySchema: {
    transformerVp: { label: 'Primary V', unit: 'V', source: 'sim' },
    transformerVs: { label: 'Secondary V', unit: 'V', source: 'sim' },
    transformerIpA: { label: 'Primary I', unit: 'A', source: 'sim' },
    transformerIsA: { label: 'Secondary I', unit: 'A', source: 'sim' },
    transformerK: { label: 'Coupling k', unit: '', source: 'sim' },
    transformerFluxN: { label: 'Flux (norm)', unit: '', source: 'sim' }
  },
  meshLayout: {
    cylinders: () => buildTransformerMesh(0, 0, 0.3).cylinders()
  },
  createPhysicsState: createTransformerPhysicsState,
  stepPhysics: stepTransformerPhysics,
  updateDynamics: transformerUpdateDynamics,
  updateMesh: transformerUpdateMesh,
  drawWebgpu: transformerDrawWebgpu,
  computeRawEnergy: transformerComputeRawEnergy,
  updateEffects: transformerUpdateEffects,
  wantsThermalHaze: false
};
