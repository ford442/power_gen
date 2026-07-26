import type { DevicePlugin } from './device-registry-types';

export type {
  DevicePlugin,
  DeviceUpdateContext,
  DeviceEffectContext,
  DeviceFlowPathContext,
  DeviceEnergyContext,
  DeviceUniformExtras
} from './device-registry-types';

export function registerDevice(plugin: DevicePlugin): void;
export function getDevicePlugin(id: string): DevicePlugin | undefined;
export function getPluginDeviceIds(): string[];
export function getAllSimDeviceIds(): string[];
export function getDeviceModeIndex(id: string): number;
export function getMergedDeviceConfig(): Record<string, unknown>;
export function getPluginMeshLayouts(): Record<string, object>;
export function stepPluginPhysics(
  state: object,
  dt: number,
  drive: number,
  opts?: object
): boolean;
export function extendPhysicsState(deviceId: string, baseState: object): object;
export function getTelemetrySchemas(): Record<string, object>;
export function getDeviceReferences(id: string): unknown[];
export function deviceNeedsPhysicsState(id: string): boolean;
export function getPluginComputeSpeed(instance: object): number;
export function pluginWasmSkipsJsPhysics(instance: object): boolean;
export function runSyncAfterPhysics(instance: object, ctx: object): void;
export function runUpdateDynamics(instance: object, ctx: object): void;
export function runUpdateMesh(instance: object): void;
export function runComputeRawEnergy(instance: object, ctx: object): number | undefined;
export function runBuildUniformExtras(instance: object): object;
export function runUpdateFlowPaths(instance: object, ctx: object): boolean;
export function runUpdateEffects(instance: object, ctx: object): boolean;
export function deviceWantsThermalHaze(instance: object): boolean;
export function runDrawWebgpu(
  instance: object,
  renderPass: GPURenderPassEncoder,
  globalUniformBuffer: GPUBuffer,
  skipEffects: boolean
): void;
export function runDrawWebgpuOverlay(
  instance: object,
  renderPass: GPURenderPassEncoder,
  globalUniformBuffer: GPUBuffer,
  skipEffects: boolean
): void;
