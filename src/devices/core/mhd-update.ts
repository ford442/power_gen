import {
  buildMhdMesh,
  createMhdPhysicsState,
  stepMhdPhysics,
  mhdUpdateMesh
} from './mhd-mesh.js';
import { advanceMhdTravel, MHD_DUCT } from './mhd-parcels';
import { hartmannShape } from '../../physics/hartmann';
import type { DevicePlugin } from '../types';

export { buildMhdMesh, createMhdPhysicsState, stepMhdPhysics, mhdUpdateMesh };

export const mhdComputeRawEnergy: NonNullable<DevicePlugin['computeRawEnergy']> = (instance, ctx) => {
  const flowN = instance.physicsState?.mhdFlowU != null
    ? Math.min(1.0, instance.physicsState.energyLevel ?? 0)
    : null;
  return flowN != null
    ? Math.min(1.0, flowN * 0.65 + ctx.speedNorm * 0.2 + ctx.overdriveBoost * 0.35)
    : Math.min(1.0, ctx.speedNorm * 0.5 + ctx.overdriveBoost * 0.5);
};

const fract = (v: number): number => v - Math.floor(v);

/**
 * Tracer sprites in the duct (WebGPU effects layer). Each rides its own lane
 * at the local Hartmann speed u(η) and is re-released at the inlet on its own
 * phase, so the cloud's leading edge is the velocity profile — the same
 * solution the timelines draw (mhd-parcels.ts), with no swirl: fully
 * developed laminar duct flow has no cross-stream motion.
 */
export const mhdUpdateEffects: NonNullable<DevicePlugin['updateEffects']> = (instance, ctx) => {
  const { budget, energy, gate, pushParticle, time } = ctx;
  const state = instance.physicsState;
  const hartmann = state?.mhdHartmann ?? 0;
  const travel = state ? advanceMhdTravel(state, time) : 0;
  const channelGate = Math.pow(gate(energy, 0.18, 0.65), 1.4);
  const tracerCount = Math.floor(budget * 0.45 * channelGate);
  for (let i = 0; i < tracerCount; i++) {
    const lane = i + 0.5;
    // Inside 92 % of the gap: a tracer on the wall itself would never leave the inlet.
    const eta = (fract(lane * 0.7548777) * 2 - 1) * 0.92;
    const zeta = fract(lane * 0.5698403) * 2 - 1;
    const tau = fract(travel + fract(lane * 0.381966));
    pushParticle(
      MHD_DUCT.xIn + MHD_DUCT.lengthU * tau * hartmannShape(eta, hartmann),
      eta * MHD_DUCT.halfGapU,
      zeta * MHD_DUCT.halfWidthU,
      // Effect type 0: drawn like the timeline markers, not as an electric filament.
      fract(lane * 0.123)
    );
  }
  return true;
};
