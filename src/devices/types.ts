/**
 * Canonical device-layer types (Wave 3).
 *
 * This is the single source of truth for the device plugin contract and for the
 * structural shape of the objects the update/render mixins bind to. It replaces
 * the hand-maintained `device-registry-types.d.ts` stub.
 */

import type { DevicePhysicsState, HeronLayout } from '../renderers/shared/device-physics';
import type { PipelineLayoutCache, BindGroupLayoutName } from '../pipeline-layout-cache';
import type { BindGroupCache } from '../renderers/shared/bind-group-cache';
import type { DeviceMeshLayout } from '../device-mesh-layouts';
import type { OverviewCullPass } from './overview-cull';
import type { DeviceDashboardDefaults } from './device-config';

export type { BindGroupLayoutName };

// ── Geometry / GPU helper shapes ───────────────────────────────────

/** Indexed mesh upload produced by the geometry builders. */
export interface MeshBuffers {
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  indexCount: number;
  vertexCount?: number;
}

/** Non-indexed mesh (coil ribbons). */
export interface VertexOnlyBuffers {
  vertexBuffer: GPUBuffer;
  vertexCount: number;
}

/** A glTF housing part ready to draw. */
export interface GltfDrawable {
  name: string;
  instanceBuffer: GPUBuffer;
  gpu: MeshBuffers;
  propId?: string;
  /** Bench that owns this prop — drives which device draws it and its emissive. */
  deviceId?: string;
  role?: string | null;
  loadPolicy?: 'resident' | 'focus';
  emissiveScale?: number;
  ringIndex?: number;
  annotationId?: string | null;
  albedoTexture?: GPUTexture | null;
}

// ── Per-frame contexts ─────────────────────────────────────────────

/** Per-frame update context passed to device update strategies. */
export interface DeviceUpdateContext {
  deltaTime: number;
  qualityScale: number;
  ringIndex: number;
  scaledParticleCount: number;
  drive: number;
}

/** Effect particle push helper supplied to updateEffects hooks. */
export type EffectPushParticle = (x: number, y: number, z: number, phaseEncoded: number) => void;

export interface DeviceEffectContext extends DeviceUpdateContext {
  budget: number;
  energy: number;
  speedMult: number;
  time: number;
  gate: (value: number, low: number, high: number) => number;
  pushParticle: EffectPushParticle;
}

export interface DeviceFlowPathContext extends DeviceUpdateContext {
  energy: number;
  time: number;
  count: number;
  writePath: (i: number, x: number, y: number, z: number, strength: number, life: number) => void;
}

export interface DeviceEnergyContext {
  deltaTime: number;
  speedNorm: number;
  overdriveBoost: number;
  time: number;
}

export interface DeviceUniformExtras {
  batteryCharge?: number;
  solarFlag?: number;
}

// ── Instance-side structural types ─────────────────────────────────

/** SEG's base plate footprint, mirrored from visualizer.baseInstanceBuffer. */
export interface HeronFlowGeometry {
  apexY: number;
  supplyX: number;
  drainBasinY: number;
}

/**
 * Geometry surface consumed by the update/render mixins (DeviceGeometry).
 * Buffers are null until the matching device mesh is built.
 */
export interface DeviceGeometryLike {
  flowPathParticles: GPUBuffer | null;
  flowPathCount: number;
  fieldLineParticles?: GPUBuffer | null;
  meshCylinderCount?: number;
  meshRingCount?: number;
  meshTubeCount?: number;
  meshPanelCount?: number;
  ringInstances?: GPUBuffer | null;
  tubeInstances?: GPUBuffer | null;
  panelInstances?: GPUBuffer | null;
  statorRingBuffer?: GPUBuffer | null;
  wiringBuffer?: GPUBuffer | null;
  baseBuffer?: GPUBuffer | null;
  rollerInstances?: GPUBuffer | null;
  fluxSegmentBuffer?: GPUBuffer | null;
  fluxTotalSegments?: number;
  /** Heron's Fountain jet/basin geometry, set from the active build preset. */
  heronFlow?: HeronFlowGeometry | null;
  updateElectromagnetLayout?: (numCoils: number, offsetAngleDeg: number) => void;
}

/** One ring of the computed SEG roller/stator layout (see seg-layout.js computeSEGLayout). */
export interface SegLayoutRing {
  index: number;
  fullCount: number;
  count: number;
  orbitRadiusM: number;
  rollerRadiusM: number;
  rollerDiameterM: number;
  rollerHeightM: number;
  statorInnerM: number;
  statorOuterM: number;
  statorHeightM: number;
  statorY: number;
  gapM: number;
  speed: number;
}

