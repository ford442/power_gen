/**
 * WebGPU device/context init. For renderer switching see renderers/renderer-selector.ts.
 * Automatic WebGL2 fallback on failure is disabled (boot hard-fails; see webgpu-probe.ts).
 * Explicit ?renderer=webgl2 remains an agent opt-in path only.
 *
 * Feature / limit matrix: docs/WEBGPU.md (and docs/AGENTS.md summary).
 *
 * Layout (webgpu-init/):
 *   adapter.ts         adapter request, feature/limit negotiation, adapter info
 *   canvas.ts          canvas sizing, URL options, context.configure()
 *   color-pipeline.ts  scene / post / canvas formats (`?color=`, `?hdr=1`)
 *   device-lost.ts     device.lost / uncapturederror hooks + reload overlay
 * This file owns the device lifetime (`init()` / `reinit()`) and global
 * uniforms; scene depth belongs to the post stack (visualizer/scene-post-buffers.ts).
 * Static helpers below delegate so callers keep one import.
 */

import { parseSsrEnabled } from './renderers/shared/url-params';
import { selectTextureCompression, type TextureCompressionKind } from './assets/gltf/ktx2-gpu';
import {
  DEFAULT_COLOR_ATTACHMENT_BYTES_PER_SAMPLE,
  PREFERRED_LIMITS,
  checkColorAttachmentBudget,
  colorAttachmentBytesPerSample,
  isSoftwareAdapterText,
  logAdapterSummary,
  negotiateFeatures,
  negotiateLimits,
  readAdapterInfo,
  requestPreferredAdapter,
  sceneColorAttachmentLimit,
  type AdapterFeatureLevel,
  type AdapterInfoSnapshot,
  type PreferredAdapterResult
} from './webgpu-init/adapter';
import {
  CANVAS_ALPHA_MODE,
  DEPTH_FORMAT,
  canvasPixelSize,
  canvasToneMappingMode,
  configureCanvasContext,
  depthStencilAttachment,
  observeDevicePixelSize,
  setMaxCanvasDimension,
  offscreenColorDescriptor,
  resolveDepthFormat,
  searchParams,
  wantsDisplayP3,
  wantsGpuTiming,
  type CanvasPixelSize,
  type CanvasToneMappingMode,
  type DepthStencilAttachmentOpts
} from './webgpu-init/canvas';
import { attachDeviceHooks, showDeviceLostUI, type DeviceLostInfo } from './webgpu-init/device-lost';
import {
  parseColorPipelineMode,
  resolveColorTargets,
  type ColorPipelineMode,
  type ColorTargets
} from './webgpu-init/color-pipeline';

export {
  DEFAULT_COLOR_ATTACHMENT_BYTES_PER_SAMPLE,
  OPTIONAL_DEVICE_FEATURES,
  PREFERRED_LIMITS,
  colorAttachmentBytesPerSample,
  sceneColorAttachmentFormats,
  sceneColorAttachmentLimit,
  type AdapterFeatureLevel,
  type AdapterInfoSnapshot,
  type PreferredAdapterResult
} from './webgpu-init/adapter';
export {
  CANVAS_ALPHA_MODE,
  DEPTH_FORMAT,
  type CanvasPixelSize,
  type DepthStencilAttachmentOpts
} from './webgpu-init/canvas';
export type { ColorPipelineMode, ColorTargets } from './webgpu-init/color-pipeline';

export interface WebGPUManagerOptions {
  alphaMode?: GPUCanvasAlphaMode;
  onDeviceLost?: (info: DeviceLostInfo) => void;
  onUncapturedError?: (event: GPUUncapturedErrorEvent) => void;
}

export class WebGPUManager {
  canvas: HTMLCanvasElement;
  adapter: GPUAdapter | null = null;
  adapterInfo: AdapterInfoSnapshot | null = null;
  device: GPUDevice | null = null;
  context: GPUCanvasContext | null = null;
  globalUniformBuffer: GPUBuffer | null = null;
  globalBindGroup: GPUBindGroup | null = null;
  globalBindGroupLayout: GPUBindGroupLayout | null = null;

  depthFormat: GPUTextureFormat = DEPTH_FORMAT;
  canvasFormat: GPUTextureFormat | null = null;
  /** Scene / post / canvas formats for this session — see webgpu-init/color-pipeline.ts. */
  colorTargets: ColorTargets | null = null;
  colorMode: ColorPipelineMode = 'linear';
  alphaMode: GPUCanvasAlphaMode;
  colorSpace: PredefinedColorSpace = 'srgb';
  toneMappingMode: 'standard' | 'extended' = 'standard';
  featureLevel: AdapterFeatureLevel | null = null;

