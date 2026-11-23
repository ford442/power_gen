import type { PipelineLayoutCache } from '../pipeline-layout-cache.js';
import { hashString } from '../helpers.js';

/** WGSL of the liquid surface passes (`FLUID_SURFACE_SHADERS`, fluids/fluid-surface-shaders.ts). */
export interface FluidSurfaceShaderSources {
  splat: string;
  filter: string;
  composite: string;
}

export interface FluidSurfacePipelines {
  /** Sphere impostors into the liquid's depth target, nearest wins. */
  depth: GPURenderPipeline;
  /** The same impostors, additive, into the thickness target. */
  thickness: GPURenderPipeline;
  /** One direction of the narrow-range filter: depth target to depth target. */
  filter: GPURenderPipeline;
  /** The shaded surface over the scene colour. */
  composite: GPURenderPipeline;
}

/** The liquid's own depth targets: linear distance, so float. */
export const FLUID_DEPTH_FORMAT: GPUTextureFormat = 'depth32float';
/** Summed chord lengths. r16float blends and filters without a feature. */
export const FLUID_THICKNESS_FORMAT: GPUTextureFormat = 'r16float';

/**
 * The screen-space liquid surface (ADR-0022). Not a method on the cache: the
 * surface is part of the lazily loaded liquid chunk, and a method there would
 * pull this file into the WebGPU chunk.
 *
 * The composite targets the scene format with plain alpha blending — it runs
 * after the scene pass has resolved, on the single-sample scene colour, so it
 * has one pipeline whatever the sample count.
 */
export async function ensureFluidSurfacePipelines(
  cache: PipelineLayoutCache,
  shaders: FluidSurfaceShaderSources
): Promise<FluidSurfacePipelines> {
  const device = cache.device;
  const splat = cache.shaderModule('fluid-splat-module', shaders.splat);
  const filter = cache.shaderModule('fluid-filter-module', shaders.filter);
  const composite = cache.shaderModule('fluid-composite-module', shaders.composite);
  const splatHash = hashString(shaders.splat);
  const quad: GPUPrimitiveState = { topology: 'triangle-strip', cullMode: 'none' };

  const [depth, thickness, filterPipeline, compositePipeline] = await Promise.all([
    cache.getOrCreatePipeline(`fluidSplatDepth_${splatHash}`, () =>
      device.createRenderPipelineAsync({
        label: 'fluid-splat-depth-pipeline',
        layout: cache.getPipelineLayout('fluidSplat'),
        vertex: { module: splat, entryPoint: 'vsSplat' },
        fragment: { module: splat, entryPoint: 'fsDepth', targets: [] },
        primitive: quad,
        depthStencil: { format: FLUID_DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'less' }
      })),
    cache.getOrCreatePipeline(`fluidSplatThickness_${splatHash}`, () =>
      device.createRenderPipelineAsync({
        label: 'fluid-splat-thickness-pipeline',
        layout: cache.getPipelineLayout('fluidSplat'),
        vertex: { module: splat, entryPoint: 'vsSplat' },
        fragment: {
          module: splat,
          entryPoint: 'fsThickness',
          targets: [{
            format: FLUID_THICKNESS_FORMAT,
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }
            }
          }]
        },
        primitive: quad
      })),
    cache.getOrCreatePipeline(`fluidFilter_${hashString(shaders.filter)}`, () =>
      device.createRenderPipelineAsync({
        label: 'fluid-filter-pipeline',
        layout: cache.getPipelineLayout('fluidFilter'),
        vertex: { module: filter, entryPoint: 'vsFilter' },
        fragment: { module: filter, entryPoint: 'fsFilter', targets: [] },
        primitive: { topology: 'triangle-list' },
        // Every fragment of the fullscreen triangle writes its own depth.
        depthStencil: { format: FLUID_DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'always' }
      })),
    cache.getOrCreatePipeline(`fluidComposite_${cache.sceneFormat}_${hashString(shaders.composite)}`, () =>
      device.createRenderPipelineAsync({
        label: 'fluid-composite-pipeline',
        layout: cache.getPipelineLayout('fluidComposite'),
        vertex: { module: composite, entryPoint: 'vsComposite' },
        fragment: {
          module: composite,
          entryPoint: 'fsComposite',
          targets: [{
            format: cache.sceneFormat,
            blend: {
              color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }
            }
          }]
        },
        primitive: { topology: 'triangle-list' }
      }))
  ]);
  return { depth, thickness, filter: filterPipeline, composite: compositePipeline };
}
