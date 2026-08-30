/**
 * Explicit GPUBindGroupLayout / GPUPipelineLayout cache and shared pipeline factory.
 *
 * Binding numbers are documented in docs/BINDINGS.md — keep WGSL and layout modules aligned.
 */

import type { MultiDeviceShaders } from '../multi-device-shaders.js';
import type { BindGroupLayoutName, LayoutRegistrar, PipelineLayoutName } from './types.js';
import { registerParticleLayouts } from './layouts/particle.js';
import { registerCullLayouts } from './layouts/cull.js';
import { registerSegEnhancedLayouts } from './layouts/seg-enhanced.js';
import { registerDeviceMeshLayouts } from './layouts/device-mesh.js';
import { registerPostLayouts } from './layouts/post.js';
import { ensureDevicePipelines as ensureDevicePipelinesImpl } from './factories/device-pipelines.js';
import {
  ensureEnergyPipePipeline as ensureEnergyPipePipelineImpl,
  ensureEnergyPipeComputePipeline as ensureEnergyPipeComputePipelineImpl,
  ensureOverviewCullPipeline as ensureOverviewCullPipelineImpl,
  ensureSkyPipeline as ensureSkyPipelineImpl,
  ensureGridPipeline as ensureGridPipelineImpl,
  ensureAnomalyWallPipeline as ensureAnomalyWallPipelineImpl,
  ensureBloomPipelines as ensureBloomPipelinesImpl,
  ensureSsrPipeline as ensureSsrPipelineImpl
} from './factories/scene-pipelines.js';
import {
  ensureRollerComputePipeline as ensureRollerComputePipelineImpl,
  ensureFieldAdvectPipeline as ensureFieldAdvectPipelineImpl,
  ensureChoresReducePipeline as ensureChoresReducePipelineImpl,
  ensureTransformerFluxPipeline as ensureTransformerFluxPipelineImpl,
  ensureFluxTracerPipeline as ensureFluxTracerPipelineImpl
} from './factories/seg-compute.js';

export type { BindGroupLayoutName, PipelineLayoutName } from './types.js';
export {
  VB_POS_NORMAL,
  VB_POS_NORMAL_UV,
  VB_ENERGY_ARC,
  VB_GRID,
  SSR_FORMAT
} from './helpers.js';

export class PipelineLayoutCache implements LayoutRegistrar {
  readonly device: GPUDevice;
  readonly canvasFormat: GPUTextureFormat;
  readonly depthFormat: GPUTextureFormat;

  readonly bindGroupLayouts = new Map<string, GPUBindGroupLayout>();
  readonly pipelineLayouts = new Map<string, GPUPipelineLayout>();
  readonly pipelines = new Map<string, GPURenderPipeline | GPUComputePipeline>();
  readonly shaderModules = new Map<string, GPUShaderModule>();

  readonly stats: {
    pipelineCreates: number;
    pipelineCacheHits: number;
    shaderModuleCreates: number;
  };

  constructor(
    device: GPUDevice,
    formats: { canvasFormat: GPUTextureFormat; depthFormat: GPUTextureFormat }
  ) {
    this.device = device;
    this.canvasFormat = formats.canvasFormat;
    this.depthFormat = formats.depthFormat;

    this.stats = {
      pipelineCreates: 0,
      pipelineCacheHits: 0,
      shaderModuleCreates: 0
    };

    this._buildLayouts();
  }

  bgl(name: BindGroupLayoutName, entries: GPUBindGroupLayoutEntry[]): void {
    const layout = this.device.createBindGroupLayout({
      label: `bgl-${name}`,
      entries
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

  setEmptyGroupsPipeline(layout: GPUPipelineLayout): void {
    this.pipelineLayouts.set('emptyGroups', layout);
  }

  private _buildLayouts(): void {
    registerParticleLayouts(this);
    registerCullLayouts(this);
    registerSegEnhancedLayouts(this);
    registerDeviceMeshLayouts(this);
    registerPostLayouts(this);
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
      entries
    });
  }

  shaderModule(label: string, code: string): GPUShaderModule {
    const key = label;
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

  async getOrCreatePipeline<T extends GPURenderPipeline | GPUComputePipeline>(
    key: string,
    factory: () => T | Promise<T>
  ): Promise<T> {
    const cached = this.pipelines.get(key);
    if (cached) {
      this.stats.pipelineCacheHits++;
      return cached as T;
    }
    const pipeline = await factory();
    this.pipelines.set(key, pipeline);
    this.stats.pipelineCreates++;
    return pipeline;
  }

  depthStencil(writeEnabled: boolean, compare: GPUCompareFunction = 'less'): GPUDepthStencilState {
    return {
      format: this.depthFormat,
      depthWriteEnabled: writeEnabled,
      depthCompare: compare
    };
  }

  async ensureDevicePipelines(shaders: MultiDeviceShaders): Promise<void> {
    return ensureDevicePipelinesImpl(this, shaders);
  }

  getPipeline(key: string): GPURenderPipeline | GPUComputePipeline | null {
    return this.pipelines.get(key) || null;
  }

  getParticleComputePipeline(): GPURenderPipeline | GPUComputePipeline | null {
    return this.pipelines.get('particleCompute') || null;
  }

  async ensureEnergyPipePipeline(shaders: MultiDeviceShaders): Promise<GPURenderPipeline> {
    return ensureEnergyPipePipelineImpl(this, shaders);
  }

  async ensureEnergyPipeComputePipeline(shaders: MultiDeviceShaders): Promise<GPUComputePipeline> {
    return ensureEnergyPipeComputePipelineImpl(this, shaders);
  }

  async ensureOverviewCullPipeline(shaders: MultiDeviceShaders): Promise<GPUComputePipeline> {
    return ensureOverviewCullPipelineImpl(this, shaders);
  }

  async ensureSkyPipeline(shaders: MultiDeviceShaders): Promise<GPURenderPipeline> {
    return ensureSkyPipelineImpl(this, shaders);
  }

  async ensureGridPipeline(shaders: MultiDeviceShaders): Promise<GPURenderPipeline> {
    return ensureGridPipelineImpl(this, shaders);
  }

  async ensureAnomalyWallPipeline(shaders: MultiDeviceShaders): Promise<GPURenderPipeline> {
    return ensureAnomalyWallPipelineImpl(this, shaders);
  }

  async ensureBloomPipelines(shaders: MultiDeviceShaders): Promise<void> {
    return ensureBloomPipelinesImpl(this, shaders);
  }

  async ensureSsrPipeline(code: string): Promise<GPUComputePipeline> {
    return ensureSsrPipelineImpl(this, code);
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
}
