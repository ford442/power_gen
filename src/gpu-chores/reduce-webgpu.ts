/**
 * WebGPU reduce — adopts the session GPUDevice. Never requestAdapter/requestDevice.
 */

import { finalizeReduce, mergeAccum, reduceF32Js } from './reduce-js';
import type { ReduceResult } from './types';

const PARTIAL_STRIDE = 4;
const MAX_COUNT = 65536;

export class WebgpuReduce {
  private device: GPUDevice;
  private pipeline: GPUComputePipeline | null = null;
  private inputBuf: GPUBuffer | null = null;
  private partialBuf: GPUBuffer | null = null;
  private uniformBuf: GPUBuffer | null = null;
  private staging: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private capacity = 0;
  private wgCapacity = 0;
  private last: ReduceResult | null = null;
  private inflight = false;

  constructor(device: GPUDevice) {
    this.device = device;
  }

  async init(pipeline: GPUComputePipeline): Promise<void> {
    this.pipeline = pipeline;
    this.uniformBuf = this.device.createBuffer({
      label: 'chores-reduce-uniforms',
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
  }

  get ready(): boolean {
    return !!this.pipeline && !!this.uniformBuf;
  }

  /**
   * Upload packed f32, dispatch, read previous frame's result (non-blocking).
   * First call returns a JS reduce so the HUD never waits on mapAsync.
   */
  reduce(data: ArrayLike<number>): ReduceResult {
    const js = finalizeReduce(reduceF32Js(data), 'webgpu');
    if (!this.ready || this.inflight) return this.last ?? js;
    const n = Math.min(data.length, MAX_COUNT);
    if (n <= 0) return js;
    try {
      this._ensureCapacity(n);
      const upload = new Float32Array(n);
      for (let i = 0; i < n; i++) upload[i] = Number(data[i]) || 0;
      this.device.queue.writeBuffer(this.inputBuf!, 0, upload);
      const uniforms = new Uint32Array([n, 0, 0, 0]);
      this.device.queue.writeBuffer(this.uniformBuf!, 0, uniforms);
      const wgs = Math.max(1, Math.ceil(n / 64));
      const enc = this.device.createCommandEncoder({ label: 'chores-reduce' });
      const pass = enc.beginComputePass({ label: 'chores-reduce' });
      pass.setPipeline(this.pipeline!);
      pass.setBindGroup(0, this.bindGroup!);
      pass.dispatchWorkgroups(wgs);
      pass.end();
      const copyBytes = wgs * PARTIAL_STRIDE * 4;
      enc.copyBufferToBuffer(this.partialBuf!, 0, this.staging!, 0, copyBytes);
      this.device.queue.submit([enc.finish()]);
      this.inflight = true;
      const staging = this.staging!;
      staging.mapAsync(GPUMapMode.READ).then(() => {
        const view = new Float32Array(staging.getMappedRange().slice(0));
        staging.unmap();
        const acc = {
          sum: 0,
          min: Number.POSITIVE_INFINITY,
          max: Number.NEGATIVE_INFINITY,
          sumSq: 0,
          count: 0
        };
        for (let i = 0; i < wgs; i++) {
          const o = i * 4;
          mergeAccum(acc, {
            sum: view[o],
            min: view[o + 1],
            max: view[o + 2],
            sumSq: view[o + 3],
            count: 1
          });
        }
        // workgroup count is not element count — restore from input length
        acc.count = n;
        this.last = finalizeReduce(acc, 'webgpu');
        this.inflight = false;
      }).catch(() => {
        this.inflight = false;
      });
    } catch (err) {
      console.warn('[gpu-chores] WebGPU reduce failed', err);
      this.inflight = false;
      return this.last ?? js;
    }
    return this.last ?? js;
  }

  private _ensureCapacity(n: number): void {
    if (this.capacity >= n && this.inputBuf && this.partialBuf && this.staging && this.bindGroup) return;
    this.inputBuf?.destroy();
    this.partialBuf?.destroy();
    this.staging?.destroy();
    this.capacity = Math.max(256, n);
    this.wgCapacity = Math.max(1, Math.ceil(this.capacity / 64));
    this.inputBuf = this.device.createBuffer({
      label: 'chores-reduce-input',
      size: this.capacity * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    this.partialBuf = this.device.createBuffer({
      label: 'chores-reduce-partials',
      size: this.wgCapacity * 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
    });
    this.staging = this.device.createBuffer({
      label: 'chores-reduce-staging',
      size: this.wgCapacity * 16,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
    });
    this.bindGroup = this.device.createBindGroup({
      label: 'chores-reduce-bg',
      layout: this.pipeline!.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.inputBuf } },
        { binding: 1, resource: { buffer: this.partialBuf } },
        { binding: 2, resource: { buffer: this.uniformBuf! } }
      ]
    });
  }
}
