// ============================================
// ENERGY PIPE — animated Bézier transfer between devices
// ============================================

import { BindGroupCache } from './renderers/shared/bind-group-cache.js';
import {
  bezierControlPoints,
  deviceAnchor,
  getPipeColor,
  isPipeEndpointEnabled
} from './renderers/shared/energy-network.ts';
import { PARTICLE_LAYOUTS } from '../generated/physics-constants.js';

const PARTICLE_BYTES = PARTICLE_LAYOUTS.pipeBytes;

/** Overview / low-quality particle budgets (CPU path until compute lands). */
const PIPE_PARTICLES_FULL = 72;
const PIPE_PARTICLES_LOD = 36;

/** Switch pipe particle integration to GPU compute at or above this count. */
export const PIPE_GPU_COMPUTE_THRESHOLD = 64;

const CURVE_UNIFORM_BYTES = 96;

function bezier3(p0, p1, p2, p3, t) {
  const u = 1 - t;
  const uu = u * u;
  const tt = t * t;
  const uuu = uu * u;
  const ttt = tt * t;
  return [
    uuu * p0[0] + 3 * uu * t * p1[0] + 3 * u * tt * p2[0] + ttt * p3[0],
    uuu * p0[1] + 3 * uu * t * p1[1] + 3 * u * tt * p2[1] + ttt * p3[1],
    uuu * p0[2] + 3 * uu * t * p1[2] + 3 * u * tt * p2[2] + ttt * p3[2]
  ];
}

function bezierTangent(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return [
    3 * u * u * (p1[0] - p0[0]) + 6 * u * t * (p2[0] - p1[0]) + 3 * t * t * (p3[0] - p2[0]),
    3 * u * u * (p1[1] - p0[1]) + 6 * u * t * (p2[1] - p1[1]) + 3 * t * t * (p3[1] - p2[1]),
    3 * u * u * (p1[2] - p0[2]) + 6 * u * t * (p2[2] - p1[2]) + 3 * t * t * (p3[2] - p2[2])
  ];
}

class EnergyPipe {
  /**
   * @param {GPUDevice} device
   * @param {{ from: string, to: string, speed?: number }} config
   * @param {import('./multi-device-visualizer.js').MultiDeviceVisualizer} visualizer
   */
  constructor(device, config, visualizer) {
    this.device = device;
    this.config = config;
    this.visualizer = visualizer;
    this.particleCount = PIPE_PARTICLES_FULL;
    this.activeParticleCount = PIPE_PARTICLES_FULL;
    this.particles = null;
    this.uniformBuffer = null;
    this.flowLevel = 0;
    this._particleData = new Float32Array(PIPE_PARTICLES_FULL * 8);
    this._colorKey = `${config.from}-${config.to}`;
    this._color = getPipeColor(config.from, config.to);
    this._bindGroups = new BindGroupCache();
    this._lastWriteFrame = -1;
    this.curveUniformBuffer = null;
    this.computeBindGroup = null;
    this._curveData = new Float32Array(CURVE_UNIFORM_BYTES / 4);
  }

  usesGpuCompute() {
    return this.activeParticleCount >= PIPE_GPU_COMPUTE_THRESHOLD
      && !!this.visualizer?.energyPipeComputePipeline;
  }

  _setupComputeResources() {
    const cache = this.visualizer?.pipelineCache;
    const pipeline = this.visualizer?.energyPipeComputePipeline;
    if (!cache || !pipeline || !this.particles) return;

    if (!this.curveUniformBuffer) {
      this.curveUniformBuffer = this.device.createBuffer({
        label: `energy-pipe-curve-${this._colorKey}`,
        size: CURVE_UNIFORM_BYTES,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      });
    }

    this.computeBindGroup = this._bindGroups.get('compute', () =>
      cache.createBindGroup('energyPipeCompute', [
        { binding: 0, resource: { buffer: this.particles } },
        { binding: 1, resource: { buffer: this.curveUniformBuffer } }
      ], `energy-pipe-compute-${this._colorKey}`)
    );
  }

