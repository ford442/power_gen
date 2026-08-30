import { DeviceGeometry } from './device-geometry.js';
import { DevicePipelineManager } from './device-pipeline-manager.js';
import { DeviceUniformManager } from './device-uniforms.js';
import { DeviceComputeManager } from './device-compute.js';
import { DEVICE_MESH_LAYOUTS } from './device-mesh-layouts.js';
import { createDevicePhysicsState } from './renderers/shared/device-physics';
import type { DevicePhysicsState, HeronLayout } from './renderers/shared/device-physics';
import { getHeronLayout } from './heron-layout.js';

import {
  getDeviceModeIndex,
  getPluginMeshLayouts
} from './devices/device-registry.js';
import type { MergedDeviceConfigEntry } from './devices/device-registry.js';
import { DeviceSetupMixin } from './devices/device-setup.js';
import { DeviceRenderMixin } from './devices/device-render';
import { DeviceUpdateMixin } from './devices/device-update';
import type { BindGroupCache } from './renderers/shared/bind-group-cache';
import type {
  BindGroupLayoutName,
  DeviceGeometryLike,
  DeviceInstanceLike,
  VisualizerLike
} from './devices/types';

/**
 * Constructor config from getMergedDeviceConfig(). Stored as DeviceInstanceLike['config']
 * via a structural cast (MergedDeviceConfigEntry has no string index signature).
 */
export type DeviceInstanceConfig = MergedDeviceConfigEntry;

type DeviceGeometryHost = DeviceGeometryLike & {
  particles: GPUBuffer;
  rollerInstances: GPUBuffer | null;
  fieldLineParticles: GPUBuffer | null;
  energyArcParticles: GPUBuffer | null;
  coreInstances: GPUBuffer | null;
  shaftInstanceBuffer: GPUBuffer | null;
  magnetInstanceBuffer: GPUBuffer | null;
  topPlateInstanceBuffer: GPUBuffer | null;
  bottomPlateInstanceBuffer: GPUBuffer | null;
  electromagnetInstances: GPUBuffer | null;
  fluxSegmentBuffer: GPUBuffer | null;
  setupParticles: () => Promise<void>;
  initializeSEG: () => Promise<void>;
  initializeDeviceMesh: () => Promise<void>;
  applyHeronLayout?: (presetId: string) => Promise<void>;
  reseedParticles?: () => void;
};

type DeviceUniformManagerHost = DeviceInstanceLike['uniformManager'] & {
  deviceUniformBuffer: GPUBuffer;
  materialUniformBuffer: GPUBuffer;
  coreMaterialBuffer: GPUBuffer | null;
  gaugeInstanceBuffer: GPUBuffer | null;
  coilMaterialBuffer: GPUBuffer | null;
  ringMaterialBuffer: GPUBuffer | null;
  coilInstances: GPUBuffer | null;
  batteryCharge: number;
  setupUniforms: () => Promise<void>;
};

type DeviceComputeManagerHost = DeviceInstanceLike['computeManager'] & {
  computePipeline: GPUComputePipeline | null;
  computeBindGroup: GPUBindGroup | null;
  computeUniformBuffer: GPUBuffer | null;
  scaledParticleCount: number;
  speedMult: number;
  setupComputeResources: () => Promise<void>;
};

type DevicePipelineManagerHost = NonNullable<DeviceInstanceLike['pipelineManager']> & {
  rollerPipeline: GPURenderPipeline | null;
  particlePipeline: GPURenderPipeline | null;
  corePipeline: GPURenderPipeline | null;
  fieldLinePipeline: GPURenderPipeline | null;
  energyArcPipeline: GPURenderPipeline | null;
  coilPipeline: GPURenderPipeline | null;
  segEnhancedPipeline: GPURenderPipeline | null;
  ringPipeline: GPURenderPipeline | null;
  fluxSegmentPipeline: GPURenderPipeline | null;
  setupPipelines: () => Promise<void>;
  /** Swap every render pipeline between its base/MSAA-4x variant (ADR-0005 WS2) — see device-pipeline-manager.js. */
  applyMsaaState: (active: boolean) => void;
};

