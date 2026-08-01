/**
 * Ambient types for the SEG update strategy (implementation stays JS —
 * it is dense plant/visual math scheduled for a later wave).
 */

import type { DeviceInstanceLike, DeviceEffectContext, DeviceUpdateContext } from '../types';

export function segGetComputeSpeed(instance: DeviceInstanceLike, baseSpeed: number): number;
export function segUpdateDynamics(instance: DeviceInstanceLike, ctx: DeviceUpdateContext): void;
export function segComputeRawEnergy(instance: DeviceInstanceLike): number;
export function segUpdateEffects(instance: DeviceInstanceLike, ctx: DeviceEffectContext): boolean;
export function segUpdateElectromagnetCoils(instance: DeviceInstanceLike): void;
export function segUpdatePickupCoilEnergies(
  instance: DeviceInstanceLike,
  rollerData?: Float32Array,
  compact?: boolean
): void;
export function segUpdateEnergyArcs(instance: DeviceInstanceLike): void;
export function segUpdateFrameVibration(instance: DeviceInstanceLike): void;
