import type { MultiDeviceShaders } from '../../multi-device-shaders.js';
import type { PipelineLayoutCache } from '../pipeline-layout-cache.js';
import { VB_GRID, VB_POS_NORMAL_UV, ALPHA_BLEND, ADDITIVE_SRC_ALPHA, hashString } from '../helpers.js';
import type { DevicePipelineOptions } from './device-pipelines.js';

export async function ensureEnergyPipePipeline(
  cache: PipelineLayoutCache,
  shaders: MultiDeviceShaders,
  opts: DevicePipelineOptions = {}
): Promise<GPURenderPipeline> {
  const sampleCount = opts.sampleCount ?? 1;
  const suffix = sampleCount === 4 ? '_msaa4' : '';
  return cache.getOrCreatePipeline(`energyPipe${suffix}`, () =>
    cache.device.createRenderPipeline({
      label: `energyPipePipeline${suffix}`,
      layout: cache.getPipelineLayout('energyPipe'),
      vertex: {
        module: cache.shaderModule('energy-pipe-vert', shaders.energyPipeVertShader),
        entryPoint: 'main',
        buffers: []
      },
      fragment: {
        module: cache.shaderModule('energy-pipe-frag', shaders.energyPipeFragShader),
        entryPoint: 'main',
        // No material G-buffer write — null keeps this compatible with the
        // scene pass's second color attachment (ADR-0005 WS2 G-buffer).
        targets: [{ format: cache.canvasFormat, blend: ADDITIVE_SRC_ALPHA }, null]
      },
      primitive: { topology: 'triangle-strip' },
      depthStencil: cache.depthStencil(false, 'less'),
      multisample: { count: sampleCount }
    })
  );
}

export async function ensureEnergyPipeComputePipeline(
  cache: PipelineLayoutCache,
  shaders: MultiDeviceShaders
): Promise<GPUComputePipeline> {
  const code = shaders.energyPipeComputeShader;
  const key = `energyPipeCompute_${hashString(code)}`;
  let pipeline = cache.pipelines.get(key) as GPUComputePipeline | undefined;
  if (!pipeline) {
    pipeline = cache.device.createComputePipeline({
      label: 'energyPipeComputePipeline',
      layout: cache.getPipelineLayout('energyPipeCompute'),
      compute: {
        module: cache.shaderModule('energy-pipe-compute', code),
        entryPoint: 'main'
      }
    });
    cache.pipelines.set(key, pipeline);
  }
  if (!cache.pipelines.has('energyPipeCompute')) {
    cache.pipelines.set('energyPipeCompute', pipeline);
  }
  return cache.pipelines.get('energyPipeCompute') as GPUComputePipeline;
}

export async function ensureOverviewCullPipeline(
  cache: PipelineLayoutCache,
  shaders: MultiDeviceShaders
): Promise<GPUComputePipeline> {
  const code = shaders.overviewCullComputeShader;
  return cache.getOrCreatePipeline(`overviewCull_${hashString(code)}`, () =>
    cache.device.createComputePipeline({
      label: 'overviewCullPipeline',
      layout: cache.getPipelineLayout('overviewCull'),
      compute: {
        module: cache.shaderModule('overview-cull-compute', code),
        entryPoint: 'main'
      }
    })
  );
}

export async function ensureSkyPipeline(
  cache: PipelineLayoutCache,
  shaders: MultiDeviceShaders,
  opts: DevicePipelineOptions = {}
): Promise<GPURenderPipeline> {
  const sampleCount = opts.sampleCount ?? 1;
  const suffix = sampleCount === 4 ? '_msaa4' : '';
  return cache.getOrCreatePipeline(`sky${suffix}`, () =>
    cache.device.createRenderPipeline({
      label: `skyPipeline${suffix}`,
      layout: cache.getPipelineLayout('sky'),
      vertex: {
        module: cache.shaderModule('sky-vert', shaders.skyVertShader),
        entryPoint: 'main'
      },
      fragment: {
        module: cache.shaderModule('sky-frag', shaders.skyFragShader),
        entryPoint: 'main',
        // No material G-buffer write — null keeps this compatible with the
        // scene pass's second color attachment (ADR-0005 WS2 G-buffer).
        targets: [{ format: cache.canvasFormat }, null]
      },
      primitive: { topology: 'triangle-list' },
      depthStencil: cache.depthStencil(false, 'always'),
      multisample: { count: sampleCount }
    })
  );
}

export async function ensureGridPipeline(
  cache: PipelineLayoutCache,
  shaders: MultiDeviceShaders,
  opts: DevicePipelineOptions = {}
): Promise<GPURenderPipeline> {
  const sampleCount = opts.sampleCount ?? 1;
  const suffix = sampleCount === 4 ? '_msaa4' : '';
  return cache.getOrCreatePipeline(`grid${suffix}`, () =>
    cache.device.createRenderPipeline({
      label: `gridPipeline${suffix}`,
      layout: cache.getPipelineLayout('empty'),
      vertex: {
        module: cache.shaderModule('grid-vert', shaders.gridVertShader),
        entryPoint: 'main',
        buffers: [VB_GRID]
      },
      fragment: {
        module: cache.shaderModule('grid-frag', shaders.gridFragShader),
        entryPoint: 'main',
        // No material G-buffer write — null keeps this compatible with the
        // scene pass's second color attachment (ADR-0005 WS2 G-buffer).
        targets: [{ format: cache.canvasFormat, blend: ALPHA_BLEND }, null]
      },
      primitive: { topology: 'triangle-list' },
      depthStencil: cache.depthStencil(false, 'less'),
      multisample: { count: sampleCount }
    })
  );
}

