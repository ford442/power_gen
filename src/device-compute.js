/**
 * DeviceComputeManager - Manages compute pipeline setup and execution for device instances
 * Handles: compute pipeline, compute bind groups, compute uniforms
 */
class DeviceComputeManager {
  constructor(device, id, config, pipelineManager, geometry) {
    this.device = device;
    this.id = id;
    this.config = config;
    this.pipelineManager = pipelineManager;
    this.geometry = geometry;

    // Compute pipeline resources
    this.computePipeline = null;
    this.computeBindGroup = null;
    this.computeUniformBuffer = null;
    this.scaledParticleCount = 0;
    this.speedMult = 1.0;
  }

  async setupComputeResources() {
    this.computePipeline = this.pipelineManager.computePipeline;
    if (!this.computePipeline) return;

    // Compute uniform buffer: time, mode, particleCount, speedMult (16 bytes)
    this.computeUniformBuffer = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

    // Track buffer for profiling if visualizer is available (optional)
    if (this.pipelineManager.visualizer && this.pipelineManager.visualizer.profiler) {
      this.pipelineManager.visualizer.profiler.trackBuffer(`device-${this.id}-compute-uniforms`, 16, GPUBufferUsage.UNIFORM);
    }

    // Compute bind group: binding 0 = particles storage, binding 1 = uniforms
    this.computeBindGroup = this.device.createBindGroup({
      layout: this.computePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.geometry.particles } },
        { binding: 1, resource: { buffer: this.computeUniformBuffer } }
      ]
    });
  }

  updateComputeUniforms(time, mode, particleCount, speedMult = 1.0) {
    if (!this.computeUniformBuffer) return;

    this.scaledParticleCount = particleCount;
    this.speedMult = speedMult;

    // Pack into 16 bytes: time (f32), mode (u32), particleCount (u32), speedMult (f32)
    const computeData = new Float32Array(4);
    computeData[0] = time;
    
    // Encode mode and particleCount as floats that will be reinterpreted
    const modeView = new Uint32Array(computeData.buffer, 4, 1);
    const countView = new Uint32Array(computeData.buffer, 8, 1);
    modeView[0] = mode;
    countView[0] = particleCount;
    
    computeData[3] = speedMult;

    this.device.queue.writeBuffer(this.computeUniformBuffer, 0, computeData);
  }

  /**
   * Dispatch compute shader with given dispatch dimensions
   * @param {GPUComputePassEncoder} computePass - The compute pass encoder
   * @param {number} workgroupCountX - Number of workgroups in X dimension
   * @param {number} workgroupCountY - Number of workgroups in Y dimension (default: 1)
   * @param {number} workgroupCountZ - Number of workgroups in Z dimension (default: 1)
   */
  dispatchCompute(computePass, workgroupCountX, workgroupCountY = 1, workgroupCountZ = 1) {
    if (!this.computePipeline || !this.computeBindGroup) return;

    computePass.setPipeline(this.computePipeline);
    computePass.setBindGroup(0, this.computeBindGroup);
    computePass.dispatchWorkgroups(workgroupCountX, workgroupCountY, workgroupCountZ);
  }
}

export { DeviceComputeManager };
