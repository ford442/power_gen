// Floor grid, sky, bloom, SSR, IBL prefilter, depth, and canvas resize.
import { WebGPUManager, DEPTH_FORMAT } from '../webgpu-manager';
import { packPostUniforms } from '../seg-lighting-presets';
import { SSR_FORMAT, MATERIAL_GBUFFER_FORMAT, type BindGroupLayoutName } from '../pipeline-layout-cache';
import { createIblResources, uploadIblForPreset } from '../ibl-prefilter';
import { writeQueueBuffer } from '../gpu-buffer-write';
import type { MultiDeviceVisualizer } from '../multi-device-visualizer.js';
import { bindHostMethods } from './bind-host-methods.js';

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
  _rebuildDepthResolveBindGroup(): void;
  setupDepthResolvePipeline(): Promise<void>;
  setupSsrTexture(): void;
  _rebuildSsrBindGroup(): void;
  setupSsrPipeline(): Promise<void>;
  setupBloomTextures(): void;
  _rebuildBloomBindGroups(): void;
  setupBloomPipeline(): Promise<void>;
} = {
  /**
   * Bake the prefiltered GGX environment for the active lighting look.
   * Skipped on fallback/software adapters (analytic PBR path when iblLevels = 0).
   */
  setupIblPrefilter() {
    const fallbackSoft = !!(this.webgpu?.adapterInfo?.fallback || this.webgpu?.adapterInfo?.software);
    if (fallbackSoft) {
      this.iblLevels = 0;
      console.log('[MultiDeviceVisualizer] IBL prefilter skipped (fallback/software adapter)');
      return { levels: 0, cached: true, ms: 0 };
    }
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
    if (this.depthMsaaTexture) this.depthMsaaTexture.destroy();
    if (this.depthResolvedTexture) this.depthResolvedTexture.destroy();

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

    // 4x MSAA depth (ADR-0005 WS2 showroom pass, `high` tier + focus mode
    // only — see render-loop.ts `msaaActive`). WebGPU has no automatic
    // resolveTarget for depth, so `depth-resolve.wgsl` manually resolves
    // this into `depthResolvedTexture` (single-sample) each MSAA frame,
    // which SSR/bloom then read exactly as they read `depthTexture` today.
    this.depthMsaaTexture = this.device.createTexture({
      label: 'scene-depth-msaa4',
      size: [width, height, 1],
      format: depthFormat,
      sampleCount: 4,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    });
    this.depthMsaaAttachmentView = this.depthMsaaTexture.createView();
    this.depthMsaaSampleView = this.depthMsaaTexture.createView({ aspect: 'depth-only' });
    this.depthResolvedTexture = this.device.createTexture({
      label: 'scene-depth-resolved',
      size: [width, height, 1],
      format: depthFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    });
    this.depthResolvedAttachmentView = this.depthResolvedTexture.createView();
    this.depthResolvedSampleView = this.depthResolvedTexture.createView({ aspect: 'depth-only' });
    this.profiler.trackTexture('depthMsaa', width, height, depthFormat, 4);
    this.profiler.trackTexture('depthResolved', width, height, depthFormat);
    this._rebuildDepthResolveBindGroup();
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

  /**
   * SSR compute bind group(s) — depend on depth + scene textures, so rebuilt
   * on resize. Two variants: `ssrBindGroup` binds the regular single-sample
   * depth; `ssrBindGroupResolved` binds `depthResolvedTexture` (ADR-0005 WS2
   * MSAA path — see render-loop.ts `msaaActive`) so SSR never has to know
   * whether MSAA ran this frame, just which bind group to pick.
   */
  _rebuildSsrBindGroup() {
    if (!this.pipelineCache || !this.ssrTextureView || !this.depthSampleView
        || !this.bloomSceneTexture || !this.bloomSampler || !this.ssrParamsBuffer
        || !this.materialGBufferView) {
      return;
    }
    this.ssrBindGroup = this.pipelineCache.createBindGroup('ssr', [
      { binding: 0, resource: this.depthSampleView },
      { binding: 1, resource: this.bloomSceneTexture.createView() },
      { binding: 2, resource: this.bloomSampler },
      { binding: 3, resource: { buffer: this.ssrParamsBuffer } },
      { binding: 4, resource: this.ssrTextureView },
      { binding: 5, resource: this.materialGBufferView }
    ], 'ssr-bg');

    if (this.depthResolvedSampleView) {
      this.ssrBindGroupResolved = this.pipelineCache.createBindGroup('ssr', [
        { binding: 0, resource: this.depthResolvedSampleView },
        { binding: 1, resource: this.bloomSceneTexture.createView() },
        { binding: 2, resource: this.bloomSampler },
        { binding: 3, resource: { buffer: this.ssrParamsBuffer } },
        { binding: 4, resource: this.ssrTextureView },
        { binding: 5, resource: this.materialGBufferView }
      ], 'ssr-bg-resolved');
    }
  },

  /** Manual MSAA depth-resolve bind group — depends on depthMsaaTexture, so rebuilt on resize. */
  _rebuildDepthResolveBindGroup() {
    if (!this.pipelineCache || !this.depthMsaaSampleView) return;
    this._depthResolveBindGroup = this.pipelineCache.createBindGroup('depthResolve', [
      { binding: 0, resource: this.depthMsaaSampleView }
    ], 'depth-resolve-bg');
  },

  async setupDepthResolvePipeline() {
    const cache = this.pipelineCache;
    if (!cache) return;
    try {
      this.depthResolvePipeline = await cache.ensureDepthResolvePipeline(this.shaders);
    } catch (e) {
      console.warn('[MultiDeviceVisualizer] Depth-resolve pipeline unavailable — 4x MSAA disabled:', e);
      this.depthResolvePipeline = null;
    }
    this._rebuildDepthResolveBindGroup();
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
    if (this.materialGBufferTexture) this.materialGBufferTexture.destroy();
    if (this.sceneMsaaTexture) this.sceneMsaaTexture.destroy();
    if (this.materialGBufferMsaaTexture) this.materialGBufferMsaaTexture.destroy();
    if (this.bloomBlurTexture)  this.bloomBlurTexture.destroy();
    if (this.bloomTempTexture)  this.bloomTempTexture.destroy();
    if (this.prevSceneTexture)  this.prevSceneTexture.destroy();

    this.bloomSceneTexture = this.device.createTexture(
      WebGPUManager.offscreenColorDescriptor({
        label: 'bloom-scene',
        size: [w, h],
        format: fmt,
        sampleCount: 1
      })
    );
    // Metalness/roughness G-buffer (ADR-0005 WS2): second color target on the
    // scene pass, written only by seg-enhanced/roller (chrome/nickel + CAD
    // housing), read by SSR to weight reflections by material instead of a
    // Fresnel-only grazing term. Every other pass declares a `null` second
    // target, so its texels keep the render pass's clear value below —
    // metallic=0 / roughness=1, i.e. "non-metal" by default.
    this.materialGBufferTexture = this.device.createTexture(
      WebGPUManager.offscreenColorDescriptor({
        label: 'material-gbuffer',
        size: [w, h],
        format: MATERIAL_GBUFFER_FORMAT,
        sampleCount: 1,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
      })
    );
    this.materialGBufferView = this.materialGBufferTexture.createView();
    this.profiler?.trackTexture?.('materialGBuffer', w, h, MATERIAL_GBUFFER_FORMAT);

    // 4x MSAA scene color + G-buffer (`high` tier + focus mode only — see
    // render-loop.ts `msaaActive`). Render-attachment only: both resolve
    // automatically into bloomSceneTexture/materialGBufferTexture above via
    // `resolveTarget`, so neither needs TEXTURE_BINDING usage.
    this.sceneMsaaTexture = this.device.createTexture({
      label: 'scene-color-msaa4',
      size: [w, h],
      format: fmt,
      sampleCount: 4,
      usage: GPUTextureUsage.RENDER_ATTACHMENT
    });
    this.sceneMsaaView = this.sceneMsaaTexture.createView();
    this.materialGBufferMsaaTexture = this.device.createTexture({
      label: 'material-gbuffer-msaa4',
      size: [w, h],
      format: MATERIAL_GBUFFER_FORMAT,
      sampleCount: 4,
      usage: GPUTextureUsage.RENDER_ATTACHMENT
    });
    this.materialGBufferMsaaView = this.materialGBufferMsaaTexture.createView();
    this.profiler?.trackTexture?.('sceneMsaa', w, h, fmt, 4);
    this.profiler?.trackTexture?.('materialGBufferMsaa', w, h, MATERIAL_GBUFFER_FORMAT, 4);

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
          ssrEnabled: this.ssrEnabled !== false,
          outputLinearHdr: this.webgpu?.toneMappingMode === 'extended'
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

    // MSAA variant (ADR-0005 WS2) — binds depthResolvedTexture instead of
    // the regular depth for the contact-shadow term. Picked per frame in
    // render-loop.ts alongside ssrBindGroupResolved.
    if (this.depthResolvedSampleView) {
      this.bloomCompositeBindGroupResolved = mk('bloomComposite', [
        { binding: 0, resource: this.bloomSceneTexture.createView() },
        { binding: 1, resource: this.bloomTempTexture.createView() },
        { binding: 2, resource: this.bloomSampler },
        { binding: 3, resource: { buffer: paramsBuf } },
        { binding: 4, resource: this.depthResolvedSampleView },
        { binding: 5, resource: this.prevSceneTexture.createView() },
        { binding: 6, resource: this.ssrTextureView }
      ], 'bloom-composite-bg-resolved');
    }
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

/** Bloom / IBL / SSR / depth / canvas resize collaborator. */
export class PostStack {
  setupIblPrefilter: typeof sceneSetupMethods.setupIblPrefilter;
  refreshIblPrefilter: typeof sceneSetupMethods.refreshIblPrefilter;
  setupFloorGrid: typeof sceneSetupMethods.setupFloorGrid;
  setupSkyGradient: typeof sceneSetupMethods.setupSkyGradient;
  setupAnomalyWallPipeline: typeof sceneSetupMethods.setupAnomalyWallPipeline;
  _waitForCanvasLayout: typeof sceneSetupMethods._waitForCanvasLayout;
  _observeCanvasLayout: typeof sceneSetupMethods._observeCanvasLayout;
  _syncCanvasSize: typeof sceneSetupMethods._syncCanvasSize;
  setupDepthBuffer: typeof sceneSetupMethods.setupDepthBuffer;
  _rebuildDepthResolveBindGroup: typeof sceneSetupMethods._rebuildDepthResolveBindGroup;
  setupDepthResolvePipeline: typeof sceneSetupMethods.setupDepthResolvePipeline;
  setupSsrTexture: typeof sceneSetupMethods.setupSsrTexture;
  _rebuildSsrBindGroup: typeof sceneSetupMethods._rebuildSsrBindGroup;
  setupSsrPipeline: typeof sceneSetupMethods.setupSsrPipeline;
  setupBloomTextures: typeof sceneSetupMethods.setupBloomTextures;
  _rebuildBloomBindGroups: typeof sceneSetupMethods._rebuildBloomBindGroups;
  setupBloomPipeline: typeof sceneSetupMethods.setupBloomPipeline;

  constructor(host: MultiDeviceVisualizer) {
    const bound = bindHostMethods(sceneSetupMethods, host);
    this.setupIblPrefilter = bound.setupIblPrefilter;
    this.refreshIblPrefilter = bound.refreshIblPrefilter;
    this.setupFloorGrid = bound.setupFloorGrid;
    this.setupSkyGradient = bound.setupSkyGradient;
    this.setupAnomalyWallPipeline = bound.setupAnomalyWallPipeline;
    this._waitForCanvasLayout = bound._waitForCanvasLayout;
    this._observeCanvasLayout = bound._observeCanvasLayout;
    this._syncCanvasSize = bound._syncCanvasSize;
    this.setupDepthBuffer = bound.setupDepthBuffer;
    this._rebuildDepthResolveBindGroup = bound._rebuildDepthResolveBindGroup;
    this.setupDepthResolvePipeline = bound.setupDepthResolvePipeline;
    this.setupSsrTexture = bound.setupSsrTexture;
    this._rebuildSsrBindGroup = bound._rebuildSsrBindGroup;
    this.setupSsrPipeline = bound.setupSsrPipeline;
    this.setupBloomTextures = bound.setupBloomTextures;
    this._rebuildBloomBindGroups = bound._rebuildBloomBindGroups;
    this.setupBloomPipeline = bound.setupBloomPipeline;
  }
}