/**
 * Mixin methods bound onto each instance in the constructor.
 * Declared via interface merging so callers see real signatures (same pattern as
 * MultiDeviceVisualizer).
 */
export interface DeviceInstance {
  setupRollerCompute(): Promise<void>;
  setupFieldAdvect(): Promise<void>;
  setupFluxLineTracer(): Promise<void>;
  setupTransformerFlux(): Promise<void>;
  setupEffectsParticles(): void;

  _ensureBgCache(): BindGroupCache;
  _cacheBg(
    key: string,
    layoutName: BindGroupLayoutName,
    entries: GPUBindGroupEntry[],
    label?: string
  ): GPUBindGroup;
  _enhancedBindGroup(
    globalUniformBuffer: GPUBuffer,
    instanceBuffer: GPUBuffer,
    keySuffix?: string
  ): GPUBindGroup;
  _rollerBindGroup(
    globalUniformBuffer: GPUBuffer,
    instanceBuffer: GPUBuffer,
    keySuffix?: string
  ): GPUBindGroup;
  _ensureRingUniformBuffers(): void;
  renderDeviceMesh(renderPass: GPURenderPassEncoder, globalUniformBuffer: GPUBuffer): void;
  render(renderPass: GPURenderPassEncoder, globalUniformBuffer: GPUBuffer, skipEffects?: boolean): void;
  renderBase(renderPass: GPURenderPassEncoder, globalUniformBuffer: GPUBuffer): void;
  renderGltfHousing(renderPass: GPURenderPassEncoder, globalUniformBuffer: GPUBuffer): void;
  renderFrame(renderPass: GPURenderPassEncoder, globalUniformBuffer: GPUBuffer): void;
  renderStatorRings(renderPass: GPURenderPassEncoder, globalUniformBuffer: GPUBuffer): void;
  renderWiring(renderPass: GPURenderPassEncoder, globalUniformBuffer: GPUBuffer): void;
  renderCore(renderPass: GPURenderPassEncoder, globalUniformBuffer: GPUBuffer): void;
  renderPickupCoils(renderPass: GPURenderPassEncoder, globalUniformBuffer: GPUBuffer): void;
  renderStand(renderPass: GPURenderPassEncoder, globalUniformBuffer: GPUBuffer): void;
  renderWires(renderPass: GPURenderPassEncoder, globalUniformBuffer: GPUBuffer): void;

  update(deltaTime: number, qualityScale: number): void;
  updateDeviceFlowPaths(deltaTime: number): void;
  _computeEnergyLevel(deltaTime: number): void;
  _buildDeviceUniformData(renderMode: number, yOffset?: number): Float32Array<ArrayBuffer>;
  updateEmitterEffects(deltaTime: number, qualityScale: number): void;
  updateElectromagnetCoils(): void;
  updatePickupCoilEnergies(rollerData?: Float32Array, compact?: boolean): void;
  updateEnergyArcs(): void;
  updateFieldLines(): void;

  // Assigned by device-setup.js compute helpers
  rollerComputePipeline?: GPUComputePipeline | null;
  rollerComputeBindGroup?: GPUBindGroup | null;
  fluxTracerPipeline?: GPUComputePipeline | null;
  fluxTracerBindGroup?: GPUBindGroup | null;
  transformerFluxPipeline?: GPUComputePipeline | null;
  transformerFluxBindGroup?: GPUBindGroup | null;
  transformerFluxLineCount?: number;
  particleBaseCount?: number;
  particleLodLevel?: number;
  _meshDrawDetail?: string;
  _anomalyT?: number;
  _prevEffectBudget?: number;
}

function bindMixinFunctions(target: object, mixin: Record<string, unknown>): void {
  for (const [name, value] of Object.entries(mixin)) {
    if (typeof value === 'function') {
      Reflect.set(target, name, value.bind(target));
    }
  }
}

export class DeviceInstance {
  device: GPUDevice;
  readonly id: string;
  /** Satisfies DeviceInstanceLike.config (indexable bag + optional core). */
  config: DeviceInstanceLike['config'];
  visualizer: VisualizerLike;

  particleCount: number;
  geometry: DeviceGeometryHost;
  pipelineManager: DevicePipelineManagerHost;
  uniformManager: DeviceUniformManagerHost;
  computeManager: DeviceComputeManagerHost;

