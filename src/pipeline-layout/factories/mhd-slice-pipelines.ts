import type { PipelineLayoutCache } from '../pipeline-layout-cache.js';
import { hashString } from '../helpers.js';

/** WGSL of the MHD slice's compute passes (`MHD_SLICE_SHADERS`, fluids/mhd-slice-shaders.ts). */
export interface MhdSliceShaderSources {
  lbm: string;
  phi: string;
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
  const [step, sorRed, sorBlack, reduceColumns, reduceElectrodes] = await Promise.all([
    make('step', src.lbm, 'step'),
    make('sor-red', src.phi, 'sorRed'),
    make('sor-black', src.phi, 'sorBlack'),
    make('reduce-columns', src.phi, 'reduceColumns'),
    make('reduce-electrodes', src.phi, 'reduceElectrodes')
  ]);
  return { step, sorRed, sorBlack, reduceColumns, reduceElectrodes };
}