export async function ensureAnomalyWallPipeline(
  cache: PipelineLayoutCache,
  shaders: MultiDeviceShaders,
  opts: DevicePipelineOptions = {}
): Promise<GPURenderPipeline> {
  const code = shaders.anomalyWallsShader;
  const sampleCount = opts.sampleCount ?? 1;
  const suffix = sampleCount === 4 ? '_msaa4' : '';
  return cache.getOrCreatePipeline(`anomalyWall${suffix}`, () =>
    cache.device.createRenderPipeline({
      label: `anomalyWallPipeline${suffix}`,
      layout: cache.getPipelineLayout('anomalyWall'),
      vertex: {
        module: cache.shaderModule('anomaly-walls', code),
        entryPoint: 'vsMain',
        buffers: [VB_POS_NORMAL_UV]
      },
      fragment: {
        module: cache.shaderModule('anomaly-walls', code),
        entryPoint: 'fsMain',
        // No material G-buffer write — null keeps this compatible with the
        // scene pass's second color attachment (ADR-0005 WS2 G-buffer).
        targets: [{ format: cache.canvasFormat, blend: ALPHA_BLEND }, null]
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: cache.depthStencil(false, 'less'),
      multisample: { count: sampleCount }
    })
  );
}

/**
 * Manual MSAA depth resolve (ADR-0005 WS2) — see passes/depth-resolve.wgsl.
 * Depth-only: no color targets, `depthCompare: 'always'` so every fragment of
 * the fullscreen triangle unconditionally writes its @builtin(frag_depth).
 */
export async function ensureDepthResolvePipeline(
  cache: PipelineLayoutCache,
  shaders: MultiDeviceShaders
): Promise<GPURenderPipeline> {
  const code = shaders.depthResolveShader;
  return cache.getOrCreatePipeline('depthResolve', () =>
    cache.device.createRenderPipeline({
      label: 'depthResolvePipeline',
      layout: cache.getPipelineLayout('depthResolve'),
      vertex: {
        module: cache.shaderModule('depth-resolve', code),
        entryPoint: 'vsMain'
      },
      fragment: {
        module: cache.shaderModule('depth-resolve', code),
        entryPoint: 'fsMain',
        targets: []
      },
      primitive: { topology: 'triangle-list' },
      depthStencil: cache.depthStencil(true, 'always')
    })
  );
}

export async function ensureBloomPipelines(
  cache: PipelineLayoutCache,
  shaders: MultiDeviceShaders
): Promise<void> {
  const fmt = cache.canvasFormat;
  const vertModule = cache.shaderModule('bloom-vert', shaders.bloomVertShader);

  await cache.getOrCreatePipeline('bloomExtract', () =>
    cache.device.createRenderPipeline({
      label: 'bloomExtract',
      layout: cache.getPipelineLayout('bloomExtract'),
      vertex: { module: vertModule, entryPoint: 'main' },
      fragment: {
        module: cache.shaderModule('bloom-extract', shaders.bloomExtractShader),
        entryPoint: 'main',
        targets: [{ format: fmt }]
      },
      primitive: { topology: 'triangle-list' }
    })
  );

  await cache.getOrCreatePipeline('bloomBlur', () =>
    cache.device.createRenderPipeline({
      label: 'bloomBlur',
      layout: cache.getPipelineLayout('bloomBlur'),
      vertex: { module: vertModule, entryPoint: 'main' },
      fragment: {
        module: cache.shaderModule('bloom-blur', shaders.bloomBlurShader),
        entryPoint: 'main',
        targets: [{ format: fmt }]
      },
      primitive: { topology: 'triangle-list' }
    })
  );

  await cache.getOrCreatePipeline('bloomComposite', () =>
    cache.device.createRenderPipeline({
      label: 'bloomComposite',
      layout: cache.getPipelineLayout('bloomComposite'),
      vertex: { module: vertModule, entryPoint: 'main' },
      fragment: {
        module: cache.shaderModule('bloom-composite', shaders.bloomCompositeShader),
        entryPoint: 'main',
        targets: [{ format: fmt }]
      },
      primitive: { topology: 'triangle-list' }
    })
  );
}

export async function ensureIblPrefilterPipeline(
  cache: PipelineLayoutCache,
  code: string
): Promise<GPUComputePipeline> {
  return cache.getOrCreatePipeline(`iblPrefilter_${hashString(code)}`, async () => {
    const module = cache.shaderModule('ibl-prefilter-compute-module', code);
    const p = await cache.device.createComputePipelineAsync({
      label: 'ibl-prefilter-compute-pipeline',
      layout: cache.getPipelineLayout('iblPrefilter'),
      compute: { module, entryPoint: 'main' }
    });
    cache.pipelines.set('iblPrefilter', p);
    return p;
  });
}

export async function ensureSsrPipeline(
  cache: PipelineLayoutCache,
  code: string
): Promise<GPUComputePipeline> {
  return cache.getOrCreatePipeline(`ssrCompute_${hashString(code)}`, async () => {
    const module = cache.shaderModule('ssr-compute-module', code);
    const p = await cache.device.createComputePipelineAsync({
      label: 'ssr-compute-pipeline',
      layout: cache.getPipelineLayout('ssr'),
      compute: { module, entryPoint: 'main' }
    });
    cache.pipelines.set('ssr', p);
    return p;
  });
}