  position: ArrayLike<number>;
  rotation: ArrayLike<number>;
  renderMode: number;
  physicsState: DevicePhysicsState | null = null;

  fieldLineCount: number;
  fieldLineEnabled: boolean;
  arcSegmentCount: number;
  arcSegments: GPUBuffer | null;
  energyArcEnabled: boolean;
  lastArcTime: number;

  coilEnergies?: Float32Array;
  _lastCoilCount?: number;
  _rollerPositions: Float32Array;

  maxEffectParticles: number;
  effectParticleCount: number;
  effectsParticles: GPUBuffer | null;
  _effectParticleData: Float32Array<ArrayBuffer>;

  energyLevel: number;
  pwmEnergyLevel: number;
  flowEnergyLevel: number;
  voltageEnergyLevel: number;

  // Delegated via Object.defineProperty — typed for DeviceInstanceLike / callers
  particles!: GPUBuffer;
  rollerInstances!: GPUBuffer | null;
  fieldLineParticles!: GPUBuffer | null;
  energyArcParticles!: GPUBuffer | null;
  coreInstances!: GPUBuffer | null;
  shaftInstanceBuffer!: GPUBuffer | null;
  magnetInstanceBuffer!: GPUBuffer | null;
  topPlateInstanceBuffer!: GPUBuffer | null;
  bottomPlateInstanceBuffer!: GPUBuffer | null;
  electromagnetInstances!: GPUBuffer | null;
  fluxSegmentBuffer!: GPUBuffer | null;

  rollerPipeline!: GPURenderPipeline | null;
  particlePipeline!: GPURenderPipeline;
  corePipeline!: GPURenderPipeline | null;
  fieldLinePipeline!: GPURenderPipeline | null;
  energyArcPipeline!: GPURenderPipeline | null;
  coilPipeline!: GPURenderPipeline | null;
  segEnhancedPipeline!: GPURenderPipeline | null;
  ringPipeline!: GPURenderPipeline | null;
  fluxSegmentPipeline!: GPURenderPipeline | null;

  deviceUniformBuffer!: GPUBuffer;
  materialUniformBuffer!: GPUBuffer;
  coreMaterialBuffer!: GPUBuffer | null;
  gaugeInstanceBuffer!: GPUBuffer | null;
  coilMaterialBuffer!: GPUBuffer | null;
  ringMaterialBuffer!: GPUBuffer | null;
  coilInstances!: GPUBuffer | null;
  batteryCharge!: number;

  computePipeline!: GPUComputePipeline | null;
  computeBindGroup!: GPUBindGroup | null;
  computeUniformBuffer!: GPUBuffer | null;
  scaledParticleCount!: number;
  speedMult!: number;

