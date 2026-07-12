/**
 * Particle / roller / field compute entry points.
 * Pass files under `passes/` are canonical; this module only re-exports `?raw`
 * sources expanded by vite-plugin-wgsl-include / extract-wgsl.mjs.
 */
import particleComputeWgsl from '../passes/particle-compute.wgsl?raw';
import segRollerComputeWgsl from '../passes/seg-roller-compute.wgsl?raw';
import fieldAdvectComputeWgsl from '../passes/field-advect-compute.wgsl?raw';

export function getComputeShader() {
  return particleComputeWgsl;
}

export function getSegRollerComputeShader() {
  return segRollerComputeWgsl;
}

export function getSegFieldAdvectShader() {
  return fieldAdvectComputeWgsl;
}
