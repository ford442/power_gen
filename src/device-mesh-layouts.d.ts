/**
 * Ambient types for the instanced-mesh layout builders (implementation stays JS).
 * Instances are flat float tuples — see packInstance() for the packing.
 */

/** One packed instance, or a nested array of them from a builder. */
export type InstanceFloats = number[];
export type InstanceArray = InstanceFloats[];

export const TUBE_MESH_HEIGHT: number;
export const TUBE_MESH_RADIUS: number;

export function packInstance(
  pos: number[],
  ringIndex: number,
  rot?: number[],
  color?: number[],
  emissive?: number
): InstanceFloats;

export function tubeSegments(
  from: number[],
  to: number[],
  color?: number[],
  emissive?: number,
  ringIndex?: number
): InstanceArray;

export function buildHeronInstances(presetId?: string): InstanceArray;
export function buildHeronPlatformInstances(presetId?: string): InstanceArray;
export function buildHeronTubeInstances(presetId?: string): InstanceArray;
export function buildKelvinInstances(): InstanceArray;
export function buildKelvinRingInstances(): InstanceArray;
export function buildKelvinBucketInstances(): InstanceArray;
export function buildKelvinTubeInstances(): InstanceArray;
export function buildSolarLedInstances(): InstanceArray;
export function buildSolarBatteryInstance(): InstanceArray;
export function buildSolarPanelInstance(): InstanceArray;
export function buildSolarMountInstances(): InstanceArray;
export function buildSolarTubeInstances(): InstanceArray;

/** Flatten nested instance arrays into a GPU-ready Float32Array. */
export function instancesToBufferData(instanceArrays: unknown[]): Float32Array<ArrayBuffer>;

/** Instance count for a flat float array. */
export function countInstances(data: ArrayLike<number>): number;

/** Per-device mesh builders keyed by device id. */
export interface DeviceMeshLayout {
  build?: (presetId?: string) => Record<string, InstanceArray>;
  cylinders?: () => InstanceArray;
  rings?: () => InstanceArray;
  tubes?: () => InstanceArray;
  panel?: () => InstanceArray;
  platform?: () => InstanceArray;
}

export const DEVICE_MESH_LAYOUTS: Record<string, DeviceMeshLayout>;
