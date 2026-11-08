/**
 * Explicit GPUBindGroupLayout / GPUPipelineLayout cache and shared pipeline factory.
 *
 * Binding numbers are documented in docs/BINDINGS.md — keep WGSL and layout modules aligned.
 */

import type { MultiDeviceShaders } from '../multi-device-shaders.js';
import type { ColorTargets } from '../webgpu-init/color-pipeline.js';
import type { BindGroupLayoutName, LayoutRegistrar, PipelineLayoutName } from './types.js';
import { registerFrameLayout } from './layouts/frame.js';
import { registerParticleLayouts } from './layouts/particle.js';
import { registerCullLayouts } from './layouts/cull.js';
import { registerSegEnhancedLayouts } from './layouts/seg-enhanced.js';
import { registerDeviceMeshLayouts } from './layouts/device-mesh.js';
import { registerPostLayouts } from './layouts/post.js';
import { registerFdtdLayouts } from './layouts/fdtd.js';
import {
  ensureDevicePipelines as ensureDevicePipelinesImpl,
  ensureShadowCasterPipelines as ensureShadowCasterPipelinesImpl,
  type DevicePipelineOptions
} from './factories/device-pipelines.js';
import {
  ensureEnergyPipePipeline as ensureEnergyPipePipelineImpl,
  ensureEnergyPipeComputePipeline as ensureEnergyPipeComputePipelineImpl,
  ensureOverviewCullPipeline as ensureOverviewCullPipelineImpl,
  ensureSkyPipeline as ensureSkyPipelineImpl,
  ensureGridPipeline as ensureGridPipelineImpl,
  ensureAnomalyWallPipeline as ensureAnomalyWallPipelineImpl,
  ensureBloomPipelines as ensureBloomPipelinesImpl,
  ensureSsrPipeline as ensureSsrPipelineImpl,
  ensureIblPrefilterPipeline as ensureIblPrefilterPipelineImpl,
  ensureTaaResolvePipeline as ensureTaaResolvePipelineImpl,
  ensureDepthResolvePipeline as ensureDepthResolvePipelineImpl
} from './factories/scene-pipelines.js';
import {
  ensureRollerComputePipeline as ensureRollerComputePipelineImpl,
  ensureFieldAdvectPipeline as ensureFieldAdvectPipelineImpl,
  ensureChoresReducePipeline as ensureChoresReducePipelineImpl,
  ensureTransformerFluxPipeline as ensureTransformerFluxPipelineImpl,
  ensureFluxTracerPipeline as ensureFluxTracerPipelineImpl
} from './factories/seg-compute.js';
import {
  ensureFdtdComputePipelines as ensureFdtdComputePipelinesImpl,
  ensureFdtdSlicePipeline as ensureFdtdSlicePipelineImpl,
  type FdtdComputePipelines
} from './factories/fdtd-pipelines.js';

export type { BindGroupLayoutName, PipelineLayoutName } from './types.js';
export type { DevicePipelineOptions } from './factories/device-pipelines.js';
export type { FdtdComputePipelines } from './factories/fdtd-pipelines.js';
export {
  VB_POS_NORMAL,
  VB_POS_NORMAL_UV,
  VB_ENERGY_ARC,
  VB_GRID,
  SSR_FORMAT,
  MATERIAL_GBUFFER_FORMAT
} from './helpers.js';

export class PipelineLayoutCache implements LayoutRegistrar {
  readonly device: GPUDevice;
  /** Session colour formats — see webgpu-init/color-pipeline.ts. */
  readonly colorTargets: ColorTargets;
  /** Every scene-pass pipeline's first color target (and MSAA / TAA / history). */
  readonly sceneFormat: GPUTextureFormat;
  /** Bloom extract / blur / mip-chain target. */
  readonly bloomFormat: GPUTextureFormat;
  /** The composite's target: the canvas view it renders through. */
  readonly outputFormat: GPUTextureFormat;
  readonly depthFormat: GPUTextureFormat;

  readonly bindGroupLayouts = new Map<string, GPUBindGroupLayout>();
  readonly pipelineLayouts = new Map<string, GPUPipelineLayout>();
  readonly pipelines = new Map<string, GPURenderPipeline | GPUComputePipeline>();
  /** Keyed by WGSL source text — see {@link shaderModule}. */
  readonly shaderModules = new Map<string, GPUShaderModule>();
  private readonly pendingPipelines = new Map<string, Promise<GPURenderPipeline | GPUComputePipeline>>();

