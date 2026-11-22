import type { PipelineLayoutCache } from '../pipeline-layout-cache.js';
import { hashString } from '../helpers.js';

/** WGSL of the MLS-MPM passes (`MultiDeviceShaders.mpmShaders`). */
export interface MpmShaderSources {
  p2g: string;
  grid: string;
  g2p: string;
  emit: string;
  probe: string;
  exportDraw: string;
}

export interface MpmPipelines {
  /** The substep, on the `mpm` layout. */
  p2g: GPUComputePipeline;
  gridUpdate: GPUComputePipeline;
  g2p: GPUComputePipeline;
  /** Once a frame, on the `mpmIo` layout. */
  emit: GPUComputePipeline;
  probe: GPUComputePipeline;
  exportDraw: GPUComputePipeline;
}

/**
 * MLS-MPM liquid (ADR-0022): six modules, one entry point each. The substep
 * (passes/mpm-p2g.wgsl, mpm-grid.wgsl, mpm-g2p.wgsl) is on the `mpm` layout;
 * emitters and sinks, the profile read-back and the draw export
 * (mpm-emit.wgsl, mpm-probe.wgsl, mpm-export.wgsl) are on `mpmIo`.
 */
export async function ensureMpmPipelines(cache: PipelineLayoutCache, src: MpmShaderSources): Promise<MpmPipelines> {
  const make = (layoutName: 'mpm' | 'mpmIo', name: string, code: string, entryPoint: string) =>
    cache.getOrCreatePipeline(`mpm_${name}_${hashString(code)}`, () =>
      cache.device.createComputePipelineAsync({
        label: `mpm-${name}-pipeline`,
        layout: cache.getPipelineLayout(layoutName),
        compute: { module: cache.shaderModule(`mpm-${name}-module`, code), entryPoint }
      })
    );
  const [p2g, gridUpdate, g2p, emit, probe, exportDraw] = await Promise.all([
    make('mpm', 'p2g', src.p2g, 'p2g'),
    make('mpm', 'grid', src.grid, 'gridUpdate'),
    make('mpm', 'g2p', src.g2p, 'g2p'),
    make('mpmIo', 'emit', src.emit, 'emit'),
    make('mpmIo', 'probe', src.probe, 'probe'),
    make('mpmIo', 'export', src.exportDraw, 'exportParticles')
  ]);
  return { p2g, gridUpdate, g2p, emit, probe, exportDraw };
}
