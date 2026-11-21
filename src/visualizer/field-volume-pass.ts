/**
 * 3-D magnetostatic field volume on WebGPU (ADR-0017, #255).
 *
 * One pass object owns everything that reads the volume: the n³ rgba16float
 * texture (B.xyz, |B| in mT), the source / seed / segment / particle buffers,
 * and the pipelines — volume sweep, streamline tracer, Boris pusher, point
 * probe (compute); line billboards, slice plane, isosurface march (scene).
 *
 * Pipelines are built once, lazily, the first frame the gate would open
 * (field-volume-drive.ts). Texture and buffers are a frame-graph lifetime
 * (`field-volume`): allocated the first frame the pass runs and released a
 * few frames after it stops, so overview and low tier never hold them.
 *
 * A refresh ("sweep") snapshots the bench's sources, uploads them with the
 * line seeds, and recomputes the volume in z-slabs (fieldSweepPlan: one
 * frame at 64³, four at 128³); the lines are re-traced when a sweep
 * completes. Particles push every frame. Nothing is read back except on an
 * explicit {@link probeGpu} (debug / golden).
 *
 * Layouts: docs/BINDINGS.md → fieldVolume, fieldProbe, fieldStreamlines,
 * fieldCharges, fieldLines, fieldSlice, fieldIso.
 */

import { writeQueueBuffer } from '../gpu-buffer-write';
import type { PipelineLayoutCache } from '../pipeline-layout-cache';
import type { FieldComputePipelines, FieldRenderPipelines, FieldShaderSources } from '../pipeline-layout/factories/field-pipelines';
import type { ResourceLifetime } from './frame-graph';
import { FIELD_MAX_SOURCES, FIELD_SOURCE_BYTES, FIELD_SOURCE_FLOATS, maxSourceDelta } from '../physics/field-sources';
import { FIELD_BRICK, FIELD_VOLUME_PARAMS_BYTES, FIELD_VOLUME_PER_TESLA, packFieldVolumeParams } from '../physics/field-volume';
import {
  FIELD_ISO_PARAMS_BYTES,
  FIELD_LINE_SEGMENT_BYTES,
  FIELD_LINE_STYLE_BYTES,
  FIELD_MAX_SEEDS,
  FIELD_PARTICLE_BYTES,
  FIELD_PROBE_INFO_BYTES,
  FIELD_PROBE_MAX_POINTS,
  FIELD_SEGMENTS_PER_LINE,
  FIELD_SLICE_PARAMS_BYTES,
  FIELD_SOURCE_CHANGE_EPS,
  FIELD_STREAM_PARAMS_BYTES,
  fieldSweepPlan,
  packIsoParams,
  packLineStyle,
  packParticleParams,
  packSliceParams,
  packStreamParams,
  type FieldSliceAxis,
  type FieldSliceMode
} from '../physics/field-pack';
import { FIELD_PARTICLE_PARAMS_BYTES, FIELD_PARTICLE_TRAIL, type FieldParticlePlan } from '../physics/field-particles';
import type { BenchField } from '../physics/field-bench';

const U = GPUBufferUsage;
const MAX_PARTICLES = 1024;

export interface FieldVolumePassHost {
  pipelineCache?: PipelineLayoutCache | null;
  profiler?: { trackBuffer?: (name: string, size: number, usage: GPUBufferUsageFlags) => unknown } | null;
  shaders: { fieldShaders: FieldShaderSources };
}

/** What the scene draw needs from the focused device (device-render.ts mixin). */
export interface FieldLineDrawDevice {
  _deviceUniformResource(): GPUBufferBinding;
  _deviceUniformOffset(part: 0, label?: string): number;
}

export interface FieldVolumeFrame {
  bench: BenchField;
  /** Volume resolution for this tier (64 or 128). */
  n: number;
  /** Wall-clock seconds (refresh-rate cap). */
  wallTime: number;
  /** Visual time (line pulse / LIC drift). */
  time: number;
  devicePos: ArrayLike<number>;
  bRefMt: number;
  slice: { axis: Exclude<FieldSliceAxis, 'off'>; offset: number; mode: FieldSliceMode } | null;
  isoLevelsMt: readonly number[] | null;
  particles: { plan: FieldParticlePlan; efield: ArrayLike<number>; spawn: ArrayLike<number>; count: number } | null;
}

