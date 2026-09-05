/**
 * Van de Graaff generator — Quanta classroom electrostatics demo. Pairs with
 * Kelvin's Thunderstorm (both build voltage via charge separation + spark
 * breakdown, not free energy).
 *
 * Lumped model: a charged belt carries current onto an isolated conducting
 * sphere. Sphere voltage follows Q = CV for an isolated sphere
 * (C = 4πε₀r); air leakage bleeds charge slowly, and a spark gap discharges
 * the sphere once V crosses the breakdown threshold for the gap distance
 * (E ≈ 3 MV/m in dry air — the same rule-of-thumb Kelvin's plant uses).
 *
 * Educational model — classroom electrostatics, not a high-voltage
 * engineering design. Shader/wasm indices: physics/devices.json (codegen) —
 * do not hardcode.
 *
 * References: standard undergrad electrostatics (Van de Graaff, 1929 —
 * "A 1,500,000 Volt Electrostatic Generator").
 */

import { packInstance, type InstanceArray } from '../../device-mesh-layouts';
import {
  MATERIAL_STEEL_BASE,
  MATERIAL_STRUCTURAL,
  MATERIAL_QUANTA_FLOATER,
  MATERIAL_QUANTA_BRUSH
} from '../material-roles';
import { writeMeshCylinders } from '../update-helpers';
import { ValidatedConstants } from '../../ValidatedConstants';
import type { DevicePlugin } from '../types';
import type { DevicePhysicsState } from '../../renderers/shared/device-physics';
import { catalogIdentity } from '../../../generated/device-catalog';

const EPSILON_0 = ValidatedConstants.EPSILON_0?.value ?? 8.8541878128e-12;
/** Dry-air dielectric breakdown field, classroom rule of thumb (matches kelvin_plant.cpp). */
const E_AIR_BREAKDOWN = 3.0e6; // V/m

/** Classroom-scale Van de Graaff parameters. */
export const VDG = Object.freeze({
  sphereRadiusM: 0.14,
  columnHeightM: 1.05,
  gapM: 0.05, // spark-gap distance to the discharge electrode
  beltMaxMps: 6, // belt surface speed at drive = 1
  beltMaxCurrentA: 2.2e-6, // charge transfer current at full belt speed
  leakageROhm: 5.0e13, // air/corona leakage resistance (large — spark-limited, not leakage-limited)
  sparkDischargeFrac: 0.05, // fraction of charge remaining right after a spark
  sparkDurS: 0.15,
  sparkRateWindowS: 1.0
});

/** Isolated-sphere capacitance C = 4πε₀r. */
export const VDG_CAPACITANCE_F = 4 * Math.PI * EPSILON_0 * VDG.sphereRadiusM;
/** Breakdown voltage for the configured spark-gap distance. */
export const VDG_V_BREAK = E_AIR_BREAKDOWN * VDG.gapM;

function yawQuat(angleRad: number): number[] {
  const half = angleRad * 0.5;
  return [0, Math.sin(half), 0, Math.cos(half)];
}

/**
 * Column + belt + sphere. `sparkGlow` (0..1) brightens the discharge
 * electrode right after a spark; `chargeNorm` (0..1, V/V_break) tints the
 * sphere.
 */
export function buildVdgMesh(chargeNorm = 0, sparkGlow = 0): { cylinders: () => InstanceArray } {
  const steel = [0.42, 0.44, 0.48];
  const belt = [0.15, 0.15, 0.17];
  const sphereColor = [0.75, 0.8, 0.86];
  const sphereGlow = 0.05 + chargeNorm * 0.5;
  const h = VDG.columnHeightM;
  return {
    cylinders: (): InstanceArray => [
      // Base + insulating column
      packInstance([0, -0.55, 0], MATERIAL_STEEL_BASE, [0, 0, 0, 1], steel, 0.03),
      packInstance([0, -0.55 + h * 0.5, 0], MATERIAL_STRUCTURAL, [0, 0, 0, 1], [0.85, 0.82, 0.7], 0.02),
      // Belt loop (two vertical runs, visual only)
      packInstance([0.09, -0.2, 0], MATERIAL_QUANTA_BRUSH, [0, 0, 0, 1], belt, 0.04),
      packInstance([-0.09, -0.2, 0], MATERIAL_QUANTA_BRUSH, [0, 0, 0, 1], belt, 0.04),
      // Sphere terminal atop the column
      packInstance([0, h * 0.55, 0], MATERIAL_QUANTA_FLOATER, [0, 0, 0, 1], sphereColor, sphereGlow),
      // Discharge electrode, offset by the spark-gap distance
      packInstance([VDG.gapM * 3 + 0.18, h * 0.55, 0], MATERIAL_STEEL_BASE, yawQuat(Math.PI / 2),
        [0.6, 0.62, 0.66], 0.04 + sparkGlow * 0.9)
    ]
  };
}

/**
 * Belt charge transport → isolated-sphere voltage → spark-gap breakdown.
 * `dQ/dt = beltCurrentA(drive) − V/R_leak`; on `V ≥ V_break` the sphere
 * discharges to a small fraction of its charge and a spark timer starts.
 *
 * @param drive 0..1 from the speed slider (belt motor speed)
 */
