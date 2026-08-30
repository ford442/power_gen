import type { PipelineLayoutCache } from '../pipeline-layout-cache.js';
import { hashString } from '../helpers.js';

export async function ensureRollerComputePipeline(
  cache: PipelineLayoutCache,
  code: string
): Promise<GPUComputePipeline> {
  return cache.getOrCreatePipeline(`rollerCompute_${hashString(code)}`, async () => {
    const module = cache.shaderModule('seg-roller-compute-module', code);
    const p = await cache.device.createComputePipelineAsync({
      label: 'seg-roller-compute-pipeline',
      layout: cache.getPipelineLayout('rollerCompute'),
      compute: { module, entryPoint: 'main' }
    });
    cache.pipelines.set('rollerCompute', p);
    return p;
  });
}

export async function ensureFieldAdvectPipeline(
  cache: PipelineLayoutCache,
  code: string
): Promise<GPUComputePipeline> {
  return cache.getOrCreatePipeline(`fieldAdvect_${hashString(code)}`, async () => {
    const module = cache.shaderModule('seg-field-advect-module', code);
    const p = await cache.device.createComputePipelineAsync({
      label: 'seg-field-advect-pipeline',
      layout: cache.getPipelineLayout('fieldAdvect'),
      compute: { module, entryPoint: 'main' }
    });
    cache.pipelines.set('fieldAdvect', p);
    return p;
  });
}

export async function ensureChoresReducePipeline(
  cache: PipelineLayoutCache,
  code: string
): Promise<GPUComputePipeline> {
  return cache.getOrCreatePipeline(`choresReduce_${hashString(code)}`, async () => {
    const module = cache.shaderModule('chores-reduce-f32-module', code);
    const p = await cache.device.createComputePipelineAsync({
      label: 'chores-reduce-f32-pipeline',
      layout: cache.getPipelineLayout('choresReduce'),
      compute: { module, entryPoint: 'main' }
    });
    cache.pipelines.set('choresReduce', p);
    return p;
  });
}

export async function ensureTransformerFluxPipeline(
  cache: PipelineLayoutCache,
  code: string
): Promise<GPUComputePipeline> {
  return cache.getOrCreatePipeline(`transformerFlux_${hashString(code)}`, async () => {
    const module = cache.shaderModule('transformer-flux-compute-module', code);
    const p = await cache.device.createComputePipelineAsync({
      label: 'transformer-flux-compute-pipeline',
      layout: cache.getPipelineLayout('transformerFlux'),
      compute: { module, entryPoint: 'main' }
    });
    cache.pipelines.set('transformerFlux', p);
    return p;
  });
}

export async function ensureFluxTracerPipeline(
  cache: PipelineLayoutCache,
  code: string
): Promise<GPUComputePipeline> {
  return cache.getOrCreatePipeline(`fluxTracer_${hashString(code)}`, async () => {
    const module = cache.shaderModule('flux-tracer-module', code);
    const p = await cache.device.createComputePipelineAsync({
      label: 'flux-tracer-pipeline',
      layout: cache.getPipelineLayout('fluxTracer'),
      compute: { module, entryPoint: 'traceBidirectional' }
    });
    cache.pipelines.set('fluxTracer', p);
    return p;
  });
}