export class FieldVolumePass {
  readonly device: GPUDevice;
  readonly host: FieldVolumePassHost;
  ready = false;
  /** True while the gate was open on the last update. */
  active = false;
  /** Sweeps completed since allocation (diagnostics). */
  sweeps = 0;
  n = 0;

  private compute: FieldComputePipelines | null = null;
  private render1: FieldRenderPipelines | null = null;
  private render4: FieldRenderPipelines | null = null;
  private sampler: GPUSampler | null = null;

  // Lifetime-owned (allocate / release).
  private texture: GPUTexture | null = null;
  private buffers: Record<string, GPUBuffer> | null = null;
  private groups: Record<string, GPUBindGroup> | null = null;
  private lineGroup: { group: GPUBindGroup; buffer: GPUBuffer; trail: boolean }[] = [];

  // Sweep state.
  private snapshot = new Float32Array(64 * FIELD_SOURCE_FLOATS);
  private snapshotCount = -1;
  private seedCount = 0;
  private benchId = '';
  private sweepNext = -1;
  private lastSweepStart = -Infinity;
  private traceDue = false;
  private particleKey = '';
  private particleFrame = 0;
  private wantedN = 64;

  // This frame's work.
  private slab: { z0: number; count: number } | null = null;
  private drawSlice = false;
  private drawIso = false;
  private particleCount = 0;

  private readonly scratch = {
    volume: new Float32Array(FIELD_VOLUME_PARAMS_BYTES / 4),
    stream: new Float32Array(FIELD_STREAM_PARAMS_BYTES / 4),
    style: new Float32Array(FIELD_LINE_STYLE_BYTES / 4),
    slice: new Float32Array(FIELD_SLICE_PARAMS_BYTES / 4),
    iso: new Float32Array(FIELD_ISO_PARAMS_BYTES / 4),
    particle: new Float32Array(FIELD_PARTICLE_PARAMS_BYTES / 4)
  };

  constructor(device: GPUDevice, host: FieldVolumePassHost) {
    this.device = device;
    this.host = host;
  }

  async init(): Promise<boolean> {
    const cache = this.host.pipelineCache;
    if (!cache) return false;
    const src = this.host.shaders.fieldShaders;
    [this.compute, this.render1, this.render4] = await Promise.all([
      cache.ensureFieldComputePipelines(src),
      cache.ensureFieldRenderPipelines(src),
      cache.ensureFieldRenderPipelines(src, { sampleCount: 4 })
    ]);
    this.sampler = this.device.createSampler({
      label: 'field-volume-sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      addressModeW: 'clamp-to-edge'
    });
    this.ready = true;
    return true;
  }

  /** Frame-graph resource `field-volume` (render-encode.ts). */
  lifetime(): ResourceLifetime {
    return {
      name: 'field-volume',
      isAllocated: () => !!this.texture,
      ensure: () => this.allocate(this.wantedN),
      release: () => this.release()
    };
  }

  get allocatedBytes(): number {
    if (!this.texture || !this.buffers) return 0;
    let total = this.n ** 3 * 8;
    for (const b of Object.values(this.buffers)) total += b.size;
    return total;
  }

