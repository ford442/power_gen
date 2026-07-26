export function heronSyncAfterPhysics(instance) {
  instance.flowEnergyLevel = instance.physicsState.energyLevel;
}

export function heronComputeRawEnergy(instance, ctx) {
  const fromPhysics = instance.physicsState?.energyLevel;
  instance.flowEnergyLevel = fromPhysics != null
    ? fromPhysics
    : Math.min(1.0, ctx.speedNorm * 0.7 + (0.5 + 0.5 * Math.sin(ctx.time * 1.6)) * 0.3);
  return instance.flowEnergyLevel;
}

export function heronUpdateFlowPaths(instance, ctx) {
  const { count, time, energy, writePath } = ctx;
  const headN = instance.physicsState
    ? instance.physicsState.heronHead / Math.max(0.01, instance.physicsState.heronHeadMax)
    : instance.flowEnergyLevel;
  const flow = instance.geometry.heronFlow || { apexY: 6.1, supplyX: 1.6, drainBasinY: -2.2 };
  const jetTop = flow.apexY + headN * 0.35;
  const reservoirY = jetTop - (flow.apexY - flow.drainBasinY) * 0.42;
  const supplyX = flow.supplyX;
  for (let i = 0; i < count; i++) {
    const phase = i / count;
    const side = i % 2 === 0 ? -1 : 1;
    const u = (time * 0.35 * (0.4 + energy) + phase) % 1;
    let x, y, z;
    if (u < 0.25) {
      const k = u / 0.25;
      x = side * supplyX * 0.7 * (1 - k * 0.3);
      y = reservoirY + k * (jetTop - reservoirY);
      z = 0;
    } else if (u < 0.55) {
      const k = (u - 0.25) / 0.3;
      x = side * (supplyX * 0.5 + Math.sin(k * Math.PI) * supplyX * 0.35);
      y = jetTop - k * (jetTop - flow.drainBasinY) * 0.35;
      z = Math.sin(k * Math.PI * 2 + time) * 0.25;
    } else {
      const k = (u - 0.55) / 0.45;
      x = Math.sin(phase * 12.566 + time) * (0.4 + k);
      y = jetTop - (jetTop - flow.drainBasinY) * 0.35 - k * (jetTop - flow.drainBasinY) * 0.65;
      z = Math.cos(phase * 9.42 + time * 1.2) * 0.3;
    }
    writePath(i, x, y, z, energy * (0.4 + headN * 0.6), 0.5 + 0.5 * Math.sin(time * 4 + phase * 20));
  }
  return true;
}

export function heronUpdateEffects(instance, ctx) {
  const { budget, gate, pushParticle } = ctx;
  const flowGate = Math.pow(gate(instance.flowEnergyLevel, 0.18, 0.58), 1.2);
  const impactGate = Math.pow(gate(instance.flowEnergyLevel, 0.55, 0.90), 1.6);
  const flow = instance.geometry.heronFlow || { apexY: 6.1, drainBasinY: -2.2 };
  const headN = instance.physicsState
    ? instance.physicsState.heronHead / Math.max(0.01, instance.physicsState.heronHeadMax)
    : instance.flowEnergyLevel;
  const jetY = flow.apexY + headN * 0.25;
  const basinY = flow.drainBasinY;
  const mistCount = Math.floor(budget * 0.56 * flowGate);
  const clusterA = [Math.sin(ctx.time * 0.8) * 0.25, jetY - 0.9 + Math.sin(ctx.time * 1.2) * 0.12, Math.cos(ctx.time * 0.9) * 0.25];
  const clusterB = [-clusterA[0], jetY - 0.4 + Math.cos(ctx.time * 1.1) * 0.12, -clusterA[2]];
  for (let i = 0; i < mistCount; i++) {
    const c = i % 2 === 0 ? clusterA : clusterB;
    const r = Math.random() * 1.1;
    const a = Math.random() * Math.PI * 2;
    pushParticle(c[0] + Math.cos(a) * r, c[1] + (Math.random() - 0.5) * 1.5, c[2] + Math.sin(a) * r, Math.random());
  }
  const rippleCount = Math.floor(budget * 0.30 * impactGate);
  for (let i = 0; i < rippleCount; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = 0.3 + Math.random() * 1.3;
    const y = basinY + 0.3 + Math.random() * 0.35;
    pushParticle(Math.cos(a) * r, y, Math.sin(a) * r, 5.0 + Math.random());
  }
  return true;
}
