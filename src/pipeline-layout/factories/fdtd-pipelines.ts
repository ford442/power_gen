import type { PipelineLayoutCache } from '../pipeline-layout-cache.js';
import { ALPHA_BLEND, MATERIAL_GBUFFER_FORMAT, hashString } from '../helpers.js';

export interface FdtdComputePipelines {
  updateH: GPUComputePipeline;
  updateE: GPUComputePipeline;
}

/**
 * FDTD Yee update (ADR-0010): one module, two entry points on the shared
 * `fdtdCompute` layout. See passes/fdtd-tmz-compute.wgsl.
 */
export async function ensureFdtdComputePipelines(
  cache: PipelineLayoutCache,
  code: string
): Promise<FdtdComputePipelines> {
  const hash = hashString(code);
  const module = cache.shaderModule('fdtd-tmz-compute-module', code);
  const layout = cache.getPipelineLayout('fdtdCompute');
  const make = (entryPoint: 'updateH' | 'updateE') =>
    cache.getOrCreatePipeline(`fdtd_${entryPoint}_${hash}`, () =>
      cache.device.createComputePipelineAsync({
        label: `fdtd-${entryPoint}-pipeline`,
        layout,
        compute: { module, entryPoint }
      })
    );
  const [updateH, updateE] = await Promise.all([make('updateH'), make('updateE')]);
  return { updateH, updateE };
}

/**
 * FDTD slice panel, drawn inside the scene pass: canvas-format target with
 * alpha blend, depth-tested but not depth-writing, both faces. Built per
 * sample count like the other scene draws so the render loop can swap it
 * with MSAA.
 *
 * The material G-buffer is declared with `writeMask: 0` rather than `null`:
 * Dawn treats a `null` target as a different attachment state from a pass
 * that has a second attachment and rejects `setPipeline`. A masked target
 * matches the pass and leaves the cleared "non-metal, fully rough" value.
 */
export async function ensureFdtdSlicePipeline(
  cache: PipelineLayoutCache,
  code: string,
  opts: { sampleCount?: number } = {}
): Promise<GPURenderPipeline> {
  const sampleCount = opts.sampleCount ?? 1;
  const suffix = sampleCount === 4 ? '_msaa4' : '';
  const module = cache.shaderModule('fdtd-slice-module', code);
  return cache.getOrCreatePipeline(`fdtdSlice${suffix}_${hashString(code)}`, () =>
    cache.device.createRenderPipelineAsync({
      label: `fdtdSlicePipeline${suffix}`,
      layout: cache.getPipelineLayout('fdtdSlice'),
      vertex: { module, entryPoint: 'vsMain' },
      fragment: {
        module,
        entryPoint: 'fsMain',
        targets: [
          { format: cache.canvasFormat, blend: ALPHA_BLEND },
          { format: MATERIAL_GBUFFER_FORMAT, writeMask: 0 }
        ]
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: cache.depthStencil(false, 'less'),
      multisample: { count: sampleCount }
    })
  );
}
