/**
 * WebGPU device/context init. For renderer switching see renderers/renderer-selector.js.
 * WebGL2 fallback uses WebGL2Context — same canvas, shared simulation in renderers/shared/.
 *
 * Language: plain JS (render orchestration). Gradual migration to TS is optional;
 * enable `// @ts-check` only after call sites have stable GPU typings.
 *
 * Feature / limit matrix: docs/WEBGPU.md (and docs/AGENTS.md summary).
 */

/** Depth-only format — stencil is unused; saves memory vs depth24plus-stencil8. */
export const DEPTH_FORMAT = 'depth24plus';

/** Preferred canvas alpha for full-viewport apps (HTML overlays do not need canvas alpha). */
export const CANVAS_ALPHA_MODE = 'opaque';

/**
 * Optional device features to enable when the adapter supports them.
 * Never hard-required — missing features are logged and skipped.
 * `timestamp-query` is gated separately (?gpuTiming=1) to avoid blank-canvas bugs.
 */
export const OPTIONAL_DEVICE_FEATURES = [
  'float32-filterable',
  // Future BC compressed textures; harmless if unused.
  'texture-compression-bc',
  'rg11b10ufloat-renderable',
  'bgra8unorm-storage'
];

/**
 * Soft preferred limits: only requested when the adapter can satisfy them.
 * Defaults already cover current particle compute (workgroup 64); raise here as needed.
 */
export const PREFERRED_LIMITS = {
  maxStorageBuffersPerShaderStage: 10,
  maxComputeWorkgroupStorageSize: 16384,
  maxBufferSize: 256 * 1024 * 1024,
  maxStorageBufferBindingSize: 128 * 1024 * 1024,
  maxComputeInvocationsPerWorkgroup: 256
};

export class WebGPUManager {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    /** @type {GPUAdapter | null} */
    this.adapter = null;
    /** @type {GPUAdapterInfo | Record<string, string> | null} */
    this.adapterInfo = null;
    /** @type {GPUDevice | null} */
    this.device = null;
    this.context = null;
    this.depthTexture = null;
    this.globalUniformBuffer = null;
    this.globalBindGroup = null;
    this.globalBindGroupLayout = null;

    /** @type {typeof DEPTH_FORMAT} */
    this.depthFormat = DEPTH_FORMAT;
    this.canvasFormat = null;
    this.alphaMode = options.alphaMode || CANVAS_ALPHA_MODE;

    /** Features actually enabled on the device */
    this.enabledFeatures = [];
    /** Limits passed to requestDevice */
    this.requestedLimits = {};
    this.gpuTimingRequested = false;
    this.deviceLost = false;

