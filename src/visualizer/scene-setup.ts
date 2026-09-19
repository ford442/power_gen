// Floor grid, sky gradient, anomaly wall, IBL prefilter, and canvas-layout
// tracking. Depth/SSR/bloom/TAA buffer allocation lives in
// scene-post-buffers.ts (split out to stay under the repo's 700-line cap).
import { createIblResources, uploadIblForPreset } from '../ibl-prefilter';
import { IblPrefilterCompute } from '../ibl-prefilter-gpu';
import { WebGPUManager } from '../webgpu-manager';
import type { MultiDeviceVisualizer } from '../multi-device-visualizer.js';
import { bindHostMethods } from './bind-host-methods.js';
import { scenePostBufferMethods } from './scene-post-buffers.js';

// Re-exported for compatibility — other modules (e.g. render-loop.ts) import
// these from './scene-setup.js'; the values themselves live in
// scene-post-buffers.ts, next to the only methods that use them.
export { SSR_RESOLUTION_SCALE, SSR_PARAMS_BYTES, TAA_PARAMS_BYTES } from './scene-post-buffers.js';

type Host = MultiDeviceVisualizer;

/** Result of one IBL bake — `path` says which of the two bake paths ran. */
export interface IblBakeStats {
  levels: number;
  cached: boolean;
  ms: number;
  path: 'compute' | 'cpu' | 'skipped';
}

