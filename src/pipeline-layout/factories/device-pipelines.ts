import type { MultiDeviceShaders } from '../../multi-device-shaders.js';
import type { PipelineLayoutCache } from '../pipeline-layout-cache.js';
import {
  VB_POS_NORMAL, VB_POS_NORMAL_UV, VB_ENERGY_ARC,
  ALPHA_BLEND, ADDITIVE_BLEND, ADDITIVE_SRC_ALPHA, hashString
} from '../helpers.js';

/** Ensure all multi-device device pipelines exist. Call once after shaders are ready. */
export async function ensureDevicePipelines(
  cache: PipelineLayoutCache,
  shaders: MultiDeviceShaders
): Promise<void> {
  const fmt = cache.canvasFormat;
  const depthWrite = cache.depthStencil(true, 'less');
  const depthRead = cache.depthStencil(false, 'less');

  await cache.getOrCreatePipeline('roller', () =>
    cache.device.createRenderPipeline({
      label: 'rollerPipeline',
      layout: cache.getPipelineLayout('roller'),
      vertex: {
        module: cache.shaderModule('roller-vert', shaders.rollerVertShader),
        entryPoint: 'main',
        buffers: [VB_POS_NORMAL]
      },
      fragment: {
        module: cache.shaderModule('roller-frag', shaders.rollerFragShader),
        entryPoint: 'main',
        targets: [{ format: fmt, blend: ALPHA_BLEND }]
      },
      primitive: { topology: 'triangle-list' },
      depthStencil: depthWrite
    })
  );

  await cache.getOrCreatePipeline('particle', () =>
    cache.device.createRenderPipeline({
      label: 'particlePipeline',
      layout: cache.getPipelineLayout('particle'),
      vertex: {
        module: cache.shaderModule('particle-vert', shaders.particleVertShader),
        entryPoint: 'main',
        buffers: []
      },
      fragment: {
        module: cache.shaderModule('particle-frag', shaders.particleFragShader),
        entryPoint: 'main',
        targets: [{ format: fmt, blend: ADDITIVE_BLEND }]
      },
      primitive: { topology: 'triangle-strip' },
      depthStencil: depthRead
    })
  );

  await cache.getOrCreatePipeline('segEnhanced', () =>
    cache.device.createRenderPipeline({
      label: 'segEnhancedPipeline',
      layout: cache.getPipelineLayout('segEnhanced'),
      vertex: {
        module: cache.shaderModule('seg-enhanced-vert', shaders.segEnhancedVertShader),
        entryPoint: 'main',
        buffers: [VB_POS_NORMAL_UV]
      },
      fragment: {
        module: cache.shaderModule('seg-enhanced-frag', shaders.segEnhancedFragShader),
        entryPoint: 'main',
        targets: [{ format: fmt, blend: ALPHA_BLEND }]
      },
      primitive: { topology: 'triangle-list', cullMode: 'back' },
      depthStencil: depthWrite
    })
  );

  await cache.getOrCreatePipeline('fluxSegment', () =>
    cache.device.createRenderPipeline({
      label: 'fluxSegmentPipeline',
      layout: cache.getPipelineLayout('fluxSegment'),
      vertex: {
        module: cache.shaderModule('flux-segment-vert', shaders.fluxSegmentVertShader),
        entryPoint: 'main',
        buffers: []
      },
      fragment: {
        module: cache.shaderModule('flux-segment-frag', shaders.fluxSegmentFragShader),
        entryPoint: 'main',
        targets: [{ format: fmt, blend: ADDITIVE_SRC_ALPHA }]
      },
      primitive: { topology: 'triangle-strip' },
      depthStencil: depthRead
    })
  );

  await cache.getOrCreatePipeline('energyArc', () =>
    cache.device.createRenderPipeline({
      label: 'energyArcPipeline',
      layout: cache.getPipelineLayout('fieldParticles'),
      vertex: {
        module: cache.shaderModule('energy-arc-vert', shaders.energyArcVertShader),
        entryPoint: 'main',
        buffers: [VB_ENERGY_ARC]
      },
      fragment: {
        module: cache.shaderModule('energy-arc-frag', shaders.energyArcFragShader),
        entryPoint: 'main',
        targets: [{ format: fmt, blend: ALPHA_BLEND }]
      },
      primitive: { topology: 'line-list' },
      depthStencil: depthRead
    })
  );

  await cache.getOrCreatePipeline('fieldLine', () =>
    cache.device.createRenderPipeline({
      label: 'fieldLinePipeline',
      layout: cache.getPipelineLayout('fieldParticles'),
      vertex: {
        module: cache.shaderModule('field-line-vert', shaders.fieldLineVertShader),
        entryPoint: 'main',
        buffers: []
      },
      fragment: {
        module: cache.shaderModule('field-line-frag', shaders.fieldLineFragShader),
        entryPoint: 'main',
        targets: [{ format: fmt, blend: ADDITIVE_SRC_ALPHA }]
      },
      primitive: { topology: 'triangle-strip' },
      depthStencil: depthRead
    })
  );

  const computeCode = shaders.computeShader;
  const computeKey = `particleCompute_${hashString(computeCode)}`;
  await cache.getOrCreatePipeline(computeKey, async () => {
    const module = cache.shaderModule('compute-particle-module', computeCode);
    return cache.device.createComputePipelineAsync({
      label: 'compute-particle-pipeline',
      layout: cache.getPipelineLayout('particleCompute'),
      compute: { module, entryPoint: 'main' }
    });
  });
  const computePipeline = cache.pipelines.get(computeKey);
  if (computePipeline && !cache.pipelines.has('particleCompute')) {
    cache.pipelines.set('particleCompute', computePipeline);
  }

  if (shaders.coilVertShader && shaders.coilFragShader) {
    await cache.getOrCreatePipeline('coil', () =>
      cache.device.createRenderPipeline({
        label: 'coilPipeline',
        layout: cache.getPipelineLayout('coil'),
        vertex: {
          module: cache.shaderModule('coil-vert', shaders.coilVertShader),
          entryPoint: 'main',
          buffers: [VB_POS_NORMAL]
        },
        fragment: {
          module: cache.shaderModule('coil-frag', shaders.coilFragShader),
          entryPoint: 'main',
          targets: [{ format: fmt, blend: ALPHA_BLEND }]
        },
        primitive: { topology: 'triangle-list' },
        depthStencil: depthWrite
      })
    );
  }

  console.log(
    `[PipelineLayoutCache] device pipelines ready: creates=${cache.stats.pipelineCreates} ` +
    `hits=${cache.stats.pipelineCacheHits} shaderModules=${cache.stats.shaderModuleCreates}`
  );
}
