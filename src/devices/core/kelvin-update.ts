import type { DevicePlugin } from '../types';

export const kelvinSyncAfterPhysics: NonNullable<DevicePlugin['syncAfterPhysics']> = (instance) => {
  instance.voltageEnergyLevel = instance.physicsState!.kelvinVoltageN;
};

export const kelvinComputeRawEnergy: NonNullable<DevicePlugin['computeRawEnergy']> = (instance, ctx) => {
  const fromPhysics = instance.physicsState?.kelvinVoltageN;
  instance.voltageEnergyLevel = fromPhysics != null
    ? fromPhysics
    : Math.min(1.0, ctx.speedNorm * 0.65 + (0.5 + 0.5 * Math.sin(ctx.time * 3.2)) * 0.35);
  return instance.voltageEnergyLevel;
};

/**
 * The flow-path markers were the bench's drops before it had any: 72 points
 * sliding down the two columns at a made-up speed, with a made-up wobble for
 * "levitation". The columns now carry real drops — the solver's in focus, the
 * stand-in train elsewhere (docs/FLUIDS.md → Kelvin) — so the markers are
 * written dark and parked inside the collectors. The spark effects below
 * stay: they draw the discharge, which nothing else does.
 */
export const kelvinUpdateFlowPaths: NonNullable<DevicePlugin['updateFlowPaths']> = (_instance, ctx) => {
  const { count, writePath } = ctx;
  for (let i = 0; i < count; i++) writePath(i, i % 2 === 0 ? -2.5 : 2.5, -3.4, 0, 0, 0);
  return true;
};

/**
 * The discharge. These sprites used to run all the time, thicker with
 * voltage — streaks along the columns standing for "charge". The columns now
 * carry the drops themselves, so the sprites are kept for what nothing else
 * draws: the spark, while the plant says one is live.
 */
export const kelvinUpdateEffects: NonNullable<DevicePlugin['updateEffects']> = (instance, ctx) => {
  if (!((instance.physicsState?.kelvinSparkTimer ?? 0) > 0)) return true;
  const { budget, energy, gate, pushParticle } = ctx;
  const voltageProxy = Math.max(0.0, Math.min(1.0, instance.voltageEnergyLevel! * 0.7 + Math.pow(energy, 1.2) * 0.5));
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
};