export const sceneSetupMethods: ThisType<Host> & {
  setupIblPrefilter(): Promise<IblBakeStats>;
  refreshIblPrefilter(): void;
  _bakeIbl(): IblBakeStats;
  setupFloorGrid(): Promise<void>;
  setupSkyGradient(): Promise<void>;
  setupAnomalyWallPipeline(): Promise<void>;
  _waitForCanvasLayout(): Promise<void>;
  _observeCanvasLayout(): void;
  _syncCanvasSize(): Promise<void>;
} = {
  /**
   * Allocate the IBL array texture and bake it for the active lighting look.
   * Skipped on fallback/software adapters (analytic PBR path when iblLevels = 0).
   *
   * Async only because building the compute prefilter pipeline is async; the
   * bake itself stays synchronous so `refreshIblPrefilter` can run it from the
   * synchronous `setLightingLook` path.
   */
  async setupIblPrefilter() {
    const fallbackSoft = !!(this.webgpu?.adapterInfo?.fallback || this.webgpu?.adapterInfo?.software);
    if (fallbackSoft) {
      this.iblLevels = 0;
      console.log('[MultiDeviceVisualizer] IBL prefilter skipped (fallback/software adapter)');
      return { levels: 0, cached: true, ms: 0, path: 'skipped' as const };
    }
    if (!this.iblResources) {
      this.iblResources = await createIblResources(this.device);
      this.profiler?.trackTexture?.(
        'iblSpecularArray',
        this.iblResources.size,
        this.iblResources.size * this.iblResources.layers,
        'rgba16float'
      );
    }

    // Compute path (ADR-0005 WS2): keeps the ~270 ms GGX importance-sampling
    // off the main thread. `create` returns null on any failure — no storage
    // binding, no pipeline — and the CPU bake below covers that case.
    if (this.iblCompute === undefined && this.pipelineCache) {
      this.iblCompute = await IblPrefilterCompute.create(
        this.device,
        this.pipelineCache,
        this.iblResources,
        this.shaders.iblPrefilterComputeShader
      );
    }

    return this._bakeIbl();
  },

  /**
   * Bake the active look into the (already allocated) IBL texture, preferring
   * the compute prefilter and falling back to the memoised CPU bake.
   */
  _bakeIbl() {
    if (this.iblCompute) {
      const gpu = this.iblCompute.bake(this.postPreset, this.iblResources!.size);
      this.iblLevels = gpu.levels;
      console.log(
        `[MultiDeviceVisualizer] IBL prefilter "${this.lightingLook}": ` +
        `${gpu.levels} GGX levels + irradiance, ${(this.iblResources!.byteLength / 1024).toFixed(0)} KB ` +
        `(compute, ${gpu.layers} dispatches, ${gpu.ms.toFixed(1)} ms encode)`
      );
      return { levels: gpu.levels, cached: false, ms: gpu.ms, path: 'compute' as const };
    }

    const stats = uploadIblForPreset(
      this.device,
      this.iblResources!,
      this.postPreset,
      this.lightingLook
    );
    this.iblLevels = stats.levels;
    console.log(
      `[MultiDeviceVisualizer] IBL prefilter "${this.lightingLook}": ` +
      `${stats.levels} GGX levels + irradiance, ${(this.iblResources!.byteLength / 1024).toFixed(0)} KB ` +
      `(cpu, ${stats.cached ? 'cached' : `${stats.ms.toFixed(0)} ms bake`})`
    );
    return { ...stats, path: 'cpu' as const };
  },

  /**
   * Re-bake the IBL chain after a lighting-look switch. Bind groups keep
   * pointing at the same texture, so nothing needs to be rebuilt — and the
   * compute pipeline is already built by now, so this stays synchronous.
   */
  refreshIblPrefilter() {
    if (!this.iblResources || !this.device) return;
    this._bakeIbl();
  },

  async setupFloorGrid() {
    const cache = this.pipelineCache;
    if (!cache || !this.profiler) return;
    this.gridPipelineBase = await cache.ensureGridPipeline(this.shaders);
    this.gridPipelineMsaa4 = await cache.ensureGridPipeline(this.shaders, { sampleCount: 4 });
    this.gridPipeline = this.gridPipelineBase;

    const gridVertices = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);
    this.gridVertexBuffer = this.device.createBuffer({
      size: gridVertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(this.gridVertexBuffer, 0, gridVertices);
    this.profiler.trackBuffer('gridVertices', gridVertices.byteLength, GPUBufferUsage.VERTEX);

    // Explicit empty bind group layout (grid shaders have no bindings)
    this.gridBindGroup = cache.createBindGroup('empty', [], 'grid-bg');
  },

  async setupSkyGradient() {
    const cache = this.pipelineCache;
    if (!cache) return;
    this.skyUniformBuffer = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this._uploadSkyUniforms();

    this.skyPipelineBase = await cache.ensureSkyPipeline(this.shaders);
    this.skyPipelineMsaa4 = await cache.ensureSkyPipeline(this.shaders, { sampleCount: 4 });
    this.skyPipeline = this.skyPipelineBase;

    this.skyBindGroup = cache.createBindGroup(
      'sky',
      [{ binding: 0, resource: { buffer: this.skyUniformBuffer } }],
      'sky-bg'
    );
  },

  async setupAnomalyWallPipeline() {
    const cache = this.pipelineCache;
    if (!cache || !this.profiler || !this.globalUniformBuffer) return;
    this.anomalyWallPipelineBase = await cache.ensureAnomalyWallPipeline(this.shaders);
    this.anomalyWallPipelineMsaa4 = await cache.ensureAnomalyWallPipeline(this.shaders, { sampleCount: 4 });
    this.anomalyWallPipeline = this.anomalyWallPipelineBase;

    this.anomalyWallParamsBuffer = this.device.createBuffer({
      label: 'anomaly-wall-params',
      size: 24,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.profiler.trackBuffer('anomaly-wall-params', 24, GPUBufferUsage.UNIFORM);

    this.anomalyWallBindGroup = cache.createBindGroup(
      'anomalyWall',
      [
        { binding: 0, resource: { buffer: this.globalUniformBuffer } },
        { binding: 1, resource: { buffer: this.anomalyWallParamsBuffer } }
      ],
      'anomaly-wall-bg'
    );
  },

  _waitForCanvasLayout(): Promise<void> {
    const canvas = this.canvas;
    if (canvas.clientWidth >= 1 && canvas.clientHeight >= 1) {
      return Promise.resolve();
    }
    const target = canvas.parentElement || canvas;
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        if (canvas.clientWidth >= 1 && canvas.clientHeight >= 1) {
          settled = true;
          ro.disconnect();
          resolve();
        }
      };
      const ro = new ResizeObserver(finish);
      ro.observe(target);
      requestAnimationFrame(finish);
      setTimeout(() => {
        if (!settled) {
          settled = true;
          ro.disconnect();
          resolve();
        }
      }, 500);
    });
  },

  _observeCanvasLayout() {
    const target = this.canvas.parentElement || this.canvas;
    if (this._canvasResizeObserver) {
      this._canvasResizeObserver.disconnect();
    }
    this._canvasResizeObserver = new ResizeObserver(() => {
      this._syncCanvasSize();
    });
    this._canvasResizeObserver.observe(target);
  },

  async _syncCanvasSize() {
    this.webgpu.resize();
    if (!this.device || !this.profiler) return;

    const { width, height, layoutReady } = WebGPUManager.canvasPixelSize(this.canvas);
    if (!layoutReady) return;
    if (this._lastCanvasWidth === width && this._lastCanvasHeight === height && this.depthTexture) {
      return;
    }

    this._lastCanvasWidth = width;
    this._lastCanvasHeight = height;
    await this.setupDepthBuffer();
    if (this.bloomParamsBuffer) {
      this.setupBloomTextures();
    }
  },

};

