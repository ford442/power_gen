/**
 * Explicit GPUBindGroupLayout / GPUPipelineLayout cache and shared pipeline factory.
 *
 * Binding numbers are documented in docs/BINDINGS.md — keep WGSL and this file aligned.
 *
 * Design:
 *  - One requestAdapter/device owns one PipelineLayoutCache (on MultiDeviceVisualizer).
 *  - DevicePipelineManager reuses shared pipelines (no per-device recompile).
 *  - Bind group creation sites use cache.getLayout(name), not pipeline.getBindGroupLayout().
 */

const VS = GPUShaderStage.VERTEX;
const FS = GPUShaderStage.FRAGMENT;
const CS = GPUShaderStage.COMPUTE;
const VF = VS | FS;

function uniform(binding, visibility) {
  return { binding, visibility, buffer: { type: 'uniform' } };
}

function storage(binding, visibility, readOnly = false) {
  return {
    binding,
    visibility,
    buffer: { type: readOnly ? 'read-only-storage' : 'storage' }
  };
}

function texture(binding, visibility, sampleType = 'float') {
  return { binding, visibility, texture: { sampleType, viewDimension: '2d' } };
}

function depthTexture(binding, visibility) {
  return {
    binding,
    visibility,
    texture: { sampleType: 'depth', viewDimension: '2d' }
  };
}

function sampler(binding, visibility) {
  return { binding, visibility, sampler: { type: 'filtering' } };
}

/** Vertex buffer: pos+normal float32x3×2 (24 B) — rollers, cylinders */
export const VB_POS_NORMAL = {
  arrayStride: 24,
  attributes: [
    { shaderLocation: 0, offset: 0, format: 'float32x3' },
    { shaderLocation: 1, offset: 12, format: 'float32x3' }
  ]
};

/** Vertex buffer: pos+normal+uv (32 B) — SEG enhanced meshes */
export const VB_POS_NORMAL_UV = {
  arrayStride: 32,
  attributes: [
    { shaderLocation: 0, offset: 0, format: 'float32x3' },
    { shaderLocation: 1, offset: 12, format: 'float32x3' },
    { shaderLocation: 2, offset: 24, format: 'float32x2' }
  ]
};

/** Energy arc line-list attributes (32 B) */
export const VB_ENERGY_ARC = {
  arrayStride: 32,
  attributes: [
    { shaderLocation: 0, offset: 0, format: 'float32x3' },
    { shaderLocation: 1, offset: 12, format: 'float32x3' },
    { shaderLocation: 2, offset: 24, format: 'float32' },
    { shaderLocation: 3, offset: 28, format: 'float32' }
  ]
};

/** Grid clip-space verts (8 B) */
export const VB_GRID = {
  arrayStride: 8,
  attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }]
};

const ALPHA_BLEND = {
  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }
};

const ADDITIVE_BLEND = {
  color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }
};

const ADDITIVE_SRC_ALPHA = {
  color: { srcFactor: 'src-alpha', dstFactor: 'one', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }
};

export class PipelineLayoutCache {
  /**
   * @param {GPUDevice} device
   * @param {{ canvasFormat: GPUTextureFormat, depthFormat: GPUTextureFormat }} formats
   */
  constructor(device, formats) {
    this.device = device;
    this.canvasFormat = formats.canvasFormat;
    this.depthFormat = formats.depthFormat;

    /** @type {Map<string, GPUBindGroupLayout>} */
    this.bindGroupLayouts = new Map();
    /** @type {Map<string, GPUPipelineLayout>} */
    this.pipelineLayouts = new Map();
    /** @type {Map<string, GPURenderPipeline | GPUComputePipeline>} */
    this.pipelines = new Map();
    /** @type {Map<string, GPUShaderModule>} */
    this.shaderModules = new Map();

    this.stats = {
      pipelineCreates: 0,
      pipelineCacheHits: 0,
      shaderModuleCreates: 0
    };

    this._buildLayouts();
  }

  // ── Layout construction ──────────────────────────────────────────

