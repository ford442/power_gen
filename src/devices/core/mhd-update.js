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
  const channelGate = Math.pow(gate(energy, 0.22, 0.68), 1.45);
  const filamentCount = Math.floor(budget * 0.40 * channelGate);
  for (let i = 0; i < filamentCount; i++) {
    const drift = Math.sin(time * 1.6 + i * 0.23) * 0.8;
    const x = (Math.random() - 0.5) * 4.4 + drift;
    const y = (Math.random() - 0.5) * 2.4;
    const z = (Math.random() - 0.5) * 1.8;
    pushParticle(x, y, z, 3.0 + Math.random());
  }
  return true;
}
