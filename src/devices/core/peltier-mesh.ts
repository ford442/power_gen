/**
 * Peltier thermoelectric cooler — mesh + heat-tint. The plant (JS fallback,
 * mirrored by the WASM one under `?wasmPhysics=1`) is ./peltier-plant.ts.
 */

import { packInstance, type InstanceArray } from '../../device-mesh-layouts';
import { PELTIER } from '../../../generated/physics-constants';
import { MATERIAL_STEEL_BASE, MATERIAL_STRUCTURAL, MATERIAL_QUANTA_COIL } from '../material-roles';
import { writeMeshCylinders } from '../update-helpers';
import type { DeviceInstanceLike } from '../types';

export { PELTIER };
export { PELTIER_PARAMS, createPeltierPhysicsState, stepPeltierPhysics } from './peltier-plant';

/** Half-height of the shared instance cylinder (setup-geometry.ts `generateCylinder(0.8, 2.5)`). */
const CYL_H = 2.5;

/** What the three drawn bodies are coloured by, K. */
export interface PeltierMeshTemps {
  /** Heat sink (bottom). */
  sinkK: number;
  /** The module between its plates (middle): mean of the two plate temperatures. */
  moduleK: number;
  /** Cold block (top). */
  blockK: number;
}

/** Read the three body temperatures off a plant state (ambient before the first step). */
export function peltierMeshTemps(state?: {
  peltierNodesK?: readonly number[];
  peltierHotK?: number;
  peltierColdK?: number;
} | null): PeltierMeshTemps {
  const ambient = PELTIER.ambientK;
  const nodes = state?.peltierNodesK;
  const hot = state?.peltierHotK ?? ambient;
  const cold = state?.peltierColdK ?? ambient;
  return {
    sinkK: nodes?.[nodes.length - 1] ?? hot,
    moduleK: 0.5 * (hot + cold),
    blockK: nodes?.[0] ?? cold
  };
}

/**
 * Air parcels beside the two end bodies (posPeltier / integratePeltier): where
 * they sit and how fast they drift. Illustrative — a plume speed that goes as
 * √|ΔT| like a buoyant one, not a convection solve.
 */
export const PELTIER_AIR = Object.freeze({
  /** Centre height of the sink (−) and block (+) bodies. */
  bodyY: CYL_H,
  /** Vertical extent a parcel travels. */
  spanU: 2.6,
  /** Inner radius and radial spread of the parcels. */
  radiusU: 0.95,
  spreadU: 0.5,
  /** Transits per second at |T − T_ambient| = deltaTRefK. */
  transitHzAtRef: 0.35
});

/** View-side drift state kept on the physics state (not plant state, not snapshotted). */
export interface PeltierAirState {
  peltierNodesK?: readonly number[];
  peltierHotK?: number;
  peltierColdK?: number;
  _peltierAirSink?: number;
  _peltierAirBlock?: number;
  _peltierAirClock?: number;
}

const fract = (v: number): number => v - Math.floor(v);

/**
 * Advance the two drifts to scene time `time`: up beside a body warmer than
 * the room, down beside a colder one, still at ambient. Idempotent within a
 * frame. Returns the fractional drifts [sink, block].
 */
export function advancePeltierAir(state: PeltierAirState, time: number): [number, number] {
  let sink = state._peltierAirSink ?? 0;
  let block = state._peltierAirBlock ?? 0;
  const last = state._peltierAirClock;
  if (last !== undefined && Number.isFinite(time)) {
    const dt = Math.min(0.1, time - last);
    if (dt > 0) {
      const t = peltierMeshTemps(state);
      const rate = (k: number): number => {
        const d = (k - PELTIER.ambientK) / PELTIER.deltaTRefK;
        return Math.sign(d) * Math.sqrt(Math.min(1, Math.abs(d))) * PELTIER_AIR.transitHzAtRef;
      };
      sink = fract(sink + rate(t.sinkK) * dt);
      block = fract(block + rate(t.blockK) * dt);
    }
  }
  if (Number.isFinite(time)) state._peltierAirClock = time;
  state._peltierAirSink = sink;
  state._peltierAirBlock = block;
  return [sink, block];
}

/**
 * Temperature → colour: blue 60 K below ambient, neutral grey at ambient, red
 * 80 K above. A stand-in for a thermal camera until the IR view lands.
 */
export function peltierTempColor(tempK: number): [number, number, number] {
  const d = tempK - PELTIER.ambientK;
  const neutral = [0.5, 0.52, 0.55];
  const end = d < 0 ? [0.12, 0.35, 0.95] : [0.95, 0.22, 0.1];
  const w = Math.max(0, Math.min(1, d < 0 ? -d / 60 : d / 80));
  return [
    neutral[0] + (end[0] - neutral[0]) * w,
    neutral[1] + (end[1] - neutral[1]) * w,
    neutral[2] + (end[2] - neutral[2]) * w
  ];
}

/**
 * Three stacked bodies, each one instance cylinder, each coloured by its own
 * temperature from the plant: heat sink (bottom), module (middle), cold block
 * (top). With the current reversed the block turns red and the sink side
 * cools — the colours follow the plant, not a fixed hot-below-cold picture.
 */
export function buildPeltierMesh(temps: PeltierMeshTemps = peltierMeshTemps()): { cylinders: () => InstanceArray } {
  const upright = [0, 0, 0, 1];
  const glow = (k: number): number => 0.04 + 0.3 * Math.min(1, Math.abs(k - PELTIER.ambientK) / PELTIER.deltaTRefK);
  return {
    cylinders: () => [
      packInstance([0, -CYL_H, 0], MATERIAL_STEEL_BASE, upright, peltierTempColor(temps.sinkK), glow(temps.sinkK)),
      packInstance([0, 0, 0], MATERIAL_QUANTA_COIL, upright, peltierTempColor(temps.moduleK), glow(temps.moduleK)),
      packInstance([0, CYL_H, 0], MATERIAL_STRUCTURAL, upright, peltierTempColor(temps.blockK), glow(temps.blockK))
    ]
  };
}

export function peltierUpdateMesh(instance: DeviceInstanceLike): void {
  writeMeshCylinders(instance, buildPeltierMesh(peltierMeshTemps(instance.physicsState)));
}
