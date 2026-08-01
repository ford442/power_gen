/**
 * Mutual induction / transformer classroom demo — Quanta plugin.
 *
 * Ideal two-winding model with coupling coefficient k, primary drive, and
 * resistive secondary load. Leakage toggle reduces k. Not FEM.
 *
 * modeIndex: 10 (first free JS/shader slot — see docs/MODE_MATRIX.md).
 * WASM L–M circuit: optional Phase 2 (no SimMode yet).
 *
 * References: standard undergrad transformer phasor model (Chapman / Fitzgerald).
 */

import { packInstance } from '../../device-mesh-layouts.js';
import {
  MATERIAL_STEEL_BASE,
  MATERIAL_STRUCTURAL,
  MATERIAL_QUANTA_COIL,
  MATERIAL_COIL_FORMER
} from '../material-roles.js';
import { writeMeshCylinders } from '../update-helpers';

export const TRANSFORMER = Object.freeze({
  fHz: 60,
  np: 120,
  ns: 40,
  lpH: 0.85,
  lsH: 0.095,
  kIdeal: 0.97,
  kLeakage: 0.72,
  rpOhm: 1.8,
  rsOhm: 0.45,
  rLoadOhm: 12,
  vPrimaryPeak: 28 // low-voltage classroom metaphor
});

function yawQuat(angleRad) {
  const half = angleRad * 0.5;
  return [0, Math.sin(half), 0, Math.cos(half)];
}

export function buildTransformerMesh(ipA = 0, isA = 0, fluxN = 0.3) {
  const steel = [0.4, 0.42, 0.46];
  const copperP = [0.85, 0.5, 0.22];
  const copperS = [0.75, 0.55, 0.18];
  const ipGlow = Math.min(0.55, 0.06 + Math.abs(ipA) * 0.04);
  const isGlow = Math.min(0.55, 0.06 + Math.abs(isA) * 0.05);
  const coreGlow = 0.05 + fluxN * 0.35;
  return {
    cylinders: () => [
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

/**
 * Phasor-domain ideal coupled inductors at line frequency.
 * Primary driven as V_p = Vpeak·drive·sin(ωt); secondary loaded by R_load.
 *
 * @param {object} state
 * @param {number} dt
 * @param {number} drive 0..1
 */
export function stepTransformerPhysics(state, dt, drive) {
  const t = TRANSFORMER;
  const omega = 2 * Math.PI * t.fHz;
  state.transformerPhase = (state.transformerPhase ?? 0) + omega * dt;
  if (state.transformerPhase > omega * 100) state.transformerPhase -= omega * 100;

  const leakage = !!state.transformerLeakage;
  const k = leakage ? t.kLeakage : t.kIdeal;
  const M = k * Math.sqrt(t.lpH * t.lsH);
  const vp = t.vPrimaryPeak * Math.max(0, Math.min(1, drive)) * Math.sin(state.transformerPhase);

  // Steady-state phasor approx refreshed each frame (educational, not ODE stiff solve)
  const xp = omega * t.lpH;
  const xs = omega * t.lsH;
  const xm = omega * M;
  // Simplified: Ip ≈ Vp / (Rp + jXp) with reflected load
  const n = t.ns / t.np;
  const rReflected = t.rLoadOhm / Math.max(n * n, 1e-6);
  const zMag = Math.hypot(t.rpOhm + rReflected * (k * k), xp * (1 - k * k * 0.15));
  const ip = vp / Math.max(zMag, 0.05);
  const vsIdeal = n * vp * k;
  const is = vsIdeal / Math.max(t.rsOhm + t.rLoadOhm, 0.05);
  const fluxN = Math.min(1, Math.abs(vp) / (t.vPrimaryPeak + 1e-6) * k);

  state.transformerVp = vp;
  state.transformerVs = vsIdeal;
  state.transformerIpA = ip;
  state.transformerIsA = is;
  state.transformerK = k;
  state.transformerFluxN = fluxN;
  state.transformerTurnsRatio = n;
  state.energyLevel = Math.min(1, drive * 0.55 + Math.abs(is) / 3 * 0.45);
}

export function createTransformerPhysicsState() {
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

function transformerUpdateMesh(instance) {
  const s = instance.physicsState || {};
  writeMeshCylinders(
    instance,
    buildTransformerMesh(s.transformerIpA ?? 0, s.transformerIsA ?? 0, s.transformerFluxN ?? 0.3)
  );
}

function transformerComputeRawEnergy(instance, ctx) {
  const e = instance.physicsState?.energyLevel ?? instance.energyLevel;
  return Math.min(1.0, e * 0.75 + ctx.speedNorm * 0.25);
}

function transformerUpdateEffects(instance, ctx) {
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
      const t = (u - 0.35) / 0.3;
      x = -0.55 + t * 1.1;
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
}

/** Toggle ideal (high-k) vs leakage coupling — classroom switch. */
export function setTransformerLeakage(state, enabled) {
  if (!state) return;
  state.transformerLeakage = !!enabled;
}

export const transformerPlugin = {
  id: 'transformer',
  label: 'Mutual Induction',
  category: 'quanta',
  modeIndex: 10,
  needsPhysicsState: true,
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
  updateMesh: transformerUpdateMesh,
  computeRawEnergy: transformerComputeRawEnergy,
  updateEffects: transformerUpdateEffects,
  wantsThermalHaze: false
};
