/**
 * WGSL of the screen-space liquid surface (ADR-0022, docs/FLUIDS.md → The
 * surface): the sphere-impostor splat, the narrow-range depth filter, the
 * composite. Travels with the liquid chunk, like fluids/mpm-shaders.ts.
 */
import fluidSplatWgsl from '../shaders/passes/fluid-splat.wgsl?raw';
import fluidFilterWgsl from '../shaders/passes/fluid-filter.wgsl?raw';
import fluidCompositeWgsl from '../shaders/passes/fluid-composite.wgsl?raw';
import type { FluidSurfaceShaderSources } from '../pipeline-layout/factories/fluid-surface-pipelines.js';

export const FLUID_SURFACE_SHADERS: FluidSurfaceShaderSources = Object.freeze({
  splat: fluidSplatWgsl,
  filter: fluidFilterWgsl,
  composite: fluidCompositeWgsl
});