    /** @type {((info: { reason?: string, message?: string }) => void) | null} */
    this.onDeviceLost = typeof options.onDeviceLost === 'function' ? options.onDeviceLost : null;
    /** @type {((event: GPUUncapturedErrorEvent) => void) | null} */
    this.onUncapturedError = typeof options.onUncapturedError === 'function' ? options.onUncapturedError : null;
  }

  static canvasPixelSize(canvas) {
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
  static wantsGpuTiming(search = typeof location !== 'undefined' ? location.search : '') {
    try {
      return new URLSearchParams(search).get('gpuTiming') === '1';
    } catch {
      return false;
    }
  }

  /**
   * Collect optional features the adapter supports (never hard-required).
   * @param {GPUAdapter} adapter
   * @param {{ gpuTiming?: boolean }} opts
   * @returns {string[]}
   */
  static negotiateFeatures(adapter, opts = {}) {
    const features = [];
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

  /**
   * Build requiredLimits from preferred caps, clamped to adapter maxima.
   * Omits keys the adapter cannot meet (no hard failure on low-end GPUs).
   * @param {GPUAdapter} adapter
   * @param {Record<string, number>} [preferred]
   */
  static negotiateLimits(adapter, preferred = PREFERRED_LIMITS) {
    const out = {};
    const limits = adapter.limits;
    for (const [key, want] of Object.entries(preferred)) {
      const max = limits[key];
      if (typeof max === 'number' && max >= want) {
        out[key] = want;
      }
    }
    return out;
  }

  /** Snapshot adapter info for logging / profiler (single request path). */
  static readAdapterInfo(adapter) {
    const info = adapter.info || {};
    return {
      vendor: info.vendor || 'unknown',
      architecture: info.architecture || 'unknown',
      device: info.device || 'unknown',
      description: info.description || '',
      // Older Chromium exposed requestAdapterInfo(); keep fallback empty.
      fallback: false
    };
  }

  logAdapterSummary(adapter, features, limits) {
    const info = this.adapterInfo || WebGPUManager.readAdapterInfo(adapter);
    const featureList = [...adapter.features].sort();
    console.log('[WebGPU] Adapter:', info);
    console.log('[WebGPU] Adapter features:', featureList);
    console.log('[WebGPU] Requesting device features:', features);
    console.log('[WebGPU] Requesting device limits:', limits);
    console.log('[WebGPU] Adapter limit snapshot:', {
      maxStorageBuffersPerShaderStage: adapter.limits.maxStorageBuffersPerShaderStage,
      maxComputeWorkgroupStorageSize: adapter.limits.maxComputeWorkgroupStorageSize,
      maxBufferSize: adapter.limits.maxBufferSize,
      maxComputeWorkgroupSizeX: adapter.limits.maxComputeWorkgroupSizeX,
      maxBindGroups: adapter.limits.maxBindGroups
    });
  }

  async init() {
    if (!navigator.gpu) {
      alert('WebGPU not supported. Use Chrome 113+ or Edge 113+.');
      throw new Error('WebGPU not supported');
    }

    try {
      // ── Single adapter request (profiler reuses this.adapter / adapterInfo) ──
      const adapter = await navigator.gpu.requestAdapter({
        powerPreference: 'high-performance'
      });
      if (!adapter) throw new Error('No adapter');

      this.adapter = adapter;
      this.adapterInfo = WebGPUManager.readAdapterInfo(adapter);

      this.gpuTimingRequested = WebGPUManager.wantsGpuTiming();
      const requiredFeatures = WebGPUManager.negotiateFeatures(adapter, {
        gpuTiming: this.gpuTimingRequested
      });
      const requiredLimits = WebGPUManager.negotiateLimits(adapter);

      this.logAdapterSummary(adapter, requiredFeatures, requiredLimits);

      this.enabledFeatures = requiredFeatures;
      this.requestedLimits = requiredLimits;

      this.device = await adapter.requestDevice({
        requiredFeatures,
        requiredLimits,
        label: 'seg-primary-device'
      });

      this.deviceLost = false;
      this._attachDeviceHooks(this.device);

      this.context = this.canvas.getContext('webgpu');
      if (!this.context) throw new Error('Failed to get webgpu canvas context');

      this.canvasFormat = navigator.gpu.getPreferredCanvasFormat();
      this.context.configure({
        device: this.device,
        format: this.canvasFormat,
        alphaMode: this.alphaMode,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
      });

      console.log(
        `[WebGPU] Canvas configured: format=${this.canvasFormat} alphaMode=${this.alphaMode} depth=${this.depthFormat}` +
        (this.gpuTimingRequested ? ' gpuTiming=on' : ' gpuTiming=off (default; ?gpuTiming=1 to request)')
      );

      await this.setupGlobalResources();
    } catch (e) {
      console.error(e);
      alert('WebGPU init failed: ' + e.message);
      throw e;
    }
  }

  /**
   * device.lost + uncapturederror — recovery is reload-oriented so pipelines
   * and buffers do not need a full multi-device re-init path.
   * @param {GPUDevice} device
   */
  _attachDeviceHooks(device) {
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

  /**
   * User-visible recovery prompt (manual reload). Safe default when no callback is set.
   * @param {{ reason?: string, message?: string }} info
   */
  static showDeviceLostUI(info = {}) {
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

  /**
   * Depth attachment descriptor for a render pass (no stencil ops on depth-only formats).
   * @param {GPUTextureView} view
   * @param {{ depthClearValue?: number, depthLoadOp?: GPULoadOp, depthStoreOp?: GPUStoreOp }} [opts]
   */
  static depthStencilAttachment(view, opts = {}) {
    const attachment = {
      view,
      depthClearValue: opts.depthClearValue ?? 1.0,
      depthLoadOp: opts.depthLoadOp ?? 'clear',
      depthStoreOp: opts.depthStoreOp ?? 'store'
    };
    // Stencil ops only when format includes stencil (we use depth24plus).
    if (DEPTH_FORMAT.includes('stencil')) {
      attachment.stencilClearValue = 0;
      attachment.stencilLoadOp = 'clear';
      attachment.stencilStoreOp = 'store';
    }
    return attachment;
  }

  async setupDepthBuffer() {
    const { width, height } = WebGPUManager.canvasPixelSize(this.canvas);
    if (this.depthTexture) {
      this.depthTexture.destroy();
      this.depthTexture = null;
    }
    this.depthTexture = this.device.createTexture({
      label: 'webgpu-manager-depth',
      size: [width, height, 1],
      format: this.depthFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    });
  }

  async setupGlobalResources() {
    // Global uniform buffer: viewProj + time/camera + 4× light blocks (512 B total).
    this.globalUniformBuffer = this.device.createBuffer({
      label: 'global-uniforms',
      size: 512,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

    // Seed a valid viewProj and a non-zero resolution so partial init never
    // leaves NaN transforms or division-by-zero in the GPU block.
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

  resize() {
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
      this.setupDepthBuffer();
    }
    return true;
  }

  /** Features enabled on the live device (Set-like check helper). */
  hasFeature(name) {
    return !!(this.device && this.device.features.has(name));
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
