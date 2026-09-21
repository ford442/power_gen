/**
 * WebGPU device/context init. For renderer switching see renderers/renderer-selector.ts.
 * Automatic WebGL2 fallback on failure is disabled (boot hard-fails; see webgpu-probe.ts).
 * Explicit ?renderer=webgl2 remains an agent opt-in path only.
 *
 * Feature / limit matrix: docs/WEBGPU.md (and docs/AGENTS.md summary).
 */

import { parseSsrEnabled } from './renderers/shared/url-params';
import { selectTextureCompression, type TextureCompressionKind } from './assets/gltf/ktx2-gpu';
import { MATERIAL_GBUFFER_FORMAT } from './pipeline-layout';
import {
  DEFAULT_COLOR_ATTACHMENT_BYTES_PER_SAMPLE,
  colorAttachmentBytesPerSample
} from './color-attachment-cost';

/** Depth-only format — stencil is unused; saves memory vs depth24plus-stencil8. */
export const DEPTH_FORMAT: GPUTextureFormat = 'depth24plus';

/** Preferred canvas alpha for full-viewport apps (HTML overlays do not need canvas alpha). */
export const CANVAS_ALPHA_MODE: GPUCanvasAlphaMode = 'opaque';

/**
 * Optional device features to enable when the adapter supports them.
 * Never hard-required — missing features are logged and skipped.
 * `timestamp-query` is gated separately (?gpuTiming=1) to avoid blank-canvas bugs.
 * Compression is requested if present so a later CAD path does not need a new device.
 * `float32-filterable` is not requested (no sampled rgba32float targets).
 * `bgra8unorm-storage` is not requested (no compute write to the swapchain).
 */
export const OPTIONAL_DEVICE_FEATURES = [
  'rg11b10ufloat-renderable',
  'texture-compression-bc',
  'texture-compression-etc2',
  'texture-compression-astc',
] as const;

export type AdapterFeatureLevel = 'core' | 'compatibility';

export interface PreferredAdapterResult {
  adapter: GPUAdapter;
  featureLevel: AdapterFeatureLevel;
}

/** Device feature required for HDR bloom blur/extract intermediates. */
export const BLOOM_HDR_FEATURE = 'rg11b10ufloat-renderable';

/** GPUTextureFormat used for bloom extract/blur when {@link BLOOM_HDR_FEATURE} is enabled. */
export const BLOOM_HDR_FORMAT: GPUTextureFormat = 'rg11b10ufloat';

/**
 * Soft preferred limits: only requested when the adapter can satisfy them.
 * Defaults already cover current particle compute (workgroup 64); raise here as needed.
 */
export const PREFERRED_LIMITS: Partial<Record<keyof GPUSupportedLimits, number>> = {
  maxStorageBuffersPerShaderStage: 10,
  maxComputeWorkgroupStorageSize: 16384,
  maxBufferSize: 256 * 1024 * 1024,
  maxStorageBufferBindingSize: 128 * 1024 * 1024,
  maxComputeInvocationsPerWorkgroup: 256
};

export { DEFAULT_COLOR_ATTACHMENT_BYTES_PER_SAMPLE, colorAttachmentBytesPerSample };

/**
 * Color targets of the scene render pass: canvas-format scene color plus the
 * metalness/roughness G-buffer (ADR-0005 WS2). The MSAA showroom variant
 * attaches the same two formats at sampleCount 4.
 */
export function sceneColorAttachmentFormats(canvasFormat: GPUTextureFormat): GPUTextureFormat[] {
  return [canvasFormat, MATERIAL_GBUFFER_FORMAT];
}

/**
 * Preferred-limit patch for the scene pass's color attachments.
 *
 * Returns `{}` whenever the pass fits in the guaranteed default, so the common
 * case requests nothing at all (#171's "never ask for what no pass uses"
 * rule). It only becomes a real request if the targets grow past 32 B/sample —
 * e.g. swapping the `rg8unorm` G-buffer for an `rgba16float` one. Merged into
 * {@link PREFERRED_LIMITS} before {@link WebGPUManager.negotiateLimits}, which
 * drops any key the adapter cannot satisfy, so a low-end adapter still gets a
 * device instead of a `requestDevice` rejection.
 */
