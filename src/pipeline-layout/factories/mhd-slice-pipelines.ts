import type { PipelineLayoutCache } from '../pipeline-layout-cache.js';
import { ALPHA_BLEND, MATERIAL_GBUFFER_FORMAT, hashString } from '../helpers.js';

/** WGSL of the MHD slice's compute passes (`MHD_SLICE_SHADERS`, fluids/mhd-slice-shaders.ts). */
export interface MhdSliceShaderSources {
  lbm: string;
  phi: string;
  draw: string;
}

export interface MhdSlicePipelines {
  /** One lattice-Boltzmann step. */
  step: GPUComputePipeline;
  /** The two colours of a sweep of the potential. */
  sorRed: GPUComputePipeline;
  sorBlack: GPUComputePipeline;
  /** Mean force per column; current and voltage per electrode pair. */
  reduceColumns: GPUComputePipeline;
  reduceElectrodes: GPUComputePipeline;
  /** The current's stream function, for the picture. */
  streamFunction: GPUComputePipeline;
}

/**
 * The MHD duct slice (docs/FLUIDS.md → MHD duct → The slice), all on the
 * `mhdSlice` layout. Not a method on the cache: the slice travels with the
 * lazily loaded liquid chunk, and a method there would pull this file into
 * the WebGPU chunk.
 */
export async function ensureMhdSlicePipelines(cache: PipelineLayoutCache, src: MhdSliceShaderSources): Promise<MhdSlicePipelines> {
  const make = (name: string, code: string, entryPoint: string) =>
    cache.getOrCreatePipeline(`mhdSlice_${name}_${hashString(code)}`, () =>
      cache.device.createComputePipelineAsync({
        label: `mhd-slice-${name}-pipeline`,
        layout: cache.getPipelineLayout('mhdSlice'),
        compute: { module: cache.shaderModule(`mhd-slice-${entryPoint === 'step' ? 'lbm' : 'phi'}-module`, code), entryPoint }
      })
    );
  const [step, sorRed, sorBlack, reduceColumns, reduceElectrodes, streamFunction] = await Promise.all([
    make('step', src.lbm, 'step'),
    make('sor-red', src.phi, 'sorRed'),
    make('sor-black', src.phi, 'sorBlack'),
    make('reduce-columns', src.phi, 'reduceColumns'),
    make('reduce-electrodes', src.phi, 'reduceElectrodes'),
    make('stream-function', src.phi, 'streamFunction')
  ]);
  return { step, sorRed, sorBlack, reduceColumns, reduceElectrodes, streamFunction };
}

/**
 * The slice's panel, drawn in the scene pass after the opaque meshes. Two
 * attachments like every scene pipeline: the colour blends, the material
 * G-buffer is masked (a transparent panel leaves no material behind).
 */
export async function ensureMhdSliceDrawPipeline(cache: PipelineLayoutCache, code: string, opts: { sampleCount?: number } = {}): Promise<GPURenderPipeline> {
  const sampleCount = opts.sampleCount ?? 1;
  const suffix = sampleCount === 4 ? '_msaa4' : '';
  const module = cache.shaderModule('mhd-slice-draw-module', code);
  return cache.getOrCreatePipeline(`mhdSliceDraw${suffix}_${hashString(code)}`, () =>
    cache.device.createRenderPipelineAsync({
      label: `mhd-slice-draw-pipeline${suffix}`,
      layout: cache.getPipelineLayout('mhdSliceDraw'),
      vertex: { module, entryPoint: 'vsMain' },
      fragment: {
        module,
        entryPoint: 'fsMain',
        targets: [
          { format: cache.sceneFormat, blend: ALPHA_BLEND },
          { format: MATERIAL_GBUFFER_FORMAT, writeMask: 0 }
        ]
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: cache.depthStencil(false, 'less'),
      multisample: { count: sampleCount }
    })
  );
}
