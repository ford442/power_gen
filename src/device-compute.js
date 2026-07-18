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

    // Compute uniform buffer: time, mode, particleCount, speedMult, physics×4 (32 bytes)
    this.computeUniformBuffer = this.device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

    // Track buffer for profiling if visualizer is available (optional)
    if (this.pipelineManager.visualizer && this.pipelineManager.visualizer.profiler) {
      this.pipelineManager.visualizer.profiler.trackBuffer(`device-${this.id}-compute-uniforms`, 32, GPUBufferUsage.UNIFORM);
    }

    // Compute bind group: binding 0 = particles storage, binding 1 = uniforms
    // Layout: docs/BINDINGS.md → particleCompute
    const cache = this.pipelineManager.visualizer?.pipelineCache;
    this.computeBindGroup = cache
      ? cache.createBindGroup('particleCompute', [
          { binding: 0, resource: { buffer: this.geometry.particles } },
          { binding: 1, resource: { buffer: this.computeUniformBuffer } }
        ], `device-${this.id}-compute-bg`)
      : this.device.createBindGroup({
          layout: this.computePipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: this.geometry.particles } },
            { binding: 1, resource: { buffer: this.computeUniformBuffer } }
          ]
        });
  }

  updateComputeUniforms(time, mode, particleCount, speedMult = 1.0, physicsState = null) {
    if (!this.computeUniformBuffer) return;

    this.scaledParticleCount = particleCount;
    this.speedMult = speedMult;

    let p0 = 0, p1 = 0, p2 = 0, p3 = 0;
    if (physicsState) {
      if (physicsState.deviceId === 'heron') {
        p0 = physicsState.heronHead / Math.max(0.01, physicsState.heronHeadMax);
        p1 = physicsState.heronVExit / 8;
      } else if (physicsState.deviceId === 'kelvin') {
        p0 = physicsState.kelvinVoltageN;
        p1 = physicsState.kelvinSparkTimer > 0 ? 1 : 0;
        p2 = physicsState.kelvinE;
      } else if (physicsState.deviceId === 'solar') {
        p0 = physicsState.batteryCharge;
      } else if (physicsState.deviceId === 'maglev') {
        p0 = physicsState.maglevGap ?? 0.018;
        p1 = physicsState.maglevFieldT ?? 0.5;
      } else if (physicsState.deviceId === 'homopolar') {
        p0 = (physicsState.homopolarRpm ?? 0) / 3600;
        p1 = Math.min(1, (physicsState.homopolarEmfV ?? 0) / 2);
        p2 = physicsState.homopolarAngle ?? 0;
      } else if (physicsState.deviceId === 'halbach-viz') {
        p0 = (physicsState.halbachSegmentCount ?? 8) / 24;
        p1 = Math.min(1, (physicsState.halbachPeakBT ?? 0) / 0.8);
      }
    }

    this.device.queue.writeBuffer(
      this.computeUniformBuffer, 0,
      new Float32Array([time, mode, particleCount, speedMult, p0, p1, p2, p3])
    );
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
