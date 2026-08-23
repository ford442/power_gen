/** Ambient types for glTF → WebGPU upload helpers (implementation stays JS). */

export const GLTF_INSTANCE_FLOATS: number;
export const GLTF_INSTANCE_BYTES: number;

export interface GltfMeshUpload {
  vertices: Float32Array;
  indices: Uint16Array | Uint32Array;
}

export interface GltfGpuBuffers {
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  indexCount: number;
}

export function uploadGltfMesh(device: GPUDevice, mesh: GltfMeshUpload): GltfGpuBuffers;

export function createGltfInstanceBuffer(
  device: GPUDevice,
  opts?: {
    position?: [number, number, number];
    rotation?: [number, number, number, number];
    ringIndex?: number;
    color?: [number, number, number];
    emissive?: number;
  }
): GPUBuffer;

export function updateGltfInstanceEmissive(
  device: GPUDevice,
  buffer: GPUBuffer,
  emissive: number
): void;
