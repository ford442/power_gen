/**
 * DeviceComputeManager - Manages compute pipeline setup and execution for device instances
 * Handles: compute pipeline, compute bind groups, compute uniforms
 */
import { writeQueueBuffer } from './gpu-buffer-write';
import type { DeviceInstanceConfig } from './device-instance';
import type { DevicePipelineManager } from './device-pipeline-manager';
import type { DevicePhysicsState } from './renderers/shared/device-physics';

interface ComputeGeometryHost {
  particles: GPUBuffer;
}

class DeviceComputeManager {
  device: GPUDevice;
  id: string;
  config: DeviceInstanceConfig;
  pipelineManager: DevicePipelineManager;
  geometry: ComputeGeometryHost;

  computePipeline: GPUComputePipeline | GPURenderPipeline | null = null;
  computeBindGroup: GPUBindGroup | null = null;
  computeUniformBuffer: GPUBuffer | null = null;
  scaledParticleCount = 0;
  speedMult = 1.0;

  constructor(device: GPUDevice, id: string, config: DeviceInstanceConfig, pipelineManager: DevicePipelineManager, geometry: ComputeGeometryHost) {
    this.device = device;
    this.id = id;
    this.config = config;
    this.pipelineManager = pipelineManager;
    this.geometry = geometry;
  }

  async setupComputeResources(): Promise<void> {
    this.computePipeline = this.pipelineManager.computePipeline;
    if (!this.computePipeline) return;

    // Compute uniform buffer: time, mode, particleCount, speedMult,
    // physics×4, lodLevel + 3 pad (48 bytes) — see common/compute-uniforms.wgsl
    this.computeUniformBuffer = this.device.createBuffer({
      size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

    // Track buffer for profiling if visualizer is available (optional)
    if (this.pipelineManager.visualizer && this.pipelineManager.visualizer.profiler) {
      this.pipelineManager.visualizer.profiler.trackBuffer?.(`device-${this.id}-compute-uniforms`, 48, GPUBufferUsage.UNIFORM);
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
          layout: (this.computePipeline as GPUComputePipeline).getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: this.geometry.particles } },
            { binding: 1, resource: { buffer: this.computeUniformBuffer } }
          ]
        });
  }

  /**
   * @param particleCount count *before* GPU LOD — the shader applies
   *   `lodLevel` itself (common/overview-lod.wgsl).
   * @param lodLevel overview particle LOD 0..3
   */
  updateComputeUniforms(time: number, mode: number, particleCount: number, speedMult = 1.0, physicsState: DevicePhysicsState | null = null, lodLevel = 0): void {
    if (!this.computeUniformBuffer) return;

    this.scaledParticleCount = particleCount >>> Math.max(0, Math.min(3, lodLevel | 0));
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
      } else if (physicsState.deviceId === 'peltier') {
        p0 = Math.min(1, Math.abs(physicsState.peltierDeltaT ?? 0) / 80);
        p1 = Math.min(1, physicsState.peltierCOP ?? 0);
        p2 = Math.min(1, ((physicsState.peltierHotK ?? 300) - 280) / 150);
      } else if (physicsState.deviceId === 'mhd') {
        p0 = Math.min(1, (physicsState.mhdFlowU ?? 0) / 3.5);
        p1 = Math.min(1, (physicsState.mhdBFieldT ?? 0) / 1.0);
        p2 = Math.min(1, (physicsState.mhdHartmann ?? 0) / 40);
      } else if (physicsState.deviceId === 'transformer') {
        p0 = Math.min(1, Math.abs(physicsState.transformerIpA ?? 0) / 4);
        p1 = Math.min(1, Math.abs(physicsState.transformerIsA ?? 0) / 3);
        p2 = physicsState.transformerFluxN ?? 0;
        p3 = physicsState.transformerK ?? 0.95;
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
      } else if (physicsState.deviceId === 'pulse-coil') {
        p0 = Math.min(1, Math.abs(physicsState.pulseCoilCurrentA ?? 0) / 80);
        p1 = Math.min(1, (physicsState.pulseCoilBPeakT ?? 0) / 1.5);
        p2 = Math.min(1, (physicsState.pulseCoilArmatureM ?? 0) / 0.12);
      } else if (physicsState.deviceId === 'vdg') {
        // 150000 mirrors VDG_V_BREAK in devices/quanta/van-de-graaff.ts.
        p0 = Math.min(1, (physicsState.vdgVoltage ?? 0) / 150000);
        p1 = (physicsState.vdgSparkHz ?? 0) > 0 ? 1 : 0;
      } else if (physicsState.deviceId === 'hall') {
        p0 = Math.min(1, (physicsState.hallCurrent ?? 0) / 1.2);
        p1 = Math.min(1, (physicsState.hallFieldT ?? 0) / 0.65);
      }
    }

    writeQueueBuffer(
      this.device,
      this.computeUniformBuffer,
      new Float32Array([
        time, mode, particleCount, speedMult,
        p0, p1, p2, p3,
        Math.max(0, Math.min(3, lodLevel | 0)), 0, 0, 0
      ])
    );
  }

  /**
   * Dispatch compute shader with given dispatch dimensions
   * @param computePass - The compute pass encoder
   * @param workgroupCountX - Number of workgroups in X dimension
   * @param workgroupCountY - Number of workgroups in Y dimension (default: 1)
   * @param workgroupCountZ - Number of workgroups in Z dimension (default: 1)
   */
  dispatchCompute(computePass: GPUComputePassEncoder, workgroupCountX: number, workgroupCountY = 1, workgroupCountZ = 1): void {
    if (!this.computePipeline || !this.computeBindGroup) return;

    computePass.setPipeline(this.computePipeline as GPUComputePipeline);
    computePass.setBindGroup(0, this.computeBindGroup);
    computePass.dispatchWorkgroups(workgroupCountX, workgroupCountY, workgroupCountZ);
  }
}

export { DeviceComputeManager };
