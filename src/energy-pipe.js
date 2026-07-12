// ============================================
// ENERGY PIPE — animated Bézier transfer between devices
// ============================================

import { BindGroupCache } from './renderers/shared/bind-group-cache.js';
import { PARTICLE_LAYOUTS } from '../generated/physics-constants.js';

const PIPE_COLORS = {
  'seg-heron': [0.15, 0.92, 0.75],
  'heron-kelvin': [0.25, 0.65, 1.0],
  'kelvin-seg': [0.72, 0.45, 1.0],
  'kelvin-peltier': [0.55, 0.35, 0.95],
  'peltier-solar': [1.0, 0.82, 0.25],
  'seg-mhd': [0.35, 0.88, 1.0],
  'mhd-peltier': [0.45, 0.75, 1.0],
  'solar-maglev': [0.25, 0.92, 1.0],
  'maglev-seg': [0.15, 0.85, 0.95]
};

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
    this._color = PIPE_COLORS[this._colorKey] || [0.4, 0.9, 1.0];
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

  _bezierControlPoints(fromDev, toDev) {
    const p0 = this._deviceAnchor(fromDev);
    const p3 = this._deviceAnchor(toDev);
    const lift = 3.5 + Math.abs(p0[0] - p3[0]) * 0.08 + Math.abs(p0[2] - p3[2]) * 0.08;
    const mid = [
      (p0[0] + p3[0]) * 0.5,
      Math.max(p0[1], p3[1]) + lift,
      (p0[2] + p3[2]) * 0.5
    ];
    const p1 = [
      p0[0] + (mid[0] - p0[0]) * 0.45,
      p0[1] + lift * 0.55,
      p0[2] + (mid[2] - p0[2]) * 0.45
    ];
    const p2 = [
      p3[0] + (mid[0] - p3[0]) * 0.45,
      p3[1] + lift * 0.55,
      p3[2] + (mid[2] - p3[2]) * 0.45
    ];
    return { p0, p1, p2, p3 };
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

  _deviceAnchor(dev) {
    if (!dev) return [0, 2, 0];
    const yBoost = dev.id === 'solar' ? 1.5 : dev.id === 'heron' ? 3.0 : 2.2;
    return [
      dev.position[0],
      dev.position[1] + yBoost,
      dev.position[2]
    ];
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

    const enabled = this.visualizer.devicesEnabled?.[this.config.from]
      && this.visualizer.devicesEnabled?.[this.config.to];
    // Skip dead pipes when either endpoint is disabled in the overview toggles.
    if (!enabled && this.flowLevel < 0.02) {
      this.flowLevel = 0;
      return;
    }

    const sourceFlow = fromDev.energyLevel ?? 0;
    const target = 0.12 + sourceFlow * 0.88;
    const smooth = 1 - Math.exp(-Math.max(0, deltaTime) * 6);
    this.flowLevel = this.flowLevel + ((enabled ? target : 0) - this.flowLevel) * smooth;

    if (this.flowLevel < 0.02) return;

    const lodScale = opts.lodScale ?? 1;
    this.activeParticleCount = lodScale < 0.75
      ? PIPE_PARTICLES_LOD
      : PIPE_PARTICLES_FULL;

    const speed = this.config.speed ?? 1.5;
    const pulse = 0.5 + 0.5 * Math.sin(time * 2.4 + fromDev.position[0] * 0.1);
    const curve = this._bezierControlPoints(fromDev, toDev);

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

export { EnergyPipe, PIPE_COLORS };
