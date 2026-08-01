/**
 * Ambient types for the device plugin registry (implementation stays JS because it
 * imports the legacy DEVICE_CONFIG from debug-panel.js). The contract itself lives
 * in ./types.ts — this file only describes the JS module's exports.
 */

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

export type {
  DevicePlugin,
  DeviceUpdateContext,
  DeviceEffectContext,
  DeviceFlowPathContext,
  DeviceEnergyContext,
  DeviceUniformExtras
} from './types';

export function registerDevice(plugin: DevicePlugin): void;
export function getDevicePlugin(id: string): DevicePlugin | undefined;
export function getPluginDeviceIds(): string[];
export function getAllSimDeviceIds(): string[];
export function getDeviceModeIndex(id: string): number;
export function getMergedDeviceConfig(): Record<string, Record<string, unknown>>;
export function getPluginMeshLayouts(): Record<string, Record<string, unknown>>;
export function stepPluginPhysics(
  state: DevicePhysicsState,
  dt: number,
  drive: number,
  opts?: object
): boolean;
export function extendPhysicsState(deviceId: string, baseState: object): object;
export function getTelemetrySchemas(): Record<string, object>;
export function getDeviceReferences(id: string): unknown[];
export function deviceNeedsPhysicsState(id: string): boolean;
export function getPluginComputeSpeed(instance: DeviceInstanceLike): number;
export function pluginWasmSkipsJsPhysics(instance: DeviceInstanceLike): boolean;
export function runSyncAfterPhysics(instance: DeviceInstanceLike, ctx: DeviceUpdateContext): void;
export function runUpdateDynamics(instance: DeviceInstanceLike, ctx: DeviceUpdateContext): void;
export function runUpdateMesh(instance: DeviceInstanceLike): void;
export function runComputeRawEnergy(
  instance: DeviceInstanceLike,
  ctx: DeviceEnergyContext
): number | undefined;
export function runBuildUniformExtras(instance: DeviceInstanceLike): DeviceUniformExtras;
export function runUpdateFlowPaths(
  instance: DeviceInstanceLike,
  ctx: DeviceFlowPathContext
): boolean;
export function runUpdateEffects(instance: DeviceInstanceLike, ctx: DeviceEffectContext): boolean;
export function deviceWantsThermalHaze(instance: DeviceInstanceLike): boolean;
export function runDrawWebgpu(
  instance: DeviceInstanceLike,
  renderPass: GPURenderPassEncoder,
  globalUniformBuffer: GPUBuffer,
  skipEffects: boolean
): void;
export function runDrawWebgpuOverlay(
  instance: DeviceInstanceLike,
  renderPass: GPURenderPassEncoder,
  globalUniformBuffer: GPUBuffer,
  skipEffects: boolean
): void;