/** Full computed SEG layout — literature-grounded roller/stator geometry. */
export interface SegLayout {
  name: string;
  preset: string;
  worldScale: number;
  gapM: number;
  shaftRadiusM: number;
  shaftHeightM: number;
  statorHeightM: number;
  basePlateRadiusM: number;
  cameraOffset: number[];
  rings: SegLayoutRing[];
  ringCount: number;
  totalRollers: number;
  maxRollers: number;
  maxRings: number;
  fluxLinesPerRing: number;
  totalFluxLines: number;
  outerRadiusM: number;
  innerRadiusM: number;
  rollerHeightRatio: number;
}

/** SEG structural frame parts, keyed by level. */
export interface SegFrameBuffers {
  labBench?: MeshBuffers | null;
  structural?: MeshBuffers | null;
  controlBox?: MeshBuffers | null;
  safetyCage?: MeshBuffers | null;
  /** computeFrameDimensions() output (seg-frame-model.ts). */
  dims?: { statorH: number; plateY?: number };
}

/**
 * The MultiDeviceVisualizer surface the device mixins reach into. Kept explicit
 * (no index signature) so a renamed scene buffer is a typecheck failure, not a
 * silently missing draw.
 */
export interface VisualizerLike {
  time: number;
  profiler?: {
    qualityLevel: number;
    qualityTier?: string;
    recordDraw?: (n?: number) => void;
    beginFrameDraws?: () => void;
    trackBuffer?: (name: string, size: number, usage: GPUBufferUsageFlags) => unknown;
  } | null;
  pipelineCache?: PipelineLayoutCache | null;
  /** GPU overview cull pass — drives indirect particle draws (ADR-0005 WS4). */
  overviewCull?: OverviewCullPass | null;
  isOverviewMode?: () => boolean;
  /** Compute/vertex/fragment shader source getters (multi-device-shaders.js). */
  shaders?: {
    segRollerComputeShader?: string;
    segFieldAdvectShader?: string;
    fluxLineTracerShader?: string;
    transformerFluxShader?: string;
  };
  globalUniformBuffer?: GPUBuffer | null;

  heronLayout?: (HeronLayout & { name?: string; description?: string }) | null;
  heronLayoutPreset?: string;

  // SEG operator physics + layout
  segOmega?: number;
  corona?: number;
  segLayout?: SegLayout | null;
  prototypePreset?: string;
  rollerInstanceCullEnabled?: boolean;
  enhancedRollerBuffer?: MeshBuffers | null;

  // Hardware digital twin (Web Serial / mock) — see hardware-bridge.ts
  hardwareBridge?: {
    isConnected?: boolean;
    mirrorEnabled?: boolean;
    twinMode?: string;
    actualPhase?: number;
    config?: { numCoils?: number };
    coilMask?: number;
  } | null;
  // Electromagnet coil driver — see electromagnet-controller.ts
  emController?: {
    numCoils?: number;
    offsetAngle?: number;
    computeCoilMask?: (phaseDeg: number, dir: number) => number;
    computePwmValues?: (phaseDeg: number, dir: number) => number[] | null;
  } | null;
  // Orbit camera — see camera-controller.ts
  camera?: { camera?: { position?: number[] } } | null;

  // Solar battery gauge (3D cylinder mesh resized from charge level)
  updateBatteryGaugeMesh?: (charge?: number) => void;
  batteryGaugeVertexBuffer?: GPUBuffer;
  batteryGaugeIndexBuffer?: GPUBuffer;
  batteryGaugeIndexCount?: number;

  // Shared uniform buffers
  segLayoutUniformBuffer?: GPUBuffer | null;
  lightingUniformBuffer?: GPUBuffer | null;
  materialTableBuffer?: GPUBuffer | null;

  /** Prefiltered GGX environment chain (ADR-0005 WS2) — bound by segEnhanced. */
  iblResources?: {
    texture: GPUTexture;
    sampler: GPUSampler;
    view: GPUTextureView;
    size: number;
    layers: number;
    byteLength: number;
  } | null;

