/**
 * Particle / roller / field compute entry points.
 * Pass files under `passes/` are canonical; this module only re-exports `?raw`
 * sources expanded by vite-plugin-wgsl-include / extract-wgsl.mjs.
 */
import particleComputeWgsl from '../passes/particle-compute.wgsl?raw';
import segRollerComputeWgsl from '../passes/seg-roller-compute.wgsl?raw';
import fieldAdvectComputeWgsl from '../passes/field-advect-compute.wgsl?raw';
import overviewCullComputeWgsl from '../passes/overview-cull-compute.wgsl?raw';
import transformerFluxComputeWgsl from '../passes/transformer-flux-compute.wgsl?raw';
import choresReduceF32Wgsl from '../passes/chores-reduce-f32.wgsl?raw';

export function getComputeShader() {
  return particleComputeWgsl;
}

export function getSegRollerComputeShader() {
  return segRollerComputeWgsl;
}

export function getSegFieldAdvectShader() {
  return fieldAdvectComputeWgsl;
}

export function getOverviewCullComputeShader() {
  return overviewCullComputeWgsl;
}

export function getTransformerFluxShader() {
  return transformerFluxComputeWgsl;
}

export function getChoresReduceShader() {
  return choresReduceF32Wgsl;
}
