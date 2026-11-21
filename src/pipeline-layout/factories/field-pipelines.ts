import type { PipelineLayoutCache } from '../pipeline-layout-cache.js';
import {
  ADDITIVE_SRC_ALPHA,
  ALPHA_BLEND,
  MATERIAL_GBUFFER_FORMAT,
  hashString
} from '../helpers.js';

/** Shader sources for every field-volume pipeline (multi-device-shaders.ts getters). */
export interface FieldShaderSources {
  volume: string;
  probe: string;
  streamlines: string;
  particles: string;
  linesVert: string;
  linesFrag: string;
  slice: string;
  iso: string;
}

export interface FieldComputePipelines {
  volume: GPUComputePipeline;
  probe: GPUComputePipeline;
  streamlines: GPUComputePipeline;
  particles: GPUComputePipeline;
}

export interface FieldRenderPipelines {
  lines: GPURenderPipeline;
  slice: GPURenderPipeline;
  iso: GPURenderPipeline;
}

/** The four field compute pipelines (ADR-0017), compiled in parallel. */
export async function ensureFieldComputePipelines(
  cache: PipelineLayoutCache,
  src: FieldShaderSources
): Promise<FieldComputePipelines> {
  const make = (name: 'fieldVolume' | 'fieldProbe' | 'fieldStreamlines' | 'fieldCharges', code: string) =>
    cache.getOrCreatePipeline(`${name}_${hashString(code)}`, () =>
      cache.device.createComputePipelineAsync({
        label: `${name}-pipeline`,
        layout: cache.getPipelineLayout(name),
        compute: { module: cache.shaderModule(`${name}-module`, code), entryPoint: 'main' }
      })
    );
  const [volume, probe, streamlines, particles] = await Promise.all([
    make('fieldVolume', src.volume),
    make('fieldProbe', src.probe),
    make('fieldStreamlines', src.streamlines),
    make('fieldCharges', src.particles)
  ]);
  return { volume, probe, streamlines, particles };
}

/**
 * Scene-pass consumers, per sample count (the render loop swaps them with
 * MSAA like every other scene draw). The material G-buffer target is masked
 * (`writeMask: 0`), as for the FDTD panel — see fdtd-pipelines.ts.
 *   lines  — billboards, additive, triangle strip (the flux-segment look)
 *   slice  — alpha-blended quad, both faces
 *   iso    — alpha-blended ray march over the AABB, writes frag_depth
 */
export async function ensureFieldRenderPipelines(
  cache: PipelineLayoutCache,
  src: FieldShaderSources,
  opts: { sampleCount?: number } = {}
): Promise<FieldRenderPipelines> {
  const sampleCount = opts.sampleCount ?? 1;
  const suffix = sampleCount === 4 ? '_msaa4' : '';
  const masked: GPUColorTargetState = { format: MATERIAL_GBUFFER_FORMAT, writeMask: 0 };
  const multisample = { count: sampleCount };
  const lines = cache.getOrCreatePipeline(`fieldLines${suffix}_${hashString(src.linesVert)}`, () =>
    cache.device.createRenderPipelineAsync({
      label: `fieldLinesPipeline${suffix}`,
      layout: cache.getPipelineLayout('fieldLines'),
      vertex: { module: cache.shaderModule('field-lines-vert', src.linesVert), entryPoint: 'main' },
      fragment: {
        module: cache.shaderModule('flux-segment-frag', src.linesFrag),
        entryPoint: 'main',
        targets: [{ format: cache.sceneFormat, blend: ADDITIVE_SRC_ALPHA }, masked]
      },
      primitive: { topology: 'triangle-strip' },
      depthStencil: cache.depthStencil(false, 'less'),
      multisample
    })
  );
  const quad = (name: 'fieldSlice' | 'fieldIso', code: string) =>
    cache.getOrCreatePipeline(`${name}${suffix}_${hashString(code)}`, () => {
      const module = cache.shaderModule(`${name}-module`, code);
      return cache.device.createRenderPipelineAsync({
        label: `${name}Pipeline${suffix}`,
        layout: cache.getPipelineLayout(name),
        vertex: { module, entryPoint: 'vsMain' },
        fragment: {
          module,
          entryPoint: 'fsMain',
          targets: [{ format: cache.sceneFormat, blend: ALPHA_BLEND }, masked]
        },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: cache.depthStencil(false, 'less'),
        multisample
      });
    });
  const [l, s, i] = await Promise.all([lines, quad('fieldSlice', src.slice), quad('fieldIso', src.iso)]);
  return { lines: l, slice: s, iso: i };
}
