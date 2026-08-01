import {
  buildPeltierMesh,
  createPeltierPhysicsState,
  stepPeltierPhysics,
  peltierUpdateMesh
} from './peltier-mesh.js';

export { buildPeltierMesh, createPeltierPhysicsState, stepPeltierPhysics, peltierUpdateMesh };

export function peltierComputeRawEnergy(instance, ctx) {
  const thermalN = instance.physicsState?.peltierDeltaT != null
    ? Math.min(1.0, instance.physicsState.energyLevel ?? 0)
    : null;
  return thermalN != null
    ? Math.min(1.0, thermalN * 0.7 + ctx.speedNorm * 0.2 + ctx.overdriveBoost * 0.3)
    : Math.min(1.0, ctx.speedNorm * 0.6 + ctx.overdriveBoost * 0.4);
}

export function peltierUpdateEffects(instance, ctx) {
  const { budget, energy, gate, pushParticle } = ctx;
  const deltaTN = Math.min(1, Math.abs(instance.physicsState?.peltierDeltaT ?? 20) / 80);
  const thermalGate = Math.pow(gate(energy, 0.2, 0.68), 1.35) * (0.45 + deltaTN * 0.55);
  const thermalCount = Math.floor(budget * 0.4 * thermalGate);
  for (let i = 0; i < thermalCount; i++) {
    // Hot rising from bottom plate, cold sinking from top
    const rising = Math.random() < 0.55;
    const x = (Math.random() - 0.5) * 1.8;
    const z = (Math.random() - 0.5) * 1.5;
    const y = rising
      ? -0.2 + Math.random() * 0.5
      : 0.15 + Math.random() * 0.45;
    pushParticle(x, y, z, 3.0 + Math.random() + (rising ? 0.2 : 0));
  }
  return true;
}