  enabledFeatures: string[] = [];
  requestedLimits: Record<string, number> = {};
  gpuTimingRequested = false;
  deviceLost = false;
  /** Gated BC/ETC2/ASTC pick (`none` on software/fallback or missing features). */
  textureCompression: TextureCompressionKind = 'none';
  /** Last CAD KTX2 upload family (`none` until a compressed/fallback albedo is created). */
  textureCompressionUsed: TextureCompressionKind = 'none';

  private onDeviceLost: ((info: DeviceLostInfo) => void) | null;
  private _simulatedLoss = false;
  private onUncapturedError: ((event: GPUUncapturedErrorEvent) => void) | null;

  constructor(canvas: HTMLCanvasElement, options: WebGPUManagerOptions = {}) {
    this.canvas = canvas;
    this.alphaMode = options.alphaMode || CANVAS_ALPHA_MODE;
    this.onDeviceLost = typeof options.onDeviceLost === 'function' ? options.onDeviceLost : null;
    this.onUncapturedError = typeof options.onUncapturedError === 'function' ? options.onUncapturedError : null;
  }

  // ── Static helpers: implementations live in webgpu-init/ ──────────────
  static canvasPixelSize(canvas: HTMLCanvasElement): CanvasPixelSize {
    return canvasPixelSize(canvas);
  }

  static observeDevicePixelSize(canvas: HTMLCanvasElement, onChange: () => void): ResizeObserver | null {
    return observeDevicePixelSize(canvas, onChange);
  }

  static wantsGpuTiming(search?: string): boolean {
    return wantsGpuTiming(search);
  }

  static searchParams(search?: string): URLSearchParams {
    return searchParams(search);
  }

  static wantsDisplayP3(search?: string): boolean {
    return wantsDisplayP3(search);
  }

  static canvasToneMappingMode(search?: string): CanvasToneMappingMode {
    return canvasToneMappingMode(search);
  }

  static offscreenColorDescriptor(opts: Parameters<typeof offscreenColorDescriptor>[0]): GPUTextureDescriptor {
    return offscreenColorDescriptor(opts);
  }

  static isSoftwareAdapterText(...parts: Array<string | undefined>): boolean {
    return isSoftwareAdapterText(...parts);
  }

  static requestPreferredAdapter(gpu?: GPU): Promise<PreferredAdapterResult | null> {
    return requestPreferredAdapter(gpu);
  }

  static negotiateFeatures(adapter: GPUAdapter, opts: { gpuTiming?: boolean } = {}): string[] {
    return negotiateFeatures(adapter, opts);
  }

  static negotiateLimits(
    adapter: GPUAdapter,
    preferred?: Partial<Record<keyof GPUSupportedLimits, number>>
  ): Record<string, number> {
    return negotiateLimits(adapter, preferred);
  }

  static readAdapterInfo(
    adapter: GPUAdapter,
    featureLevel: AdapterFeatureLevel | null = null
  ): AdapterInfoSnapshot {
    return readAdapterInfo(adapter, featureLevel);
  }

  static resolveDepthFormat(ssrEnabled: boolean): GPUTextureFormat {
    return resolveDepthFormat(ssrEnabled);
  }

  static showDeviceLostUI(info: DeviceLostInfo = {}): void {
    showDeviceLostUI(info);
  }

  static depthStencilAttachment(
    view: GPUTextureView,
    opts: DepthStencilAttachmentOpts = {}
  ): GPURenderPassDepthStencilAttachment {
    return depthStencilAttachment(view, opts);
  }

  logAdapterSummary(adapter: GPUAdapter, features: string[], limits: Record<string, number>): void {
    const info = this.adapterInfo || readAdapterInfo(adapter);
    logAdapterSummary(adapter, info, features, limits);
  }