  _bgl(name, entries) {
    const layout = this.device.createBindGroupLayout({
      label: `bgl-${name}`,
      entries
    });
    this.bindGroupLayouts.set(name, layout);
    return layout;
  }

  _pl(name, bglNames) {
    const bindGroupLayouts = bglNames.map((n) => {
      const l = this.bindGroupLayouts.get(n);
      if (!l) throw new Error(`[PipelineLayoutCache] missing BGL "${n}" for pipeline layout "${name}"`);
      return l;
    });
    const layout = this.device.createPipelineLayout({
      label: `pl-${name}`,
      bindGroupLayouts
    });
    this.pipelineLayouts.set(name, layout);
    return layout;
  }

  _buildLayouts() {
    // Device mesh rollers (vert: 0,1,2 — frag: 0,1,3,5)
    this._bgl('roller', [
      uniform(0, VF),
      uniform(1, VF),
      storage(2, VS, true),
      uniform(3, FS),
      storage(5, FS, true)
    ]);
    this._pl('roller', ['roller']);

    // Particles billboards (vert: 0,1,4 — frag: 0,1,3)
    this._bgl('particle', [
      uniform(0, VF),
      uniform(1, VF),
      uniform(3, FS),
      storage(4, VS, true)
    ]);
    this._pl('particle', ['particle']);

    // SEG enhanced PBR (vert: 0,1,2,4 — frag: 0,1,3,5,6)
    this._bgl('segEnhanced', [
      uniform(0, VF),
      uniform(1, VF),
      storage(2, VS, true),
      uniform(3, FS),
      uniform(4, VS),
      uniform(5, FS),
      storage(6, FS, true)
    ]);
    this._pl('segEnhanced', ['segEnhanced']);

    // Flux segment billboards (0,1,2)
    this._bgl('fluxSegment', [
      uniform(0, VF),
      uniform(1, VF),
      storage(2, VS, true)
    ]);
    this._pl('fluxSegment', ['fluxSegment']);

    // Field-line / energy-arc particle-style (0,1,4)
    this._bgl('fieldParticles', [
      uniform(0, VF),
      uniform(1, VF),
      storage(4, VS, true)
    ]);
    this._pl('fieldParticles', ['fieldParticles']);

    // Energy pipe (0,1,2)
    this._bgl('energyPipe', [
      uniform(0, VF),
      uniform(1, VF),
      storage(2, VS, true)
    ]);
    this._pl('energyPipe', ['energyPipe']);

    // Coil mesh (vert: 0,1,2 — frag: 0,1,3)
    this._bgl('coil', [
      uniform(0, VF),
      uniform(1, VF),
      storage(2, VS, true),
      uniform(3, FS)
    ]);
    this._pl('coil', ['coil']);

    // Particle compute (0 storage rw, 1 uniform)
    this._bgl('particleCompute', [
      storage(0, CS, false),
      uniform(1, CS)
    ]);
    this._pl('particleCompute', ['particleCompute']);

    // SEG roller instance compute (0,1,2)
    this._bgl('rollerCompute', [
      storage(0, CS, false),
      uniform(1, CS),
      uniform(2, CS)
    ]);
    this._pl('rollerCompute', ['rollerCompute']);

    // Field advection compute (0,1)
    this._bgl('fieldAdvect', [
      storage(0, CS, false),
      uniform(1, CS)
    ]);
    this._pl('fieldAdvect', ['fieldAdvect']);

    // Flux line tracer (0 rw, 1 uniform, 2 storage read, 3 uniform)
    this._bgl('fluxTracer', [
      storage(0, CS, false),
      uniform(1, CS),
      storage(2, CS, true),
      uniform(3, CS)
    ]);
    this._pl('fluxTracer', ['fluxTracer']);

    // Sky gradient
    this._bgl('sky', [uniform(0, FS)]);
    this._pl('sky', ['sky']);

    // Grid (no bindings)
    this._bgl('empty', []);
    this._pl('empty', ['empty']);
    // Also a pipeline layout with zero bind groups for true empty shaders
    const emptyPl = this.device.createPipelineLayout({
      label: 'pl-empty-groups',
      bindGroupLayouts: []
    });
    this.pipelineLayouts.set('emptyGroups', emptyPl);

    // Anomaly walls (0,1)
    this._bgl('anomalyWall', [
      uniform(0, VF),
      uniform(1, FS)
    ]);
    this._pl('anomalyWall', ['anomalyWall']);

    // Bloom extract (0 tex, 1 sampler, 2 params)
    this._bgl('bloomExtract', [
      texture(0, FS),
      sampler(1, FS),
      uniform(2, FS)
    ]);
    this._pl('bloomExtract', ['bloomExtract']);

    // Bloom blur (+ direction uniform)
    this._bgl('bloomBlur', [
      texture(0, FS),
      sampler(1, FS),
      uniform(2, FS),
      uniform(3, FS)
    ]);
    this._pl('bloomBlur', ['bloomBlur']);

    // Bloom composite
    this._bgl('bloomComposite', [
      texture(0, FS),
      texture(1, FS),
      sampler(2, FS),
      uniform(3, FS),
      depthTexture(4, FS),
      texture(5, FS)
    ]);
    this._pl('bloomComposite', ['bloomComposite']);
  }

