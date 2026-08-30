/**
 * Animated energy-transfer pipes between devices in world space.
 * Pass files under passes/ are canonical; this module only re-exports ?raw.
 */
import energyPipeComputeWgsl from '../passes/energy-pipe-compute.wgsl?raw';
import energyPipeVertWgsl from '../passes/energy-pipe-vert.wgsl?raw';
import energyPipeFragWgsl from '../passes/energy-pipe-frag.wgsl?raw';

export function getEnergyPipeComputeShader() {
  return energyPipeComputeWgsl;
}

export function getEnergyPipeVertShader() {
  return energyPipeVertWgsl;
}

export function getEnergyPipeFragShader() {
  return energyPipeFragWgsl;
}
