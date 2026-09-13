/**
 * 2D TM_z FDTD wave slice for the pulse-coil focus view (ADR-0010).
 *
 * Owns three n² field buffers (Ez, Hx, Hy), the Yee update pipelines and the
 * scene-pass panel pipeline. Each frame the render loop asks {@link update}
 * whether the gate is open; if so it encodes {@link dispatch} inside the
 * shared compute pass and {@link draw} inside the scene pass. Nothing is read
 * back to the CPU.
 *
 * Grid time is decoupled from plant time: the grid advances a fixed
 * `FDTD_STEPS_PER_FRAME` Yee steps per frame, i.e. light is slowed by many
 * orders of magnitude so a wave front crosses the panel in about a second.
 * The coil current only sets the source amplitude. See docs/DEVICE_GALLERY.md.
 *
 * Layouts: docs/BINDINGS.md → `fdtdCompute`, `fdtdSlice`.
 */

import {
  FDTD_DEFAULT_CONFIG,
  FDTD_PARAMS_BYTES,
  FDTD_SLICE_PARAMS_BYTES,
  FDTD_STEPS_PER_FRAME,
  FDTD_WORKGROUP,
  fdtdSliceGateOpen,
  packFdtdParams,
  type FdtdSource
} from '../../physics/fdtd-tmz';
import { PULSE_COIL_FDTD, pulseCoilFdtdSources } from './pulse-coil';
import { writeQueueBuffer } from '../../gpu-buffer-write';
import type { PipelineLayoutCache } from '../../pipeline-layout-cache';

/** Frames for the drive to cover ~63 % of a jump — keeps the source band-limited on the grid. */
const DRIVE_SLEW_FRAMES = 4;
/** tanh gains tuned against the CPU reference (Ez transients ≈ 0.3, |H| near a winding ≈ 1). */
const EZ_GAIN = 3.5;
const H_GAIN = 1.5;

export interface FdtdSliceHost {
  pipelineCache?: PipelineLayoutCache | null;
  profiler?: {
    trackBuffer?: (name: string, size: number, usage: GPUBufferUsageFlags) => unknown;
  } | null;
  shaders: { fdtdTmzComputeShader: string; fdtdSliceShader: string };
}

export interface FdtdSliceFrame {
  enabled: boolean;
  currentView: string | null | undefined;
  qualityTier: string | null | undefined;
  /** Owning device's world position. */
  devicePos: ArrayLike<number>;
  /** Signed normalized drive from the owning plugin (pulseCoilFdtdDrive). */
  drive: number;
}

export class FdtdSlicePass {
  readonly device: GPUDevice;
  readonly host: FdtdSliceHost;
  readonly n = FDTD_DEFAULT_CONFIG.n;

  ready = false;
  /** True while the gate was open on the last update. */
  active = false;

  private updateH: GPUComputePipeline | null = null;
  private updateE: GPUComputePipeline | null = null;
  private sliceBase: GPURenderPipeline | null = null;
  private sliceMsaa4: GPURenderPipeline | null = null;

  private ez: GPUBuffer | null = null;
  private hx: GPUBuffer | null = null;
  private hy: GPUBuffer | null = null;
  private paramsBuffer: GPUBuffer | null = null;
  private sliceParamsBuffer: GPUBuffer | null = null;
  private computeBindGroup: GPUBindGroup | null = null;
  private sliceBindGroup: GPUBindGroup | null = null;
  private sliceBindGroupGlobals: GPUBuffer | null = null;

  /** Fields hold a previous session's wave; zero them before the next open frame. */
  private needsClear = true;
  private drive = 0;
  private readonly unitSources: FdtdSource[] = pulseCoilFdtdSources();
  private readonly frameSources: FdtdSource[] = this.unitSources.map((s) => ({ ...s }));
  private readonly paramsScratch = new Float32Array(FDTD_PARAMS_BYTES / 4);
  private readonly sliceScratch = new Float32Array(FDTD_SLICE_PARAMS_BYTES / 4);

  constructor(device: GPUDevice, host: FdtdSliceHost) {
    this.device = device;
    this.host = host;
  }

