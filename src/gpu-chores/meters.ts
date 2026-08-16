/**
 * HUD / export meters that go through gpu-chores instead of ad-hoc shader math.
 */

import { gpuChores } from './session';
import { mapScaleF32Js } from './reduce-js';
import type { ReduceResult } from './types';

const ENERGY_DENSITY_SURFACE = 1.976e6;

export interface LabEnergyMeter {
  energies: Float32Array;
  reduce: ReduceResult;
  /** Display-scaled field (map): 0.2 + 0.8·clamp(x,0,1) times surface density. */
  densityJm3: Float32Array;
  avgEnergyDensity: number;
  labEnergySum: number;
  labEnergyRms: number;
  backend: ReduceResult['backend'];
}

export function collectDeviceEnergies(
  devices: Record<string, { energyLevel?: number; physics?: { energyLevel?: number }; physicsState?: { energyLevel?: number } }> | null | undefined
): Float32Array {
  if (!devices) return new Float32Array(0);
  const vals: number[] = [];
  for (const d of Object.values(devices)) {
    const e = d.physicsState?.energyLevel ?? d.physics?.energyLevel ?? d.energyLevel;
    if (typeof e === 'number' && Number.isFinite(e)) vals.push(e);
  }
  return Float32Array.from(vals);
}

/** Reduce per-device energyLevel → lab energy + display-scaled density field. */
export function meterLabEnergy(energies: ArrayLike<number>): LabEnergyMeter {
  const packed = energies instanceof Float32Array ? energies : Float32Array.from(energies as ArrayLike<number>);
  const reduce = gpuChores.reduceF32(packed);
  const mapped = gpuChores.mapScaleF32
    ? gpuChores.mapScaleF32(packed, { scale: 0.8, bias: 0.2 })
    : mapScaleF32Js(packed, { scale: 0.8, bias: 0.2 });
  const density = new Float32Array(mapped.length);
  for (let i = 0; i < mapped.length; i++) {
    density[i] = ENERGY_DENSITY_SURFACE * Math.max(0, Math.min(1.2, mapped[i]));
  }
  const avg = reduce.count > 0
    ? ENERGY_DENSITY_SURFACE * (0.2 + 0.8 * Math.max(0, Math.min(1, reduce.rms)))
    : 0;
  return {
    energies: packed,
    reduce,
    densityJm3: density,
    avgEnergyDensity: avg,
    labEnergySum: reduce.sum,
    labEnergyRms: reduce.rms,
    backend: reduce.backend
  };
}

export function meterScalarFlux(counts: ArrayLike<number>, speedMult = 1): {
  reduce: ReduceResult;
  particleFlux: number;
} {
  const reduce = gpuChores.reduceF32(counts);
  return {
    reduce,
    particleFlux: reduce.sum * Math.max(0.05, speedMult)
  };
}