  constructor(
    device: GPUDevice,
    id: string,
    config: DeviceInstanceConfig,
    visualizer: VisualizerLike
  ) {
    this.device = device;
    this.id = id;
    this.config = config as unknown as DeviceInstanceLike['config'];
    this.visualizer = visualizer;
    this.particleCount = config.particleCount ?? 0;
    this.geometry = new DeviceGeometry(
      device,
      id,
      config,
      visualizer
    ) as unknown as DeviceGeometryHost;
    this.pipelineManager = new DevicePipelineManager(
      device,
      id,
      visualizer
    ) as unknown as DevicePipelineManagerHost;
    this.uniformManager = new DeviceUniformManager(
      device,
      id,
      config,
      visualizer
    ) as unknown as DeviceUniformManagerHost;
    this.computeManager = new DeviceComputeManager(
      device,
      id,
      config,
      this.pipelineManager,
      this.geometry
    ) as unknown as DeviceComputeManagerHost;

    Object.defineProperty(this, 'particles', { get: () => this.geometry.particles });

    // Bind every extracted mixin method. Enumerating them by hand used to drop
    // helpers the mixins call on `this` (`updateDeviceFlowPaths`, the bind-group
    // builders), which threw on the first frame; binding whole mixins keeps the
    // instance surface in step as the mixins grow.
    for (const mixin of [DeviceSetupMixin, DeviceRenderMixin, DeviceUpdateMixin]) {
      bindMixinFunctions(this, mixin as Record<string, unknown>);
    }

    Object.defineProperty(this, 'rollerInstances', { get: () => this.geometry.rollerInstances });
    Object.defineProperty(this, 'fieldLineParticles', { get: () => this.geometry.fieldLineParticles });
    Object.defineProperty(this, 'energyArcParticles', { get: () => this.geometry.energyArcParticles });
    Object.defineProperty(this, 'coreInstances', { get: () => this.geometry.coreInstances });
    Object.defineProperty(this, 'shaftInstanceBuffer', { get: () => this.geometry.shaftInstanceBuffer });
    Object.defineProperty(this, 'magnetInstanceBuffer', { get: () => this.geometry.magnetInstanceBuffer });
    Object.defineProperty(this, 'topPlateInstanceBuffer', { get: () => this.geometry.topPlateInstanceBuffer });
    Object.defineProperty(this, 'bottomPlateInstanceBuffer', { get: () => this.geometry.bottomPlateInstanceBuffer });
    Object.defineProperty(this, 'rollerPipeline', { get: () => this.pipelineManager.rollerPipeline });
    Object.defineProperty(this, 'particlePipeline', { get: () => this.pipelineManager.particlePipeline });
    Object.defineProperty(this, 'corePipeline', { get: () => this.pipelineManager.corePipeline });
    Object.defineProperty(this, 'fieldLinePipeline', { get: () => this.pipelineManager.fieldLinePipeline });
    Object.defineProperty(this, 'energyArcPipeline', { get: () => this.pipelineManager.energyArcPipeline });
    Object.defineProperty(this, 'electromagnetInstances', { get: () => this.geometry.electromagnetInstances });
    Object.defineProperty(this, 'coilPipeline', { get: () => this.pipelineManager.coilPipeline });
    Object.defineProperty(this, 'segEnhancedPipeline', { get: () => this.pipelineManager.segEnhancedPipeline });
    Object.defineProperty(this, 'ringPipeline', { get: () => this.pipelineManager.ringPipeline });
    Object.defineProperty(this, 'fluxSegmentBuffer', { get: () => this.geometry.fluxSegmentBuffer });
    Object.defineProperty(this, 'fluxSegmentPipeline', { get: () => this.pipelineManager.fluxSegmentPipeline });

    Object.defineProperty(this, 'deviceUniformBuffer', {
      get: () => this.uniformManager.deviceUniformBuffer,
      set: (v: GPUBuffer) => { this.uniformManager.deviceUniformBuffer = v; }
    });
    Object.defineProperty(this, 'materialUniformBuffer', {
      get: () => this.uniformManager.materialUniformBuffer,
      set: (v: GPUBuffer) => { this.uniformManager.materialUniformBuffer = v; }
    });
    Object.defineProperty(this, 'coreMaterialBuffer', {
      get: () => this.uniformManager.coreMaterialBuffer,
      set: (v: GPUBuffer | null) => { this.uniformManager.coreMaterialBuffer = v; }
    });
    Object.defineProperty(this, 'gaugeInstanceBuffer', {
      get: () => this.uniformManager.gaugeInstanceBuffer,
      set: (v: GPUBuffer | null) => { this.uniformManager.gaugeInstanceBuffer = v; }
    });
    Object.defineProperty(this, 'coilMaterialBuffer', {
      get: () => this.uniformManager.coilMaterialBuffer,
      set: (v: GPUBuffer | null) => { this.uniformManager.coilMaterialBuffer = v; }
    });
    Object.defineProperty(this, 'ringMaterialBuffer', {
      get: () => this.uniformManager.ringMaterialBuffer,
      set: (v: GPUBuffer | null) => { this.uniformManager.ringMaterialBuffer = v; }
    });
    Object.defineProperty(this, 'coilInstances', {
      get: () => this.uniformManager.coilInstances,
      set: (v: GPUBuffer | null) => { this.uniformManager.coilInstances = v; }
    });
    Object.defineProperty(this, 'batteryCharge', {
      get: () => this.uniformManager.batteryCharge,
      set: (v: number) => { this.uniformManager.batteryCharge = v; }
    });

    Object.defineProperty(this, 'computePipeline', {
      get: () => this.computeManager.computePipeline,
      set: (v: GPUComputePipeline | null) => { this.computeManager.computePipeline = v; }
    });
    Object.defineProperty(this, 'computeBindGroup', {
      get: () => this.computeManager.computeBindGroup,
      set: (v: GPUBindGroup | null) => { this.computeManager.computeBindGroup = v; }
    });
    Object.defineProperty(this, 'computeUniformBuffer', {
      get: () => this.computeManager.computeUniformBuffer,
      set: (v: GPUBuffer | null) => { this.computeManager.computeUniformBuffer = v; }
    });
    Object.defineProperty(this, 'scaledParticleCount', {
      get: () => this.computeManager.scaledParticleCount,
      set: (v: number) => { this.computeManager.scaledParticleCount = v; }
    });
    Object.defineProperty(this, 'speedMult', {
      get: () => this.computeManager.speedMult,
      set: (v: number) => { this.computeManager.speedMult = v; }
    });

    this.position = config.position ?? [0, 0, 0];
    this.rotation = config.rotation ?? [0, 0, 0, 1];
    this.renderMode = 0;

    this.fieldLineCount = 1200;
    this.fieldLineEnabled = true;

    this.arcSegmentCount = 20;
    this.arcSegments = null;
    this.energyArcEnabled = true;
    this.lastArcTime = 0;

    this.coilEnergies = undefined;
    this._lastCoilCount = undefined;

    this._rollerPositions = new Float32Array(36 * 2);

    this.maxEffectParticles = 512;
    this.effectParticleCount = 0;
    this.effectsParticles = null;
    this._effectParticleData = new Float32Array(
      this.maxEffectParticles * 4
    ) as Float32Array<ArrayBuffer>;

    this.energyLevel = 0.0;
    this.pwmEnergyLevel = 0.0;
    this.flowEnergyLevel = 0.0;
    this.voltageEnergyLevel = 0.0;
  }

