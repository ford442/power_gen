/**
 * Device plugin registry — register apparatus without editing MultiDeviceVisualizer.
 *
 * Plugin shape: see ./types.ts (DevicePlugin)
 *
 * Built-in devices (seg, heron, …) remain in debug-panel DEVICE_CONFIG for dashboard
 * layout; register-core.js attaches update/render strategies to the same ids.
 */

import { DEVICE_CONFIG as LEGACY_DEVICE_CONFIG } from '../debug-panel.js';
import { applyAutoLayout } from './layout-packer.js';

/** @type {Map<string, import('./types').DevicePlugin>} */
const plugins = new Map();

/** Legacy WGSL mode indices — stable for existing shaders. */
const LEGACY_MODE_INDEX = {
  seg: 0,
  heron: 1,
  kelvin: 2,
  solar: 3,
  peltier: 4,
  mhd: 5
};

let cachedMergedConfig = null;

/**
 * @param {import('./types').DevicePlugin} plugin
 */
export function registerDevice(plugin) {
  if (!plugin?.id) throw new Error('[DeviceRegistry] plugin.id required');
  if (plugins.has(plugin.id)) {
    console.warn(`[DeviceRegistry] replacing plugin "${plugin.id}"`);
  }
  plugins.set(plugin.id, { ...plugins.get(plugin.id), ...plugin });
  cachedMergedConfig = null;
}

/** @returns {import('./types').DevicePlugin|undefined} */
export function getDevicePlugin(id) {
  return plugins.get(id);
}

export function getPluginDeviceIds() {
  return [...plugins.keys()];
}

export function getAllSimDeviceIds() {
  const legacy = Object.keys(LEGACY_DEVICE_CONFIG);
  const extra = getPluginDeviceIds().filter((id) => !legacy.includes(id));
  return [...legacy, ...extra];
}

/**
 * WGSL / uniform mode index for a device id.
 * @param {string} id
 */
export function getDeviceModeIndex(id) {
  const plugin = plugins.get(id);
  if (plugin?.modeIndex != null) return plugin.modeIndex;
  return LEGACY_MODE_INDEX[id] ?? 0;
}

/**
 * Full dashboard config: legacy entries + registered plugins, with auto layout
 * for plugin devices that omit `position`.
 */
export function getMergedDeviceConfig() {
  if (cachedMergedConfig) return cachedMergedConfig;

  const merged = { ...LEGACY_DEVICE_CONFIG };
  for (const [id, plugin] of plugins) {
    // Core legacy ids keep DEVICE_CONFIG positions; plugin only supplies strategies.
    if (LEGACY_DEVICE_CONFIG[id]) continue;

    const defaults = plugin.defaults || {};
    merged[id] = {
      particleCount: 10000,
      color: [0.5, 0.8, 1.0],
      cameraOffset: [0, 4, 12],
      rotation: [0, 0, 0, 1],
      ...defaults,
      id,
      label: plugin.label,
      category: plugin.category,
      plugin: true
    };
  }

  cachedMergedConfig = applyAutoLayout(merged, { radius: 20, startAngle: Math.PI * 0.15 });
  return cachedMergedConfig;
}

/** Mesh layout hooks for DeviceGeometry.initializeDeviceMesh */
export function getPluginMeshLayouts() {
  /** @type {Record<string, object>} */
  const layouts = {};
  for (const [id, plugin] of plugins) {
    if (plugin.meshLayout) layouts[id] = plugin.meshLayout;
  }
  return layouts;
}

/**
 * @param {object} state  physics state from createDevicePhysicsState / plugin
 * @param {number} dt
 * @param {number} drive 0..1
 * @param {object} [opts]
 */
export function stepPluginPhysics(state, dt, drive, opts = {}) {
  const plugin = plugins.get(state.deviceId);
  if (plugin?.stepPhysics) {
    plugin.stepPhysics(state, dt, drive, opts);
    return true;
  }
  return false;
}

