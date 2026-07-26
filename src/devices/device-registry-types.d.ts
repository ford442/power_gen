import type { DevicePhysicsState } from '../renderers/shared/device-physics';

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

/**
 * Registry plugin contract — built-in core devices and Quanta catalog entries.
 * Mixins delegate per-device logic to these hooks instead of id branches.
 */
export interface DevicePlugin {
  id: string;
  label?: string;
  category?: string;
  modeIndex?: number;
  wasmMode?: number;
  defaults?: Record<string, unknown>;
  references?: unknown[];
  telemetrySchema?: Record<string, { label: string; unit?: string; source?: string }>;
  meshLayout?: Record<string, unknown>;

  createPhysicsState?: () => Partial<DevicePhysicsState>;
  stepPhysics?: (state: DevicePhysicsState, dt: number, drive: number, opts?: object) => void;

  /** Devices that need lazy physics state initialization. */
  needsPhysicsState?: boolean;

  /** Scale factor applied to compute shader speed (SEG couples to segOmega). */
  getComputeSpeed?: (instance: object, baseSpeed: number) => number;

  /** Skip JS plant when WASM owns physics this frame. */
  wasmSkipsJsPhysics?: boolean;

  /** Sync instance fields after stepDevicePhysics (battery gauge, mesh hot-update, …). */
  syncAfterPhysics?: (instance: object, ctx: DeviceUpdateContext) => void;

  /** Per-frame dynamics not covered by stepPhysics (SEG rollers, coils, frame vibration). */
  updateDynamics?: (instance: object, ctx: DeviceUpdateContext) => void;

  /** Hot-update instanced mesh buffers from physics state. */
  updateMesh?: (instance: object) => void;

  /** Raw device energy 0..1 before exponential smoothing. */
  computeRawEnergy?: (instance: object, ctx: DeviceEnergyContext) => number;

  /** Extra uniform fields for _buildDeviceUniformData. */
  buildUniformExtras?: (instance: object) => DeviceUniformExtras;

  /** Animate device-specific flow-path particles; return true if handled. */
  updateFlowPaths?: (instance: object, ctx: DeviceFlowPathContext) => boolean;

  /** Populate effect particle buffer; return true if handled. */
  updateEffects?: (instance: object, ctx: DeviceEffectContext) => boolean;

  /** Whether subtle thermal haze billboards apply at high energy. */
  wantsThermalHaze?: boolean;

  /** WebGPU draw path for device-specific geometry (SEG pipeline, solar gauge, …). */
  drawWebgpu?: (instance: object, renderPass: GPURenderPassEncoder, globalUniformBuffer: GPUBuffer, skipEffects: boolean) => void;

  /** Draw after instanced mesh (e.g. solar battery gauge on top of panel). */
  drawWebgpuOverlay?: (instance: object, renderPass: GPURenderPassEncoder, globalUniformBuffer: GPUBuffer, skipEffects: boolean) => void;
}
