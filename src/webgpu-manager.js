/**
 * WebGPU device/context init. For renderer switching see renderers/renderer-selector.js.
 * WebGL2 fallback uses WebGL2Context — same canvas, shared simulation in renderers/shared/.
 */
export class WebGPUManager {
  constructor(canvas) {
    this.canvas = canvas;
    this.device = null;
    this.context = null;
    this.depthTexture = null;
    this.globalUniformBuffer = null;
    this.globalBindGroup = null;
    this.globalBindGroupLayout = null;
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

  async init() {
    if (!navigator.gpu) {
      alert("WebGPU not supported. Use Chrome 113+ or Edge 113+.");
      throw new Error("WebGPU not supported");
    }

    try {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
      if (!adapter) throw new Error("No adapter");

      // Log adapter info for debugging
      console.log('WebGPU Adapter:', adapter.info);

      // GPU timestamp queries break canvas presentation on D3D12/ANGLE when written into
      // the main render command encoder (blank/white canvas, 60 FPS, no validation errors).
      // Opt in only for profiling: ?gpuTiming=1 (requires reload).
      const wantsGpuTiming = typeof location !== 'undefined' &&
        new URLSearchParams(location.search).get('gpuTiming') === '1';
      const requiredFeatures = (wantsGpuTiming && adapter.features.has('timestamp-query'))
        ? ['timestamp-query']
        : [];
      this.device = await adapter.requestDevice({ requiredFeatures });

      this.context = this.canvas.getContext('webgpu');

      this.context.configure({
        device: this.device,
        format: navigator.gpu.getPreferredCanvasFormat(),
        alphaMode: 'premultiplied',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
      });

      await this.setupGlobalResources();

    } catch (e) {
      console.error(e);
      alert("WebGPU init failed: " + e.message);
      throw e;
    }
  }

  async setupDepthBuffer() {
    const { width, height } = WebGPUManager.canvasPixelSize(this.canvas);
    const size = [width, height, 1];
    this.depthTexture = this.device.createTexture({
      size,
      format: 'depth24plus-stencil8',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    });
  }

  async setupGlobalResources() {
    // Global uniform buffer: viewProj + time/camera + 4× light blocks (512 B total).
    this.globalUniformBuffer = this.device.createBuffer({
      size: 512, // viewProj(64) + time/camera(32) + 4 lights × 32 = 224; padded to 512
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

    // Seed a valid viewProj and a non-zero resolution so partial init never
    // leaves NaN transforms or division-by-zero in the GPU block.
    const globalSeed = new Float32Array(24);
    globalSeed[0] = 1; globalSeed[5] = 1; globalSeed[10] = 1; globalSeed[15] = 1;
    globalSeed[18] = 1; globalSeed[19] = 1;
    globalSeed[20] = 0; globalSeed[21] = 8; globalSeed[22] = 18;
    this.device.queue.writeBuffer(this.globalUniformBuffer, 0, globalSeed);

    // Global bind group layout
    this.globalBindGroupLayout = this.device.createBindGroupLayout({
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' }
      }]
    });

    // Global bind group
    this.globalBindGroup = this.device.createBindGroup({
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

      // Recreate depth buffer
      if (this.depthTexture) {
        this.depthTexture.destroy();
      }
      this.setupDepthBuffer();
    }
    return true;
  }
}