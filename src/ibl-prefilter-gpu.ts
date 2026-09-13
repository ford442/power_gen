// ============================================================================
// IBL Specular Prefilter — compute path (ADR-0005 Workstream 2)
// ============================================================================
// Runs the GGX split-sum bake on the GPU instead of importance-sampling it in
// JS. The CPU bake in ibl-prefilter.ts costs ~270 ms of *main-thread* time on
// the first switch to each lighting look, which is a visible hitch mid-session;
// the same work as a compute dispatch costs the main thread only the encode.
//
// Nothing about the sampled side changes: same octahedral layout, same array
// layers, same rgba16float texture, so pbr-eval.wgsl is untouched and the CPU
// bake remains a drop-in fallback (software adapters already skip IBL
// entirely — see scene-setup.ts `setupIblPrefilter`).
//
// One dispatch per layer, as ADR-0005 WS2 specifies: the roughness chain plus
// the irradiance layer. See passes/ibl-prefilter-compute.wgsl.

import {
  IBL_PREFILTER_PARAMS_BYTES,
  iblPrefilterJobs,
  packIblPrefilterParams,
  type IblResources
} from './ibl-prefilter';
import type { LightingPreset } from './seg-lighting-presets';
import type { PipelineLayoutCache } from './pipeline-layout';
import { writeQueueBuffer } from './gpu-buffer-write';

/** Matches `@workgroup_size(8, 8, 1)` in the prefilter shader. */
const WORKGROUP = 8;

/**
 * Uniform buffers must be bound at 256-byte-aligned offsets by default, so the
 * per-layer params are packed one stride apart in a single buffer and each
 * dispatch binds its own slice. One buffer + one bind group per layer beats
 * re-writing a single block between dispatches, which would need a submit (or
 * a barrier) per layer to be correct.
 */
const PARAMS_STRIDE = 256;

export interface IblComputeBakeResult {
  levels: number;
  /** Layers dispatched (roughness chain + irradiance). */
  layers: number;
  /** Main-thread ms spent encoding — not GPU time. */
  ms: number;
}

/**
 * Owns the prefilter compute pipeline and its per-layer uniform slices.
 *
 * Construct with {@link IblPrefilterCompute.create}, which returns `null` when
 * the pipeline cannot be built — the caller then keeps the CPU path.
 */
export class IblPrefilterCompute {
  private constructor(
    private readonly device: GPUDevice,
    private readonly pipeline: GPUComputePipeline,
    private readonly paramsBuffer: GPUBuffer,
    private readonly bindGroups: GPUBindGroup[],
    readonly levels: number
  ) {}

  /**
   * Build the compute prefilter for `resources`.
   *
   * @returns `null` if the resources have no STORAGE_BINDING, or if pipeline /
   *   bind-group creation fails — both mean "fall back to the CPU bake".
   */
  static async create(
    device: GPUDevice,
    cache: PipelineLayoutCache,
    resources: IblResources,
    shaderCode: string
  ): Promise<IblPrefilterCompute | null> {
    if (!resources.storage) return null;

    const jobs = iblPrefilterJobs();
    if (jobs.length > resources.layers) {
      console.warn(
        `[ibl-prefilter] ${jobs.length} layers to bake but the texture has ${resources.layers} — using the CPU bake`
      );
      return null;
    }

    try {
      const pipeline = await cache.ensureIblPrefilterPipeline(shaderCode);

      // The storage view and the bind groups are the other two places WebGPU
      // reports a problem as a validation error rather than an exception, so
      // they go inside an error scope too: an invalid bind group would
      // otherwise dispatch happily and leave the environment unwritten,
      // instead of falling back to the CPU bake.
      device.pushErrorScope('validation');

      const paramsBuffer = device.createBuffer({
        label: 'ibl-prefilter-params',
        size: PARAMS_STRIDE * jobs.length,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      });

      // A write-only storage view must name the layer range it covers; the
      // shader indexes layers itself, so bind the whole array once.
      const storageView = resources.texture.createView({
        label: 'ibl-prefilter-storage',
        dimension: '2d-array',
        baseArrayLayer: 0,
        arrayLayerCount: resources.layers
      });

      const bindGroups = jobs.map((job) => cache.createBindGroup('iblPrefilter', [
        {
          binding: 0,
          resource: {
            buffer: paramsBuffer,
            offset: PARAMS_STRIDE * job.layer,
            size: IBL_PREFILTER_PARAMS_BYTES
          }
        },
        { binding: 1, resource: storageView }
      ], `ibl-prefilter-bg-${job.layer}`));

      const error = await device.popErrorScope();
      if (error) {
        console.warn(
          '[ibl-prefilter] compute prefilter resources invalid — using the CPU bake:',
          error.message
        );
        paramsBuffer.destroy();
        return null;
      }

      return new IblPrefilterCompute(device, pipeline, paramsBuffer, bindGroups, jobs.length - 1);
    } catch (e) {
      // createComputePipelineAsync *does* reject on validation failure, and a
      // malformed descriptor still throws, so the catch is not redundant.
      console.warn('[ibl-prefilter] compute prefilter unavailable — using the CPU bake:', e);
      return null;
    }
  }

  /**
   * Bake `preset` into the IBL array texture.
   *
   * Encodes one dispatch per layer and submits. The main thread pays only the
   * encode; the GPU does the sampling while the frame loop carries on.
   */
  bake(preset: LightingPreset, size: number): IblComputeBakeResult {
    const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
    const jobs = iblPrefilterJobs();
    const groups = Math.ceil(size / WORKGROUP);

    for (const job of jobs) {
      writeQueueBuffer(
        this.device,
        this.paramsBuffer,
        packIblPrefilterParams(preset, job),
        PARAMS_STRIDE * job.layer
      );
    }

    const encoder = this.device.createCommandEncoder({ label: 'ibl-prefilter-encoder' });
    const pass = encoder.beginComputePass({ label: 'ibl-prefilter-pass' });
    pass.setPipeline(this.pipeline);
    for (const job of jobs) {
      pass.setBindGroup(0, this.bindGroups[job.layer]);
      pass.dispatchWorkgroups(groups, groups, 1);
    }
    pass.end();
    this.device.queue.submit([encoder.finish()]);

    const ms = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
    return { levels: this.levels, layers: jobs.length, ms };
  }
}
