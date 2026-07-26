/**
 * Shared helpers for device update strategies (effects budget, gates, mesh writes).
 */

import { instancesToBufferData, countInstances } from '../device-mesh-layouts.js';

export function effectGate(value, low, high) {
  if (high <= low) return value > high ? 1 : 0;
  return Math.max(0, Math.min(1, (value - low) / (high - low)));
}

export function computeEffectBudget(instance, qualityScale) {
  const speedMult = instance.speedMult || 1.0;
  const energy = instance.energyLevel;
  const quality = Math.max(
    0.0,
    Math.min(1.0, Math.min(qualityScale, instance.visualizer.profiler.qualityLevel))
  );
  return Math.min(
    instance.maxEffectParticles,
    Math.floor(
      instance.maxEffectParticles
        * quality
        * Math.min(1.0, 0.28 + speedMult * 0.18 + Math.pow(energy, 1.35) * 0.7)
    )
  );
}

export function computeSpeedNorm(speedMult) {
  const speed = Math.max(0.0, speedMult || 1.0);
  return Math.min(1.0, Math.log2(speed + 1.0) / Math.log2(21.0));
}

export function computeOverdriveBoost(speedMult) {
  const speed = Math.max(0.0, speedMult || 1.0);
  const overdrive = Math.max(0.0, speed - 1.0);
  return Math.min(1.0, 1.0 - Math.exp(-overdrive * 0.18));
}

export function smoothEnergyLevel(instance, rawEnergy, deltaTime) {
  const speed = Math.max(0.0, instance.speedMult || 1.0);
  const overdrive = Math.max(0.0, speed - 1.0);
  const overdriveBoost = Math.min(1.0, 1.0 - Math.exp(-overdrive * 0.18));
  const boosted = Math.pow(Math.max(0.0, rawEnergy), 0.75);
  const target = Math.min(1.0, boosted + overdriveBoost * 0.35);
  const smooth = 1.0 - Math.exp(-Math.max(0.0, deltaTime) * 14.0);
  instance.energyLevel = instance.energyLevel + (target - instance.energyLevel) * smooth;
  instance.energyLevel = Math.min(1.0, Math.max(0.0, instance.energyLevel));
}

/** Write rebuilt cylinder instances to the device roller buffer. */
export function writeMeshCylinders(instance, mesh) {
  if (!instance.rollerInstances || !mesh?.cylinders) return;
  const data = instancesToBufferData([mesh.cylinders()]);
  instance.device.queue.writeBuffer(instance.rollerInstances, 0, data);
  instance.meshCylinderCount = countInstances(mesh.cylinders().flat());
}