  readonly stats: {
    pipelineCreates: number;
    pipelineCacheHits: number;
    shaderModuleCreates: number;
  };

  constructor(
    device: GPUDevice,
    formats: { colorTargets: ColorTargets; depthFormat: GPUTextureFormat }
  ) {
    this.device = device;
    this.colorTargets = formats.colorTargets;
    this.sceneFormat = formats.colorTargets.sceneFormat;
    this.bloomFormat = formats.colorTargets.bloomFormat;
    this.outputFormat = formats.colorTargets.outputFormat;
    this.depthFormat = formats.depthFormat;

    this.stats = {
      pipelineCreates: 0,
      pipelineCacheHits: 0,
      shaderModuleCreates: 0
    };

    this._buildLayouts();
  }

  bgl(name: BindGroupLayoutName, entries: readonly GPUBindGroupLayoutEntry[]): void {
    const layout = this.device.createBindGroupLayout({
      label: `bgl-${name}`,
      entries: [...entries]
    });
    this.bindGroupLayouts.set(name, layout);
  }

  pl(name: PipelineLayoutName, bglNames: BindGroupLayoutName[]): void {
    const bindGroupLayouts = bglNames.map((n) => {
      const l = this.bindGroupLayouts.get(n);
      if (!l) throw new Error(`[PipelineLayoutCache] missing BGL "${n}" for pipeline layout "${name}"`);
      return l;
    });
    const layout = this.device.createPipelineLayout({
      label: `pl-${name}`,
      bindGroupLayouts
    });
    this.pipelineLayouts.set(name, layout);
  }

  private _buildLayouts(): void {
    // The scene pass's shared @group(0) — every scene pipeline layout below
    // starts with it (docs/BINDINGS.md → Frame group).
    registerFrameLayout(this);
    registerParticleLayouts(this);
    registerCullLayouts(this);
    registerSegEnhancedLayouts(this);
    registerDeviceMeshLayouts(this);
    registerPostLayouts(this);
    registerFdtdLayouts(this);
  }

  getLayout(name: BindGroupLayoutName): GPUBindGroupLayout {
    const l = this.bindGroupLayouts.get(name);
    if (!l) throw new Error(`[PipelineLayoutCache] unknown bind group layout "${name}"`);
    return l;
  }

  getPipelineLayout(name: PipelineLayoutName): GPUPipelineLayout {
    const l = this.pipelineLayouts.get(name);
    if (!l) throw new Error(`[PipelineLayoutCache] unknown pipeline layout "${name}"`);
    return l;
  }

  createBindGroup(
    layoutName: BindGroupLayoutName,
    entries: GPUBindGroupEntry[],
    label?: string
  ): GPUBindGroup {
    return this.device.createBindGroup({
      label: label || `bg-${layoutName}`,
      layout: this.getLayout(layoutName),
      entries: [...entries]
    });
  }

  /**
   * One module per distinct WGSL source. Keyed by the source text, not the
   * label: two call sites that label the same code differently share a
   * module, and two that reuse a label for different code do not collide.
   * The first caller's label names the module.
   */
  shaderModule(label: string, code: string): GPUShaderModule {
    const key = code;
    const cached = this.shaderModules.get(key);
    if (cached) return cached;
    const module = this.device.createShaderModule({ label, code });
    this.stats.shaderModuleCreates++;
    module.getCompilationInfo?.().then((info) => {
      const errors = info.messages.filter((m) => m.type === 'error');
      if (errors.length) {
        console.error(`[shader:${label}] ${errors.length} compile error(s):`);
        for (const m of errors) {
          console.error(`  ${label}:${m.lineNum}:${m.linePos} ${m.message}`);
        }
      }
    }).catch(() => {});
    this.shaderModules.set(key, module);
    return module;
  }

  /**
   * Cached pipeline for `key`, creating it once. Concurrent callers for the
   * same key (a tier's `Promise.all` racing a setup function) share the one
   * in-flight compile instead of starting a second.
   */
  async getOrCreatePipeline<T extends GPURenderPipeline | GPUComputePipeline>(
    key: string,
    factory: () => T | Promise<T>
  ): Promise<T> {
    const cached = this.pipelines.get(key);
    if (cached) {
      this.stats.pipelineCacheHits++;
      return cached as T;
    }
    const pending = this.pendingPipelines.get(key);
    if (pending) {
      this.stats.pipelineCacheHits++;
      return pending as Promise<T>;
    }
    const promise = Promise.resolve(factory()).then((pipeline) => {
      this.pipelines.set(key, pipeline);
      this.stats.pipelineCreates++;
      return pipeline;
    }).finally(() => this.pendingPipelines.delete(key));
    this.pendingPipelines.set(key, promise);
    return promise;
  }

