export class DevicePipelineManager {
  constructor(device, id, visualizer) {
    this.device = device;
    this.id = id;
    this.visualizer = visualizer;
    this.pipelines = new Map();
  }

  async setupPipelines() {
    await this.setupComputePipeline();
    // Roller pipeline
    this.rollerPipeline = this.device.createRenderPipeline({
      label: 'rollerPipeline',
      layout: 'auto',
      vertex: {
        module: this.device.createShaderModule({ code: this.visualizer.rollerVertShader }),
        entryPoint: 'main',
        buffers: [{ arrayStride: 24, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }] }]
      },
      fragment: {
        module: this.device.createShaderModule({ code: this.visualizer.rollerFragShader }),
        entryPoint: 'main',
        targets: [{ format: this.visualizer.context.getCurrentTexture().format, blend: { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: {} } }]
      },
      primitive: { topology: 'triangle-list' },
      depthStencil: { depthWriteEnabled: true, depthCompare: 'less' }
    });

    // Particle pipeline
    this.particlePipeline = this.device.createRenderPipeline({
      label: 'particlePipeline',
      layout: 'auto',
      vertex: {
        module: this.device.createShaderModule({ code: this.visualizer.particleVertShader }),
        entryPoint: 'main',
        buffers: [{ arrayStride: 16, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32' }] }]
      },
      fragment: {
        module: this.device.createShaderModule({ code: this.visualizer.particleFragShader }),
        entryPoint: 'main',
        targets: [{ format: this.visualizer.context.getCurrentTexture().format, blend: { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: {} } }]
      },
      primitive: { topology: 'triangle-strip' },
      depthStencil: { depthWriteEnabled: false, depthCompare: 'less' }
    });

    // Core pipeline (SEG only)
    if (this.id === 'seg') {
      this.corePipeline = this.device.createRenderPipeline({
        label: 'corePipeline',
        layout: 'auto',
        vertex: {
          module: this.device.createShaderModule({ code: this.visualizer.coreVertShader }),
          entryPoint: 'main',
          buffers: [{ arrayStride: 24, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }] }]
        },
        fragment: {
          module: this.device.createShaderModule({ code: this.visualizer.coreFragShader }),
          entryPoint: 'main',
          targets: [{ format: this.visualizer.context.getCurrentTexture().format }]
        },
        primitive: { topology: 'triangle-list' },
        depthStencil: { depthWriteEnabled: true, depthCompare: 'less' }
      });
    }

    // Field line pipeline (SEG only)
    if (this.id === 'seg') {
      this.fieldLinePipeline = this.device.createRenderPipeline({
        label: 'fieldLinePipeline',
        layout: 'auto',
        vertex: {
          module: this.device.createShaderModule({ code: this.visualizer.fieldLineVertShader }),
          entryPoint: 'main',
          buffers: [{ arrayStride: 32, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }, { shaderLocation: 2, offset: 24, format: 'float32' }, { shaderLocation: 3, offset: 28, format: 'float32' }] }]
        },
        fragment: {
          module: this.device.createShaderModule({ code: this.visualizer.fieldLineFragShader }),
          entryPoint: 'main',
          targets: [{ format: this.visualizer.context.getCurrentTexture().format, blend: { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: {} } }]
        },
        primitive: { topology: 'line-list' },
        depthStencil: { depthWriteEnabled: false, depthCompare: 'less' }
      });
    }

    // Energy arc pipeline (SEG only)
    if (this.id === 'seg') {
      this.energyArcPipeline = this.device.createRenderPipeline({
        label: 'energyArcPipeline',
        layout: 'auto',
        vertex: {
          module: this.device.createShaderModule({ code: this.visualizer.energyArcVertShader }),
          entryPoint: 'main',
          buffers: [{ arrayStride: 32, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }, { shaderLocation: 2, offset: 24, format: 'float32' }, { shaderLocation: 3, offset: 28, format: 'float32' }] }]
        },
        fragment: {
          module: this.device.createShaderModule({ code: this.visualizer.energyArcFragShader }),
          entryPoint: 'main',
          targets: [{ format: this.visualizer.context.getCurrentTexture().format, blend: { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: {} } }]
        },
        primitive: { topology: 'line-list' },
        depthStencil: { depthWriteEnabled: false, depthCompare: 'less' }
      });
    }

    // Electromagnet coil pipeline (SEG only)
    if (this.id === 'seg') {
      this.coilPipeline = this.device.createRenderPipeline({
        label: 'coilPipeline',
        layout: 'auto',
        vertex: {
          module: this.device.createShaderModule({ code: this.visualizer.coilVertShader }),
          entryPoint: 'main',
          buffers: [{ arrayStride: 24, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }] }]
        },
        fragment: {
          module: this.device.createShaderModule({ code: this.visualizer.coilFragShader }),
          entryPoint: 'main',
          targets: [{ format: this.visualizer.context.getCurrentTexture().format, blend: { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: {} } }]
        },
        primitive: { topology: 'triangle-list' },
        depthStencil: { depthWriteEnabled: true, depthCompare: 'less' }
      });
    }
  }

  async setupComputePipeline() {
    const computeShader = this.visualizer.computeShader;
    const cacheKey = `compute_${this.hashString(computeShader)}`;
    if (this.pipelines.has(cacheKey)) {
      this.computePipeline = this.pipelines.get(cacheKey);
      return;
    }

    const shaderModule = this.device.createShaderModule({
      label: 'compute-particle-module',
      code: computeShader
    });

    this.computePipeline = await this.device.createComputePipelineAsync({
      label: 'compute-particle-pipeline',
      layout: 'auto',
      compute: {
        module: shaderModule,
        entryPoint: 'main'
      }
    });

    this.pipelines.set(cacheKey, this.computePipeline);
  }

  hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return hash.toString(36);
  }
}