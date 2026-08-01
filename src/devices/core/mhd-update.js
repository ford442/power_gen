import {
  buildMhdMesh,
  createMhdPhysicsState,
  stepMhdPhysics,
  mhdUpdateMesh
} from './mhd-mesh.js';

export { buildMhdMesh, createMhdPhysicsState, stepMhdPhysics, mhdUpdateMesh };

export function mhdComputeRawEnergy(instance, ctx) {
  const flowN = instance.physicsState?.mhdFlowU != null
    ? Math.min(1.0, instance.physicsState.energyLevel ?? 0)
    : null;
  return flowN != null
    ? Math.min(1.0, flowN * 0.65 + ctx.speedNorm * 0.2 + ctx.overdriveBoost * 0.35)
    : Math.min(1.0, ctx.speedNorm * 0.5 + ctx.overdriveBoost * 0.5);
}

export function mhdUpdateEffects(instance, ctx) {
  const { budget, energy, gate, pushParticle, time } = ctx;
  const flowU = instance.physicsState?.mhdFlowU ?? 0.5;
  const bField = instance.physicsState?.mhdBFieldT ?? 0.4;
  const uN = Math.min(1, flowU / 3.5);
  const channelGate = Math.pow(gate(energy, 0.18, 0.65), 1.4);
  const filamentCount = Math.floor(budget * 0.45 * channelGate);
  for (let i = 0; i < filamentCount; i++) {
    // Channel advection along +X with B-scaled swirl (matches WASM mhd_particle_step spirit)
    const drift = ((time * (0.6 + uN * 1.4) + i * 0.17) % 1);
    const x = -2.0 + drift * 4.0;
    const swirl = bField * 0.35;
    const y = Math.sin(time * 2.1 + i * 0.4) * swirl + (Math.random() - 0.5) * 0.5;
    const z = Math.cos(time * 1.7 + i * 0.31) * swirl * 0.8 + (Math.random() - 0.5) * 0.4;
    pushParticle(x, y, z, 3.0 + Math.random());
  }
  return true;
}