export const stepVdgPhysics: NonNullable<DevicePlugin['stepPhysics']> = (state, dt, drive) => {
  const d = Math.max(0, Math.min(1, drive));
  const beltMps = d * VDG.beltMaxMps;
  const beltCurrentA = d * VDG.beltMaxCurrentA;

  let chargeC = state.vdgChargeC ?? 0;
  let sparkTimer = state.vdgSparkTimer ?? 0;
  let sparkAccum = state.vdgSparkAccum ?? 0;
  let windowT = state.vdgSparkWindowT ?? 0;
  let sparkHz = state.vdgSparkHz ?? 0;

  const voltageBefore = chargeC / VDG_CAPACITANCE_F;
  const leakageA = voltageBefore / VDG.leakageROhm;
  chargeC = Math.max(0, chargeC + (beltCurrentA - leakageA) * dt);

  let voltage = chargeC / VDG_CAPACITANCE_F;
  if (sparkTimer > 0) {
    sparkTimer = Math.max(0, sparkTimer - dt);
  } else if (voltage >= VDG_V_BREAK) {
    chargeC *= VDG.sparkDischargeFrac;
    voltage = chargeC / VDG_CAPACITANCE_F;
    sparkTimer = VDG.sparkDurS;
    sparkAccum += 1;
  }

  windowT += dt;
  if (windowT >= VDG.sparkRateWindowS) {
    sparkHz = sparkAccum / windowT;
    sparkAccum = 0;
    windowT = 0;
  }

  state.vdgChargeC = chargeC;
  state.vdgVoltage = voltage;
  state.vdgBeltMps = beltMps;
  state.vdgSparkTimer = sparkTimer;
  state.vdgSparkAccum = sparkAccum;
  state.vdgSparkWindowT = windowT;
  state.vdgSparkHz = sparkHz;
  state.energyLevel = Math.min(1, d * 0.4 + Math.min(1, voltage / VDG_V_BREAK) * 0.6);
};

export function createVdgPhysicsState(): Partial<DevicePhysicsState> {
  return {
    vdgChargeC: 0,
    vdgVoltage: 0,
    vdgBeltMps: 0,
    vdgSparkTimer: 0,
    vdgSparkAccum: 0,
    vdgSparkWindowT: 0,
    vdgSparkHz: 0,
    energyLevel: 0
  };
}

export const VDG_REFERENCES = [
  {
    title: 'A 1,500,000 Volt Electrostatic Generator',
    authors: 'R. J. Van de Graaff',
    year: 1929,
    note: 'Original belt-charging electrostatic generator design'
  },
  {
    title: 'Introduction to Electrodynamics (capacitance of an isolated sphere)',
    authors: 'D. J. Griffiths',
    year: 2017,
    note: 'C = 4πε₀r for an isolated conducting sphere; classroom breakdown-field estimate'
  }
];

const vdgUpdateMesh: NonNullable<DevicePlugin['updateMesh']> = (instance) => {
  const s = instance.physicsState;
  const chargeNorm = Math.min(1, (s?.vdgVoltage ?? 0) / VDG_V_BREAK);
  const sparkGlow = Math.min(1, (s?.vdgSparkTimer ?? 0) / VDG.sparkDurS);
  writeMeshCylinders(instance, buildVdgMesh(chargeNorm, sparkGlow));
};

const vdgComputeRawEnergy: NonNullable<DevicePlugin['computeRawEnergy']> = (instance, ctx) => {
  const e = instance.physicsState?.energyLevel ?? instance.energyLevel;
  return Math.min(1.0, e * 0.8 + ctx.speedNorm * 0.2);
};

const vdgUpdateEffects: NonNullable<DevicePlugin['updateEffects']> = (instance, ctx) => {
  const { budget, energy, gate, pushParticle, time } = ctx;
  const beltGate = Math.pow(gate(energy, 0.05, 0.6), 1.1);
  const beltCount = Math.floor(budget * 0.55 * beltGate);
  const h = VDG.columnHeightM;
  // Charge packets riding the belt loop (visual — not a real Coulomb-force sim).
  for (let i = 0; i < beltCount; i++) {
    const u = (i / Math.max(1, beltCount) + time * 0.6) % 1;
    const y = -0.55 + u * (h * 0.55 + 0.55);
    const side = i % 2 === 0 ? 0.09 : -0.09;
    pushParticle(side, y, 0, 3.0 + Math.random());
  }
  const sparkTimer = instance.physicsState?.vdgSparkTimer ?? 0;
  if (sparkTimer > 0) {
    const sparkGlow = sparkTimer / VDG.sparkDurS;
    const sparkCount = Math.floor(budget * 0.35 * sparkGlow);
    const x0 = 0.18;
    const x1 = VDG.gapM * 3 + 0.18;
    for (let i = 0; i < sparkCount; i++) {
      const t = Math.random();
      const jitter = (Math.random() - 0.5) * 0.05;
      pushParticle(x0 + (x1 - x0) * t, h * 0.55 + jitter, jitter, 4.0 + Math.random() * 2);
    }
  }
  return true;
};

export const vdgPlugin: DevicePlugin = {
  ...catalogIdentity('vdg'),
  needsPhysicsState: true,
  wasmSkipsJsPhysics: true,
  defaults: {
    particleCount: 3600,
    color: [0.8, 0.85, 0.95],
    cameraOffset: [0, 2.8, 9]
  },
  references: VDG_REFERENCES,
  telemetrySchema: {
    vdgVoltage: { label: 'Sphere voltage', unit: 'V', source: 'sim' },
    vdgBeltMps: { label: 'Belt speed', unit: 'm/s', source: 'sim' },
    vdgChargeC: { label: 'Sphere charge', unit: 'C', source: 'sim' },
    vdgSparkHz: { label: 'Spark rate', unit: 'Hz', source: 'sim' }
  },
  meshLayout: {
    cylinders: () => buildVdgMesh(0, 0).cylinders()
  },
  createPhysicsState: createVdgPhysicsState,
  stepPhysics: stepVdgPhysics,
  updateMesh: vdgUpdateMesh,
  computeRawEnergy: vdgComputeRawEnergy,
  updateEffects: vdgUpdateEffects,
  wantsThermalHaze: false
};
