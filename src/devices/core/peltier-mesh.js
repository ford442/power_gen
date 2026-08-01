/**
 * Peltier thermoelectric stack — mesh + JS plant fallback + heat-tint.
 * WASM two-node Seebeck plant remains authoritative with `?wasmPhysics=1`.
 */

import { packInstance } from '../../device-mesh-layouts.js';
import { MATERIAL_STEEL_BASE, MATERIAL_STRUCTURAL, MATERIAL_QUANTA_COIL } from '../material-roles.js';
import { writeMeshCylinders } from '../update-helpers';

/** Classroom-scale module parameters (mirrors cpp/plant/peltier_plant.cpp spirit). */
export const PELTIER_PARAMS = Object.freeze({
  seebeck: 0.0002,
  couples: 127,
  rInternalOhm: 2.2,
  rLoadOhm: 4.0,
  conductanceWK: 0.55,
  heatCapHotJK: 28,
  heatCapColdJK: 32,
  sinkWK: 1.8,
  heaterMaxW: 45,
  ambientK: 298
});

/**
 * Two-node thermal plates: hot (bottom, red tint) + cold (top, blue tint).
 * Emissive scales with ΔT for a cheap heat-map look.
 */
export function buildPeltierMesh(hotK = 320, coldK = 290, deltaT = 30) {
  const ambient = PELTIER_PARAMS.ambientK;
  const hotN = Math.max(0, Math.min(1, (hotK - ambient) / 120));
  const coldN = Math.max(0, Math.min(1, (ambient - coldK + 40) / 80));
  const dN = Math.max(0, Math.min(1, Math.abs(deltaT) / 80));
  const hotColor = [0.55 + hotN * 0.4, 0.22 + (1 - hotN) * 0.15, 0.16];
  const coldColor = [0.2, 0.35 + coldN * 0.35, 0.75 + coldN * 0.2];
  return {
    cylinders: () => [
      packInstance([0, -0.55, 0], MATERIAL_STEEL_BASE, [0, 0, 0, 1], [0.35, 0.36, 0.38], 0.03),
      // Hot plate
      packInstance([0, -0.15, 0], MATERIAL_STRUCTURAL, [0, 0, 0, 1], hotColor, 0.08 + hotN * 0.55),
      // Ceramic junction stack
      packInstance([0, 0.05, 0], MATERIAL_QUANTA_COIL, [0, 0, 0, 1], [0.72, 0.74, 0.78], 0.05 + dN * 0.15),
      // Cold plate
      packInstance([0, 0.28, 0], MATERIAL_STRUCTURAL, [0, 0, 0, 1], coldColor, 0.06 + coldN * 0.4),
      // Heat sink fins (visual)
      packInstance([0, 0.55, 0], MATERIAL_STEEL_BASE, [0, 0, 0, 1], [0.55, 0.58, 0.62], 0.04)
    ]
  };
}

/**
 * JS fallback when WASM plant is off — same two-node spirit as C++.
 * @param {object} state
 * @param {number} dt
 * @param {number} drive 0..1
 */
export function stepPeltierPhysics(state, dt, drive) {
  const p = PELTIER_PARAMS;
  const S = p.seebeck * p.couples;
  let hotK = state.peltierHotK ?? p.ambientK + 15;
  let coldK = state.peltierColdK ?? p.ambientK;
  let deltaTK = hotK - coldK;
  const qHeater = drive * p.heaterMaxW;
  const qCond = p.conductanceWK * deltaTK;
  let I = S * deltaTK / (p.rInternalOhm + p.rLoadOhm);
  const qJoule = 0.5 * I * I * p.rInternalOhm;
  const dTh = (qHeater - qCond - S * I * hotK + qJoule) / p.heatCapHotJK;
  const dTc = (qCond + S * I * coldK + qJoule - p.sinkWK * (coldK - p.ambientK)) / p.heatCapColdJK;
  hotK = Math.max(p.ambientK - 5, Math.min(p.ambientK + 250, hotK + dTh * dt));
  coldK = Math.max(p.ambientK - 5, Math.min(p.ambientK + 150, coldK + dTc * dt));
  deltaTK = hotK - coldK;
  I = S * deltaTK / (p.rInternalOhm + p.rLoadOhm);
  const voltageV = I * p.rLoadOhm;
  const powerW = I * voltageV;
  const cop = qHeater > 1e-3 ? Math.max(0, Math.min(1, powerW / qHeater)) : 0;

  state.peltierHotK = hotK;
  state.peltierColdK = coldK;
  state.peltierDeltaT = deltaTK;
  state.peltierVoltage = voltageV;
  state.peltierCurrent = I;
  state.peltierPowerW = powerW;
  state.peltierCOP = cop;
  state.energyLevel = Math.min(1, Math.abs(deltaTK) / 80);
}

export function createPeltierPhysicsState() {
  const p = PELTIER_PARAMS;
  return {
    peltierHotK: p.ambientK + 12,
    peltierColdK: p.ambientK,
    peltierDeltaT: 12,
    peltierVoltage: 0,
    peltierCurrent: 0,
    peltierPowerW: 0,
    peltierCOP: 0,
    energyLevel: 0.15
  };
}

export function peltierUpdateMesh(instance) {
  const s = instance.physicsState || {};
  writeMeshCylinders(
    instance,
    buildPeltierMesh(s.peltierHotK ?? 320, s.peltierColdK ?? 290, s.peltierDeltaT ?? 30)
  );
}