  // Shared geometry
  cylinderBuffer?: MeshBuffers | null;
  kelvinRingBuffer?: MeshBuffers | null;
  deviceTubeBuffer?: MeshBuffers | null;
  solarPanelBuffer?: MeshBuffers | null;
  basePlateBuffer?: MeshBuffers | null;
  statorRingUVBuffer?: MeshBuffers | null;
  wiringUVBuffer?: MeshBuffers | null;
  coreShaftBuffer?: MeshBuffers | null;
  coreMagnetBuffer?: MeshBuffers | null;
  corePlateBuffer?: MeshBuffers | null;
  coreBoltBuffer?: MeshBuffers | null;
  connectionRingBuffer?: MeshBuffers | null;
  standBuffer?: MeshBuffers | null;
  wireBuffers?: MeshBuffers[] | null;
  coilBuffer?: VertexOnlyBuffers | null;

  // Instance buffers
  baseInstanceBuffer?: GPUBuffer | null;
  statorRingInstanceBuffer?: GPUBuffer | null;
  coreBoltInstanceBuffer?: GPUBuffer | null;
  coreBoltPositions?: ArrayLike<number>;
  frameStructuralInstanceBuffer?: GPUBuffer | null;
  frameLabBenchInstanceBuffer?: GPUBuffer | null;
  frameControlInstanceBuffer?: GPUBuffer | null;
  frameCageInstanceBuffer?: GPUBuffer | null;

  // SEG frame / housing
  segFrameLevel?: string;
  segFrameBuffers?: SegFrameBuffers | null;
  gltfHousingEnabled?: boolean;
  gltfHousingDrawables?: GltfDrawable[] | null;
  currentView?: string | null;
}

/**
 * Structural view of DeviceInstance as seen by the update/render mixins.
 * The mixins bind against this contract (implementation: `device-instance.ts`).
 */
export interface DeviceInstanceLike {
  readonly id: string;
  device: GPUDevice;
  config: Record<string, unknown> & { core?: unknown };
  visualizer: VisualizerLike;
  geometry: DeviceGeometryLike;

  particleCount: number;
  scaledParticleCount: number;
  maxEffectParticles: number;
  effectParticleCount: number;
  energyLevel: number;
  speedMult: number;
  renderMode: number;
  position: ArrayLike<number>;
  rotation: ArrayLike<number>;
  physicsState: DevicePhysicsState | null;
  meshCylinderCount?: number;
  /** Overview mesh LOD ladder: full | simplified | proxy | skip */
  _meshDrawDetail?: string;
  /** GPU particle LOD level 0..3 assigned by the overview cull pass. */
  particleLodLevel?: number;
  /** Particle count before LOD when the GPU cull path drives this device. */
  particleBaseCount?: number;
  fieldLineCount: number;

  computeManager: {
    updateComputeUniforms: (
      time: number,
      ringIndex: number,
      particleCount: number,
      speed: number,
      physicsState: DevicePhysicsState | null,
      lodLevel?: number
    ) => void;
  };
  uniformManager: {
    updateUniforms: (
      position: ArrayLike<number>,
      rotation: ArrayLike<number>,
      renderMode: number,
      energyLevel: number
    ) => void;
    /** Solar only — mirrors instance.batteryCharge into the packed uniform. */
    batteryCharge?: number;
    updateGaugeBuffer?: (position: ArrayLike<number>, ringIndex: number) => void;
  };
  /** DevicePipelineManager instance (device-pipeline-manager.ts). */
  pipelineManager?: {
    fluxSegmentPipeline?: GPURenderPipeline | null;
    /** Swap every render pipeline between its base/MSAA-4x variant (ADR-0005 WS2) — called once per frame from render-loop.ts. */
    applyMsaaState?: (active: boolean) => void;
  };

  // Buffers owned by the instance / delegated from geometry
  deviceUniformBuffer: GPUBuffer;
  materialUniformBuffer: GPUBuffer;
  particles: GPUBuffer;
  effectsParticles: GPUBuffer | null;
  fieldLineParticles: GPUBuffer | null;
  rollerInstances: GPUBuffer | null;
  coilInstances?: GPUBuffer | null;
  coilMaterialBuffer?: GPUBuffer | null;
  ringMaterialBuffer?: GPUBuffer | null;
  shaftInstanceBuffer?: GPUBuffer | null;
  magnetInstanceBuffer?: GPUBuffer | null;
  topPlateInstanceBuffer?: GPUBuffer | null;
  bottomPlateInstanceBuffer?: GPUBuffer | null;
  gaugeInstanceBuffer?: GPUBuffer | null;

