/**
 * MHD Hartmann channel — mesh + JS plant fallback + flow-arrow cues.
 * WASM channel plant remains authoritative with `?wasmPhysics=1`.
 */

import { packInstance, type InstanceArray } from '../../device-mesh-layouts';
import { MHD } from '../../../generated/physics-constants';
import { MATERIAL_STEEL_BASE, MATERIAL_STRUCTURAL, MATERIAL_QUANTA_COIL } from '../material-roles';
import { writeMeshCylinders } from '../update-helpers';
import type { DeviceInstanceLike, DevicePlugin } from '../types';
import type { DevicePhysicsState } from '../../renderers/shared/device-physics';

/**
 * Channel parameters — the single set shared with the C++ plant. Generated
 * from physics/constants.json (`mhd` block) into `MHD` (TS) and
 * `power_gen::MhdConstants` (C++). Do not re-literal SI numbers here; edit
 * the JSON and rerun `npm run codegen:constants`.
 */
export const MHD_PARAMS = MHD;
export { MHD };

/**
 * Rectangular duct + magnet poles. Arrow-ish cylinders along +X for flow cue.
 */
export function buildMhdMesh(flowU = 0.5, bFieldT = 0.4, hartmann = 1): { cylinders: () => InstanceArray } {
  const uN = Math.max(0, Math.min(1, flowU / MHD_PARAMS.flowUMaxMps));
  const bN = Math.max(0, Math.min(1, bFieldT / 1.0));
  const haN = Math.max(0, Math.min(1, hartmann / 40));
  const yawX = [0, Math.sin(Math.PI / 4), 0, Math.cos(Math.PI / 4)];
  const steel = [0.42, 0.45, 0.5];
  const fluid = [0.25, 0.75, 0.95];
  const magnet = [0.75, 0.2, 0.25];
  return {
    cylinders: () => [
      packInstance([0, -0.7, 0], MATERIAL_STEEL_BASE, [0, 0, 0, 1], steel, 0.03),
      // Channel walls (visual)
      packInstance([0, 0.05, 0.55], MATERIAL_STRUCTURAL, [0, 0, 0, 1], steel, 0.04),
      packInstance([0, 0.05, -0.55], MATERIAL_STRUCTURAL, [0, 0, 0, 1], steel, 0.04),
      // Flow core
      packInstance([0, 0.05, 0], MATERIAL_QUANTA_COIL, yawX, fluid, 0.12 + uN * 0.45),
      // Magnet poles (B across channel)
      packInstance([0, 0.85, 0], MATERIAL_STRUCTURAL, [0, 0, 0, 1], magnet, 0.1 + bN * 0.4),
      packInstance([0, -0.55, 0], MATERIAL_STRUCTURAL, [0, 0, 0, 1], magnet, 0.08 + bN * 0.35),
      // Flow arrow heads along +X
      packInstance([-1.2, 0.35, 0], MATERIAL_QUANTA_COIL, yawX, [0.3, 0.9, 1.0], 0.15 + uN * 0.5),
      packInstance([0.2, 0.35, 0], MATERIAL_QUANTA_COIL, yawX, [0.3, 0.9, 1.0], 0.12 + uN * 0.45),
      packInstance([1.4, 0.35, 0], MATERIAL_QUANTA_COIL, yawX, [0.3, 0.9, 1.0], 0.1 + uN * 0.4 + haN * 0.1)
    ]
  };
}

export const stepMhdPhysics: NonNullable<DevicePlugin['stepPhysics']> = (state, dt, drive) => {
  const m = MHD_PARAMS;
  const bFieldT = m.bFieldBaseT + m.bFieldSpanT * drive;
  let flowU = state.mhdFlowU ?? 0;
  const accel = drive * m.pumpAccelMs2 - (m.lorentzK * bFieldT * bFieldT + m.frictionK) * flowU;
  flowU = Math.max(0, Math.min(m.flowUMaxMps * 2, flowU + accel * dt));
  const vOpen = bFieldT * flowU * m.widthM;
  const currentA = vOpen / (m.rInternalOhm + m.rLoadOhm);
  const voltageV = currentA * m.rLoadOhm;
  const powerW = currentA * voltageV;
  const hartmann = bFieldT * m.halfGapM * Math.sqrt(m.sigmaSm / (m.rhoKgM3 * m.nuM2s));

  state.mhdFlowU = flowU;
  state.mhdBFieldT = bFieldT;
  state.mhdHartmann = hartmann;
  state.mhdVoltage = voltageV;
  state.mhdCurrent = currentA;
  state.mhdPowerW = powerW;
  state.energyLevel = Math.min(1, flowU / m.flowUMaxMps);
};

export function createMhdPhysicsState(): Partial<DevicePhysicsState> {
  // Seeded at rest with the drive-zero field, exactly like MHDState's C++
  // defaults — the pump drive is what develops flow.
  return {
    mhdFlowU: 0,
    mhdBFieldT: MHD_PARAMS.bFieldBaseT,
    mhdHartmann: 0,
    mhdVoltage: 0,
    mhdCurrent: 0,
    mhdPowerW: 0,
    energyLevel: 0
  };
}

export function mhdUpdateMesh(instance: DeviceInstanceLike): void {
  const s = instance.physicsState;
  writeMeshCylinders(
    instance,
    buildMhdMesh(s?.mhdFlowU ?? 0.5, s?.mhdBFieldT ?? 0.4, s?.mhdHartmann ?? 1)
  );
}