export function sceneColorAttachmentLimit(
  canvasFormat: GPUTextureFormat
): Partial<Record<keyof GPUSupportedLimits, number>> {
  const need = colorAttachmentBytesPerSample(sceneColorAttachmentFormats(canvasFormat));
  if (need <= DEFAULT_COLOR_ATTACHMENT_BYTES_PER_SAMPLE) return {};
  return { maxColorAttachmentBytesPerSample: need };
}

export interface WebGPUManagerOptions {
  alphaMode?: GPUCanvasAlphaMode;
  onDeviceLost?: (info: { reason?: string; message?: string }) => void;
  onUncapturedError?: (event: GPUUncapturedErrorEvent) => void;
}

export interface CanvasPixelSize {
  width: number;
  height: number;
  layoutReady: boolean;
}

export interface AdapterInfoSnapshot {
  vendor: string;
  architecture: string;
  device: string;
  description: string;
  fallback: boolean;
  software: boolean;
  featureLevel: AdapterFeatureLevel | null;
}

export interface DepthStencilAttachmentOpts {
  depthClearValue?: number;
  depthLoadOp?: GPULoadOp;
  depthStoreOp?: GPUStoreOp;
  format?: GPUTextureFormat;
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

  private onDeviceLost: ((info: { reason?: string; message?: string }) => void) | null;
  private onUncapturedError: ((event: GPUUncapturedErrorEvent) => void) | null;

  constructor(canvas: HTMLCanvasElement, options: WebGPUManagerOptions = {}) {
    this.canvas = canvas;
    this.alphaMode = options.alphaMode || CANVAS_ALPHA_MODE;
    this.onDeviceLost = typeof options.onDeviceLost === 'function' ? options.onDeviceLost : null;
    this.onUncapturedError = typeof options.onUncapturedError === 'function' ? options.onUncapturedError : null;
  }

  static canvasPixelSize(canvas: HTMLCanvasElement): CanvasPixelSize {
    const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
    const clientWidth = canvas.clientWidth;
    const clientHeight = canvas.clientHeight;
    const layoutReady = clientWidth >= 1 && clientHeight >= 1;
    const cssWidth = layoutReady ? clientWidth : Math.max(canvas.width / dpr, 1);
    const cssHeight = layoutReady ? clientHeight : Math.max(canvas.height / dpr, 1);
    return {
      width: Math.max(1, Math.floor(cssWidth * dpr)),
      height: Math.max(1, Math.floor(cssHeight * dpr)),
      layoutReady
    };
  }

  /**
   * Whether GPU timestamp queries should be requested as a device feature.
   * Opt-in only: writing timestamps into the main render encoder blanks the canvas
   * on some D3D12/ANGLE stacks (60 FPS, no validation errors).
   */
  static wantsGpuTiming(search = typeof location !== 'undefined' ? location.search : ''): boolean {
    try {
      return new URLSearchParams(search).get('gpuTiming') === '1';
    } catch {
      return false;
    }
  }

  static searchParams(search = typeof location !== 'undefined' ? location.search : ''): URLSearchParams {
    try {
      return new URLSearchParams(search);
    } catch {
      return new URLSearchParams();
    }
  }

  static wantsDisplayP3(search = typeof location !== 'undefined' ? location.search : ''): boolean {
    return WebGPUManager.searchParams(search).get('p3') === '1';
  }

  /**
   * Canvas toneMapping. Default `standard` because bloom composite ACES-maps to [0,1]
   * for SDR. `extended` only with `?hdr=1` and an HDR display; composite then
   * outputs linear HDR (`outputLinearHdr`) so the canvas compositor is not double-tonemapped.
   */
  static canvasToneMappingMode(
    search = typeof location !== 'undefined' ? location.search : ''
  ): 'standard' | 'extended' {
    if (WebGPUManager.searchParams(search).get('hdr') !== '1') return 'standard';
    try {
      if (typeof matchMedia === 'function' && matchMedia('(dynamic-range: high)').matches) {
        return 'extended';
      }
    } catch { /* ignore */ }
    return 'standard';
  }

