import {
  buildPeltierMesh,
  createPeltierPhysicsState,
  stepPeltierPhysics,
  peltierUpdateMesh
} from './peltier-mesh.js';
import type { DevicePlugin } from '../types';

export { buildPeltierMesh, createPeltierPhysicsState, stepPeltierPhysics, peltierUpdateMesh };

export const peltierComputeRawEnergy: NonNullable<DevicePlugin['computeRawEnergy']> = (instance, ctx) => {
  const thermalN = instance.physicsState?.peltierDeltaT != null
    ? Math.min(1.0, instance.physicsState.energyLevel ?? 0)
    : null;
  return thermalN != null
    ? Math.min(1.0, thermalN * 0.7 + ctx.speedNorm * 0.2 + ctx.overdriveBoost * 0.3)
    : Math.min(1.0, ctx.speedNorm * 0.6 + ctx.overdriveBoost * 0.4);
};

/**
 * No effect sprites: the old ones were electric "filaments" flickering at
 * random points around the stack, which is nothing a thermoelectric module
 * does. The bodies' temperature colours and the air parcels carry the picture.
 */
export const peltierUpdateEffects: NonNullable<DevicePlugin['updateEffects']> = () => true;
