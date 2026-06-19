export const DeviceSetupMixin = {
  setupRollerCompute: async function () {
    this.rollerComputeUniformBuffer = this.device.createBuffer({
      label: 'seg-roller-compute-uniforms',
      size: 16,  // [time f32, speedMult f32, pad f32, pad f32]
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

    const module = this.device.createShaderModule({
      label: 'seg-roller-compute-module',
      code: this.visualizer.shaders.segRollerComputeShader
    });

    this.rollerComputePipeline = await this.device.createComputePipelineAsync({
      label: 'seg-roller-compute-pipeline',
      layout: 'auto',
      compute: { module, entryPoint: 'main' }
    });

    this.rollerComputeBindGroup = this.device.createBindGroup({
      label: 'seg-roller-compute-bg',
      layout: this.rollerComputePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.geometry.rollerInstances } },
        { binding: 1, resource: { buffer: this.rollerComputeUniformBuffer } }
      ]
    });
  },

  setupFieldAdvect: async function () {
    this.fieldAdvectUniformBuffer = this.device.createBuffer({
      label: 'seg-field-advect-uniforms',
      size: 16,  // [time f32, speedMult f32, particleCount u32, pad f32]
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

    const module = this.device.createShaderModule({
      label: 'seg-field-advect-module',
      code: this.visualizer.shaders.segFieldAdvectShader
    });

    this.fieldAdvectPipeline = await this.device.createComputePipelineAsync({
      label: 'seg-field-advect-pipeline',
      layout: 'auto',
      compute: { module, entryPoint: 'main' }
    });

    this.fieldAdvectBindGroup = this.device.createBindGroup({
      label: 'seg-field-advect-bg',
      layout: this.fieldAdvectPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.geometry.fieldLineParticles } },
        { binding: 1, resource: { buffer: this.fieldAdvectUniformBuffer } }
      ]
    });
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
    // (vec3f pos + f32 energy). Currently coilBoostCount is held at 0 in the
    // uniform write, so the shader's boost loop is inert — but the binding must
    // still exist because the 'auto' pipeline layout derives all 4 bindings
    // declared by traceBidirectional (segments, uniforms, coilBoost, segLayout).
    this.fluxCoilBoostBuffer = this.device.createBuffer({
      label: 'flux-coil-boost',
      size: 24 * 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });

    const module = this.device.createShaderModule({
      label: 'flux-tracer-module',
      code: this.visualizer.shaders.fluxLineTracerShader
    });

    this.fluxTracerPipeline = await this.device.createComputePipelineAsync({
      label: 'flux-tracer-pipeline',
      layout: 'auto',
      compute: { module, entryPoint: 'traceBidirectional' }
    });

    this.fluxTracerBindGroup = this.device.createBindGroup({
      label: 'flux-tracer-bg',
      layout: this.fluxTracerPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.geometry.fluxSegmentBuffer } },
        { binding: 1, resource: { buffer: this.fluxTracerUniformBuffer } },
        { binding: 2, resource: { buffer: this.fluxCoilBoostBuffer } },
        { binding: 3, resource: { buffer: this.visualizer.segLayoutUniformBuffer } }
      ]
    });

    // Pre-create the render bind group so render() can reuse it every frame.
    // globalUniformBuffer and deviceUniformBuffer never change buffer identity
    // (only their contents are updated via writeBuffer), so this is safe.
    this.fluxSegmentRenderBindGroup = this.device.createBindGroup({
      label: 'flux-segment-render-bg',
      layout: this.pipelineManager.fluxSegmentPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.visualizer.globalUniformBuffer } },
        { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
        { binding: 2, resource: { buffer: this.geometry.fluxSegmentBuffer } }
      ]
    });
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
