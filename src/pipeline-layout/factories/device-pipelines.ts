import type { MultiDeviceShaders } from '../../multi-device-shaders.js';
import type { PipelineLayoutCache } from '../pipeline-layout-cache.js';
import type { PipelineLayoutName } from '../types.js';
import {
  VB_POS_NORMAL, VB_POS_NORMAL_UV, VB_ENERGY_ARC,
  ALPHA_BLEND, ADDITIVE_BLEND, ADDITIVE_SRC_ALPHA, hashString,
  MATERIAL_GBUFFER_FORMAT,
  MATERIAL_GBUFFER_NO_WRITE
} from '../helpers.js';
import { SHADOW_CASTER_DEPTH } from '../../visualizer/shadow-map.js';

export interface DevicePipelineOptions {
  /**
   * 1 (default) or 4. The 4x variant is a second, otherwise-identical
   * GPURenderPipeline for the ADR-0005 WS2 showroom MSAA path (`high` tier +
   * focus mode — see render-encode.ts `frameContext()`). It is compiled on
   * first use by visualizer/pipeline-tiers.ts, never at boot; cache keys get a
   * `_msaa4` suffix and layouts are unaffected (only `multisample` differs).
   */
  sampleCount?: number;
}

interface MeshPipelineSpec {
  name: string;
  layout: PipelineLayoutName;
  vert: [label: string, code: string];
  frag: [label: string, code: string];
  buffers: GPUVertexBufferLayout[];
  /** Material G-buffer target: written (`true`) or masked. */
  gbuffer: boolean;
  blend?: GPUBlendState;
  topology: GPUPrimitiveTopology;
  cullMode?: GPUCullMode;
  depthWrite: boolean;
}

function meshSpecs(shaders: MultiDeviceShaders): MeshPipelineSpec[] {
  const specs: MeshPipelineSpec[] = [
    {
      // Location 1: metalness/roughness G-buffer (ADR-0005 WS2) — chrome
      // rollers write real values here; see docs/BINDINGS.md.
      name: 'roller', layout: 'roller',
      vert: ['roller-vert', shaders.rollerVertShader], frag: ['roller-frag', shaders.rollerFragShader],
      buffers: [VB_POS_NORMAL], gbuffer: true, blend: ALPHA_BLEND, topology: 'triangle-list', depthWrite: true
    },
    {
      // Unlit additive particles don't participate in the material G-buffer
      // (SSR already ignores them) — a masked target keeps this pipeline
      // compatible with the scene pass's second color attachment.
      name: 'particle', layout: 'particle',
      vert: ['particle-vert', shaders.particleVertShader], frag: ['particle-frag', shaders.particleFragShader],
      buffers: [], gbuffer: false, blend: ADDITIVE_BLEND, topology: 'triangle-strip', depthWrite: false
    },
    {
      // Rollers, magnets, bearings and the CAD housing / frame all draw with
      // this pipeline and write real G-buffer values; see docs/BINDINGS.md.
      name: 'segEnhanced', layout: 'segEnhanced',
      vert: ['seg-enhanced-vert', shaders.segEnhancedVertShader], frag: ['seg-enhanced-frag', shaders.segEnhancedFragShader],
      buffers: [VB_POS_NORMAL_UV], gbuffer: true, blend: ALPHA_BLEND, topology: 'triangle-list',
      cullMode: 'back', depthWrite: true
    },
    {
      name: 'fluxSegment', layout: 'fluxSegment',
      vert: ['flux-segment-vert', shaders.fluxSegmentVertShader], frag: ['flux-segment-frag', shaders.fluxSegmentFragShader],
      buffers: [], gbuffer: false, blend: ADDITIVE_SRC_ALPHA, topology: 'triangle-strip', depthWrite: false
    },
    {
      name: 'energyArc', layout: 'fieldParticles',
      vert: ['energy-arc-vert', shaders.energyArcVertShader], frag: ['energy-arc-frag', shaders.energyArcFragShader],
      buffers: [VB_ENERGY_ARC], gbuffer: false, blend: ALPHA_BLEND, topology: 'line-list', depthWrite: false
    },
    {
      name: 'fieldLine', layout: 'fieldParticles',
      vert: ['field-line-vert', shaders.fieldLineVertShader], frag: ['field-line-frag', shaders.fieldLineFragShader],
      buffers: [], gbuffer: false, blend: ADDITIVE_SRC_ALPHA, topology: 'triangle-strip', depthWrite: false
    }
  ];
  if (shaders.coilVertShader && shaders.coilFragShader) {
    // Coils have no PBR metallic/roughness model — masked G-buffer target.
    specs.push({
      name: 'coil', layout: 'coil',
      vert: ['coil-vert', shaders.coilVertShader], frag: ['coil-frag', shaders.coilFragShader],
      buffers: [VB_POS_NORMAL], gbuffer: false, blend: ALPHA_BLEND, topology: 'triangle-list', depthWrite: true
    });
  }
  return specs;
}

