/**
 * WebGPU device/context init. For renderer switching see renderers/renderer-selector.ts.
 * Automatic WebGL2 fallback on failure is disabled (boot hard-fails; see webgpu-probe.ts).
 * Explicit ?renderer=webgl2 remains an agent opt-in path only.
 *
 * Feature / limit matrix: docs/WEBGPU.md (and docs/AGENTS.md summary).
 *
 * Layout (webgpu-init/):
 *   adapter.ts     adapter request, feature/limit negotiation, adapter info
 *   canvas.ts      canvas sizing, URL options, context.configure()
 *   device-lost.ts device.lost / uncapturederror hooks + reload overlay
 * This file owns the device lifetime (`init()` / `reinit()`), depth buffer and
 * global uniforms. Static helpers below delegate so callers keep one import.
 */

import { parseSsrEnabled } from './renderers/shared/url-params';
import { selectTextureCompression, type TextureCompressionKind } from './assets/gltf/ktx2-gpu';
import {
  DEFAULT_COLOR_ATTACHMENT_BYTES_PER_SAMPLE,
  PREFERRED_LIMITS,
  bloomIntermediateFormat,
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
  canvasViewFormats,
  configureCanvasContext,
  depthStencilAttachment,
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

export {
  BLOOM_HDR_FEATURE,
  BLOOM_HDR_FORMAT,
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
  depthTexture: GPUTexture | null = null;
  globalUniformBuffer: GPUBuffer | null = null;
  globalBindGroup: GPUBindGroup | null = null;
  globalBindGroupLayout: GPUBindGroupLayout | null = null;

  depthFormat: GPUTextureFormat = DEPTH_FORMAT;
  canvasFormat: GPUTextureFormat | null = null;
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

  static canvasViewFormats(format: GPUTextureFormat): GPUTextureFormat[] {
    return canvasViewFormats(format);
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

  static bloomIntermediateFormat(device: GPUDevice, canvasFormat: GPUTextureFormat): GPUTextureFormat {
    return bloomIntermediateFormat(device, canvasFormat);
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
   * device (ADR-0007). Shared by {@link init} and {@link reinit}; the scene
   * pass's color-attachment cost depends on `canvasFormat`, and any limit it
   * needs has to be part of the device request.
   */
  private async _requestDevice(adapter: GPUAdapter, canvasFormat: GPUTextureFormat): Promise<void> {
    const requiredFeatures = negotiateFeatures(adapter, { gpuTiming: this.gpuTimingRequested });
    const requiredLimits = negotiateLimits(adapter, {
      ...PREFERRED_LIMITS,
      ...sceneColorAttachmentLimit(canvasFormat)
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
      onDeviceLost: this.onDeviceLost,
      onUncapturedError: this.onUncapturedError
    });
    checkColorAttachmentBudget(this.device, canvasFormat);
    this.textureCompression = selectTextureCompression(this.device, this.adapterInfo!);
    this.textureCompressionUsed = 'none';
  }

  private _configureCanvas(device: GPUDevice, canvasFormat: GPUTextureFormat): void {
    this.context = configureCanvasContext(this.canvas, device, {
      format: canvasFormat,
      alphaMode: this.alphaMode,
      colorSpace: this.colorSpace,
      toneMappingMode: this.toneMappingMode
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
      // Resolved before requestDevice — see _requestDevice.
      this.canvasFormat = navigator.gpu.getPreferredCanvasFormat();
      await this._requestDevice(adapter, this.canvasFormat);
      console.log('[WebGPU] Texture compression (device):', this.textureCompression);

      const ssrOn = parseSsrEnabled();
      const fallbackSoft = !!(this.adapterInfo.fallback || this.adapterInfo.software);
      this.depthFormat = resolveDepthFormat(ssrOn && !fallbackSoft);

      this.colorSpace = wantsDisplayP3() ? 'display-p3' : 'srgb';
      this.toneMappingMode = canvasToneMappingMode();
      this._configureCanvas(this.device!, this.canvasFormat);

      console.log(
        `[WebGPU] Canvas configured: format=${this.canvasFormat} alphaMode=${this.alphaMode}` +
        ` colorSpace=${this.colorSpace} toneMapping=${this.toneMappingMode}` +
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
   * Re-create the device + canvas context on the SAME adapter after
   * `device.lost` (ADR-0007: still one long-lived device — this never
   * requests a second `GPUAdapter`). Feature/limit negotiation is re-run so
   * a spec-compliant adapter that changed its reported support between
   * losses still gets a valid request.
   *
   * Returns `false` instead of throwing (adapter itself is gone, or the
   * fresh `requestDevice` rejects) so callers can fall back to the reload
   * overlay. Only device/context/depth/global-uniform state lives here —
   * visualizer-owned GPU state (pipelines, geometry, devices, IBL, …) is
   * the caller's job to rebuild once this resolves `true`.
   */
  async reinit(): Promise<boolean> {
    if (!this.adapter || !this.canvasFormat) return false;
    try {
      await this._requestDevice(this.adapter, this.canvasFormat);

      // The old texture died with the device — drop the reference so
      // resize()/setupDepthBuffer() allocate a fresh one against the new device.
      this.depthTexture = null;

      this._configureCanvas(this.device!, this.canvasFormat);

      await this.setupGlobalResources();
      console.log('[WebGPU] Device re-initialized on existing adapter after device.lost');
      return true;
    } catch (e) {
      console.error('[WebGPU] reinit failed (adapter likely gone too):', e);
      return false;
    }
  }

  async setupDepthBuffer(): Promise<void> {
    const { width, height } = WebGPUManager.canvasPixelSize(this.canvas);
    if (this.depthTexture) {
      this.depthTexture.destroy();
      this.depthTexture = null;
    }
    if (!this.device) return;
    this.depthTexture = this.device.createTexture({
      label: 'webgpu-manager-depth',
      size: [width, height, 1],
      format: this.depthFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    });
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

      if (this.depthTexture) {
        this.depthTexture.destroy();
        this.depthTexture = null;
      }
      void this.setupDepthBuffer();
    }
    return true;
  }

  hasFeature(name: string): boolean {
    return !!(this.device && this.device.features.has(name as GPUFeatureName));
  }
}
