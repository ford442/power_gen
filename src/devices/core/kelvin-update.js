export function kelvinSyncAfterPhysics(instance) {
  instance.voltageEnergyLevel = instance.physicsState.kelvinVoltageN;
}

export function kelvinComputeRawEnergy(instance, ctx) {
  const fromPhysics = instance.physicsState?.kelvinVoltageN;
  instance.voltageEnergyLevel = fromPhysics != null
    ? fromPhysics
    : Math.min(1.0, ctx.speedNorm * 0.65 + (0.5 + 0.5 * Math.sin(ctx.time * 3.2)) * 0.35);
  return instance.voltageEnergyLevel;
}

export function kelvinUpdateFlowPaths(instance, ctx) {
  const { count, time, writePath } = ctx;
  const voltN = instance.physicsState?.kelvinVoltageN ?? instance.voltageEnergyLevel;
  const spark = instance.physicsState?.kelvinSparkTimer > 0 ? 1 : 0;
  for (let i = 0; i < count; i++) {
    const side = i % 2 === 0 ? -2.5 : 2.5;
    const phase = i / count;
    const u = (time * 0.22 + phase * 0.8) % 1;
    const y = 5.5 - u * 9.2;
    const wobble = Math.sin(time * 6 + phase * 31) * (0.05 + voltN * 0.18);
    const lift = voltN > 0.7 ? Math.sin(time * 8 + phase * 17) * voltN * 0.35 : 0;
    const branch = spark > 0 ? (Math.random() - 0.5) * 1.2 : 0;
    writePath(i, side + wobble + branch, y + lift, wobble * 0.5, voltN * 0.85 + spark * 0.4, 0.35 + voltN * 0.65);
  }
  return true;
}

export function kelvinUpdateEffects(instance, ctx) {
  const { budget, energy, gate, pushParticle } = ctx;
  const voltageProxy = Math.max(0.0, Math.min(1.0, instance.voltageEnergyLevel * 0.7 + Math.pow(energy, 1.2) * 0.5));
  const sparkGate = Math.pow(gate(voltageProxy, 0.24, 0.60), 1.4);
  const branchGate = Math.pow(gate(voltageProxy, 0.58, 0.92), 1.8);
  const sparkCount = Math.floor(budget * 0.58 * sparkGate);
  for (let i = 0; i < sparkCount; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const y = -2.4 + Math.random() * 8.0;
    const z = (Math.random() - 0.5) * 1.0;
    pushParticle(side * (2.2 + Math.random() * 0.8), y, z, 1.0 + Math.random());
  }
  const filamentCount = Math.floor(budget * 0.16 * sparkGate);
  for (let i = 0; i < filamentCount; i++) {
    const y = -2.8 + (i / Math.max(1, filamentCount)) * 8.8;
    const wobble = Math.sin(i * 1.7 + ctx.time * 7.0) * 0.22;
    pushParticle(wobble, y, (Math.random() - 0.5) * 0.4, 3.0 + Math.random());
  }
  const branchCount = Math.floor(budget * 0.24 * branchGate);
  for (let i = 0; i < branchCount; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const trunk = (Math.random() - 0.5) * 0.5;
    const y = -2.5 + Math.random() * 8.4;
    const z = (Math.random() - 0.5) * (0.5 + branchGate * 1.2);
    pushParticle(side * (0.6 + Math.random() * 2.0) + trunk, y, z, 6.0 + Math.random());
  }
  return true;
}