/**
 * Ensure every multi-device mesh pipeline for `sampleCount` exists — compiled
 * in parallel (`createRenderPipelineAsync` + `Promise.all`), once per variant.
 * The particle compute pipeline rides along with the base variant.
 */
export async function ensureDevicePipelines(
  cache: PipelineLayoutCache,
  shaders: MultiDeviceShaders,
  opts: DevicePipelineOptions = {}
): Promise<void> {
  const fmt = cache.sceneFormat;
  const sampleCount = opts.sampleCount ?? 1;
  const multisample = { count: sampleCount };
  const suffix = sampleCount === 4 ? '_msaa4' : '';

  const jobs: Array<Promise<unknown>> = meshSpecs(shaders).map((s) =>
    cache.getOrCreatePipeline(`${s.name}${suffix}`, () =>
      cache.device.createRenderPipelineAsync({
        label: `${s.name}Pipeline${suffix}`,
        layout: cache.getPipelineLayout(s.layout),
        vertex: { module: cache.shaderModule(s.vert[0], s.vert[1]), entryPoint: 'main', buffers: s.buffers },
        fragment: {
          module: cache.shaderModule(s.frag[0], s.frag[1]),
          entryPoint: 'main',
          targets: [
            { format: fmt, blend: s.blend },
            s.gbuffer ? { format: MATERIAL_GBUFFER_FORMAT } : MATERIAL_GBUFFER_NO_WRITE
          ]
        },
        primitive: { topology: s.topology, cullMode: s.cullMode },
        depthStencil: cache.depthStencil(s.depthWrite, 'less'),
        multisample
      })
    )
  );

  // Compute pipelines have no multisample state — created once regardless of sampleCount.
  if (sampleCount === 1) {
    const computeCode = shaders.computeShader;
    const computeKey = `particleCompute_${hashString(computeCode)}`;
    jobs.push(cache.getOrCreatePipeline(computeKey, () =>
      cache.device.createComputePipelineAsync({
        label: 'compute-particle-pipeline',
        layout: cache.getPipelineLayout('particleCompute'),
        compute: { module: cache.shaderModule('compute-particle-module', computeCode), entryPoint: 'main' }
      })
    ).then((p) => {
      if (!cache.pipelines.has('particleCompute')) cache.pipelines.set('particleCompute', p);
    }));
  }

  await Promise.all(jobs);
  console.log(
    `[PipelineLayoutCache] device pipelines ready (sampleCount=${sampleCount}): ` +
    `creates=${cache.stats.pipelineCreates} hits=${cache.stats.pipelineCacheHits} ` +
    `shaderModules=${cache.stats.shaderModuleCreates}`
  );
}

/**
 * Depth-only key-light shadow casters (#225 §4): the scene's own roller and
 * seg-enhanced vertex shaders on the same layouts, no fragment stage. The
 * shadow pass binds a frame group whose `Uniforms.viewProj` is the light's
 * matrix, so no vertex variant is needed. Cull mode `none`: open meshes
 * (bench top, cage panels) must still cast from either side.
 */
export async function ensureShadowCasterPipelines(
  cache: PipelineLayoutCache,
  shaders: MultiDeviceShaders
): Promise<void> {
  const casters: Array<[name: string, layout: PipelineLayoutName, vert: [string, string], buffers: GPUVertexBufferLayout[]]> = [
    ['roller', 'roller', ['roller-vert', shaders.rollerVertShader], [VB_POS_NORMAL]],
    ['segEnhanced', 'segEnhanced', ['seg-enhanced-vert', shaders.segEnhancedVertShader], [VB_POS_NORMAL_UV]]
  ];
  await Promise.all(casters.map(([name, layout, vert, buffers]) =>
    cache.getOrCreatePipeline(`${name}_shadow`, () =>
      cache.device.createRenderPipelineAsync({
        label: `${name}ShadowPipeline`,
        layout: cache.getPipelineLayout(layout),
        vertex: { module: cache.shaderModule(vert[0], vert[1]), entryPoint: 'main', buffers },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: SHADOW_CASTER_DEPTH
      })
    )
  ));
}
