// Floor grid, sky, bloom, SSR, IBL prefilter, depth, and canvas resize.
import { WebGPUManager, DEPTH_FORMAT } from '../webgpu-manager';
import { packPostUniforms } from '../seg-lighting-presets.js';
import { SSR_FORMAT, type BindGroupLayoutName } from '../pipeline-layout-cache';
import { createIblResources, uploadIblForPreset } from '../ibl-prefilter.js';
import { writeQueueBuffer } from '../gpu-buffer-write';
import type { MultiDeviceVisualizer } from '../multi-device-visualizer.js';

type Host = MultiDeviceVisualizer;

/** SSR runs at half resolution; the composite samples it with linear filtering. */
export const SSR_RESOLUTION_SCALE = 0.5;

/** Bytes of the SsrParams uniform block — see passes/ssr-compute.wgsl. */
export const SSR_PARAMS_BYTES = 176;

export const sceneSetupMethods: ThisType<Host> & {
  setupIblPrefilter(): { levels: number; cached: boolean; ms: number };
  refreshIblPrefilter(): void;
  setupFloorGrid(): Promise<void>;
  setupSkyGradient(): Promise<void>;
  setupAnomalyWallPipeline(): Promise<void>;
  _waitForCanvasLayout(): Promise<void>;
  _observeCanvasLayout(): void;
  _syncCanvasSize(): Promise<void>;
  setupDepthBuffer(): Promise<void>;
  setupSsrTexture(): void;
  _rebuildSsrBindGroup(): void;
  setupSsrPipeline(): Promise<void>;
  setupBloomTextures(): void;
  _rebuildBloomBindGroups(): void;
  setupBloomPipeline(): Promise<void>;
} = {
  /**
   * Bake the prefiltered GGX environment for the active lighting look and
   * upload it to the device (ADR-0005 WS2). Always-on: the texture is 224 KiB
   * and every SEG-enhanced pipeline binds it.
   */
  setupIblPrefilter() {
    if (!this.iblResources) {
      this.iblResources = createIblResources(this.device);
      this.profiler?.trackTexture?.(
        'iblSpecularArray',
        this.iblResources.size,
        this.iblResources.size * this.iblResources.layers,
        'rgba16float'
      );
    }
    const stats = uploadIblForPreset(
      this.device,
      this.iblResources,
      this.postPreset,
      this.lightingLook
    );
    this.iblLevels = stats.levels;
    console.log(
      `[MultiDeviceVisualizer] IBL prefilter "${this.lightingLook}": ` +
      `${stats.levels} GGX levels + irradiance, ${(this.iblResources.byteLength / 1024).toFixed(0)} KB ` +
      `(${stats.cached ? 'cached' : `${stats.ms.toFixed(0)} ms bake`})`
    );
    return stats;
  },

  /**
   * Re-bake the IBL chain after a lighting-look switch. Bind groups keep
   * pointing at the same texture, so nothing needs to be rebuilt.
   */
  refreshIblPrefilter() {
    if (!this.iblResources || !this.device) return;
    this.setupIblPrefilter();
  },

  async setupFloorGrid() {
    const cache = this.pipelineCache;
    if (!cache || !this.profiler) return;
    this.gridPipeline = await cache.ensureGridPipeline(this.shaders);

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

    this.skyPipeline = await cache.ensureSkyPipeline(this.shaders);

    this.skyBindGroup = cache.createBindGroup(
      'sky',
      [{ binding: 0, resource: { buffer: this.skyUniformBuffer } }],
      'sky-bg'
    );
  },

  async setupAnomalyWallPipeline() {
    const cache = this.pipelineCache;
    if (!cache || !this.profiler || !this.globalUniformBuffer) return;
    this.anomalyWallPipeline = await cache.ensureAnomalyWallPipeline(this.shaders);

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

  async setupDepthBuffer() {
    if (!this.profiler) return;
    const { width, height } = WebGPUManager.canvasPixelSize(this.canvas);
    const depthFormat = this.depthFormat || this.webgpu.depthFormat || DEPTH_FORMAT;
    if (this.depthTexture) {
      this.profiler.textureAllocations = this.profiler.textureAllocations.filter(
        (t: { name: string }) => !t.name.includes('depth')
      );
      this.depthTexture.destroy();
    }
    this.depthTexture = this.device.createTexture({
      label: 'scene-depth',
      size: [width, height, 1],
      format: depthFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    });
    // Full aspect for render attachment; depth-only for shader sampling (bloom contact shadow).
    this.depthAttachmentView = this.depthTexture.createView();
    this.depthSampleView = this.depthTexture.createView({ aspect: 'depth-only' });
    this.profiler.trackTexture('depthBuffer', width, height, depthFormat);
  },

  /**
   * (Re)allocate the half-res SSR reflection target. Kept allocated even when
   * the quality tier gates SSR off, because bloomComposite always binds it —
   * the pass is simply not dispatched and `ssrStrength` packs to 0.
   */
  setupSsrTexture() {
    const { width: w, height: h } = WebGPUManager.canvasPixelSize(this.canvas);
    const sw = Math.max(1, Math.floor(w * SSR_RESOLUTION_SCALE));
    const sh = Math.max(1, Math.floor(h * SSR_RESOLUTION_SCALE));

    if (this.ssrTexture && this.ssrWidth === sw && this.ssrHeight === sh) return;
    if (this.ssrTexture) this.ssrTexture.destroy();

    this.ssrWidth = sw;
    this.ssrHeight = sh;
    this.ssrTexture = this.device.createTexture({
      label: 'ssr-reflection',
      size: [sw, sh],
      format: SSR_FORMAT,
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING
    });
    this.ssrTextureView = this.ssrTexture.createView();
    this.profiler?.trackTexture?.('ssrReflection', sw, sh, SSR_FORMAT);
    // Stale bind groups reference the destroyed texture.
    this.ssrBindGroup = null;
  },

  /** SSR compute bind group — depends on depth + scene textures, so rebuilt on resize. */
  _rebuildSsrBindGroup() {
    if (!this.pipelineCache || !this.ssrTextureView || !this.depthSampleView
        || !this.bloomSceneTexture || !this.bloomSampler || !this.ssrParamsBuffer) {
      return;
    }
    this.ssrBindGroup = this.pipelineCache.createBindGroup('ssr', [
      { binding: 0, resource: this.depthSampleView },
      { binding: 1, resource: this.bloomSceneTexture.createView() },
      { binding: 2, resource: this.bloomSampler },
      { binding: 3, resource: { buffer: this.ssrParamsBuffer } },
      { binding: 4, resource: this.ssrTextureView }
    ], 'ssr-bg');
  },

  async setupSsrPipeline() {
    const cache = this.pipelineCache;
    if (!cache || !this.profiler) return;
    this.ssrEnabled = this.ssrEnabled !== false;

    this.ssrParamsBuffer = this.device.createBuffer({
      label: 'ssr-params',
      size: SSR_PARAMS_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.profiler.trackBuffer('ssr-params', SSR_PARAMS_BYTES, GPUBufferUsage.UNIFORM);

    this.setupSsrTexture();
    try {
      this.ssrPipeline = await cache.ensureSsrPipeline(this.shaders.ssrComputeShader);
    } catch (e) {
      console.warn('[MultiDeviceVisualizer] SSR pipeline unavailable — reflections disabled:', e);
      this.ssrPipeline = null;
      this.ssrEnabled = false;
    }
    this._rebuildSsrBindGroup();
  },

  setupBloomTextures() {
    const { width: w, height: h } = WebGPUManager.canvasPixelSize(this.canvas);
    const fmt = navigator.gpu.getPreferredCanvasFormat();
    const bloomFmt = WebGPUManager.bloomIntermediateFormat(this.device, fmt);
    this.bloomIntermediateFormat = bloomFmt;

    if (this.bloomSceneTexture) this.bloomSceneTexture.destroy();
    if (this.bloomBlurTexture)  this.bloomBlurTexture.destroy();
    if (this.bloomTempTexture)  this.bloomTempTexture.destroy();
    if (this.prevSceneTexture)  this.prevSceneTexture.destroy();

    this.bloomSceneTexture = this.device.createTexture({
      size: [w, h], format: fmt,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC
    });
    this.bloomBlurTexture = this.device.createTexture({
      size: [w, h], format: bloomFmt,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    });
    this.bloomTempTexture = this.device.createTexture({
      size: [w, h], format: bloomFmt,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    });
    this.prevSceneTexture = this.device.createTexture({
      size: [w, h], format: fmt,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    });

    if (this.bloomParamsBuffer) {
      writeQueueBuffer(
        this.device,
        this.bloomParamsBuffer,
        packPostUniforms({
          width: w,
          height: h,
          preset: this.postPreset,
          ssrEnabled: this.ssrEnabled !== false
        })
      );
    }
    this.setupSsrTexture();
    this._rebuildBloomBindGroups();
    this._rebuildSsrBindGroup();
  },

  /** Cached bloom bind groups — recreated when bloom textures resize. */
  _rebuildBloomBindGroups() {
    if (!this.pipelineCache || !this.bloomSceneTexture || !this.bloomBlurTexture
        || !this.bloomTempTexture || !this.prevSceneTexture || !this.bloomSampler
        || !this.bloomParamsBuffer || !this.depthSampleView || !this.ssrTextureView) {
      return;
    }
    const cache = this.pipelineCache;
    const paramsBuf = this.bloomParamsBuffer;
    const dirX = this.bloomBlurDirXBuffer;
    const dirY = this.bloomBlurDirYBuffer;
    if (!paramsBuf || !dirX || !dirY) return;
    const mk = (name: BindGroupLayoutName, entries: GPUBindGroupEntry[], label: string) =>
      cache.createBindGroup(name, entries, label);

    this.bloomExtractBindGroup = mk('bloomExtract', [
      { binding: 0, resource: this.bloomSceneTexture.createView() },
      { binding: 1, resource: this.bloomSampler },
      { binding: 2, resource: { buffer: paramsBuf } }
    ], 'bloom-extract-bg');

    this.bloomBlurXBindGroup = mk('bloomBlur', [
      { binding: 0, resource: this.bloomTempTexture.createView() },
      { binding: 1, resource: this.bloomSampler },
      { binding: 2, resource: { buffer: paramsBuf } },
      { binding: 3, resource: { buffer: dirX } }
    ], 'bloom-blur-x-bg');

    this.bloomBlurYBindGroup = mk('bloomBlur', [
      { binding: 0, resource: this.bloomBlurTexture.createView() },
      { binding: 1, resource: this.bloomSampler },
      { binding: 2, resource: { buffer: paramsBuf } },
      { binding: 3, resource: { buffer: dirY } }
    ], 'bloom-blur-y-bg');

    this.bloomCompositeBindGroup = mk('bloomComposite', [
      { binding: 0, resource: this.bloomSceneTexture.createView() },
      { binding: 1, resource: this.bloomTempTexture.createView() },
      { binding: 2, resource: this.bloomSampler },
      { binding: 3, resource: { buffer: paramsBuf } },
      { binding: 4, resource: this.depthSampleView },
      { binding: 5, resource: this.prevSceneTexture.createView() },
      { binding: 6, resource: this.ssrTextureView }
    ], 'bloom-composite-bg');
  },

  async setupBloomPipeline() {
    const cache = this.pipelineCache;
    if (!cache) return;

    this.bloomSampler = this.device.createSampler({
      magFilter: 'linear', minFilter: 'linear',
      addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge'
    });

    // 20 floats — see packPostUniforms (BloomParams gained ssrStrength + pad).
    this.bloomParamsBuffer = this.device.createBuffer({
      label: 'bloom-params',
      size: 80,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.bloomBlurDirXBuffer = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.bloomBlurDirYBuffer = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

    await cache.ensureBloomPipelines(this.shaders);
    this.bloomExtractPipeline = cache.getPipeline('bloomExtract') as GPURenderPipeline;
    this.bloomBlurPipeline = cache.getPipeline('bloomBlur') as GPURenderPipeline;
    this.bloomCompositePipeline = cache.getPipeline('bloomComposite') as GPURenderPipeline;

    this.device.queue.writeBuffer(this.bloomBlurDirXBuffer, 0, new Float32Array([1, 0, 0, 0]));
    this.device.queue.writeBuffer(this.bloomBlurDirYBuffer, 0, new Float32Array([0, 1, 0, 0]));
    this.setupBloomTextures();
    this._rebuildBloomBindGroups();
  }
};