  /** Build pipelines and buffers. Returns false (and stays unready) if the cache is missing. */
  async init(): Promise<boolean> {
    const cache = this.host.pipelineCache;
    if (!cache) return false;

    const compute = await cache.ensureFdtdComputePipelines(this.host.shaders.fdtdTmzComputeShader);
    this.updateH = compute.updateH;
    this.updateE = compute.updateE;
    [this.sliceBase, this.sliceMsaa4] = await Promise.all([
      cache.ensureFdtdSlicePipeline(this.host.shaders.fdtdSliceShader),
      cache.ensureFdtdSlicePipeline(this.host.shaders.fdtdSliceShader, { sampleCount: 4 })
    ]);

    const fieldBytes = this.n * this.n * 4;
    const field = (label: string) => {
      const buf = this.device.createBuffer({
        label,
        size: fieldBytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
      });
      this.host.profiler?.trackBuffer?.(label, fieldBytes, GPUBufferUsage.STORAGE);
      return buf;
    };
    this.ez = field('fdtd-ez');
    this.hx = field('fdtd-hx');
    this.hy = field('fdtd-hy');
    this.paramsBuffer = this.device.createBuffer({
      label: 'fdtd-params',
      size: FDTD_PARAMS_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.sliceParamsBuffer = this.device.createBuffer({
      label: 'fdtd-slice-params',
      size: FDTD_SLICE_PARAMS_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.host.profiler?.trackBuffer?.('fdtd-params', FDTD_PARAMS_BYTES, GPUBufferUsage.UNIFORM);

    this.computeBindGroup = cache.createBindGroup('fdtdCompute', [
      { binding: 0, resource: { buffer: this.paramsBuffer } },
      { binding: 1, resource: { buffer: this.ez } },
      { binding: 2, resource: { buffer: this.hx } },
      { binding: 3, resource: { buffer: this.hy } }
    ], 'fdtd-compute-bg');

    this.ready = true;
    return true;
  }

  /**
   * Evaluate the gate and upload this frame's uniforms.
   * @returns true when {@link dispatch} and {@link draw} should run.
   */
  update(frame: FdtdSliceFrame): boolean {
    const open = fdtdSliceGateOpen({
      enabled: frame.enabled,
      ready: this.ready,
      currentView: frame.currentView,
      qualityTier: frame.qualityTier
    });
    if (!open) {
      if (this.active) this.needsClear = true;
      this.active = false;
      this.drive = 0;
      return false;
    }

    if (this.needsClear) {
      const zeros = new Float32Array(this.n * this.n);
      for (const buf of [this.ez!, this.hx!, this.hy!]) writeQueueBuffer(this.device, buf, zeros);
      this.needsClear = false;
    }

    const target = Number.isFinite(frame.drive) ? frame.drive : 0;
    this.drive += (target - this.drive) * (1 - Math.exp(-1 / DRIVE_SLEW_FRAMES));
    for (let i = 0; i < this.unitSources.length; i++) {
      this.frameSources[i].amp = this.unitSources[i].amp * this.drive;
    }
    writeQueueBuffer(
      this.device,
      this.paramsBuffer!,
      packFdtdParams(this.frameSources, FDTD_DEFAULT_CONFIG, this.paramsScratch)
    );

    const s = this.sliceScratch;
    const c = PULSE_COIL_FDTD.center;
    s[0] = (frame.devicePos[0] ?? 0) + c[0];
    s[1] = (frame.devicePos[1] ?? 0) + c[1];
    s[2] = (frame.devicePos[2] ?? 0) + c[2];
    s[3] = PULSE_COIL_FDTD.halfExtent;
    s[4] = EZ_GAIN;
    s[5] = H_GAIN;
    s[6] = 1;
    s[7] = 0;
    writeQueueBuffer(this.device, this.sliceParamsBuffer!, s);

    this.active = true;
    return true;
  }

  /** Encode the Yee steps into the frame's shared compute pass. */
  dispatch(computePass: GPUComputePassEncoder): void {
    if (!this.active || !this.updateH || !this.updateE || !this.computeBindGroup) return;
    const groups = Math.ceil(this.n / FDTD_WORKGROUP);
    computePass.setBindGroup(0, this.computeBindGroup);
    for (let k = 0; k < FDTD_STEPS_PER_FRAME; k++) {
      computePass.setPipeline(this.updateH);
      computePass.dispatchWorkgroups(groups, groups);
      computePass.setPipeline(this.updateE);
      computePass.dispatchWorkgroups(groups, groups);
    }
  }

  /** Draw the panel inside the scene pass (after opaque device meshes). */
  draw(renderPass: GPURenderPassEncoder, globalUniformBuffer: GPUBuffer, msaaActive: boolean): void {
    if (!this.active) return;
    const pipeline = msaaActive ? this.sliceMsaa4 : this.sliceBase;
    const bindGroup = this.sliceBindGroupFor(globalUniformBuffer);
    if (!pipeline || !bindGroup) return;
    renderPass.setPipeline(pipeline);
    renderPass.setBindGroup(0, bindGroup);
    renderPass.draw(6);
  }

  destroy(): void {
    for (const buf of [this.ez, this.hx, this.hy, this.paramsBuffer, this.sliceParamsBuffer]) {
      buf?.destroy();
    }
    this.ready = false;
    this.active = false;
    this.computeBindGroup = null;
    this.sliceBindGroup = null;
  }

  private sliceBindGroupFor(globals: GPUBuffer): GPUBindGroup | null {
    const cache = this.host.pipelineCache;
    if (!cache || !this.ez || !this.hx || !this.hy || !this.paramsBuffer || !this.sliceParamsBuffer) return null;
    if (this.sliceBindGroup && this.sliceBindGroupGlobals === globals) return this.sliceBindGroup;
    this.sliceBindGroup = cache.createBindGroup('fdtdSlice', [
      { binding: 0, resource: { buffer: globals } },
      { binding: 1, resource: { buffer: this.sliceParamsBuffer } },
      { binding: 2, resource: { buffer: this.paramsBuffer } },
      { binding: 3, resource: { buffer: this.ez } },
      { binding: 4, resource: { buffer: this.hx } },
      { binding: 5, resource: { buffer: this.hy } }
    ], 'fdtd-slice-bg');
    this.sliceBindGroupGlobals = globals;
    return this.sliceBindGroup;
  }
}
