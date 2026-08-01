/**
 * MHD Hartmann channel — mesh + JS plant fallback + flow-arrow cues.
 * WASM channel plant remains authoritative with `?wasmPhysics=1`.
 */

import { packInstance } from '../../device-mesh-layouts.js';
import { MATERIAL_STEEL_BASE, MATERIAL_STRUCTURAL, MATERIAL_QUANTA_COIL } from '../material-roles.js';
import { writeMeshCylinders } from '../update-helpers';

export const MHD_PARAMS = Object.freeze({
  pumpAccel: 4.5,
  lorentzK: 0.85,
  frictionK: 0.35,
  flowUMax: 3.5,
  widthM: 0.12,
  halfGapM: 0.04,
  sigmaSm: 7.1e5,
  rhoKgM3: 6400,
  nuM2s: 1.2e-6,
  rInternalOhm: 0.08,
  rLoadOhm: 0.25
});

/**
 * Rectangular duct + magnet poles. Arrow-ish cylinders along +X for flow cue.
 */
export function buildMhdMesh(flowU = 0.5, bFieldT = 0.4, hartmann = 1) {
  const uN = Math.max(0, Math.min(1, flowU / MHD_PARAMS.flowUMax));
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

/**
 * @param {object} state
 * @param {number} dt
 * @param {number} drive
 */
export function stepMhdPhysics(state, dt, drive) {
  const m = MHD_PARAMS;
  const bFieldT = 0.2 + 0.8 * drive;
  let flowU = state.mhdFlowU ?? 0.2;
  const accel = drive * m.pumpAccel - (m.lorentzK * bFieldT * bFieldT + m.frictionK) * flowU;
  flowU = Math.max(0, Math.min(m.flowUMax * 2, flowU + accel * dt));
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
  state.energyLevel = Math.min(1, flowU / m.flowUMax);
}

export function createMhdPhysicsState() {
  return {
    mhdFlowU: 0.25,
    mhdBFieldT: 0.3,
    mhdHartmann: 5,
    mhdVoltage: 0,
    mhdCurrent: 0,
    mhdPowerW: 0,
    energyLevel: 0.1
  };
}

export function mhdUpdateMesh(instance) {
  const s = instance.physicsState || {};
  writeMeshCylinders(
    instance,
    buildMhdMesh(s.mhdFlowU ?? 0.5, s.mhdBFieldT ?? 0.4, s.mhdHartmann ?? 1)
  );
}