  // ── Device lifetime ───────────────────────────────────────────────────
  /**
   * Negotiate features/limits for `adapter` and request the single long-lived
   * device (ADR-0007). Shared by {@link init} and {@link reinit}. Resolves
   * {@link colorTargets} first: the scene pass's color-attachment cost depends
   * on the scene format, and any limit it needs has to be part of the device
   * request.
   */
  private async _requestDevice(adapter: GPUAdapter): Promise<void> {
    const requiredFeatures = negotiateFeatures(adapter, { gpuTiming: this.gpuTimingRequested });
    const enabled = new Set<string>(requiredFeatures);
    this.colorTargets = resolveColorTargets({
      mode: this.colorMode,
      preferredCanvasFormat: navigator.gpu.getPreferredCanvasFormat(),
      features: enabled,
      hdrRequested: this.toneMappingMode === 'extended'
    });
    this.canvasFormat = this.colorTargets.canvasFormat;
    const sceneFormat = this.colorTargets.sceneFormat;
    const requiredLimits = negotiateLimits(adapter, {
      ...PREFERRED_LIMITS,
      ...sceneColorAttachmentLimit(sceneFormat)
    });

    this.logAdapterSummary(adapter, requiredFeatures, requiredLimits);
    this.enabledFeatures = requiredFeatures;
    this.requestedLimits = requiredLimits;

    // Single long-lived device for multi-device visualizer (not a second device).
    this.device = await adapter.requestDevice({
      requiredFeatures: requiredFeatures as GPUFeatureName[],
      requiredLimits,
      label: 'seg-primary-device',
      // Labelled so `uncapturederror` reports and DevTools' capture view
      // attribute submits to this queue by name rather than "Queue #1".
      defaultQueue: { label: 'seg-queue' }
    });

    this.deviceLost = false;
    attachDeviceHooks(this.device, {
      markLost: () => { this.deviceLost = true; },
      onDeviceLost: (info) => this._handleDeviceLost(info),
      onUncapturedError: this.onUncapturedError
    });
    checkColorAttachmentBudget(this.device, sceneFormat);
    setMaxCanvasDimension(this.device.limits.maxTextureDimension2D);
    this.textureCompression = selectTextureCompression(this.device, this.adapterInfo!);
    this.textureCompressionUsed = 'none';
  }

  /**
   * `reason: 'destroyed'` only follows our own `device.destroy()` (page
   * teardown, tests) — a real GPU reset reports `'unknown'`. Recovering from
   * our own teardown would race the unload, so only a loss flagged by
   * {@link simulateDeviceLost} goes on to the recovery handler.
   */
  private _handleDeviceLost(info: DeviceLostInfo): void {
    const simulated = this._simulatedLoss;
    this._simulatedLoss = false;
    if (info.reason === 'destroyed' && !simulated) {
      console.info('[WebGPU] device destroyed by our own teardown — not recovering');
      return;
    }
    if (this.onDeviceLost) this.onDeviceLost(info);
    else showDeviceLostUI(info);
  }

  /**
   * Debug / e2e hook (`window.simulateDeviceLost()`): destroy the live device
   * and mark the loss as a test so {@link reinit} recovery runs, exactly as
   * after a real GPU reset.
   */
  simulateDeviceLost(): boolean {
    if (!this.device || this.deviceLost) return false;
    this._simulatedLoss = true;
    this.device.destroy();
    return true;
  }

  private _configureCanvas(device: GPUDevice, targets: ColorTargets): void {
    this.context = configureCanvasContext(this.canvas, device, {
      format: targets.canvasFormat,
      viewFormats: targets.canvasViewFormats,
      alphaMode: this.alphaMode,
      colorSpace: this.colorSpace,
      toneMappingMode: targets.hdrOutput ? 'extended' : 'standard'
    });
  }

  async init(): Promise<void> {
    if (!navigator.gpu) {
      // Hard-fail UI is shown by main.ts / webgpu-probe — avoid a second alert.
      throw new Error('WebGPU not supported');
    }

    try {
      const preferred = await requestPreferredAdapter(navigator.gpu);
      if (!preferred) throw new Error('No adapter');

      const { adapter, featureLevel } = preferred;
      this.adapter = adapter;
      this.featureLevel = featureLevel;
      this.adapterInfo = readAdapterInfo(adapter, featureLevel);

      this.gpuTimingRequested = wantsGpuTiming();
      // Colour mode + HDR request resolve before requestDevice — see _requestDevice.
      this.colorMode = parseColorPipelineMode();
      this.toneMappingMode = canvasToneMappingMode();
      if (this.colorMode === 'legacy' && this.toneMappingMode === 'extended') {
        console.warn('[WebGPU] ?hdr=1 needs the linear colour pipeline — ignored with ?color=legacy');
        this.toneMappingMode = 'standard';
      }
      await this._requestDevice(adapter);
      console.log('[WebGPU] Texture compression (device):', this.textureCompression);

      const ssrOn = parseSsrEnabled();
      const fallbackSoft = !!(this.adapterInfo.fallback || this.adapterInfo.software);
      this.depthFormat = resolveDepthFormat(ssrOn && !fallbackSoft);

      this.colorSpace = wantsDisplayP3() ? 'display-p3' : 'srgb';
      this._configureCanvas(this.device!, this.colorTargets!);

      const ct = this.colorTargets!;
      console.log(
        `[WebGPU] Canvas configured: format=${this.canvasFormat} alphaMode=${this.alphaMode}` +
        ` colorSpace=${this.colorSpace} toneMapping=${this.toneMappingMode}` +
        ` color=${ct.mode} scene=${ct.sceneFormat} output=${ct.outputFormat} bloom=${ct.bloomFormat}` +
        ` depth=${this.depthFormat} featureLevel=${featureLevel}` +
        (this.gpuTimingRequested ? ' gpuTiming=on' : ' gpuTiming=off (default; ?gpuTiming=1 to request)')
      );

      await this.setupGlobalResources();
    } catch (e) {
      console.error('[WebGPU] init failed (no WebGL2 auto-fallback):', e);
      throw e;
    }
  }