  depthStencil(writeEnabled: boolean, compare: GPUCompareFunction = 'less'): GPUDepthStencilState {
    return {
      format: this.depthFormat,
      depthWriteEnabled: writeEnabled,
      depthCompare: compare
    };
  }

  async ensureDevicePipelines(shaders: MultiDeviceShaders, opts?: DevicePipelineOptions): Promise<void> {
    return ensureDevicePipelinesImpl(this, shaders, opts);
  }

  async ensureShadowCasterPipelines(shaders: MultiDeviceShaders): Promise<void> {
    return ensureShadowCasterPipelinesImpl(this, shaders);
  }

  getPipeline(key: string): GPURenderPipeline | GPUComputePipeline | null {
    return this.pipelines.get(key) || null;
  }

  getParticleComputePipeline(): GPURenderPipeline | GPUComputePipeline | null {
    return this.pipelines.get('particleCompute') || null;
  }

  async ensureEnergyPipePipeline(shaders: MultiDeviceShaders, opts?: DevicePipelineOptions): Promise<GPURenderPipeline> {
    return ensureEnergyPipePipelineImpl(this, shaders, opts);
  }

  async ensureEnergyPipeComputePipeline(shaders: MultiDeviceShaders): Promise<GPUComputePipeline> {
    return ensureEnergyPipeComputePipelineImpl(this, shaders);
  }

  async ensureOverviewCullPipeline(shaders: MultiDeviceShaders): Promise<GPUComputePipeline> {
    return ensureOverviewCullPipelineImpl(this, shaders);
  }

  async ensureSkyPipeline(shaders: MultiDeviceShaders, opts?: DevicePipelineOptions): Promise<GPURenderPipeline> {
    return ensureSkyPipelineImpl(this, shaders, opts);
  }

  async ensureGridPipeline(shaders: MultiDeviceShaders, opts?: DevicePipelineOptions): Promise<GPURenderPipeline> {
    return ensureGridPipelineImpl(this, shaders, opts);
  }

  async ensureAnomalyWallPipeline(shaders: MultiDeviceShaders, opts?: DevicePipelineOptions): Promise<GPURenderPipeline> {
    return ensureAnomalyWallPipelineImpl(this, shaders, opts);
  }

  async ensureBloomPipelines(shaders: MultiDeviceShaders): Promise<void> {
    return ensureBloomPipelinesImpl(this, shaders);
  }

  async ensureSsrPipeline(code: string): Promise<GPUComputePipeline> {
    return ensureSsrPipelineImpl(this, code);
  }

  async ensureIblPrefilterPipeline(code: string): Promise<GPUComputePipeline> {
    return ensureIblPrefilterPipelineImpl(this, code);
  }

  async ensureTaaResolvePipeline(
    shaders: { bloomVertShader: string; taaResolveShader: string },
    format: GPUTextureFormat
  ): Promise<GPURenderPipeline> {
    return ensureTaaResolvePipelineImpl(this, shaders, format);
  }

  async ensureDepthResolvePipeline(shaders: MultiDeviceShaders): Promise<GPURenderPipeline> {
    return ensureDepthResolvePipelineImpl(this, shaders);
  }

  async ensureRollerComputePipeline(code: string): Promise<GPUComputePipeline> {
    return ensureRollerComputePipelineImpl(this, code);
  }

  async ensureFieldAdvectPipeline(code: string): Promise<GPUComputePipeline> {
    return ensureFieldAdvectPipelineImpl(this, code);
  }

  async ensureChoresReducePipeline(code: string): Promise<GPUComputePipeline> {
    return ensureChoresReducePipelineImpl(this, code);
  }

  async ensureTransformerFluxPipeline(code: string): Promise<GPUComputePipeline> {
    return ensureTransformerFluxPipelineImpl(this, code);
  }

  async ensureFluxTracerPipeline(code: string): Promise<GPUComputePipeline> {
    return ensureFluxTracerPipelineImpl(this, code);
  }

  async ensureFdtdComputePipelines(code: string): Promise<FdtdComputePipelines> {
    return ensureFdtdComputePipelinesImpl(this, code);
  }

  async ensureFdtdSlicePipeline(code: string, opts?: { sampleCount?: number }): Promise<GPURenderPipeline> {
    return ensureFdtdSlicePipelineImpl(this, code, opts);
  }
}