  // Pipelines
  particlePipeline: GPURenderPipeline;
  rollerPipeline?: GPURenderPipeline | null;
  fieldLinePipeline?: GPURenderPipeline | null;
  segEnhancedPipeline?: GPURenderPipeline | null;
  coilPipeline?: GPURenderPipeline | null;
  ringPipeline?: GPURenderPipeline | null;
  /** Getter proxying pipelineManager.energyArcPipeline (device-instance.ts). */
  energyArcPipeline?: GPURenderPipeline | null;

  // Scratch buffers lazily allocated by the mixins
  _flowPathData?: Float32Array<ArrayBuffer>;
  _effectParticleData: Float32Array<ArrayBuffer>;
  _bindGroupCache?: BindGroupCache;
  _topRingUniformBuffer?: GPUBuffer;
  _bottomRingUniformBuffer?: GPUBuffer;

  // Solar energy proxies (synced from DevicePhysicsState per device)
  batteryCharge?: number;
  flowEnergyLevel?: number;
  voltageEnergyLevel?: number;

  // SEG roller / coil / flux / arc state
  rollerComputeUniformBuffer?: GPUBuffer | null;
  rollerComputePipeline?: GPUComputePipeline | null;
  rollerComputeBindGroup?: GPUBindGroup | null;
  fieldAdvectUniformBuffer?: GPUBuffer | null;
  fieldAdvectPipeline?: GPUComputePipeline | null;
  fieldAdvectBindGroup?: GPUBindGroup | null;
  fluxTracerUniformBuffer?: GPUBuffer | null;
  fluxCoilBoostBuffer?: GPUBuffer | null;
  fluxTracerPipeline?: GPUComputePipeline | null;
  fluxTracerBindGroup?: GPUBindGroup | null;
  fluxSegmentRenderBindGroup?: GPUBindGroup | null;
  transformerFluxUniformBuffer?: GPUBuffer | null;
  transformerFluxPipeline?: GPUComputePipeline | null;
  transformerFluxBindGroup?: GPUBindGroup | null;
  transformerFluxLineCount?: number;
  fieldLineEnabled?: boolean;
  /** Flat [x0,z0, x1,z1, ...] roller position scratch buffer, sized for the active layout. */
  _rollerPositions?: Float32Array;
  electromagnetInstances?: GPUBuffer | null;
  _lastCoilCount?: number;
  coilEnergies?: Float32Array;
  pwmEnergyLevel?: number;
  arcSegments?: GPUBuffer | null;
  arcSegmentCount?: number;
  energyArcEnabled?: boolean;

  getRingIndex: () => number;

  // Mixin methods (bound onto the instance by device-instance.ts)
  _ensureBgCache: () => BindGroupCache;
  _cacheBg: (
    key: string,
    layoutName: BindGroupLayoutName,
    entries: GPUBindGroupEntry[],
    label?: string
  ) => GPUBindGroup;
  _buildDeviceUniformData: (renderMode: number, yOffset?: number) => Float32Array<ArrayBuffer>;
  _computeEnergyLevel: (deltaTime: number) => void;
  updateDeviceFlowPaths: (deltaTime: number) => void;
  updateEmitterEffects: (deltaTime: number, qualityScale: number) => void;
  renderDeviceMesh: (renderPass: GPURenderPassEncoder, globalUniformBuffer: GPUBuffer) => void;
  renderStand: (renderPass: GPURenderPassEncoder, globalUniformBuffer: GPUBuffer) => void;
  renderBase: (renderPass: GPURenderPassEncoder, globalUniformBuffer: GPUBuffer) => void;
  renderGltfHousing: (renderPass: GPURenderPassEncoder, globalUniformBuffer: GPUBuffer) => void;
  /** Draw a non-SEG bench's own CAD props in its focus view (ADR-0005 WS1). */
  renderGltfDeviceProps: (renderPass: GPURenderPassEncoder, globalUniformBuffer: GPUBuffer) => void;
  _drawGltfPropsForDevice: (
    renderPass: GPURenderPassEncoder,
    globalUniformBuffer: GPUBuffer,
    deviceId: string
  ) => void;
  renderFrame: (renderPass: GPURenderPassEncoder, globalUniformBuffer: GPUBuffer) => void;
  renderStatorRings: (renderPass: GPURenderPassEncoder, globalUniformBuffer: GPUBuffer) => void;
  renderWiring: (renderPass: GPURenderPassEncoder, globalUniformBuffer: GPUBuffer) => void;
  renderCore: (renderPass: GPURenderPassEncoder, globalUniformBuffer: GPUBuffer) => void;
  renderPickupCoils: (renderPass: GPURenderPassEncoder, globalUniformBuffer: GPUBuffer) => void;
  renderWires: (renderPass: GPURenderPassEncoder, globalUniformBuffer: GPUBuffer) => void;
  _ensureRingUniformBuffers: () => void;
  _enhancedBindGroup: (
    globalUniformBuffer: GPUBuffer,
    instanceBuffer: GPUBuffer,
    keySuffix?: string
  ) => GPUBindGroup;
  _rollerBindGroup: (
    globalUniformBuffer: GPUBuffer,
    instanceBuffer: GPUBuffer,
    keySuffix?: string
  ) => GPUBindGroup;
}