  static canvasViewFormats(format: GPUTextureFormat): GPUTextureFormat[] {
    if (format === 'bgra8unorm') return ['bgra8unorm', 'bgra8unorm-srgb'];
    if (format === 'rgba8unorm') return ['rgba8unorm', 'rgba8unorm-srgb'];
    return [format];
  }

  /**
   * Offscreen scene-color descriptor. MSAA belongs here (not on canvas.configure).
   * Base scene/G-buffer textures stay sampleCount 1 — the ADR-0005 WS2
   * showroom MSAA path (`high` tier + focus mode) allocates separate
   * sampleCount-4 textures alongside these (see scene-setup.ts
   * `sceneMsaaTexture` / `materialGBufferMsaaTexture`) rather than passing
   * sampleCount here, since color resolves via `resolveTarget` into exactly
   * these single-sample textures.
   */
  static offscreenColorDescriptor(opts: {
    format: GPUTextureFormat;
    size: GPUExtent3D;
    sampleCount?: number;
    usage?: GPUTextureUsageFlags;
    label?: string;
  }): GPUTextureDescriptor {
    return {
      label: opts.label,
      size: opts.size,
      format: opts.format,
      sampleCount: opts.sampleCount ?? 1,
      usage: opts.usage ?? (
        GPUTextureUsage.RENDER_ATTACHMENT
        | GPUTextureUsage.TEXTURE_BINDING
        | GPUTextureUsage.COPY_DST
        | GPUTextureUsage.COPY_SRC
      )
    };
  }

  static isSoftwareAdapterText(...parts: Array<string | undefined>): boolean {
    const blob = parts.filter(Boolean).join(' ').toLowerCase();
    return (
      blob.includes('swiftshader')
      || blob.includes('llvmpipe')
      || blob.includes('softpipe')
      || blob.includes('microsoft basic render')
    );
  }

  /**
   * Prefer core feature level; retry compatibility for mobile/Safari.
   * Does not request a device — probe and session still own their requestDevice calls.
   */
  static async requestPreferredAdapter(
    gpu: GPU = navigator.gpu
  ): Promise<PreferredAdapterResult | null> {
    const base = {
      powerPreference: 'high-performance' as GPUPowerPreference,
      forceFallbackAdapter: false
    };
    const withLevel = async (
      featureLevel: AdapterFeatureLevel
    ): Promise<{ adapter: GPUAdapter | null; threw: boolean }> => {
      try {
        const adapter = await gpu.requestAdapter({
          ...base,
          featureLevel
        } as GPURequestAdapterOptions);
        return { adapter, threw: false };
      } catch {
        return { adapter: null, threw: true };
      }
    };

    const legacy = async (): Promise<GPUAdapter | null> => {
      try {
        return await gpu.requestAdapter(base);
      } catch {
        return null;
      }
    };

    const core = await withLevel('core');
    if (core.threw) {
      const adapter = await legacy();
      if (adapter) {
        console.log('[WebGPU] requestAdapter (featureLevel unsupported; implicit core)');
        return { adapter, featureLevel: 'core' };
      }
      return null;
    }
    if (core.adapter) {
      console.log('[WebGPU] requestAdapter featureLevel=core');
      return { adapter: core.adapter, featureLevel: 'core' };
    }

    const compat = await withLevel('compatibility');
    if (compat.adapter) {
      console.log('[WebGPU] requestAdapter featureLevel=compatibility (core returned null)');
      return { adapter: compat.adapter, featureLevel: 'compatibility' };
    }
    return null;
  }