  private allocate(n: number): void {
    if (this.texture || !this.ready) return;
    const cache = this.host.pipelineCache!;
    this.n = n;
    this.texture = this.device.createTexture({
      label: `field-volume-${n}`,
      size: [n, n, n],
      dimension: '3d',
      format: 'rgba16float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING
    });
    const buf = (label: string, size: number, usage: GPUBufferUsageFlags) => {
      const b = this.device.createBuffer({ label, size, usage });
      this.host.profiler?.trackBuffer?.(label, size, usage);
      return b;
    };
    const segBytes = FIELD_MAX_SEEDS * FIELD_SEGMENTS_PER_LINE * FIELD_LINE_SEGMENT_BYTES;
    const b = (this.buffers = {
      volumeParams: buf('field-volume-params', FIELD_VOLUME_PARAMS_BYTES, U.UNIFORM | U.COPY_DST),
      sources: buf('field-sources', FIELD_MAX_SOURCES * FIELD_SOURCE_BYTES, U.STORAGE | U.COPY_DST),
      seeds: buf('field-seeds', FIELD_MAX_SEEDS * 16, U.STORAGE | U.COPY_DST),
      streamParams: buf('field-stream-params', FIELD_STREAM_PARAMS_BYTES, U.UNIFORM | U.COPY_DST),
      segments: buf('field-segments', segBytes, U.STORAGE | U.COPY_DST),
      lineStyle: buf('field-line-style', FIELD_LINE_STYLE_BYTES, U.UNIFORM | U.COPY_DST),
      trailStyle: buf('field-trail-style', FIELD_LINE_STYLE_BYTES, U.UNIFORM | U.COPY_DST),
      sliceParams: buf('field-slice-params', FIELD_SLICE_PARAMS_BYTES, U.UNIFORM | U.COPY_DST),
      isoParams: buf('field-iso-params', FIELD_ISO_PARAMS_BYTES, U.UNIFORM | U.COPY_DST),
      particleParams: buf('field-particle-params', FIELD_PARTICLE_PARAMS_BYTES, U.UNIFORM | U.COPY_DST),
      particles: buf('field-particles', MAX_PARTICLES * FIELD_PARTICLE_BYTES, U.STORAGE | U.COPY_DST),
      trails: buf('field-trails', MAX_PARTICLES * FIELD_PARTICLE_TRAIL * FIELD_LINE_SEGMENT_BYTES, U.STORAGE | U.COPY_DST),
      probeInfo: buf('field-probe-info', FIELD_PROBE_INFO_BYTES, U.UNIFORM | U.COPY_DST),
      probePoints: buf('field-probe-points', FIELD_PROBE_MAX_POINTS * 16, U.STORAGE | U.COPY_DST),
      probeResults: buf('field-probe-results', FIELD_PROBE_MAX_POINTS * 16, U.STORAGE | U.COPY_SRC)
    });
    // Unused slots must read as unused (age < 0) before the first trace.
    this.clearSegments(b.segments, FIELD_MAX_SEEDS * FIELD_SEGMENTS_PER_LINE);
    this.clearSegments(b.trails, MAX_PARTICLES * FIELD_PARTICLE_TRAIL);
    const view = this.texture.createView({ dimension: '3d' });
    const s = this.sampler!;
    this.groups = {
      volume: cache.createBindGroup('fieldVolume', [
        { binding: 0, resource: { buffer: b.volumeParams } },
        { binding: 1, resource: { buffer: b.sources } },
        { binding: 2, resource: view }
      ], 'field-volume-bg'),
      probe: cache.createBindGroup('fieldProbe', [
        { binding: 0, resource: { buffer: b.probeInfo } },
        { binding: 1, resource: { buffer: b.sources } },
        { binding: 2, resource: { buffer: b.probePoints } },
        { binding: 3, resource: { buffer: b.probeResults } }
      ], 'field-probe-bg'),
      stream: cache.createBindGroup('fieldStreamlines', [
        { binding: 0, resource: { buffer: b.streamParams } },
        { binding: 1, resource: view },
        { binding: 2, resource: s },
        { binding: 3, resource: { buffer: b.seeds } },
        { binding: 4, resource: { buffer: b.segments } }
      ], 'field-stream-bg'),
      charges: cache.createBindGroup('fieldCharges', [
        { binding: 0, resource: { buffer: b.particleParams } },
        { binding: 1, resource: view },
        { binding: 2, resource: s },
        { binding: 3, resource: { buffer: b.particles } },
        { binding: 4, resource: { buffer: b.trails } }
      ], 'field-charges-bg'),
      slice: cache.createBindGroup('fieldSlice', [
        { binding: 1, resource: { buffer: b.sliceParams } },
        { binding: 2, resource: view },
        { binding: 3, resource: s }
      ], 'field-slice-bg'),
      iso: cache.createBindGroup('fieldIso', [
        { binding: 1, resource: { buffer: b.isoParams } },
        { binding: 2, resource: view },
        { binding: 3, resource: s }
      ], 'field-iso-bg')
    };
    this.lineGroup = [];
    this.snapshotCount = -1;
    this.sweepNext = -1;
    this.particleKey = '';
    this.sweeps = 0;
  }

