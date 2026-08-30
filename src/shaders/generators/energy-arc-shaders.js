import energyArcVertWgsl from '../passes/energy-arc-vert.wgsl?raw';
import energyArcFragWgsl from '../passes/energy-arc-frag.wgsl?raw';

export function getEnergyArcVertShader() {
  return energyArcVertWgsl;
}

export function getEnergyArcFragShader() {
  return energyArcFragWgsl;
}
