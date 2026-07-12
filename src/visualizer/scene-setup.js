// Floor grid, sky, bloom, depth, and canvas resize.
import { WebGPUManager, DEPTH_FORMAT } from '../webgpu-manager.js';
import { packPostUniforms } from '../seg-lighting-presets.js';

export const sceneSetupMethods = {
  async setupFloorGrid() {
    this.gridPipeline = await this.pipelineCache.ensureGridPipeline(this.shaders);

    const gridVertices = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);
    this.gridVertexBuffer = this.device.createBuffer({
      size: gridVertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(this.gridVertexBuffer, 0, gridVertices);
    this.profiler.trackBuffer('gridVertices', gridVertices.byteLength, GPUBufferUsage.VERTEX);

    // Explicit empty bind group layout (grid shaders have no bindings)
    this.gridBindGroup = this.pipelineCache.createBindGroup('empty', [], 'grid-bg');
  },

  async setupSkyGradient() {
    this.skyUniformBuffer = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this._uploadSkyUniforms();

    this.skyPipeline = await this.pipelineCache.ensureSkyPipeline(this.shaders);

    this.skyBindGroup = this.pipelineCache.createBindGroup(
      'sky',
      [{ binding: 0, resource: { buffer: this.skyUniformBuffer } }],
      'sky-bg'
    );
  },

  async setupAnomalyWallPipeline() {
    this.anomalyWallPipeline = await this.pipelineCache.ensureAnomalyWallPipeline(this.shaders);

    this.anomalyWallParamsBuffer = this.device.createBuffer({
      label: 'anomaly-wall-params',
      size: 24,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.profiler.trackBuffer('anomaly-wall-params', 24, GPUBufferUsage.UNIFORM);
  },

  _waitForCanvasLayout() {
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
    const { width, height } = WebGPUManager.canvasPixelSize(this.canvas);
    const depthFormat = this.depthFormat || this.webgpu.depthFormat || DEPTH_FORMAT;
    if (this.depthTexture) {
      this.profiler.textureAllocations = this.profiler.textureAllocations.filter(t => !t.name.includes('depth'));
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

  setupBloomTextures() {
    const { width: w, height: h } = WebGPUManager.canvasPixelSize(this.canvas);
    const fmt = navigator.gpu.getPreferredCanvasFormat();

    if (this.bloomSceneTexture) this.bloomSceneTexture.destroy();
    if (this.bloomBlurTexture)  this.bloomBlurTexture.destroy();
    if (this.bloomTempTexture)  this.bloomTempTexture.destroy();
    if (this.prevSceneTexture)  this.prevSceneTexture.destroy();

    this.bloomSceneTexture = this.device.createTexture({
      size: [w, h], format: fmt,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC
    });
    this.bloomBlurTexture = this.device.createTexture({
      size: [w, h], format: fmt,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    });
    this.bloomTempTexture = this.device.createTexture({
      size: [w, h], format: fmt,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    });
    this.prevSceneTexture = this.device.createTexture({
      size: [w, h], format: fmt,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    });

    if (this.bloomParamsBuffer) {
      this.device.queue.writeBuffer(
        this.bloomParamsBuffer, 0,
        packPostUniforms({ width: w, height: h, preset: this.postPreset })
      );
    }
  },

  async setupBloomPipeline() {
    const fmt = navigator.gpu.getPreferredCanvasFormat();

    this.bloomSampler = this.device.createSampler({
      magFilter: 'linear', minFilter: 'linear',
      addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge'
    });

    this.bloomParamsBuffer = this.device.createBuffer({
      size: 64,
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

    await this.pipelineCache.ensureBloomPipelines(this.shaders);
    this.bloomExtractPipeline = this.pipelineCache.getPipeline('bloomExtract');
    this.bloomBlurPipeline = this.pipelineCache.getPipeline('bloomBlur');
    this.bloomCompositePipeline = this.pipelineCache.getPipeline('bloomComposite');

    this.device.queue.writeBuffer(this.bloomBlurDirXBuffer, 0, new Float32Array([1, 0, 0, 0]));
    this.device.queue.writeBuffer(this.bloomBlurDirYBuffer, 0, new Float32Array([0, 1, 0, 0]));
    this.setupBloomTextures();
  }
};