/** Mesh builder surface used by hot-update paths (see device-mesh-layouts). */
export interface DeviceMeshSource {
  cylinders?: () => number[][];
}

// ── Plugin contract ────────────────────────────────────────────────

/**
 * Registry plugin contract — built-in core devices and Quanta catalog entries.
 * Mixins delegate per-device logic to these hooks instead of id branches.
 */
export interface DevicePlugin {
  id: string;
  label?: string;
  category?: string;
  /** WGSL / uniform shaderMode (from physics/devices.json). Not SimMode. */
  modeIndex?: number;
  /** C++ SimMode when a WASM plant exists. Omit or undefined for JS-only. */
  wasmMode?: number;
  /** Floor layout / particle defaults (core devices share DEVICE_CONFIG entries). */
  defaults?: DeviceDashboardDefaults;
  references?: unknown[];
  telemetrySchema?: Record<string, { label: string; unit?: string; source?: string }>;
  meshLayout?: DeviceMeshLayout;

  createPhysicsState?: () => Partial<DevicePhysicsState>;
  stepPhysics?: (state: DevicePhysicsState, dt: number, drive: number, opts?: object) => void;

  /** Devices that need lazy physics state initialization. */
  needsPhysicsState?: boolean;

  /** Scale factor applied to compute shader speed (SEG couples to segOmega). */
  getComputeSpeed?: (instance: DeviceInstanceLike, baseSpeed: number) => number;

  /** Skip JS plant when WASM owns physics this frame. */
  wasmSkipsJsPhysics?: boolean;

  /** Sync instance fields after stepDevicePhysics (battery gauge, mesh hot-update, …). */
  syncAfterPhysics?: (instance: DeviceInstanceLike, ctx: DeviceUpdateContext) => void;

  /** Per-frame dynamics not covered by stepPhysics (SEG rollers, coils, frame vibration). */
  updateDynamics?: (instance: DeviceInstanceLike, ctx: DeviceUpdateContext) => void;

  /** Hot-update instanced mesh buffers from physics state. */
  updateMesh?: (instance: DeviceInstanceLike) => void;

  /** Raw device energy 0..1 before exponential smoothing. */
  computeRawEnergy?: (instance: DeviceInstanceLike, ctx: DeviceEnergyContext) => number;

  /** Extra uniform fields for _buildDeviceUniformData. */
  buildUniformExtras?: (instance: DeviceInstanceLike) => DeviceUniformExtras;

  /** Animate device-specific flow-path particles; return true if handled. */
  updateFlowPaths?: (instance: DeviceInstanceLike, ctx: DeviceFlowPathContext) => boolean;

  /** Populate effect particle buffer; return true if handled. */
  updateEffects?: (instance: DeviceInstanceLike, ctx: DeviceEffectContext) => boolean;

  /** Whether subtle thermal haze billboards apply at high energy. */
  wantsThermalHaze?: boolean;

  /** WebGPU draw path for device-specific geometry (SEG pipeline, solar gauge, …). */
  drawWebgpu?: (
    instance: DeviceInstanceLike,
    renderPass: GPURenderPassEncoder,
    globalUniformBuffer: GPUBuffer,
    skipEffects: boolean
  ) => void;

  /** Draw after instanced mesh (e.g. solar battery gauge on top of panel). */
  drawWebgpuOverlay?: (
    instance: DeviceInstanceLike,
    renderPass: GPURenderPassEncoder,
    globalUniformBuffer: GPUBuffer,
    skipEffects: boolean
  ) => void;
}