  getLayout(name) {
    const l = this.bindGroupLayouts.get(name);
    if (!l) throw new Error(`[PipelineLayoutCache] unknown bind group layout "${name}"`);
    return l;
  }

  getPipelineLayout(name) {
    const l = this.pipelineLayouts.get(name);
    if (!l) throw new Error(`[PipelineLayoutCache] unknown pipeline layout "${name}"`);
    return l;
  }

  /**
   * Create a bind group against a named layout.
   * @param {string} layoutName
   * @param {GPUBindGroupEntry[]} entries
   * @param {string} [label]
   */
  createBindGroup(layoutName, entries, label) {
    return this.device.createBindGroup({
      label: label || `bg-${layoutName}`,
      layout: this.getLayout(layoutName),
      entries
    });
  }

  shaderModule(label, code) {
    const key = label;
    if (this.shaderModules.has(key)) return this.shaderModules.get(key);
    const module = this.device.createShaderModule({ label, code });
    this.stats.shaderModuleCreates++;
    module.getCompilationInfo?.().then((info) => {
      const errors = info.messages.filter((m) => m.type === 'error');
      if (errors.length) {
        console.error(`[shader:${label}] ${errors.length} compile error(s):`);
        for (const m of errors) {
          console.error(`  ${label}:${m.lineNum}:${m.linePos} ${m.message}`);
        }
      }
    }).catch(() => {});
    this.shaderModules.set(key, module);
    return module;
  }