  /**
   * Re-create the device + canvas context after `device.lost`.
   *
   * Requests a **fresh adapter** first: per the WebGPU spec an adapter is
   * *consumed* by its first successful `requestDevice`, so asking the old
   * one again always rejects (`OperationError`) and recovery never got past
   * the reload overlay. ADR-0007 forbids a second *live* device; the lost
   * one is dead, so this is still one device. Feature/limit negotiation is
   * re-run against the new adapter.
   *
   * Returns `false` instead of throwing (no adapter, or `requestDevice`
   * rejects) so callers can fall back to the reload overlay. Only
   * device/context/depth/global-uniform state lives here — visualizer-owned
   * GPU state (pipelines, geometry, devices, IBL, …) is the caller's job to
   * rebuild once this resolves `true`.
   */
  async reinit(): Promise<boolean> {
    if (!this.colorTargets || typeof navigator === 'undefined' || !navigator.gpu) return false;
    try {
      const preferred = await requestPreferredAdapter(navigator.gpu);
      if (!preferred) throw new Error('No adapter on re-request');
      this.adapter = preferred.adapter;
      this.featureLevel = preferred.featureLevel;
      this.adapterInfo = readAdapterInfo(preferred.adapter, preferred.featureLevel);
      // A fresh adapter may not offer the same features, so the scene format
      // can change here (rg11b10ufloat → rgba16float); the visualizer rebuilds
      // every pipeline against `colorTargets` after this resolves.
      await this._requestDevice(preferred.adapter);
      this._configureCanvas(this.device!, this.colorTargets!);

      await this.setupGlobalResources();
      console.log('[WebGPU] Device re-initialized on a fresh adapter after device.lost');
      return true;
    } catch (e) {
      console.error('[WebGPU] reinit failed (adapter likely gone too):', e);
      return false;
    }
  }

  async setupGlobalResources(): Promise<void> {
    if (!this.device) return;

    this.globalUniformBuffer = this.device.createBuffer({
      label: 'global-uniforms',
      size: 512,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

    const globalSeed = new Float32Array(24);
    globalSeed[0] = 1; globalSeed[5] = 1; globalSeed[10] = 1; globalSeed[15] = 1;
    globalSeed[18] = 1; globalSeed[19] = 1;
    globalSeed[20] = 0; globalSeed[21] = 8; globalSeed[22] = 18;
    this.device.queue.writeBuffer(this.globalUniformBuffer, 0, globalSeed);

    this.globalBindGroupLayout = this.device.createBindGroupLayout({
      label: 'global-bind-group-layout',
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' }
      }]
    });

    this.globalBindGroup = this.device.createBindGroup({
      label: 'global-bind-group',
      layout: this.globalBindGroupLayout,
      entries: [{
        binding: 0,
        resource: { buffer: this.globalUniformBuffer }
      }]
    });
  }

  resize(): boolean {
    const { width: displayWidth, height: displayHeight, layoutReady } =
      WebGPUManager.canvasPixelSize(this.canvas);
    if (!layoutReady) {
      return false;
    }

    if (this.canvas.width !== displayWidth || this.canvas.height !== displayHeight) {
      this.canvas.width = displayWidth;
      this.canvas.height = displayHeight;
    }
    return true;
  }

  hasFeature(name: string): boolean {
    return !!(this.device && this.device.features.has(name as GPUFeatureName));
  }
}
