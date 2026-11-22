/**
 * MHD Hartmann duct — magnet mesh + JS plant fallback.
 * WASM channel plant remains authoritative with `?wasmPhysics=1`.
 * The velocity profile the parcels draw is devices/core/mhd-parcels.ts.
 */

import { packInstance, type InstanceArray } from '../../device-mesh-layouts';
import { MHD } from '../../../generated/physics-constants';
import { MATERIAL_STEEL_BASE, MATERIAL_STRUCTURAL } from '../material-roles';
import { MHD_DUCT } from './mhd-parcels';
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

/** Pole faces of the drawn magnet gap, |y|. The duct (±MHD_DUCT.halfGapU) sits inside with clearance. */
const POLE_FACE_Y = 0.8;
/** Half-height / radius of the shared instance cylinder (setup-geometry.ts `generateCylinder(0.8, 2.5)`). */
const CYL_HALF_H = 1.25;
const CYL_RADIUS = 0.8;
/** Pole pieces along the flow: three overlapping cylinders span the 4.2-unit duct. */
const POLE_X = [-1.4, 0, 1.4];
/** Return yoke behind the duct: its front face is the backdrop the parcels are read against. */
const YOKE_Z = -(MHD_DUCT.halfWidthU + 0.4 + CYL_RADIUS);

/**
 * C-magnet around an open slot: north pole pieces above the duct, south below,
 * a steel return yoke behind. The duct itself is left open — the parcels
 * (mhd-parcels.ts) are the fluid, and anything drawn across the gap would hide
 * the profile they show. Every part is the one shared instance cylinder, so
 * the electrodes on the two side faces of the duct are not drawn.
 * Pole emissive follows B; the yoke follows the Hartmann number.
 */
export function buildMhdMesh(_flowU = 0.5, bFieldT = 0.4, hartmann = 1): { cylinders: () => InstanceArray } {
  const bN = Math.max(0, Math.min(1, bFieldT / 1.0));
  // Ha spans about 3.8–19 over the bench's field range (physics/constants.json mhd).
  const haN = Math.max(0, Math.min(1, hartmann / 20));
  const upright = [0, 0, 0, 1];
  const north = [0.75, 0.2, 0.25];
  const south = [0.22, 0.32, 0.7];
  const steel = [0.3, 0.32, 0.36];
  const poleY = POLE_FACE_Y + CYL_HALF_H;
  return {
    cylinders: () => [
      ...POLE_X.map((x) => packInstance([x, poleY, 0], MATERIAL_STRUCTURAL, upright, north, 0.1 + bN * 0.4)),
      ...POLE_X.map((x) => packInstance([x, -poleY, 0], MATERIAL_STRUCTURAL, upright, south, 0.08 + bN * 0.35)),
      ...POLE_X.map((x) => packInstance([x, 0, YOKE_Z], MATERIAL_STEEL_BASE, upright, steel, 0.02 + haN * 0.04))
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
