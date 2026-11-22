import type { PipelineLayoutCache } from '../pipeline-layout-cache.js';
import { hashString } from '../helpers.js';

/** WGSL of the three passes of an MLS-MPM substep (`MultiDeviceShaders.mpmShaders`). */
export interface MpmShaderSources {
  p2g: string;
  grid: string;
  g2p: string;
}

export interface MpmPipelines {
  p2g: GPUComputePipeline;
  gridUpdate: GPUComputePipeline;
  g2p: GPUComputePipeline;
}

/**
 * MLS-MPM liquid substep (ADR-0022): three modules, one entry point each, on
 * the shared `mpm` layout. See passes/mpm-p2g.wgsl, mpm-grid.wgsl, mpm-g2p.wgsl.
 */
export async function ensureMpmPipelines(cache: PipelineLayoutCache, src: MpmShaderSources): Promise<MpmPipelines> {
  const layout = cache.getPipelineLayout('mpm');
  const make = (name: string, code: string, entryPoint: string) =>
    cache.getOrCreatePipeline(`mpm_${name}_${hashString(code)}`, () =>
      cache.device.createComputePipelineAsync({
        label: `mpm-${name}-pipeline`,
        layout,
        compute: { module: cache.shaderModule(`mpm-${name}-module`, code), entryPoint }
      })
    );
  const [p2g, gridUpdate, g2p] = await Promise.all([
    make('p2g', src.p2g, 'p2g'),
    make('grid', src.grid, 'gridUpdate'),
    make('g2p', src.g2p, 'g2p')
  ]);
  return { p2g, gridUpdate, g2p };
}
