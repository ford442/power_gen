/**
 * Hall-effect sensor bench — Quanta classroom metrology demo. Pairs with
 * Homopolar / Halbach (current-carrying conductor in a magnetic field).
 *
 * Lumped model: a conducting strip carries current I through a
 * perpendicular field B. The Lorentz force on the moving carriers piles up
 * charge across the strip width until the resulting transverse E-field
 * balances it, giving the classic Hall voltage:
 *
 *   V_H = I·B / (n·e·t)        R_H = 1 / (n·e)
 *
 * where n is the carrier density, e the elementary charge, t the strip
 * thickness. A classroom toggle switches n/t between a doped-semiconductor
 * sample (large, easily-read V_H) and a metal sample (tiny V_H — the same
 * current and field, but ~1e7× smaller signal, which is *why* semiconductor
 * Hall probes are used in practice).
 *
 * I and B here are both driven by the shared speed/drive control (this
 * bench has no live coupling to halbach-viz's field estimate — a simpler,
 * self-contained choice; see docs/DEVICE_GALLERY.md).
 *
 * Educational model — not a calibrated metrology instrument. Shader/wasm
 * indices: physics/devices.json (codegen) — do not hardcode.
 *
 * References: Hall, E. H. (1879), "On a New Action of the Magnet on
 * Electric Currents".
 */

import { packInstance, type InstanceArray } from '../../device-mesh-layouts';
import {
  MATERIAL_STEEL_BASE,
  MATERIAL_STRUCTURAL,
  MATERIAL_QUANTA_COIL,
  MATERIAL_QUANTA_BRUSH
} from '../material-roles';
import { writeMeshCylinders } from '../update-helpers';
import type { DevicePlugin } from '../types';
import type { DevicePhysicsState } from '../../renderers/shared/device-physics';
import { catalogIdentity } from '../../../generated/device-catalog';

/** CODATA elementary charge (C) — no shared constant exported for this yet. */
const ELEMENTARY_CHARGE = 1.602176634e-19;

/** Carrier density (m⁻³) and strip thickness (m) per classroom sample type. */
const HALL_CARRIER_PROFILES = Object.freeze({
  semiconductor: { n: 1.0e21, tM: 5.0e-4 },
  metal: { n: 8.5e28, tM: 1.0e-4 }
});

/** Classroom-scale Hall bench parameters. */
export const HALL = Object.freeze({
  stripLengthM: 0.5,
  stripWidthM: 0.08,
  iMaxA: 1.2,
  bMaxT: 0.65,
  smoothingTau: 0.25 // seconds, for I/B tracking the drive control
});

/** V_H = I·B / (n·e·t). */
export function hallVoltage(currentA: number, fieldT: number, carrier: keyof typeof HALL_CARRIER_PROFILES): number {
  const { n, tM } = HALL_CARRIER_PROFILES[carrier];
  return (currentA * fieldT) / (n * ELEMENTARY_CHARGE * tM);
}

/** R_H = 1 / (n·e). */
export function hallCoefficient(carrier: keyof typeof HALL_CARRIER_PROFILES): number {
  const { n } = HALL_CARRIER_PROFILES[carrier];
  return 1 / (n * ELEMENTARY_CHARGE);
}

/** Toggle semiconductor vs. metal sample — classroom switch (mirrors transformer's leakage toggle). */
export function setHallCarrierType(
  state: Partial<DevicePhysicsState> | null | undefined,
  carrier: 'semiconductor' | 'metal'
): void {
  if (!state) return;
  state.hallCarrierType = carrier;
}

/** Strip + current leads + a probe pair reading the transverse Hall voltage. */
export function buildHallMesh(currentNorm = 0, fieldNorm = 0): { cylinders: () => InstanceArray } {
  const strip = [0.55, 0.58, 0.62];
  const leadGlow = 0.05 + currentNorm * 0.5;
  const probeGlow = 0.05 + fieldNorm * 0.4;
  const L = HALL.stripLengthM;
  const w = HALL.stripWidthM;
  return {
    cylinders: (): InstanceArray => [
      packInstance([0, -0.35, 0], MATERIAL_STEEL_BASE, [0, 0, 0, 1], [0.4, 0.42, 0.46], 0.03),
      // Conducting strip, laid along X
      packInstance([0, 0, 0], MATERIAL_STRUCTURAL, [0, 0.7071, 0, 0.7071], strip, 0.04),
      // Current leads at each end
      packInstance([-L * 0.5 - 0.06, 0, 0], MATERIAL_QUANTA_COIL, [0, 0, 0, 1], [0.85, 0.55, 0.2], leadGlow),
      packInstance([L * 0.5 + 0.06, 0, 0], MATERIAL_QUANTA_COIL, [0, 0, 0, 1], [0.85, 0.55, 0.2], leadGlow),
      // Hall-voltage probe pair, perpendicular to the strip (Z axis)
      packInstance([0, 0, w * 0.5 + 0.05], MATERIAL_QUANTA_BRUSH, [0, 0, 0, 1], [0.3, 0.75, 0.95], probeGlow),
      packInstance([0, 0, -w * 0.5 - 0.05], MATERIAL_QUANTA_BRUSH, [0, 0, 0, 1], [0.3, 0.75, 0.95], probeGlow)
    ]
  };
}

