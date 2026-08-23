/**
 * Device plugin registry — register apparatus without editing MultiDeviceVisualizer.
 *
 * Plugin shape: see ./types.ts (DevicePlugin)
 *
 * Core dashboard layout lives in ./device-config.ts and is attached via each
 * plugin's `defaults` (register-core). Quanta plugins supply their own defaults.
 */

import { applyAutoLayout } from './layout-packer.js';
import type {
  DeviceEffectContext,
  DeviceEnergyContext,
  DeviceFlowPathContext,
  DeviceInstanceLike,
  DevicePlugin,
  DeviceUniformExtras,
  DeviceUpdateContext
} from './types';
import type { DevicePhysicsState } from '../renderers/shared/device-physics';
import type { DeviceDashboardEntry, DeviceDashboardDefaults } from './device-config';

const plugins = new Map<string, DevicePlugin>();

let cachedMergedConfig: Record<string, MergedDeviceConfigEntry> | null = null;

/** Merged floor entry: plugin defaults + registry metadata. */
export interface MergedDeviceConfigEntry extends DeviceDashboardDefaults {
  id: string;
  label?: string;
  category?: string;
  plugin?: boolean;
  /** Present when defaults supplied a full layout entry (core devices). */
  position?: [number, number, number];
  rotation?: number[];
  cameraOffset?: number[];
  particleCount?: number;
  color?: [number, number, number];
  cullRadius?: number;
  core?: DeviceDashboardEntry['core'];
}

export function registerDevice(plugin: DevicePlugin): void {
  if (!plugin?.id) throw new Error('[DeviceRegistry] plugin.id required');
  if (plugins.has(plugin.id)) {
    console.warn(`[DeviceRegistry] replacing plugin "${plugin.id}"`);
  }
  plugins.set(plugin.id, { ...plugins.get(plugin.id), ...plugin });
  cachedMergedConfig = null;
}

export function getDevicePlugin(id: string): DevicePlugin | undefined {
  return plugins.get(id);
}

export function getPluginDeviceIds(): string[] {
  return [...plugins.keys()];
}

export function getAllSimDeviceIds(): string[] {
  return getPluginDeviceIds();
}

/** WGSL / uniform mode index for a device id. */
export function getDeviceModeIndex(id: string): number {
  const plugin = plugins.get(id);
  if (plugin?.modeIndex != null) return plugin.modeIndex;
  return 0;
}

/**
 * Full dashboard config: registered plugins with auto layout for entries
 * that omit `position`.
 *
 * Core `defaults` keep the same object identity as `DEVICE_CONFIG.*` so in-place
 * cameraOffset patches (layout preset changes) remain visible to focus-camera.
 */
export function getMergedDeviceConfig(): Record<string, MergedDeviceConfigEntry> {
  if (cachedMergedConfig) return cachedMergedConfig;

  const merged: Record<string, MergedDeviceConfigEntry> = {};
  for (const [id, plugin] of plugins) {
    const defaults = plugin.defaults;
    if (defaults && hasOwnPosition(defaults)) {
      // Same object as DEVICE_CONFIG.* — do not clone or assign metadata onto it.
      merged[id] = defaults as MergedDeviceConfigEntry;
    } else {
      merged[id] = {
        particleCount: 4500,
        color: [0.5, 0.8, 1.0],
        cameraOffset: [0, 4, 12],
        rotation: [0, 0, 0, 1],
        cullRadius: 16,
        ...defaults,
        id,
        label: plugin.label,
        category: plugin.category,
        plugin: true
      };
    }
  }

  cachedMergedConfig = applyAutoLayout(merged, {
    radius: 20,
    startAngle: Math.PI * 0.15
  });
  return cachedMergedConfig;
}

function hasOwnPosition(defaults: DeviceDashboardDefaults): boolean {
  return Array.isArray(defaults.position) && defaults.position.length >= 3;
}

/** Mesh layout hooks for DeviceGeometry.initializeDeviceMesh */
export function getPluginMeshLayouts(): Record<string, NonNullable<DevicePlugin['meshLayout']>> {
  const layouts: Record<string, NonNullable<DevicePlugin['meshLayout']>> = {};
  for (const [id, plugin] of plugins) {
    if (plugin.meshLayout) layouts[id] = plugin.meshLayout;
  }
  return layouts;
}