  private release(): void {
    this.texture?.destroy();
    for (const b of Object.values(this.buffers ?? {})) b.destroy();
    this.texture = null;
    this.buffers = null;
    this.groups = null;
    this.lineGroup = [];
    this.active = false;
  }

  private clearSegments(buffer: GPUBuffer, count: number): void {
    const init = new Float32Array(count * (FIELD_LINE_SEGMENT_BYTES / 4));
    for (let i = 7; i < init.length; i += 8) init[i] = -1;
    writeQueueBuffer(this.device, buffer, init);
  }

  /** Close the gate for this frame (keeps the lifetime; the graph releases it later). */
  idle(): void {
    this.active = false;
    this.slab = null;
  }

  /**
   * Decide this frame's work and upload its uniforms. Returns false when the
   * texture is not allocated yet — the frame graph allocates it when the
   * `field-volume` pass first runs, and the work starts next frame.
   */
  update(f: FieldVolumeFrame): boolean {
    this.wantedN = f.n;
    if (this.texture && this.n !== f.n) this.release();
    this.active = true;
    if (!this.texture || !this.buffers) {
      this.slab = null;
      return true; // the pass runs, allocates, and encodes nothing this frame
    }
    const b = this.buffers;
    const bench = f.bench;
    const plan = fieldSweepPlan(this.n);
    const benchChanged = bench.deviceId !== this.benchId;

    // Start a sweep when the sources moved (rate-capped) or the bench changed.
    if (this.sweepNext < 0) {
      const delta = this.snapshotCount < 0 || benchChanged
        ? Infinity
        : maxSourceDelta(bench.sources.data, bench.sources.count, this.snapshot, this.snapshotCount);
      if (delta > FIELD_SOURCE_CHANGE_EPS && (benchChanged || f.wallTime - this.lastSweepStart >= plan.minIntervalS)) {
        this.startSweep(bench, f.wallTime);
      }
    }
    this.slab = null;
    if (this.sweepNext >= 0) {
      const z0 = this.sweepNext;
      const count = Math.min(plan.bricksPerFrame, plan.zBricks - z0);
      const desc = { n: this.n, min: bench.decl.bounds[0], max: bench.decl.bounds[1], unitM: bench.unitM };
      writeQueueBuffer(this.device, b.volumeParams, packFieldVolumeParams(desc, this.snapshotCount, z0, count, this.scratch.volume));
      this.slab = { z0, count };
      this.sweepNext = z0 + count >= plan.zBricks ? -1 : z0 + count;
      if (this.sweepNext < 0) {
        this.traceDue = true;
        this.sweeps++;
      }
    }

    const bounds = bench.decl.bounds;
    writeQueueBuffer(this.device, b.streamParams, packStreamParams(bounds, this.seedCount, f.bRefMt, f.time, this.scratch.stream));
    writeQueueBuffer(this.device, b.lineStyle, packLineStyle(f.bRefMt, false, this.scratch.style));

    this.drawSlice = !!f.slice;
    if (f.slice) {
      writeQueueBuffer(this.device, b.sliceParams, packSliceParams(
        bounds, f.slice.axis, f.slice.offset, f.slice.mode, f.devicePos, f.bRefMt, f.time, this.scratch.slice));
    }
    this.drawIso = !!f.isoLevelsMt?.length;
    if (f.isoLevelsMt?.length) {
      writeQueueBuffer(this.device, b.isoParams, packIsoParams(
        bounds, f.isoLevelsMt, f.devicePos, this.n > 64 ? 160 : 96, this.scratch.iso));
    }

    this.particleCount = 0;
    if (f.particles) {
      const p = f.particles;
      const key = `${bench.deviceId}:${p.plan.species}:${p.count}`;
      if (key !== this.particleKey) {
        writeQueueBuffer(this.device, b.particles, new Float32Array(MAX_PARTICLES * (FIELD_PARTICLE_BYTES / 4)));
        this.clearSegments(b.trails, MAX_PARTICLES * FIELD_PARTICLE_TRAIL);
        this.particleKey = key;
      }
      this.particleCount = Math.min(p.count, MAX_PARTICLES);
      writeQueueBuffer(this.device, b.particleParams, packParticleParams(
        bounds, bench.unitM, p.plan, p.efield, p.spawn, this.particleCount, FIELD_PARTICLE_TRAIL,
        this.particleFrame++, FIELD_VOLUME_PER_TESLA, this.scratch.particle));
      writeQueueBuffer(this.device, b.trailStyle, packLineStyle(f.bRefMt, true, this.scratch.style));
    }
    return true;
  }