  _hash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0;
    }
    return hash.toString(36);
  }

  /**
   * @template T
   * @param {string} key
   * @param {() => T | Promise<T>} factory
   * @returns {Promise<T>}
   */
  async getOrCreatePipeline(key, factory) {
    if (this.pipelines.has(key)) {
      this.stats.pipelineCacheHits++;
      return this.pipelines.get(key);
    }
    const pipeline = await factory();
    this.pipelines.set(key, pipeline);
    this.stats.pipelineCreates++;
    return pipeline;
  }

  depthStencil(writeEnabled, compare = 'less') {
    return {
      format: this.depthFormat,
      depthWriteEnabled: writeEnabled,
      depthCompare: compare
    };
  }

  // ── Shared device pipelines (created once, reused by all DeviceInstances) ──

  /**
   * Ensure all multi-device device pipelines exist. Call once after shaders are ready.
   * @param {import('./multi-device-shaders.js').MultiDeviceShaders} shaders
   */
  async ensureDevicePipelines(shaders) {
    const fmt = this.canvasFormat;
    const depthWrite = this.depthStencil(true, 'less');
    const depthRead = this.depthStencil(false, 'less');

    await this.getOrCreatePipeline('roller', () =>
      this.device.createRenderPipeline({
        label: 'rollerPipeline',
        layout: this.getPipelineLayout('roller'),
        vertex: {
          module: this.shaderModule('roller-vert', shaders.rollerVertShader),
          entryPoint: 'main',
          buffers: [VB_POS_NORMAL]
        },
        fragment: {
          module: this.shaderModule('roller-frag', shaders.rollerFragShader),
          entryPoint: 'main',
          targets: [{ format: fmt, blend: ALPHA_BLEND }]
        },
        primitive: { topology: 'triangle-list' },
        depthStencil: depthWrite
      })
    );

    await this.getOrCreatePipeline('particle', () =>
      this.device.createRenderPipeline({
        label: 'particlePipeline',
        layout: this.getPipelineLayout('particle'),
        vertex: {
          module: this.shaderModule('particle-vert', shaders.particleVertShader),
          entryPoint: 'main',
          buffers: []
        },
        fragment: {
          module: this.shaderModule('particle-frag', shaders.particleFragShader),
          entryPoint: 'main',
          targets: [{ format: fmt, blend: ADDITIVE_BLEND }]
        },
        primitive: { topology: 'triangle-strip' },
        depthStencil: depthRead
      })
    );

    await this.getOrCreatePipeline('segEnhanced', () =>
      this.device.createRenderPipeline({
        label: 'segEnhancedPipeline',
        layout: this.getPipelineLayout('segEnhanced'),
        vertex: {
          module: this.shaderModule('seg-enhanced-vert', shaders.segEnhancedVertShader),
          entryPoint: 'main',
          buffers: [VB_POS_NORMAL_UV]
        },
        fragment: {
          module: this.shaderModule('seg-enhanced-frag', shaders.segEnhancedFragShader),
          entryPoint: 'main',
          targets: [{ format: fmt, blend: ALPHA_BLEND }]
        },
        primitive: { topology: 'triangle-list', cullMode: 'back' },
        depthStencil: depthWrite
      })
    );

    await this.getOrCreatePipeline('fluxSegment', () =>
      this.device.createRenderPipeline({
        label: 'fluxSegmentPipeline',
        layout: this.getPipelineLayout('fluxSegment'),
        vertex: {
          module: this.shaderModule('flux-segment-vert', shaders.fluxSegmentVertShader),
          entryPoint: 'main',
          buffers: []
        },
        fragment: {
          module: this.shaderModule('flux-segment-frag', shaders.fluxSegmentFragShader),
          entryPoint: 'main',
          targets: [{ format: fmt, blend: ADDITIVE_SRC_ALPHA }]
        },
        primitive: { topology: 'triangle-strip' },
        depthStencil: depthRead
      })
    );

    await this.getOrCreatePipeline('energyArc', () =>
      this.device.createRenderPipeline({
        label: 'energyArcPipeline',
        layout: this.getPipelineLayout('fieldParticles'),
        vertex: {
          module: this.shaderModule('energy-arc-vert', shaders.energyArcVertShader),
          entryPoint: 'main',
          buffers: [VB_ENERGY_ARC]
        },
        fragment: {
          module: this.shaderModule('energy-arc-frag', shaders.energyArcFragShader),
          entryPoint: 'main',
          targets: [{ format: fmt, blend: ALPHA_BLEND }]
        },
        primitive: { topology: 'line-list' },
        depthStencil: depthRead
      })
    );

    await this.getOrCreatePipeline('fieldLine', () =>
      this.device.createRenderPipeline({
        label: 'fieldLinePipeline',
        layout: this.getPipelineLayout('fieldParticles'),
        vertex: {
          module: this.shaderModule('field-line-vert', shaders.fieldLineVertShader),
          entryPoint: 'main',
          buffers: []
        },
        fragment: {
          module: this.shaderModule('field-line-frag', shaders.fieldLineFragShader),
          entryPoint: 'main',
          targets: [{ format: fmt, blend: ADDITIVE_SRC_ALPHA }]
        },
        primitive: { topology: 'triangle-strip' },
        depthStencil: depthRead
      })
    );

    // Shared particle compute (same shader for all devices)
    const computeCode = shaders.computeShader;
    const computeKey = `particleCompute_${this._hash(computeCode)}`;
    await this.getOrCreatePipeline(computeKey, async () => {
      const module = this.shaderModule('compute-particle-module', computeCode);
      return this.device.createComputePipelineAsync({
        label: 'compute-particle-pipeline',
        layout: this.getPipelineLayout('particleCompute'),
        compute: { module, entryPoint: 'main' }
      });
    });
    // Alias stable key for lookup
    if (!this.pipelines.has('particleCompute')) {
      this.pipelines.set('particleCompute', this.pipelines.get(computeKey));
    }

    // Optional coil pipeline (shaders may exist)
    if (shaders.coilVertShader && shaders.coilFragShader) {
      await this.getOrCreatePipeline('coil', () =>
        this.device.createRenderPipeline({
          label: 'coilPipeline',
          layout: this.getPipelineLayout('coil'),
          vertex: {
            module: this.shaderModule('coil-vert', shaders.coilVertShader),
            entryPoint: 'main',
            buffers: [VB_POS_NORMAL]
          },
          fragment: {
            module: this.shaderModule('coil-frag', shaders.coilFragShader),
            entryPoint: 'main',
            targets: [{ format: fmt, blend: ALPHA_BLEND }]
          },
          primitive: { topology: 'triangle-list' },
          depthStencil: depthWrite
        })
      );
    }

    console.log(
      `[PipelineLayoutCache] device pipelines ready: creates=${this.stats.pipelineCreates} ` +
      `hits=${this.stats.pipelineCacheHits} shaderModules=${this.stats.shaderModuleCreates}`
    );
  }

  getPipeline(key) {
    return this.pipelines.get(key) || null;
  }

  getParticleComputePipeline() {
    return this.pipelines.get('particleCompute') || null;
  }

  // ── Scene-level pipelines (multi-device visualizer) ──

  async ensureEnergyPipePipeline(shaders) {
    return this.getOrCreatePipeline('energyPipe', () =>
      this.device.createRenderPipeline({
        label: 'energyPipePipeline',
        layout: this.getPipelineLayout('energyPipe'),
        vertex: {
          module: this.shaderModule('energy-pipe-vert', shaders.energyPipeVertShader),
          entryPoint: 'main',
          buffers: []
        },
        fragment: {
          module: this.shaderModule('energy-pipe-frag', shaders.energyPipeFragShader),
          entryPoint: 'main',
          targets: [{
            format: this.canvasFormat,
            blend: ADDITIVE_SRC_ALPHA
          }]
        },
        primitive: { topology: 'triangle-strip' },
        depthStencil: this.depthStencil(false, 'less')
      })
    );
  }

  async ensureSkyPipeline(shaders) {
    return this.getOrCreatePipeline('sky', () =>
      this.device.createRenderPipeline({
        label: 'skyPipeline',
        layout: this.getPipelineLayout('sky'),
        vertex: {
          module: this.shaderModule('sky-vert', shaders.skyVertShader),
          entryPoint: 'main'
        },
        fragment: {
          module: this.shaderModule('sky-frag', shaders.skyFragShader),
          entryPoint: 'main',
          targets: [{ format: this.canvasFormat }]
        },
        primitive: { topology: 'triangle-list' },
        depthStencil: this.depthStencil(false, 'always')
      })
    );
  }

  async ensureGridPipeline(shaders) {
    return this.getOrCreatePipeline('grid', () =>
      this.device.createRenderPipeline({
        label: 'gridPipeline',
        layout: this.getPipelineLayout('empty'),
        vertex: {
          module: this.shaderModule('grid-vert', shaders.gridVertShader),
          entryPoint: 'main',
          buffers: [VB_GRID]
        },
        fragment: {
          module: this.shaderModule('grid-frag', shaders.gridFragShader),
          entryPoint: 'main',
          targets: [{ format: this.canvasFormat, blend: ALPHA_BLEND }]
        },
        primitive: { topology: 'triangle-list' },
        depthStencil: this.depthStencil(false, 'less')
      })
    );
  }

  async ensureAnomalyWallPipeline(shaders) {
    const code = shaders.anomalyWallsShader;
    return this.getOrCreatePipeline('anomalyWall', () =>
      this.device.createRenderPipeline({
        label: 'anomalyWallPipeline',
        layout: this.getPipelineLayout('anomalyWall'),
        vertex: {
          module: this.shaderModule('anomaly-walls', code),
          entryPoint: 'vsMain',
          buffers: [VB_POS_NORMAL_UV]
        },
        fragment: {
          module: this.shaderModule('anomaly-walls', code),
          entryPoint: 'fsMain',
          targets: [{
            format: this.canvasFormat,
            blend: ALPHA_BLEND
          }]
        },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: this.depthStencil(false, 'less')
      })
    );
  }

  async ensureBloomPipelines(shaders) {
    const fmt = this.canvasFormat;
    const vertModule = this.shaderModule('bloom-vert', shaders.bloomVertShader);

    await this.getOrCreatePipeline('bloomExtract', () =>
      this.device.createRenderPipeline({
        label: 'bloomExtract',
        layout: this.getPipelineLayout('bloomExtract'),
        vertex: { module: vertModule, entryPoint: 'main' },
        fragment: {
          module: this.shaderModule('bloom-extract', shaders.bloomExtractShader),
          entryPoint: 'main',
          targets: [{ format: fmt }]
        },
        primitive: { topology: 'triangle-list' }
      })
    );

    await this.getOrCreatePipeline('bloomBlur', () =>
      this.device.createRenderPipeline({
        label: 'bloomBlur',
        layout: this.getPipelineLayout('bloomBlur'),
        vertex: { module: vertModule, entryPoint: 'main' },
        fragment: {
          module: this.shaderModule('bloom-blur', shaders.bloomBlurShader),
          entryPoint: 'main',
          targets: [{ format: fmt }]
        },
        primitive: { topology: 'triangle-list' }
      })
    );

    await this.getOrCreatePipeline('bloomComposite', () =>
      this.device.createRenderPipeline({
        label: 'bloomComposite',
        layout: this.getPipelineLayout('bloomComposite'),
        vertex: { module: vertModule, entryPoint: 'main' },
        fragment: {
          module: this.shaderModule('bloom-composite', shaders.bloomCompositeShader),
          entryPoint: 'main',
          targets: [{ format: fmt }]
        },
        primitive: { topology: 'triangle-list' }
      })
    );
  }

  // ── SEG-only compute helpers ──

  async ensureRollerComputePipeline(code) {
    return this.getOrCreatePipeline(`rollerCompute_${this._hash(code)}`, async () => {
      const module = this.shaderModule('seg-roller-compute-module', code);
      const p = await this.device.createComputePipelineAsync({
        label: 'seg-roller-compute-pipeline',
        layout: this.getPipelineLayout('rollerCompute'),
        compute: { module, entryPoint: 'main' }
      });
      this.pipelines.set('rollerCompute', p);
      return p;
    });
  }

  async ensureFieldAdvectPipeline(code) {
    return this.getOrCreatePipeline(`fieldAdvect_${this._hash(code)}`, async () => {
      const module = this.shaderModule('seg-field-advect-module', code);
      const p = await this.device.createComputePipelineAsync({
        label: 'seg-field-advect-pipeline',
        layout: this.getPipelineLayout('fieldAdvect'),
        compute: { module, entryPoint: 'main' }
      });
      this.pipelines.set('fieldAdvect', p);
      return p;
    });
  }

  async ensureFluxTracerPipeline(code) {
    return this.getOrCreatePipeline(`fluxTracer_${this._hash(code)}`, async () => {
      const module = this.shaderModule('flux-tracer-module', code);
      const p = await this.device.createComputePipelineAsync({
        label: 'flux-tracer-pipeline',
        layout: this.getPipelineLayout('fluxTracer'),
        compute: { module, entryPoint: 'traceBidirectional' }
      });
      this.pipelines.set('fluxTracer', p);
      return p;
    });
  }
}