/**
 * Both I and B track the shared drive control (smoothed, so slider moves
 * read as a brief transient rather than a step). V_H/R_H are pure algebraic
 * functions of the instantaneous I, B, and carrier profile — no ODE
 * stiffness here.
 *
 * @param drive 0..1 from the speed slider
 */
export const stepHallPhysics: NonNullable<DevicePlugin['stepPhysics']> = (state, dt, drive) => {
  const d = Math.max(0, Math.min(1, drive));
  const carrier = state.hallCarrierType ?? 'semiconductor';

  const iTarget = d * HALL.iMaxA;
  const bTarget = d * HALL.bMaxT;
  const alpha = Math.min(1, dt / HALL.smoothingTau);
  const current = (state.hallCurrent ?? 0) + (iTarget - (state.hallCurrent ?? 0)) * alpha;
  const fieldT = (state.hallFieldT ?? 0) + (bTarget - (state.hallFieldT ?? 0)) * alpha;

  state.hallCurrent = current;
  state.hallFieldT = fieldT;
  state.hallCarrierType = carrier;
  state.hallVoltage = hallVoltage(current, fieldT, carrier);
  state.hallCoeff = hallCoefficient(carrier);
  state.energyLevel = Math.min(1, d);
};

export function createHallPhysicsState(): Partial<DevicePhysicsState> {
  return {
    hallCurrent: 0,
    hallFieldT: 0,
    hallCarrierType: 'semiconductor',
    hallVoltage: 0,
    hallCoeff: hallCoefficient('semiconductor'),
    energyLevel: 0
  };
}

export const HALL_REFERENCES = [
  {
    title: 'On a New Action of the Magnet on Electric Currents',
    authors: 'E. H. Hall',
    year: 1879,
    note: 'Original discovery of the Hall effect'
  },
  {
    title: 'Solid State Physics (carrier density and the Hall coefficient)',
    authors: 'N. W. Ashcroft, N. D. Mermin',
    year: 1976,
    note: 'R_H = 1/(ne); typical metal vs. semiconductor carrier densities'
  }
];

const hallUpdateMesh: NonNullable<DevicePlugin['updateMesh']> = (instance) => {
  const s = instance.physicsState;
  const iNorm = Math.min(1, (s?.hallCurrent ?? 0) / HALL.iMaxA);
  const bNorm = Math.min(1, (s?.hallFieldT ?? 0) / HALL.bMaxT);
  writeMeshCylinders(instance, buildHallMesh(iNorm, bNorm));
};

const hallComputeRawEnergy: NonNullable<DevicePlugin['computeRawEnergy']> = (instance, ctx) => {
  const e = instance.physicsState?.energyLevel ?? instance.energyLevel;
  return Math.min(1.0, e * 0.7 + ctx.speedNorm * 0.3);
};

const hallUpdateEffects: NonNullable<DevicePlugin['updateEffects']> = (instance, ctx) => {
  const { budget, energy, gate, pushParticle, time } = ctx;
  const flowGate = Math.pow(gate(energy, 0.05, 0.6), 1.1);
  const count = Math.floor(budget * 0.6 * flowGate);
  const L = HALL.stripLengthM;
  const w = HALL.stripWidthM;
  const fieldT = instance.physicsState?.hallFieldT ?? 0;
  const deflect = Math.min(1, fieldT / HALL.bMaxT);
  // Carriers drifting along the strip, visually deflected toward one edge
  // by the field (illustrative — not a real per-particle Lorentz integrator).
  for (let i = 0; i < count; i++) {
    const u = (i / Math.max(1, count) + time * 0.5) % 1;
    const x = -L * 0.5 + u * L;
    const z = (u - 0.5) * w * deflect;
    pushParticle(x, Math.sin(time * 3 + i) * 0.02, z, 3.0 + Math.random());
  }
  return true;
};

export const hallPlugin: DevicePlugin = {
  ...catalogIdentity('hall'),
  needsPhysicsState: true,
  wasmSkipsJsPhysics: true,
  defaults: {
    particleCount: 3200,
    color: [0.3, 0.75, 0.95],
    cameraOffset: [0, 2.2, 8]
  },
  references: HALL_REFERENCES,
  telemetrySchema: {
    hallVoltage: { label: 'Hall voltage', unit: 'V', source: 'sim' },
    hallCurrent: { label: 'Strip current', unit: 'A', source: 'sim' },
    hallFieldT: { label: 'Field B', unit: 'T', source: 'sim' },
    hallCoeff: { label: 'Hall coefficient R_H', unit: 'm³/C', source: 'sim' }
  },
  meshLayout: {
    cylinders: () => buildHallMesh(0, 0).cylinders()
  },
  createPhysicsState: createHallPhysicsState,
  stepPhysics: stepHallPhysics,
  updateMesh: hallUpdateMesh,
  computeRawEnergy: hallComputeRawEnergy,
  updateEffects: hallUpdateEffects,
  wantsThermalHaze: false
};
