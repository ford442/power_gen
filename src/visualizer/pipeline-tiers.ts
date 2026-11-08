/**
 * Pipeline compilation by tier (#225 §3).
 *
 *   boot    every 1× scene pipeline, particle / cull / energy-pipe compute and
 *           the bloom stack — one `Promise.all` of `create*PipelineAsync`
 *           before the first frame.
 *   msaa    the `_msaa4` variant of every scene pipeline + the depth resolve
 *   ssr     SSR compute
 *   taa     TAA resolve
 *   shadow  depth-only key-light casters (roller, seg-enhanced)
 *
 * The non-boot tiers compile on first use: `ready(tier)` is asked by the
 * frame's gates only once everything else says the feature is on, starts the
 * compile the first time, and returns false until it lands. Those frames run
 * without the feature (1× scene, no SSR / TAA / shadow) — never a stall, and
 * overview at mid tier never compiles any of it.
 */
import type { MultiDeviceVisualizer } from '../multi-device-visualizer.js';

type Host = MultiDeviceVisualizer;

export type PipelineTier = 'msaa' | 'ssr' | 'taa' | 'shadow';
export type TierState = 'idle' | 'compiling' | 'ready' | 'failed';

export class PipelineTiers {
  private readonly states: Record<PipelineTier, TierState> = {
    msaa: 'idle', ssr: 'idle', taa: 'idle', shadow: 'idle'
  };
  /** ms from first use to ready, per tier (getRendererInfo). */
  readonly compileMs: Partial<Record<PipelineTier | 'boot', number>> = {};

  constructor(private readonly host: Host) {}

  /** Everything the first frame draws at any tier. */
  async boot(): Promise<void> {
    const cache = this.host.pipelineCache!;
    const shaders = this.host.shaders;
    const t0 = performance.now();
    await Promise.all([
      cache.ensureDevicePipelines(shaders),
      cache.ensureSkyPipeline(shaders),
      cache.ensureGridPipeline(shaders),
      cache.ensureAnomalyWallPipeline(shaders),
      cache.ensureEnergyPipePipeline(shaders),
      cache.ensureEnergyPipeComputePipeline(shaders),
      cache.ensureOverviewCullPipeline(shaders),
      cache.ensureBloomPipelines(shaders)
    ]);
    this.compileMs.boot = performance.now() - t0;
  }

  state(tier: PipelineTier): TierState {
    return this.states[tier];
  }

  snapshot(): Record<PipelineTier, TierState> {
    return { ...this.states };
  }

  /** True once `tier` compiled; the first call starts it. */
  ready(tier: PipelineTier): boolean {
    const s = this.states[tier];
    if (s === 'ready') return true;
    if (s === 'idle') {
      this.states[tier] = 'compiling';
      const t0 = performance.now();
      this.compile(tier).then(() => {
        this.states[tier] = 'ready';
        this.compileMs[tier] = performance.now() - t0;
      }, (err) => {
        this.states[tier] = 'failed';
        console.warn(`[PipelineTiers] '${tier}' pipelines failed to compile — feature stays off:`, err);
      });
    }
    return false;
  }

  private async compile(tier: PipelineTier): Promise<void> {
    const h = this.host;
    const cache = h.pipelineCache;
    if (!cache) throw new Error('pipelineCache missing');
    const shaders = h.shaders;
    const msaa = { sampleCount: 4 };
    switch (tier) {
      case 'msaa': {
        const [sky, grid, walls, pipes, depthResolve] = await Promise.all([
          cache.ensureSkyPipeline(shaders, msaa),
          cache.ensureGridPipeline(shaders, msaa),
          cache.ensureAnomalyWallPipeline(shaders, msaa),
          cache.ensureEnergyPipePipeline(shaders, msaa),
          cache.ensureDepthResolvePipeline(shaders),
          cache.ensureDevicePipelines(shaders, msaa)
        ]);
        h.skyPipelineMsaa4 = sky;
        h.gridPipelineMsaa4 = grid;
        h.anomalyWallPipelineMsaa4 = walls;
        h.energyPipePipelineMsaa4 = pipes;
        h.depthResolvePipeline = depthResolve;
        h._rebuildDepthResolveBindGroup();
        return;
      }
      case 'ssr':
        h.ssrPipeline = await cache.ensureSsrPipeline(shaders.ssrComputeShader);
        return;
      case 'taa':
        h.taaPipeline = await cache.ensureTaaResolvePipeline(shaders, cache.sceneFormat);
        return;
      case 'shadow':
        await cache.ensureShadowCasterPipelines(shaders);
        return;
    }
  }
}