/**
 * Extend a blank physics state for plugin devices.
 * @param {string} deviceId
 * @param {object} baseState
 */
export function extendPhysicsState(deviceId, baseState) {
  const plugin = plugins.get(deviceId);
  if (plugin?.createPhysicsState) {
    return { ...baseState, ...plugin.createPhysicsState() };
  }
  return baseState;
}

/** Telemetry field definitions for scientific UI / gallery docs. */
export function getTelemetrySchemas() {
  /** @type {Record<string, object>} */
  const schemas = {};
  for (const [id, plugin] of plugins) {
    if (plugin.telemetrySchema) schemas[id] = plugin.telemetrySchema;
  }
  return schemas;
}

export function getDeviceReferences(id) {
  return plugins.get(id)?.references ?? [];
}

/** @param {string} id */
export function deviceNeedsPhysicsState(id) {
  return plugins.get(id)?.needsPhysicsState === true;
}

/** @param {object} instance */
export function getPluginComputeSpeed(instance) {
  const plugin = plugins.get(instance.id);
  const base = instance.speedMult || 1.0;
  return plugin?.getComputeSpeed ? plugin.getComputeSpeed(instance, base) : base;
}

/** @param {object} instance */
export function pluginWasmSkipsJsPhysics(instance) {
  const plugin = plugins.get(instance.id);
  return plugin?.wasmSkipsJsPhysics === true;
}

/** @param {object} instance @param {import('./types').DeviceUpdateContext} ctx */
export function runSyncAfterPhysics(instance, ctx) {
  plugins.get(instance.id)?.syncAfterPhysics?.(instance, ctx);
}

/** @param {object} instance @param {import('./types').DeviceUpdateContext} ctx */
export function runUpdateDynamics(instance, ctx) {
  plugins.get(instance.id)?.updateDynamics?.(instance, ctx);
}

/** @param {object} instance */
export function runUpdateMesh(instance) {
  plugins.get(instance.id)?.updateMesh?.(instance);
}

/**
 * @param {object} instance
 * @param {import('./types').DeviceEnergyContext} ctx
 * @returns {number|undefined}
 */
export function runComputeRawEnergy(instance, ctx) {
  return plugins.get(instance.id)?.computeRawEnergy?.(instance, ctx);
}

/** @param {object} instance */
export function runBuildUniformExtras(instance) {
  return plugins.get(instance.id)?.buildUniformExtras?.(instance) ?? {};
}

/**
 * @param {object} instance
 * @param {import('./types').DeviceFlowPathContext} ctx
 * @returns {boolean}
 */
export function runUpdateFlowPaths(instance, ctx) {
  const fn = plugins.get(instance.id)?.updateFlowPaths;
  return fn ? fn(instance, ctx) === true : false;
}

/**
 * @param {object} instance
 * @param {import('./types').DeviceEffectContext} ctx
 * @returns {boolean}
 */
export function runUpdateEffects(instance, ctx) {
  const fn = plugins.get(instance.id)?.updateEffects;
  return fn ? fn(instance, ctx) === true : false;
}

/** @param {object} instance */
export function deviceWantsThermalHaze(instance) {
  return plugins.get(instance.id)?.wantsThermalHaze === true;
}

/**
 * @param {object} instance
 * @param {GPURenderPassEncoder} renderPass
 * @param {GPUBuffer} globalUniformBuffer
 * @param {boolean} skipEffects
 */
export function runDrawWebgpu(instance, renderPass, globalUniformBuffer, skipEffects) {
  plugins.get(instance.id)?.drawWebgpu?.(instance, renderPass, globalUniformBuffer, skipEffects);
}

export function runDrawWebgpuOverlay(instance, renderPass, globalUniformBuffer, skipEffects) {
  plugins.get(instance.id)?.drawWebgpuOverlay?.(instance, renderPass, globalUniformBuffer, skipEffects);
}
