import { PARTICLE_BYTES_PER_INSTANCE } from './device-geometry.js';

export class DevicePipelineManager {
  constructor(device, id, visualizer) {
    this.device = device;
    this.id = id;
    this.visualizer = visualizer;
    this.pipelines = new Map();
  }

  /**
   * createShaderModule + async compilation-info check. WGSL errors otherwise
   * fail silently (pipeline exists, draws produce nothing), which makes a
   * broken shared shader look like "device doesn't render".
   */
  _shaderModule(label, code) {
    const module = this.device.createShaderModule({ label, code });
    module.getCompilationInfo?.().then((info) => {
      const errors = info.messages.filter((m) => m.type === 'error');
      if (errors.length) {
        console.error(`[shader:${label}] ${errors.length} compile error(s):`);
        for (const m of errors) {
          console.error(`  ${label}:${m.lineNum}:${m.linePos} ${m.message}`);
        }
      }
    }).catch(() => {});
    return module;
  }

  async setupPipelines() {
    await this.setupComputePipeline();
    const depthFormat = this.visualizer.depthFormat || 'depth24plus-stencil8';
    // Roller pipeline
    this.rollerPipeline = this.device.createRenderPipeline({
      label: 'rollerPipeline',
      layout: 'auto',
      vertex: {
        module: this._shaderModule('roller-vert', this.visualizer.shaders.rollerVertShader),
        entryPoint: 'main',
        buffers: [{ arrayStride: 24, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }] }]
      },
      fragment: {
        module: this._shaderModule('roller-frag', this.visualizer.shaders.rollerFragShader),
        entryPoint: 'main',
        targets: [{ format: this.visualizer.context.getCurrentTexture().format, blend: { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: {} } }]
      },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: depthFormat, depthWriteEnabled: true, depthCompare: 'less' }
    });

    // Particle pipeline — vec4f storage records (xyz + phase) = PARTICLE_BYTES_PER_INSTANCE (16 B).
    // Positions are read in the vertex shader from @binding(4) storage, not vertex attribs.
    if (PARTICLE_BYTES_PER_INSTANCE !== 16) {
      throw new Error(
        `[DevicePipelineManager] Particle stride must be 16 bytes (vec4f); got ${PARTICLE_BYTES_PER_INSTANCE}`
      );
    }
    this.particlePipeline = this.device.createRenderPipeline({
      label: 'particlePipeline',
      layout: 'auto',
      vertex: {
        module: this._shaderModule('particle-vert', this.visualizer.shaders.particleVertShader),
        entryPoint: 'main',
        buffers: []
      },
      fragment: {
        module: this._shaderModule('particle-frag', this.visualizer.shaders.particleFragShader),
        entryPoint: 'main',
        targets: [{ format: this.visualizer.context.getCurrentTexture().format, blend: { color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' } } }]
      },
      primitive: { topology: 'triangle-strip' },
      depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: 'less' }
    });


    // RK4 flux segment billboard render pipeline (SEG only)
    // Reads FluxSegment data directly from storage buffer — no vertex buffer.
    // Uses additive (src-alpha, one) blending for a cumulative glow effect.
    if (this.id === 'seg') {
      this.fluxSegmentPipeline = this.device.createRenderPipeline({
        label: 'fluxSegmentPipeline',
        layout: 'auto',
        vertex: {
          module: this._shaderModule('flux-segment-vert', this.visualizer.shaders.fluxSegmentVertShader),
          entryPoint: 'main',
          buffers: []
        },
        fragment: {
          module: this._shaderModule('flux-segment-frag', this.visualizer.shaders.fluxSegmentFragShader),
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
        depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: 'less' }
      });
    }

    // Energy arc pipeline (SEG only)
    if (this.id === 'seg') {
      this.energyArcPipeline = this.device.createRenderPipeline({
        label: 'energyArcPipeline',
        layout: 'auto',
        vertex: {
          module: this._shaderModule('energy-arc-vert', this.visualizer.shaders.energyArcVertShader),
          entryPoint: 'main',
          buffers: [{ arrayStride: 32, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }, { shaderLocation: 2, offset: 24, format: 'float32' }, { shaderLocation: 3, offset: 28, format: 'float32' }] }]
        },
        fragment: {
          module: this._shaderModule('energy-arc-frag', this.visualizer.shaders.energyArcFragShader),
          entryPoint: 'main',
          targets: [{ format: this.visualizer.context.getCurrentTexture().format, blend: { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: {} } }]
        },
        primitive: { topology: 'line-list' },
        depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: 'less' }
      });
    }


    // Enhanced SEG pipeline with UV support and PBR (SEG only)
    if (this.id === 'seg') {
      this.segEnhancedPipeline = this.device.createRenderPipeline({
        label: 'segEnhancedPipeline',
        layout: 'auto',
        vertex: {
          module: this._shaderModule('seg-enhanced-vert', this.visualizer.shaders.segEnhancedVertShader),
          entryPoint: 'main',
          buffers: [{ arrayStride: 32, attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' },
            { shaderLocation: 1, offset: 12, format: 'float32x3' },
            { shaderLocation: 2, offset: 24, format: 'float32x2' }
          ] }]
        },
        fragment: {
          module: this._shaderModule('seg-enhanced-frag', this.visualizer.shaders.segEnhancedFragShader),
          entryPoint: 'main',
          targets: [{ format: this.visualizer.context.getCurrentTexture().format, blend: { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: {} } }]
        },
        primitive: { topology: 'triangle-list', cullMode: 'back' },
        depthStencil: { format: depthFormat, depthWriteEnabled: true, depthCompare: 'less' }
      });
    }

    // Device flow-path billboards (Heron siphon / Kelvin field / Solar photons)
    if (['heron', 'kelvin', 'solar'].includes(this.id)) {
      this.fieldLinePipeline = this.device.createRenderPipeline({
        label: `fieldLinePipeline-${this.id}`,
        layout: 'auto',
        vertex: {
          module: this._shaderModule('field-line-vert', this.visualizer.shaders.fieldLineVertShader),
          entryPoint: 'main',
          buffers: []
        },
        fragment: {
          module: this._shaderModule('field-line-frag', this.visualizer.shaders.fieldLineFragShader),
          entryPoint: 'main',
          targets: [{
            format: this.visualizer.context.getCurrentTexture().format,
            blend: {
              color: { srcFactor: 'src-alpha', dstFactor: 'one', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }
            }
          }]
        },
        primitive: { topology: 'triangle-strip' },
        depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: 'less' }
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