  async init() {
    this.particles = this.device.createBuffer({
      label: `energy-pipe-${this._colorKey}`,
      size: this.particleCount * PARTICLE_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    this.uniformBuffer = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.visualizer?.profiler?.trackBuffer(
      `energy-pipe-${this._colorKey}`,
      this.particleCount * PARTICLE_BYTES,
      GPUBufferUsage.STORAGE
    );
    this._setupComputeResources();
  }

  _writeCurveUniforms({ p0, p1, p2, p3 }, flowLevel, time, speed, pulse) {
    if (!this.curveUniformBuffer) return;
    const d = this._curveData;
    d[0] = p0[0]; d[1] = p0[1]; d[2] = p0[2]; d[3] = 0;
    d[4] = p1[0]; d[5] = p1[1]; d[6] = p1[2]; d[7] = 0;
    d[8] = p2[0]; d[9] = p2[1]; d[10] = p2[2]; d[11] = 0;
    d[12] = p3[0]; d[13] = p3[1]; d[14] = p3[2]; d[15] = flowLevel;
    d[16] = time;
    d[17] = speed;
    d[18] = this.activeParticleCount;
    d[19] = pulse;
    this.device.queue.writeBuffer(this.curveUniformBuffer, 0, d);
  }

  _updateParticlesCpu({ p0, p1, p2, p3 }, flowLevel, time, speed) {
    const n = this.activeParticleCount;
    for (let i = 0; i < n; i++) {
      const phase = i / n;
      const t = (time * speed * 0.12 * (0.4 + flowLevel) + phase) % 1;
      const pos = bezier3(p0, p1, p2, p3, t);
      const tan = bezierTangent(p0, p1, p2, p3, t);
      const tanLen = Math.hypot(tan[0], tan[1], tan[2]) || 1;
      const idx = i * 8;
      this._particleData[idx] = pos[0];
      this._particleData[idx + 1] = pos[1];
      this._particleData[idx + 2] = pos[2];
      this._particleData[idx + 3] = tan[0] / tanLen * speed;
      this._particleData[idx + 4] = tan[1] / tanLen * speed;
      this._particleData[idx + 5] = tan[2] / tanLen * speed;
      const lifeWave = 0.45 + 0.55 * Math.sin(time * 3.5 + phase * 12.566);
      this._particleData[idx + 6] = lifeWave;
      this._particleData[idx + 7] = flowLevel * (0.35 + 0.65 * (1 - Math.abs(t - 0.5) * 1.4));
    }
    this.device.queue.writeBuffer(
      this.particles, 0,
      this._particleData.subarray(0, n * 8)
    );
  }

  /**
   * @param {number} deltaTime
   * @param {Record<string, object>} devices
   * @param {number} time
   * @param {{ lodScale?: number }} [opts]
   */
  update(deltaTime, devices, time, opts = {}) {
    const fromDev = devices[this.config.from];
    const toDev = devices[this.config.to];
    if (!fromDev || !toDev) return;

    const enabled = isPipeEndpointEnabled(
      this.config.from,
      this.config.to,
      this.visualizer.devicesEnabled
    );

    const network = this.visualizer.energyNetwork;
    this.flowLevel = network
      ? network.getPipeFlow(this.config.from, this.config.to)
      : this.flowLevel;

    if (!enabled && this.flowLevel < 0.02) {
      this.flowLevel = 0;
      return;
    }

    if (this.flowLevel < 0.02) return;

    const lodScale = opts.lodScale ?? 1;
    this.activeParticleCount = lodScale < 0.75
      ? PIPE_PARTICLES_LOD
      : PIPE_PARTICLES_FULL;

    const speed = this.config.speed ?? 1.5;
    const pulse = 0.5 + 0.5 * Math.sin(time * 2.4 + fromDev.position[0] * 0.1);
    const p0 = deviceAnchor(fromDev);
    const p3 = deviceAnchor(toDev);
    const curve = bezierControlPoints(p0, p3);

    if (this.usesGpuCompute()) {
      this._writeCurveUniforms(curve, this.flowLevel, time, speed, pulse);
    } else {
      this._updateParticlesCpu(curve, this.flowLevel, time, speed);
    }

    this.device.queue.writeBuffer(
      this.uniformBuffer, 0,
      new Float32Array([...this._color, this.flowLevel, pulse, 0, 0])
    );
  }

  dispatchCompute(computePass) {
    if (!this.usesGpuCompute() || !this.computeBindGroup || this.flowLevel < 0.02) return;
    const pipeline = this.visualizer?.energyPipeComputePipeline;
    if (!pipeline) return;
    computePass.setPipeline(pipeline);
    computePass.setBindGroup(0, this.computeBindGroup);
    computePass.dispatchWorkgroups(Math.ceil(this.activeParticleCount / 64));
  }

  render(renderPass, globalUniformBuffer, pipeline) {
    if (!pipeline || !this.particles || this.flowLevel < 0.02) return;

    const cache = this.visualizer?.pipelineCache;
    const bindGroup = this._bindGroups.get('main', () => {
      const entries = [
        { binding: 0, resource: { buffer: globalUniformBuffer } },
        { binding: 1, resource: { buffer: this.uniformBuffer } },
        { binding: 2, resource: { buffer: this.particles } }
      ];
      return cache
        ? cache.createBindGroup('energyPipe', entries, `energy-pipe-bg-${this._colorKey}`)
        : this.device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries
          });
    });

    renderPass.setPipeline(pipeline);
    renderPass.setBindGroup(0, bindGroup);
    renderPass.draw(4, this.activeParticleCount || this.particleCount);
  }
}

export { EnergyPipe };
export { PIPE_COLORS, ENERGY_PIPE_EDGES } from './renderers/shared/energy-network.ts';