  private startSweep(bench: BenchField, wallTime: number): void {
    const b = this.buffers!;
    const count = Math.min(bench.sources.count, FIELD_MAX_SOURCES);
    const floats = count * FIELD_SOURCE_FLOATS;
    if (this.snapshot.length < floats) this.snapshot = new Float32Array(floats);
    this.snapshot.set(bench.sources.data.subarray(0, floats));
    this.snapshotCount = count;
    if (count > 0) writeQueueBuffer(this.device, b.sources, this.snapshot.subarray(0, floats));
    this.seedCount = Math.min(bench.seeds.count, FIELD_MAX_SEEDS);
    if (this.seedCount > 0) writeQueueBuffer(this.device, b.seeds, bench.seeds.data.subarray(0, this.seedCount * 4));
    if (bench.deviceId !== this.benchId) {
      this.clearSegments(b.segments, FIELD_MAX_SEEDS * FIELD_SEGMENTS_PER_LINE);
      this.benchId = bench.deviceId;
    }
    this.sweepNext = 0;
    this.lastSweepStart = wallTime;
  }

  /** The `field-volume` frame-graph pass: its own compute pass, so it gets its own GPU timestamp. */
  encode(encoder: GPUCommandEncoder, timestampWrites?: GPUComputePassTimestampWrites): boolean {
    if (!this.active || !this.compute || !this.groups) return false;
    const pass = encoder.beginComputePass({ label: 'field-volume', timestampWrites });
    if (this.slab && this.snapshotCount >= 0) {
      const g = this.n / FIELD_BRICK;
      pass.setPipeline(this.compute.volume);
      pass.setBindGroup(0, this.groups.volume);
      pass.dispatchWorkgroups(g, g, this.slab.count);
    }
    if (this.traceDue && this.seedCount > 0) {
      pass.setPipeline(this.compute.streamlines);
      pass.setBindGroup(0, this.groups.stream);
      pass.dispatchWorkgroups(Math.ceil(this.seedCount / 64));
      this.traceDue = false;
    }
    if (this.particleCount > 0 && this.sweeps > 0) {
      pass.setPipeline(this.compute.particles);
      pass.setBindGroup(0, this.groups.charges);
      pass.dispatchWorkgroups(Math.ceil(this.particleCount / 64));
    }
    pass.end();
    return true;
  }

  /** True once lines have been traced for `deviceId` (consumers then skip their fallback lines). */
  linesLiveFor(deviceId: string): boolean {
    return this.active && !!this.groups && this.sweeps > 0 && this.benchId === deviceId;
  }

  isoActive(): boolean {
    return this.active && this.drawIso && this.sweeps > 0;
  }

  /** Field lines and particle trails, after the opaque device meshes. */
  drawLines(pass: GPURenderPassEncoder, msaa: boolean, device: FieldLineDrawDevice): void {
    if (!this.active || !this.groups || !this.buffers || this.sweeps === 0) return;
    const pipes = msaa ? this.render4 : this.render1;
    if (!pipes) return;
    const offsets = [device._deviceUniformOffset(0, 'field-lines')];
    pass.setPipeline(pipes.lines);
    if (this.seedCount > 0) {
      pass.setBindGroup(1, this.lineBindGroup(device, false), offsets);
      pass.draw(4, this.seedCount * FIELD_SEGMENTS_PER_LINE);
    }
    if (this.particleCount > 0) {
      pass.setBindGroup(1, this.lineBindGroup(device, true), offsets);
      pass.draw(4, this.particleCount * FIELD_PARTICLE_TRAIL);
    }
  }

