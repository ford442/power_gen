export const DeviceSetupMixin = {
  setupRollerCompute: async function () {
    this.rollerComputeUniformBuffer = this.device.createBuffer({
      label: 'seg-roller-compute-uniforms',
      size: 16,  // [time f32, speedMult f32, pad f32, pad f32]
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

    const cache = this.visualizer.pipelineCache;
    const code = this.visualizer.shaders.segRollerComputeShader;
    this.rollerComputePipeline = await cache.ensureRollerComputePipeline(code);

    this.rollerComputeBindGroup = cache.createBindGroup(
      'rollerCompute',
      [
        { binding: 0, resource: { buffer: this.geometry.rollerInstances } },
        { binding: 1, resource: { buffer: this.rollerComputeUniformBuffer } },
        { binding: 2, resource: { buffer: this.visualizer.segLayoutUniformBuffer } }
      ],
      'seg-roller-compute-bg'
    );
  },

  setupFieldAdvect: async function () {
    this.fieldAdvectUniformBuffer = this.device.createBuffer({
      label: 'seg-field-advect-uniforms',
      size: 16,  // [time f32, speedMult f32, particleCount u32, pad f32]
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

    const cache = this.visualizer.pipelineCache;
    const code = this.visualizer.shaders.segFieldAdvectShader;
    this.fieldAdvectPipeline = await cache.ensureFieldAdvectPipeline(code);

    this.fieldAdvectBindGroup = cache.createBindGroup(
      'fieldAdvect',
      [
        { binding: 0, resource: { buffer: this.geometry.fieldLineParticles } },
        { binding: 1, resource: { buffer: this.fieldAdvectUniformBuffer } }
      ],
      'seg-field-advect-bg'
    );
  },

  setupFluxLineTracer: async function () {
    // FluxUniforms: time, deltaTime, integrationStep, lineOpacity, seedRadius, followStrength, _pad
    // = 7 × f32 = 28 bytes, aligned to 32 bytes
    this.fluxTracerUniformBuffer = this.device.createBuffer({
      label: 'flux-tracer-uniforms',
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

    // Per-coil boost data (binding 2). 24 pickup coils max, 16 B each
    this.fluxCoilBoostBuffer = this.device.createBuffer({
      label: 'flux-coil-boost',
      size: 24 * 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });

    const cache = this.visualizer.pipelineCache;
    const code = this.visualizer.shaders.fluxLineTracerShader;
    this.fluxTracerPipeline = await cache.ensureFluxTracerPipeline(code);

    this.fluxTracerBindGroup = cache.createBindGroup(
      'fluxTracer',
      [
        { binding: 0, resource: { buffer: this.geometry.fluxSegmentBuffer } },
        { binding: 1, resource: { buffer: this.fluxTracerUniformBuffer } },
        { binding: 2, resource: { buffer: this.fluxCoilBoostBuffer } },
        { binding: 3, resource: { buffer: this.visualizer.segLayoutUniformBuffer } }
      ],
      'flux-tracer-bg'
    );

    // Pre-create the render bind group so render() can reuse it every frame.
    this.fluxSegmentRenderBindGroup = cache.createBindGroup(
      'fluxSegment',
      [
        { binding: 0, resource: { buffer: this.visualizer.globalUniformBuffer } },
        { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
        { binding: 2, resource: { buffer: this.geometry.fluxSegmentBuffer } }
      ],
      'flux-segment-render-bg'
    );
  },

  setupEffectsParticles: function () {
    this.effectsParticles = this.device.createBuffer({
      size: this.maxEffectParticles * 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    this.visualizer.profiler.trackBuffer(
      `device-${this.id}-effects-particles`,
      this.maxEffectParticles * 16,
      GPUBufferUsage.STORAGE
    );
  },

};
