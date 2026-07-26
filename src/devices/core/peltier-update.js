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
  const thermalGate = Math.pow(gate(energy, 0.24, 0.70), 1.4);
  const thermalCount = Math.floor(budget * 0.36 * thermalGate);
  for (let i = 0; i < thermalCount; i++) {
    const x = (Math.random() - 0.5) * 3.2;
    const y = (Math.random() - 0.5) * 1.8;
    const z = (Math.random() - 0.5) * 2.6;
    pushParticle(x, y, z, 3.0 + Math.random());
  }
  return true;
}