/** Bloom / IBL / SSR / TAA / depth / canvas resize collaborator. */
export class PostStack {
  setupIblPrefilter: typeof sceneSetupMethods.setupIblPrefilter;
  refreshIblPrefilter: typeof sceneSetupMethods.refreshIblPrefilter;
  _bakeIbl: typeof sceneSetupMethods._bakeIbl;
  setupFloorGrid: typeof sceneSetupMethods.setupFloorGrid;
  setupSkyGradient: typeof sceneSetupMethods.setupSkyGradient;
  setupAnomalyWallPipeline: typeof sceneSetupMethods.setupAnomalyWallPipeline;
  _waitForCanvasLayout: typeof sceneSetupMethods._waitForCanvasLayout;
  _observeCanvasLayout: typeof sceneSetupMethods._observeCanvasLayout;
  _syncCanvasSize: typeof sceneSetupMethods._syncCanvasSize;
  setupDepthBuffer: typeof scenePostBufferMethods.setupDepthBuffer;
  _rebuildDepthResolveBindGroup: typeof scenePostBufferMethods._rebuildDepthResolveBindGroup;
  setupDepthResolvePipeline: typeof scenePostBufferMethods.setupDepthResolvePipeline;
  setupSsrTexture: typeof scenePostBufferMethods.setupSsrTexture;
  _rebuildSsrBindGroup: typeof scenePostBufferMethods._rebuildSsrBindGroup;
  setupSsrPipeline: typeof scenePostBufferMethods.setupSsrPipeline;
  setupBloomTextures: typeof scenePostBufferMethods.setupBloomTextures;
  _rebuildBloomBindGroups: typeof scenePostBufferMethods._rebuildBloomBindGroups;
  setupBloomPipeline: typeof scenePostBufferMethods.setupBloomPipeline;
  setupTaaPipeline: typeof scenePostBufferMethods.setupTaaPipeline;
  _rebuildTaaBindGroups: typeof scenePostBufferMethods._rebuildTaaBindGroups;

  constructor(host: MultiDeviceVisualizer) {
    const bound = bindHostMethods(sceneSetupMethods, host);
    const boundPostBuffers = bindHostMethods(scenePostBufferMethods, host);
    this.setupIblPrefilter = bound.setupIblPrefilter;
    this.refreshIblPrefilter = bound.refreshIblPrefilter;
    this._bakeIbl = bound._bakeIbl;
    this.setupFloorGrid = bound.setupFloorGrid;
    this.setupSkyGradient = bound.setupSkyGradient;
    this.setupAnomalyWallPipeline = bound.setupAnomalyWallPipeline;
    this._waitForCanvasLayout = bound._waitForCanvasLayout;
    this._observeCanvasLayout = bound._observeCanvasLayout;
    this._syncCanvasSize = bound._syncCanvasSize;
    this.setupDepthBuffer = boundPostBuffers.setupDepthBuffer;
    this._rebuildDepthResolveBindGroup = boundPostBuffers._rebuildDepthResolveBindGroup;
    this.setupDepthResolvePipeline = boundPostBuffers.setupDepthResolvePipeline;
    this.setupSsrTexture = boundPostBuffers.setupSsrTexture;
    this._rebuildSsrBindGroup = boundPostBuffers._rebuildSsrBindGroup;
    this.setupSsrPipeline = boundPostBuffers.setupSsrPipeline;
    this.setupBloomTextures = boundPostBuffers.setupBloomTextures;
    this._rebuildBloomBindGroups = boundPostBuffers._rebuildBloomBindGroups;
    this.setupBloomPipeline = boundPostBuffers.setupBloomPipeline;
    this.setupTaaPipeline = boundPostBuffers.setupTaaPipeline;
    this._rebuildTaaBindGroups = boundPostBuffers._rebuildTaaBindGroups;
  }
}

