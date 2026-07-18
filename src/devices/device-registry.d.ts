import type { DevicePhysicsState } from '../renderers/shared/device-physics.ts';
import type { HeronLayout } from '../renderers/shared/device-physics.ts';

export interface DevicePlugin {
  id: string;
  modeIndex?: number;
  stepPhysics?: (state: DevicePhysicsState, dt: number, drive: number, opts?: object) => void;
  createPhysicsState?: () => Partial<DevicePhysicsState>;
  [key: string]: unknown;
}

export function registerDevice(plugin: DevicePlugin): void;
export function getDevicePlugin(id: string): DevicePlugin | undefined;
export function getPluginDeviceIds(): string[];
export function getAllSimDeviceIds(): string[];
export function getDeviceModeIndex(id: string): number;
export function getMergedDeviceConfig(): Record<string, unknown>;
export function getPluginMeshLayouts(): Record<string, object>;
export function stepPluginPhysics(
  state: DevicePhysicsState,
  dt: number,
  drive: number,
  opts?: object
): boolean;
export function extendPhysicsState(
  deviceId: string,
  baseState: object
): DevicePhysicsState;
export function getTelemetrySchemas(): Record<string, object>;
export function getDeviceReferences(id: string): unknown[];