export function stepPluginPhysics(
  state: DevicePhysicsState,
  dt: number,
  drive: number,
  opts: object = {}
): boolean {
  const plugin = plugins.get(state.deviceId);
  if (plugin?.stepPhysics) {
    plugin.stepPhysics(state, dt, drive, opts);
    return true;
  }
  return false;
}

/** Extend a blank physics state for plugin devices. */
export function extendPhysicsState(deviceId: string, baseState: object): object {
  const plugin = plugins.get(deviceId);
  if (plugin?.createPhysicsState) {
    return { ...baseState, ...plugin.createPhysicsState() };
  }
  return baseState;
}

/** Telemetry field definitions for scientific UI / gallery docs. */
export function getTelemetrySchemas(): Record<string, object> {
  const schemas: Record<string, object> = {};
  for (const [id, plugin] of plugins) {
    if (plugin.telemetrySchema) schemas[id] = plugin.telemetrySchema;
  }
  return schemas;
}

export function getDeviceReferences(id: string): unknown[] {
  return plugins.get(id)?.references ?? [];
}

export function deviceNeedsPhysicsState(id: string): boolean {
  return plugins.get(id)?.needsPhysicsState === true;
}

export function getPluginComputeSpeed(instance: DeviceInstanceLike): number {
  const plugin = plugins.get(instance.id);
  const base = instance.speedMult || 1.0;
  return plugin?.getComputeSpeed ? plugin.getComputeSpeed(instance, base) : base;
}

export function pluginWasmSkipsJsPhysics(instance: DeviceInstanceLike): boolean {
  const plugin = plugins.get(instance.id);
  return plugin?.wasmSkipsJsPhysics === true;
}

export function runSyncAfterPhysics(instance: DeviceInstanceLike, ctx: DeviceUpdateContext): void {
  plugins.get(instance.id)?.syncAfterPhysics?.(instance, ctx);
}

export function runUpdateDynamics(instance: DeviceInstanceLike, ctx: DeviceUpdateContext): void {
  plugins.get(instance.id)?.updateDynamics?.(instance, ctx);
}

export function runUpdateMesh(instance: DeviceInstanceLike): void {
  plugins.get(instance.id)?.updateMesh?.(instance);
}

export function runComputeRawEnergy(
  instance: DeviceInstanceLike,
  ctx: DeviceEnergyContext
): number | undefined {
  return plugins.get(instance.id)?.computeRawEnergy?.(instance, ctx);
}

export function runBuildUniformExtras(instance: DeviceInstanceLike): DeviceUniformExtras {
  return plugins.get(instance.id)?.buildUniformExtras?.(instance) ?? {};
}

export function runUpdateFlowPaths(
  instance: DeviceInstanceLike,
  ctx: DeviceFlowPathContext
): boolean {
  const fn = plugins.get(instance.id)?.updateFlowPaths;
  return fn ? fn(instance, ctx) === true : false;
}

export function runUpdateEffects(
  instance: DeviceInstanceLike,
  ctx: DeviceEffectContext
): boolean {
  const fn = plugins.get(instance.id)?.updateEffects;
  return fn ? fn(instance, ctx) === true : false;
}

export function deviceWantsThermalHaze(instance: DeviceInstanceLike): boolean {
  return plugins.get(instance.id)?.wantsThermalHaze === true;
}

export function runDrawWebgpu(
  instance: DeviceInstanceLike,
  renderPass: GPURenderPassEncoder,
  globalUniformBuffer: GPUBuffer,
  skipEffects: boolean
): void {
  plugins.get(instance.id)?.drawWebgpu?.(instance, renderPass, globalUniformBuffer, skipEffects);
}

export function runDrawWebgpuOverlay(
  instance: DeviceInstanceLike,
  renderPass: GPURenderPassEncoder,
  globalUniformBuffer: GPUBuffer,
  skipEffects: boolean
): void {
  plugins.get(instance.id)?.drawWebgpuOverlay?.(
    instance,
    renderPass,
    globalUniformBuffer,
    skipEffects
  );
}
