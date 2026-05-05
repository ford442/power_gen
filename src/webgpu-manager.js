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

      this.device = await adapter.requestDevice({
        requiredFeatures: adapter.features.has('timestamp-query') ? ['timestamp-query'] : []
      });

      this.context = this.canvas.getContext('webgpu');

      this.context.configure({
        device: this.device,
        format: navigator.gpu.getPreferredCanvasFormat(),
        alphaMode: 'premultiplied',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
      });

      await this.setupDepthBuffer();
      await this.setupGlobalResources();

    } catch (e) {
      console.error(e);
      alert("WebGPU init failed: " + e.message);
      throw e;
    }
  }

  async setupDepthBuffer() {
    const size = [this.canvas.width, this.canvas.height, 1];
    this.depthTexture = this.device.createTexture({
      size,
      format: 'depth24plus-stencil8',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    });
  }

  async setupGlobalResources() {
    // Global uniform buffer for camera matrices, time, etc.
    this.globalUniformBuffer = this.device.createBuffer({
      size: 256, // 4x4 view + 4x4 proj + vec4 time/mode + vec4 camera pos
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

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
    const devicePixelRatio = window.devicePixelRatio || 1;
    const displayWidth = Math.floor(this.canvas.clientWidth * devicePixelRatio);
    const displayHeight = Math.floor(this.canvas.clientHeight * devicePixelRatio);

    if (this.canvas.width !== displayWidth || this.canvas.height !== displayHeight) {
      this.canvas.width = displayWidth;
      this.canvas.height = displayHeight;

      // Recreate depth buffer
      if (this.depthTexture) {
        this.depthTexture.destroy();
      }
      this.setupDepthBuffer();
    }
  }
}