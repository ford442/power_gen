/**
 * Upload glTF mesh data to WebGPU buffers compatible with seg-enhanced pipeline.
 */

import { makeGeomBuffers } from '../../seg-geometry/helpers.js';
import { writeQueueBuffer } from '../../gpu-buffer-write';

/** Instance stride: position(3) + ringIndex(1) + rotation(4) + color(3) + emissive(1) */
export const GLTF_INSTANCE_FLOATS = 12;
export const GLTF_INSTANCE_BYTES = GLTF_INSTANCE_FLOATS * 4;

export interface GltfMeshUpload {
  vertices: Float32Array;
  indices: Uint16Array | Uint32Array;
}

export interface GltfGpuBuffers {
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  indexCount: number;
}

export function uploadGltfMesh(device: GPUDevice, mesh: GltfMeshUpload): GltfGpuBuffers {
  return makeGeomBuffers(device, {
    vertices: mesh.vertices,
    indices: mesh.indices
  });
}

export interface CreateGltfInstanceBufferOpts {
  position?: [number, number, number];
  rotation?: [number, number, number, number];
  ringIndex?: number;
  color?: [number, number, number];
  emissive?: number;
}

export function createGltfInstanceBuffer(device: GPUDevice, opts: CreateGltfInstanceBufferOpts = {}): GPUBuffer {
  const position = opts.position ?? [0, 0, 0];
  const rotation = opts.rotation ?? [0, 0, 0, 1];
  const color = opts.color ?? [0.74, 0.76, 0.80];
  const data = new Float32Array([
    position[0], position[1], position[2],
    opts.ringIndex ?? 11.0,
    rotation[0], rotation[1], rotation[2], rotation[3],
    color[0], color[1], color[2],
    opts.emissive ?? 0.0
  ]);
  const buf = device.createBuffer({
    size: GLTF_INSTANCE_BYTES,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
  });
  writeQueueBuffer(device, buf, data);
  return buf;
}

export function updateGltfInstanceEmissive(device: GPUDevice, instanceBuffer: GPUBuffer, emissive: number): void {
  writeQueueBuffer(device, instanceBuffer, new Float32Array([emissive]), 44);
}
