export function solarSyncAfterPhysics(instance, ctx) {
  instance.batteryCharge = instance.physicsState.batteryCharge;
  instance.uniformManager.batteryCharge = instance.physicsState.batteryCharge;
  instance.visualizer.updateBatteryGaugeMesh(instance.batteryCharge);
  instance.uniformManager.updateGaugeBuffer(instance.position, ctx.ringIndex);
}

export function solarComputeRawEnergy(instance, ctx) {
  const battery = Math.min(1.0, Math.max(0.0, instance.physicsState?.batteryCharge ?? instance.batteryCharge ?? 0.0));
  return battery * 0.65 + ctx.speedNorm * 0.35;
}

export function solarBuildUniformExtras(instance) {
  return {
    batteryCharge: instance.batteryCharge,
    solarFlag: 1
  };
}

export function solarUpdateFlowPaths(instance, ctx) {
  const { count, time, energy, writePath } = ctx;
  const charge = instance.physicsState?.batteryCharge ?? instance.batteryCharge ?? 0;
  for (let i = 0; i < count; i++) {
    const led = i % 6;
    const angle = (led / 6) * Math.PI * 2;
    const r = 3.0;
    const ledX = Math.cos(angle) * r;
    const ledZ = Math.sin(angle) * r;
    const ledY = 3.5;
    const u = (time * 0.28 * (0.35 + charge) + i * 0.017) % 1;
    const panelX = (Math.sin(i * 2.17) * 0.5) * 4.5;
    const panelZ = (Math.cos(i * 1.83) * 0.5) * 4.5;
    const x = ledX + (panelX - ledX) * u;
    const y = ledY + (0.12 - ledY) * u;
    const z = ledZ + (panelZ - ledZ) * u;
    const strength = charge * 0.7 + energy * 0.3;
    writePath(i, x, y, z, strength, 0.45 + 0.55 * (1 - Math.abs(u - 0.5) * 2));
  }
  return true;
}

export function solarUpdateEffects(instance, ctx) {
  const { budget, energy, gate, pushParticle } = ctx;
  const batteryGate = Math.pow(gate(instance.batteryCharge * 0.75 + energy * 0.25, 0.20, 0.78), 1.3);
  const refractGate = Math.pow(gate(instance.batteryCharge * 0.6 + energy * 0.4, 0.55, 0.92), 1.8);
  const photonCount = Math.floor(budget * 0.45 * batteryGate);
  for (let i = 0; i < photonCount; i++) {
    const led = i % 6;
    const a = (led / 6) * Math.PI * 2 + (Math.random() - 0.5) * 0.18;
    const r = 3.0 + Math.random() * 0.6;
    const y = 2.8 + Math.random() * 1.2;
    pushParticle(Math.cos(a) * r, y, Math.sin(a) * r, 1.0 + Math.random());
  }
  const refractCount = Math.floor(budget * 0.20 * refractGate);
  for (let i = 0; i < refractCount; i++) {
    const x = (Math.random() - 0.5) * 5.8;
    const z = (Math.random() - 0.5) * 5.8;
    const y = 0.9 + Math.random() * 0.5;
    pushParticle(x, y, z, 7.0 + Math.random());
  }
  return true;
}