  static negotiateFeatures(adapter: GPUAdapter, opts: { gpuTiming?: boolean } = {}): string[] {
    const features: string[] = [];
    const available = adapter.features;

    if (opts.gpuTiming && available.has('timestamp-query')) {
      features.push('timestamp-query');
    }

    for (const name of OPTIONAL_DEVICE_FEATURES) {
      if (available.has(name) && !features.includes(name)) {
        features.push(name);
      }
    }
    return features;
  }

  static negotiateLimits(
    adapter: GPUAdapter,
    preferred: Partial<Record<keyof GPUSupportedLimits, number>> = PREFERRED_LIMITS
  ): Record<string, number> {
    const out: Record<string, number> = {};
    const limits = adapter.limits;
    for (const [key, want] of Object.entries(preferred)) {
      const max = limits[key as keyof GPUSupportedLimits];
      if (typeof max === 'number' && max >= want) {
        out[key] = want;
      }
    }
    return out;
  }

  static bloomIntermediateFormat(device: GPUDevice, canvasFormat: GPUTextureFormat): GPUTextureFormat {
    if (device?.features?.has(BLOOM_HDR_FEATURE)) {
      return BLOOM_HDR_FORMAT;
    }
    return canvasFormat;
  }

  static readAdapterInfo(
    adapter: GPUAdapter,
    featureLevel: AdapterFeatureLevel | null = null
  ): AdapterInfoSnapshot {
    const info = (adapter.info || {}) as GPUAdapterInfo & { isFallbackAdapter?: boolean };
    const legacyFallback = !!(adapter as GPUAdapter & { isFallbackAdapter?: boolean }).isFallbackAdapter;
    const vendor = info.vendor || 'unknown';
    const architecture = info.architecture || 'unknown';
    const device = info.device || 'unknown';
    const description = info.description || '';
    const fallback = !!(info.isFallbackAdapter || legacyFallback);
    const software = fallback || WebGPUManager.isSoftwareAdapterText(vendor, architecture, device, description);
    return {
      vendor,
      architecture,
      device,
      description,
      fallback,
      software,
      featureLevel
    };
  }

  static resolveDepthFormat(ssrEnabled: boolean): GPUTextureFormat {
    return ssrEnabled ? 'depth32float' : DEPTH_FORMAT;
  }

  /**
   * Warn (once, at init) if the device cannot afford the scene pass's color
   * targets. Reaching this means a target was widened without raising
   * {@link sceneColorAttachmentLimit} — the pass would fail validation on the
   * first frame, which is much harder to read than this line.
   */
  private _checkColorAttachmentBudget(device: GPUDevice, canvasFormat: GPUTextureFormat): void {
    const need = colorAttachmentBytesPerSample(sceneColorAttachmentFormats(canvasFormat));
    const granted = device.limits.maxColorAttachmentBytesPerSample
      ?? DEFAULT_COLOR_ATTACHMENT_BYTES_PER_SAMPLE;
    if (need > granted) {
      console.error(
        `[WebGPU] Scene color attachments need ${need} B/sample but the device granted ` +
        `${granted} B/sample — the scene pass will fail validation.`
      );
    }
  }

  logAdapterSummary(adapter: GPUAdapter, features: string[], limits: Record<string, number>): void {
    const info = this.adapterInfo || WebGPUManager.readAdapterInfo(adapter);
    const featureList = [...adapter.features].sort();
    console.log('[WebGPU] Adapter:', info);
    console.log('[WebGPU] Adapter features:', featureList);
    console.log('[WebGPU] Requesting device features:', features);
    console.log('[WebGPU] Requesting device limits:', limits);
    const tex = selectTextureCompression(adapter, info);
    console.log('[WebGPU] Texture compression:', tex);
    console.log('[WebGPU] Adapter limit snapshot:', {
      maxColorAttachmentBytesPerSample: adapter.limits.maxColorAttachmentBytesPerSample,
      maxStorageBuffersPerShaderStage: adapter.limits.maxStorageBuffersPerShaderStage,
      maxComputeWorkgroupStorageSize: adapter.limits.maxComputeWorkgroupStorageSize,
      maxBufferSize: adapter.limits.maxBufferSize,
      maxComputeWorkgroupSizeX: adapter.limits.maxComputeWorkgroupSizeX,
      maxBindGroups: adapter.limits.maxBindGroups
    });
  }

