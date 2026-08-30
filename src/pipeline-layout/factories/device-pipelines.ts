import type { MultiDeviceShaders } from '../../multi-device-shaders.js';
import type { PipelineLayoutCache } from '../pipeline-layout-cache.js';
import {
  VB_POS_NORMAL, VB_POS_NORMAL_UV, VB_ENERGY_ARC,
  ALPHA_BLEND, ADDITIVE_BLEND, ADDITIVE_SRC_ALPHA, hashString,
  MATERIAL_GBUFFER_FORMAT
} from '../helpers.js';

export interface DevicePipelineOptions {
  /**
   * 1 (default) or 4. The 4x variant is a second, otherwise-identical
   * GPURenderPipeline for the ADR-0005 WS2 showroom MSAA path (`high` tier +
   * focus mode — see render-loop.ts `msaaActive`) — created eagerly here
   * rather than lazily on first use, so the per-frame render loop never has
   * to await pipeline creation mid-frame. Cache keys get a `_msaa4` suffix;
   * layouts are unaffected (only `multisample` differs).
   */
  sampleCount?: number;
}

/** Ensure all multi-device device pipelines exist. Call once per sampleCount after shaders are ready. */
export async function ensureDevicePipelines(
  cache: PipelineLayoutCache,
  shaders: MultiDeviceShaders,
  opts: DevicePipelineOptions = {}
): Promise<void> {
  const fmt = cache.canvasFormat;
  const depthWrite = cache.depthStencil(true, 'less');
  const depthRead = cache.depthStencil(false, 'less');
  const sampleCount = opts.sampleCount ?? 1;
  const multisample = { count: sampleCount };
  const suffix = sampleCount === 4 ? '_msaa4' : '';
  const key = (name: string) => `${name}${suffix}`;

  await cache.getOrCreatePipeline(key('roller'), () =>
    cache.device.createRenderPipeline({
      label: `rollerPipeline${suffix}`,
      layout: cache.getPipelineLayout('roller'),
      vertex: {
        module: cache.shaderModule('roller-vert', shaders.rollerVertShader),
        entryPoint: 'main',
        buffers: [VB_POS_NORMAL]
      },
      fragment: {
        module: cache.shaderModule('roller-frag', shaders.rollerFragShader),
        entryPoint: 'main',
        // Location 1: metalness/roughness G-buffer (ADR-0005 WS2) — chrome
        // rollers write real values here; see docs/BINDINGS.md.
        targets: [{ format: fmt, blend: ALPHA_BLEND }, { format: MATERIAL_GBUFFER_FORMAT }]
      },
      primitive: { topology: 'triangle-list' },
      depthStencil: depthWrite,
      multisample
    })
  );

  await cache.getOrCreatePipeline(key('particle'), () =>
    cache.device.createRenderPipeline({
      label: `particlePipeline${suffix}`,
      layout: cache.getPipelineLayout('particle'),
      vertex: {
        module: cache.shaderModule('particle-vert', shaders.particleVertShader),
        entryPoint: 'main',
        buffers: []
      },
      fragment: {
        module: cache.shaderModule('particle-frag', shaders.particleFragShader),
        entryPoint: 'main',
        // Unlit additive particles don't participate in the material
        // G-buffer (SSR already ignores them) — null so this pipeline stays
        // compatible with the scene pass's second color attachment.
        targets: [{ format: fmt, blend: ADDITIVE_BLEND }, null]
      },
      primitive: { topology: 'triangle-strip' },
      depthStencil: depthRead,
      multisample
    })
  );

  await cache.getOrCreatePipeline(key('segEnhanced'), () =>
    cache.device.createRenderPipeline({
      label: `segEnhancedPipeline${suffix}`,
      layout: cache.getPipelineLayout('segEnhanced'),
      vertex: {
        module: cache.shaderModule('seg-enhanced-vert', shaders.segEnhancedVertShader),
        entryPoint: 'main',
        buffers: [VB_POS_NORMAL_UV]
      },
      fragment: {
        module: cache.shaderModule('seg-enhanced-frag', shaders.segEnhancedFragShader),
        entryPoint: 'main',
        // Location 1: metalness/roughness G-buffer (ADR-0005 WS2) — rollers,
        // magnets, bearings, and the CAD housing/frame (drawn with this same
        // pipeline) all write real values here; see docs/BINDINGS.md.
        targets: [{ format: fmt, blend: ALPHA_BLEND }, { format: MATERIAL_GBUFFER_FORMAT }]
      },
      primitive: { topology: 'triangle-list', cullMode: 'back' },
      depthStencil: depthWrite,
      multisample
    })
  );

  await cache.getOrCreatePipeline(key('fluxSegment'), () =>
    cache.device.createRenderPipeline({
      label: `fluxSegmentPipeline${suffix}`,
      layout: cache.getPipelineLayout('fluxSegment'),
      vertex: {
        module: cache.shaderModule('flux-segment-vert', shaders.fluxSegmentVertShader),
        entryPoint: 'main',
        buffers: []
      },
      fragment: {
        module: cache.shaderModule('flux-segment-frag', shaders.fluxSegmentFragShader),
        entryPoint: 'main',
        // No material G-buffer write — null keeps this compatible with the
        // scene pass's second color attachment (see roller/segEnhanced).
        targets: [{ format: fmt, blend: ADDITIVE_SRC_ALPHA }, null]
      },
      primitive: { topology: 'triangle-strip' },
      depthStencil: depthRead,
      multisample
    })
  );

  await cache.getOrCreatePipeline(key('energyArc'), () =>
    cache.device.createRenderPipeline({
      label: `energyArcPipeline${suffix}`,
      layout: cache.getPipelineLayout('fieldParticles'),
      vertex: {
        module: cache.shaderModule('energy-arc-vert', shaders.energyArcVertShader),
        entryPoint: 'main',
        buffers: [VB_ENERGY_ARC]
      },
      fragment: {
        module: cache.shaderModule('energy-arc-frag', shaders.energyArcFragShader),
        entryPoint: 'main',
        // No material G-buffer write — null keeps this compatible with the
        // scene pass's second color attachment (see roller/segEnhanced).
        targets: [{ format: fmt, blend: ALPHA_BLEND }, null]
      },
      primitive: { topology: 'line-list' },
      depthStencil: depthRead,
      multisample
    })
  );

  await cache.getOrCreatePipeline(key('fieldLine'), () =>
    cache.device.createRenderPipeline({
      label: `fieldLinePipeline${suffix}`,
      layout: cache.getPipelineLayout('fieldParticles'),
      vertex: {
        module: cache.shaderModule('field-line-vert', shaders.fieldLineVertShader),
        entryPoint: 'main',
        buffers: []
      },
      fragment: {
        module: cache.shaderModule('field-line-frag', shaders.fieldLineFragShader),
        entryPoint: 'main',
        // No material G-buffer write — null keeps this compatible with the
        // scene pass's second color attachment (see roller/segEnhanced).
        targets: [{ format: fmt, blend: ADDITIVE_SRC_ALPHA }, null]
      },
      primitive: { topology: 'triangle-strip' },
      depthStencil: depthRead,
      multisample
    })
  );

  // Compute pipelines have no multisample state — created once regardless of sampleCount.
  if (sampleCount === 1) {
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
  }

  if (shaders.coilVertShader && shaders.coilFragShader) {
    await cache.getOrCreatePipeline(key('coil'), () =>
      cache.device.createRenderPipeline({
        label: `coilPipeline${suffix}`,
        layout: cache.getPipelineLayout('coil'),
        vertex: {
          module: cache.shaderModule('coil-vert', shaders.coilVertShader),
          entryPoint: 'main',
          buffers: [VB_POS_NORMAL]
        },
        fragment: {
          module: cache.shaderModule('coil-frag', shaders.coilFragShader),
          entryPoint: 'main',
          // Coils have no PBR metallic/roughness model — null keeps this
          // compatible with the scene pass's second color attachment.
          targets: [{ format: fmt, blend: ALPHA_BLEND }, null]
        },
        primitive: { topology: 'triangle-list' },
        depthStencil: depthWrite,
        multisample
      })
    );
  }

  console.log(
    `[PipelineLayoutCache] device pipelines ready (sampleCount=${sampleCount}): ` +
    `creates=${cache.stats.pipelineCreates} hits=${cache.stats.pipelineCacheHits} ` +
    `shaderModules=${cache.stats.shaderModuleCreates}`
  );
}
