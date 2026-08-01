/**
 * Shared helpers for device update strategies (effects budget, gates, mesh writes).
 */

import { instancesToBufferData, countInstances } from '../device-mesh-layouts.js';
import type { DeviceInstanceLike, DeviceMeshSource } from './types';

export function effectGate(value: number, low: number, high: number): number {
  if (high <= low) return value > high ? 1 : 0;
  return Math.max(0, Math.min(1, (value - low) / (high - low)));
}

export function computeEffectBudget(instance: DeviceInstanceLike, qualityScale: number): number {
  const speedMult = instance.speedMult || 1.0;
  const energy = instance.energyLevel;
  const quality = Math.max(
    0.0,
    Math.min(1.0, Math.min(qualityScale, instance.visualizer.profiler?.qualityLevel ?? 1))
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

export function computeSpeedNorm(speedMult: number): number {
  const speed = Math.max(0.0, speedMult || 1.0);
  return Math.min(1.0, Math.log2(speed + 1.0) / Math.log2(21.0));
}

export function computeOverdriveBoost(speedMult: number): number {
  const speed = Math.max(0.0, speedMult || 1.0);
  const overdrive = Math.max(0.0, speed - 1.0);
  return Math.min(1.0, 1.0 - Math.exp(-overdrive * 0.18));
}

export function smoothEnergyLevel(
  instance: DeviceInstanceLike,
  rawEnergy: number,
  deltaTime: number
): void {
  const speed = Math.max(0.0, instance.speedMult || 1.0);
  const overdrive = Math.max(0.0, speed - 1.0);
  const overdriveBoost = Math.min(1.0, 1.0 - Math.exp(-overdrive * 0.18));
  const boosted = Math.pow(Math.max(0.0, rawEnergy), 0.75);
  const target = Math.min(1.0, boosted + overdriveBoost * 0.35);
  const smooth = 1.0 - Math.exp(-Math.max(0.0, deltaTime) * 14.0);
  instance.energyLevel = instance.energyLevel + (target - instance.energyLevel) * smooth;
  instance.energyLevel = Math.min(1.0, Math.max(0.0, instance.energyLevel));
}

/**
 * Write rebuilt cylinder instances to the device roller buffer.
 * Updates both instance + geometry counts so overview mesh LOD can prefix-draw.
 */
export function writeMeshCylinders(instance: DeviceInstanceLike, mesh?: DeviceMeshSource): void {
  if (!instance.rollerInstances || !mesh?.cylinders) return;
  const data = instancesToBufferData([mesh.cylinders()]);
  instance.device.queue.writeBuffer(instance.rollerInstances, 0, data);
  const count = countInstances(mesh.cylinders().flat());
  instance.meshCylinderCount = count;
  if (instance.geometry) instance.geometry.meshCylinderCount = count;
}