  async init(): Promise<void> {
    if (!navigator.gpu) {
      // Hard-fail UI is shown by main.ts / webgpu-probe — avoid a second alert.
      throw new Error('WebGPU not supported');
    }

    try {
      const preferred = await WebGPUManager.requestPreferredAdapter(navigator.gpu);
      if (!preferred) throw new Error('No adapter');

      const { adapter, featureLevel } = preferred;
      this.adapter = adapter;
      this.featureLevel = featureLevel;
      this.adapterInfo = WebGPUManager.readAdapterInfo(adapter, featureLevel);

      this.gpuTimingRequested = WebGPUManager.wantsGpuTiming();
      const requiredFeatures = WebGPUManager.negotiateFeatures(adapter, {
        gpuTiming: this.gpuTimingRequested
      });
      // Resolved before requestDevice: the scene pass's color-attachment cost
      // depends on the canvas format, and any limit it needs has to be part of
      // the device request.
      this.canvasFormat = navigator.gpu.getPreferredCanvasFormat();
      const requiredLimits = WebGPUManager.negotiateLimits(adapter, {
        ...PREFERRED_LIMITS,
        ...sceneColorAttachmentLimit(this.canvasFormat)
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
      this._attachDeviceHooks(this.device);
      this._checkColorAttachmentBudget(this.device, this.canvasFormat);
      this.textureCompression = selectTextureCompression(this.device, this.adapterInfo);
      this.textureCompressionUsed = 'none';
      console.log('[WebGPU] Texture compression (device):', this.textureCompression);

      const ssrOn = parseSsrEnabled();
      const fallbackSoft = !!(this.adapterInfo.fallback || this.adapterInfo.software);
      this.depthFormat = WebGPUManager.resolveDepthFormat(ssrOn && !fallbackSoft);

      this.context = this.canvas.getContext('webgpu');
      if (!this.context) throw new Error('Failed to get webgpu canvas context');

      this.colorSpace = WebGPUManager.wantsDisplayP3() ? 'display-p3' : 'srgb';
      this.toneMappingMode = WebGPUManager.canvasToneMappingMode();
      const viewFormats = WebGPUManager.canvasViewFormats(this.canvasFormat);

      this.context.configure({
        device: this.device,
        format: this.canvasFormat,
        alphaMode: this.alphaMode,
        colorSpace: this.colorSpace,
        toneMapping: { mode: this.toneMappingMode } as GPUCanvasToneMapping,
        viewFormats,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
      } as GPUCanvasConfiguration);

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
      const requiredFeatures = WebGPUManager.negotiateFeatures(this.adapter, {
        gpuTiming: this.gpuTimingRequested
      });
      const requiredLimits = WebGPUManager.negotiateLimits(this.adapter, {
        ...PREFERRED_LIMITS,
        ...sceneColorAttachmentLimit(this.canvasFormat)
      });

      this.logAdapterSummary(this.adapter, requiredFeatures, requiredLimits);
      this.enabledFeatures = requiredFeatures;
      this.requestedLimits = requiredLimits;

      this.device = await this.adapter.requestDevice({
        requiredFeatures: requiredFeatures as GPUFeatureName[],
        requiredLimits,
        label: 'seg-primary-device',
        defaultQueue: { label: 'seg-queue' }
      });

      this.deviceLost = false;
      this._attachDeviceHooks(this.device);
      this._checkColorAttachmentBudget(this.device, this.canvasFormat);
      this.textureCompression = selectTextureCompression(this.device, this.adapterInfo!);
      this.textureCompressionUsed = 'none';

      // The old texture died with the device — drop the reference so
      // resize()/setupDepthBuffer() allocate a fresh one against the new device.
      this.depthTexture = null;

      this.context = this.canvas.getContext('webgpu');
      if (!this.context) throw new Error('Failed to get webgpu canvas context');

      const viewFormats = WebGPUManager.canvasViewFormats(this.canvasFormat);
      this.context.configure({
        device: this.device,
        format: this.canvasFormat,
        alphaMode: this.alphaMode,
        colorSpace: this.colorSpace,
        toneMapping: { mode: this.toneMappingMode } as GPUCanvasToneMapping,
        viewFormats,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
      } as GPUCanvasConfiguration);

      await this.setupGlobalResources();
      console.log('[WebGPU] Device re-initialized on existing adapter after device.lost');
      return true;
    } catch (e) {
      console.error('[WebGPU] reinit failed (adapter likely gone too):', e);
      return false;
    }
  }

  private _attachDeviceHooks(device: GPUDevice): void {
    device.lost.then((info) => {
      this.deviceLost = true;
      const reason = info?.reason || 'unknown';
      const message = info?.message || 'GPU device was lost';
      console.error('[WebGPU] device.lost:', reason, message);

      if (this.onDeviceLost) {
        try {
          this.onDeviceLost({ reason, message });
        } catch (e) {
          console.warn('[WebGPU] onDeviceLost handler threw:', e);
        }
      } else {
        WebGPUManager.showDeviceLostUI({ reason, message });
      }
    });

    device.addEventListener('uncapturederror', (event) => {
      const err = event.error;
      console.error('[WebGPU] uncapturederror:', err?.message || err);
      if (this.onUncapturedError) {
        try {
          this.onUncapturedError(event);
        } catch (e) {
          console.warn('[WebGPU] onUncapturedError handler threw:', e);
        }
      }
    });
  }

  static showDeviceLostUI(info: { reason?: string; message?: string } = {}): void {
    if (typeof document === 'undefined') return;

    const existing = document.getElementById('webgpu-device-lost');
    if (existing) existing.remove();

    const el = document.createElement('div');
    el.id = 'webgpu-device-lost';
    el.setAttribute('role', 'alert');
    el.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:100000',
      'display:flex', 'align-items:center', 'justify-content:center',
      'background:rgba(0,0,0,0.82)', 'color:#e8f4ff',
      'font-family:system-ui,Segoe UI,sans-serif', 'padding:24px', 'text-align:center'
    ].join(';');

    const reason = info.reason || 'unknown';
    const detail = info.message || 'The GPU device was lost.';
    el.innerHTML = `
      <div style="max-width:420px">
        <h2 style="margin:0 0 12px;font-size:1.25rem;color:#0ff">WebGPU device lost</h2>
        <p style="margin:0 0 8px;opacity:0.9;font-size:0.95rem">${escapeHtml(detail)}</p>
        <p style="margin:0 0 20px;opacity:0.65;font-size:0.8rem">Reason: ${escapeHtml(reason)}</p>
        <button type="button" id="webgpu-device-lost-reload"
          style="cursor:pointer;padding:10px 20px;border:1px solid #0ff;background:#062a33;color:#0ff;border-radius:6px;font-size:0.95rem">
          Reload page
        </button>
      </div>
    `;
    document.body.appendChild(el);
    el.querySelector('#webgpu-device-lost-reload')?.addEventListener('click', () => {
      location.reload();
    });
  }

  static depthStencilAttachment(
    view: GPUTextureView,
    opts: DepthStencilAttachmentOpts = {}
  ): GPURenderPassDepthStencilAttachment {
    const attachment: GPURenderPassDepthStencilAttachment = {
      view,
      depthClearValue: opts.depthClearValue ?? 1.0,
      depthLoadOp: opts.depthLoadOp ?? 'clear',
      depthStoreOp: opts.depthStoreOp ?? 'store'
    };
    const format = opts.format ?? DEPTH_FORMAT;
    if (format.includes('stencil')) {
      attachment.stencilClearValue = 0;
      attachment.stencilLoadOp = 'clear';
      attachment.stencilStoreOp = 'store';
    }
    return attachment;
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

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