  async init(): Promise<void> {
    await this.uniformManager.setupUniforms();
    await this.pipelineManager.setupPipelines();
    await this.geometry.setupParticles();
    await this.computeManager.setupComputeResources();
    this.setupEffectsParticles();

    if (this.id === 'seg') {
      await this.geometry.initializeSEG();

      this.arcSegments = this.geometry.energyArcParticles;

      await this.setupRollerCompute();
      await this.setupFieldAdvect();
      await this.setupFluxLineTracer();
    } else if (DEVICE_MESH_LAYOUTS[this.id] || getPluginMeshLayouts()[this.id]) {
      await this.geometry.initializeDeviceMesh();
      if (this.id === 'transformer') {
        await this.setupTransformerFlux();
      }
    }
  }

  getRingIndex(): number {
    return getDeviceModeIndex(this.id);
  }

  /**
   * Reset simulation accumulators when the user enters this device's focused view.
   */
  resetForModeEntry(): void {
    if (['heron', 'kelvin', 'solar', 'peltier', 'mhd', 'maglev', 'homopolar', 'halbach-viz', 'pulse-coil', 'transformer'].includes(this.id)) {
      const heronLayout: HeronLayout | undefined = this.id === 'heron'
        ? ((this.visualizer.heronLayout as HeronLayout | undefined) ||
          getHeronLayout(this.visualizer.heronLayoutPreset))
        : undefined;
      this.physicsState = createDevicePhysicsState(this.id, { heronLayout });
      if (this.id === 'solar') {
        this.batteryCharge = this.physicsState.batteryCharge;
        this.uniformManager.batteryCharge = this.physicsState.batteryCharge;
        this.visualizer.updateBatteryGaugeMesh?.(this.batteryCharge);
      }
      this.flowEnergyLevel = 0;
      this.voltageEnergyLevel = 0;
      this.energyLevel = 0;
    }

    this.effectParticleCount = 0;
    this.geometry.reseedParticles?.();
  }
}

/** Compile-time check: instance type remains assignable to the mixin contract. */
type _AssertDeviceInstanceLike = DeviceInstance extends DeviceInstanceLike ? true : never;
const _assertDeviceInstanceLike: _AssertDeviceInstanceLike = true;
void _assertDeviceInstanceLike;
