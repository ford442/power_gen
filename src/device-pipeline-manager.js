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
        module: this.device.createShaderModule({ code: this.visualizer.shaders.rollerVertShader }),
        entryPoint: 'main',
        buffers: [{ arrayStride: 24, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }] }]
      },
      fragment: {
        module: this.device.createShaderModule({ code: this.visualizer.shaders.rollerFragShader }),
        entryPoint: 'main',
        targets: [{ format: this.visualizer.context.getCurrentTexture().format, blend: { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: {} } }]
      },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: 'depth24plus-stencil8', depthWriteEnabled: true, depthCompare: 'less' }
    });

    // Particle pipeline
    this.particlePipeline = this.device.createRenderPipeline({
      label: 'particlePipeline',
      layout: 'auto',
      vertex: {
        module: this.device.createShaderModule({ code: this.visualizer.shaders.particleVertShader }),
        entryPoint: 'main',
        buffers: []
      },
      fragment: {
        module: this.device.createShaderModule({ code: this.visualizer.shaders.particleFragShader }),
        entryPoint: 'main',
        targets: [{ format: this.visualizer.context.getCurrentTexture().format, blend: { color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' } } }]
      },
      primitive: { topology: 'triangle-strip' },
      depthStencil: { format: 'depth24plus-stencil8', depthWriteEnabled: false, depthCompare: 'less' }
    });

    // Core pipeline (SEG only)
    if (this.id === 'seg') {
      this.corePipeline = this.device.createRenderPipeline({
        label: 'corePipeline',
        layout: 'auto',
        vertex: {
          module: this.device.createShaderModule({ code: this.visualizer.shaders.coreVertShader }),
          entryPoint: 'main',
          buffers: [{ arrayStride: 24, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }] }]
        },
        fragment: {
          module: this.device.createShaderModule({ code: this.visualizer.shaders.coreFragShader }),
          entryPoint: 'main',
          targets: [{ format: this.visualizer.context.getCurrentTexture().format }]
        },
        primitive: { topology: 'triangle-list' },
        depthStencil: { format: 'depth24plus-stencil8', depthWriteEnabled: true, depthCompare: 'less' }
      });
    }

    // Field line pipeline (SEG only)
    if (this.id === 'seg') {
      this.fieldLinePipeline = this.device.createRenderPipeline({
        label: 'fieldLinePipeline',
        layout: 'auto',
        vertex: {
          module: this.device.createShaderModule({ code: this.visualizer.shaders.fieldLineVertShader }),
          entryPoint: 'main',
          buffers: [{ arrayStride: 32, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }, { shaderLocation: 2, offset: 24, format: 'float32' }, { shaderLocation: 3, offset: 28, format: 'float32' }] }]
        },
        fragment: {
          module: this.device.createShaderModule({ code: this.visualizer.shaders.fieldLineFragShader }),
          entryPoint: 'main',
          targets: [{ format: this.visualizer.context.getCurrentTexture().format, blend: { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: {} } }]
        },
        primitive: { topology: 'line-list' },
        depthStencil: { format: 'depth24plus-stencil8', depthWriteEnabled: false, depthCompare: 'less' }
      });
    }

    // RK4 flux segment billboard render pipeline (SEG only)
    // Reads FluxSegment data directly from storage buffer — no vertex buffer.
    // Uses additive (src-alpha, one) blending for a cumulative glow effect.
    if (this.id === 'seg') {
      this.fluxSegmentPipeline = this.device.createRenderPipeline({
        label: 'fluxSegmentPipeline',
        layout: 'auto',
        vertex: {
          module: this.device.createShaderModule({ code: this.visualizer.shaders.fluxSegmentVertShader }),
          entryPoint: 'main',
          buffers: []
        },
        fragment: {
          module: this.device.createShaderModule({ code: this.visualizer.shaders.fluxSegmentFragShader }),
          entryPoint: 'main',
          targets: [{
            format: this.visualizer.context.getCurrentTexture().format,
            blend: {
              color: { srcFactor: 'src-alpha', dstFactor: 'one', operation: 'add' },
              alpha: { srcFactor: 'one',       dstFactor: 'one', operation: 'add' }
            }
          }]
        },
        primitive: { topology: 'triangle-strip' },
        depthStencil: { format: 'depth24plus-stencil8', depthWriteEnabled: false, depthCompare: 'less' }
      });
    }

    // Energy arc pipeline (SEG only)
    if (this.id === 'seg') {
      this.energyArcPipeline = this.device.createRenderPipeline({
        label: 'energyArcPipeline',
        layout: 'auto',
        vertex: {
          module: this.device.createShaderModule({ code: this.visualizer.shaders.energyArcVertShader }),
          entryPoint: 'main',
          buffers: [{ arrayStride: 32, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }, { shaderLocation: 2, offset: 24, format: 'float32' }, { shaderLocation: 3, offset: 28, format: 'float32' }] }]
        },
        fragment: {
          module: this.device.createShaderModule({ code: this.visualizer.shaders.energyArcFragShader }),
          entryPoint: 'main',
          targets: [{ format: this.visualizer.context.getCurrentTexture().format, blend: { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: {} } }]
        },
        primitive: { topology: 'line-list' },
        depthStencil: { format: 'depth24plus-stencil8', depthWriteEnabled: false, depthCompare: 'less' }
      });
    }

    // Electromagnet coil pipeline (SEG only)
    if (this.id === 'seg') {
      this.coilPipeline = this.device.createRenderPipeline({
        label: 'coilPipeline',
        layout: 'auto',
        vertex: {
          module: this.device.createShaderModule({ code: this.visualizer.shaders.coilVertShader }),
          entryPoint: 'main',
          buffers: [{ arrayStride: 24, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }] }]
        },
        fragment: {
          module: this.device.createShaderModule({ code: this.visualizer.shaders.coilFragShader }),
          entryPoint: 'main',
          targets: [{ format: this.visualizer.context.getCurrentTexture().format, blend: { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: {} } }]
        },
        primitive: { topology: 'triangle-list' },
        depthStencil: { format: 'depth24plus-stencil8', depthWriteEnabled: true, depthCompare: 'less' }
      });
    }

    // Enhanced SEG pipeline with UV support and PBR (SEG only)
    if (this.id === 'seg') {
      this.segEnhancedPipeline = this.device.createRenderPipeline({
        label: 'segEnhancedPipeline',
        layout: 'auto',
        vertex: {
          module: this.device.createShaderModule({ code: this.visualizer.shaders.segEnhancedVertShader }),
          entryPoint: 'main',
          buffers: [{ arrayStride: 32, attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' },
            { shaderLocation: 1, offset: 12, format: 'float32x3' },
            { shaderLocation: 2, offset: 24, format: 'float32x2' }
          ] }]
        },
        fragment: {
          module: this.device.createShaderModule({ code: this.visualizer.shaders.segEnhancedFragShader }),
          entryPoint: 'main',
          targets: [{ format: this.visualizer.context.getCurrentTexture().format, blend: { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: {} } }]
        },
        primitive: { topology: 'triangle-list', cullMode: 'back' },
        depthStencil: { format: 'depth24plus-stencil8', depthWriteEnabled: true, depthCompare: 'less' }
      });
    }

    // Ring pipeline for connection rings (SEG only)
    if (this.id === 'seg') {
      this.ringPipeline = this.device.createRenderPipeline({
        label: 'ringPipeline',
        layout: 'auto',
        vertex: {
          module: this.device.createShaderModule({ code: this.visualizer.shaders.coreVertShader }),
          entryPoint: 'main',
          buffers: [{ arrayStride: 24, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }] }]
        },
        fragment: {
          module: this.device.createShaderModule({ code: this.visualizer.shaders.coreFragShader }),
          entryPoint: 'main',
          targets: [{ format: this.visualizer.context.getCurrentTexture().format }]
        },
        primitive: { topology: 'triangle-list' },
        depthStencil: { format: 'depth24plus-stencil8', depthWriteEnabled: true, depthCompare: 'less' }
      });
    }
  }

  async setupComputePipeline() {
    const computeShader = this.visualizer.shaders.computeShader;
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