  /** Slice plane and isosurfaces (transparent, last in the scene pass). */
  drawOverlays(pass: GPURenderPassEncoder, msaa: boolean): void {
    if (!this.active || !this.groups || this.sweeps === 0) return;
    const pipes = msaa ? this.render4 : this.render1;
    if (!pipes) return;
    if (this.drawIso) {
      pass.setPipeline(pipes.iso);
      pass.setBindGroup(1, this.groups.iso);
      pass.draw(36);
    }
    if (this.drawSlice) {
      pass.setPipeline(pipes.slice);
      pass.setBindGroup(1, this.groups.slice);
      pass.draw(6);
    }
  }

  private lineBindGroup(device: FieldLineDrawDevice, trail: boolean): GPUBindGroup {
    const ring = device._deviceUniformResource();
    const hit = this.lineGroup.find((g) => g.trail === trail && g.buffer === ring.buffer);
    if (hit) return hit.group;
    const b = this.buffers!;
    const group = this.host.pipelineCache!.createBindGroup('fieldLines', [
      { binding: 1, resource: ring },
      { binding: 2, resource: { buffer: trail ? b.trails : b.segments } },
      { binding: 3, resource: { buffer: trail ? b.trailStyle : b.lineStyle } }
    ], trail ? 'field-trails-bg' : 'field-lines-bg');
    this.lineGroup = this.lineGroup.filter((g) => g.trail !== trail);
    this.lineGroup.push({ group, buffer: ring.buffer, trail });
    return group;
  }

  /**
   * B (T) at device-local scene-unit points, evaluated by field-probe.wgsl
   * from a copy of the current sweep's source snapshot — the numbers the
   * volume was built from. The copy is re-uploaded with the dispatch and
   * returned, so a caller compares against exactly what the GPU summed even
   * if a frame starts a new sweep before the readback lands. Debug / golden
   * only (`window.fieldVolume.probeGpu`).
   */
  async probeGpu(
    points: ReadonlyArray<ArrayLike<number>>,
    unitM: number
  ): Promise<{ B: Float32Array; sources: Float32Array; count: number } | null> {
    if (!this.compute || !this.groups || !this.buffers || this.snapshotCount < 0) return null;
    const b = this.buffers;
    const sourceCount = this.snapshotCount;
    const sources = this.snapshot.slice(0, sourceCount * FIELD_SOURCE_FLOATS);
    const count = Math.min(points.length, FIELD_PROBE_MAX_POINTS);
    const pts = new Float32Array(FIELD_PROBE_MAX_POINTS * 4);
    for (let i = 0; i < count; i++) for (let c = 0; c < 3; c++) pts[i * 4 + c] = points[i][c];
    if (sourceCount > 0) writeQueueBuffer(this.device, b.sources, sources);
    writeQueueBuffer(this.device, b.probePoints, pts);
    writeQueueBuffer(this.device, b.probeInfo, new Float32Array([unitM, sourceCount, count, 0]));
    const readback = this.device.createBuffer({ label: 'field-probe-readback', size: Math.max(16, count * 16), usage: U.MAP_READ | U.COPY_DST });
    const encoder = this.device.createCommandEncoder({ label: 'field-probe' });
    const pass = encoder.beginComputePass({ label: 'field-probe' });
    pass.setPipeline(this.compute.probe);
    pass.setBindGroup(0, this.groups.probe);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(b.probeResults, 0, readback, 0, count * 16);
    this.device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const B = new Float32Array(readback.getMappedRange().slice(0));
    readback.unmap();
    readback.destroy();
    return { B, sources, count: sourceCount };
  }

  destroy(): void {
    this.release();
    this.ready = false;
  }
}
