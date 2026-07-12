/**
 * Upload glTF mesh data to WebGPU buffers compatible with seg-enhanced pipeline.
 */

import { makeGeomBuffers } from '../../seg-geometry/helpers.js';

/** Instance stride: position(3) + ringIndex(1) + rotation(4) + color(3) + emissive(1) */
export const GLTF_INSTANCE_FLOATS = 12;
export const GLTF_INSTANCE_BYTES = GLTF_INSTANCE_FLOATS * 4;

/**
 * @param {GPUDevice} device
 * @param {{ vertices: Float32Array, indices: Uint16Array }} mesh
 */
export function uploadGltfMesh(device, mesh) {
  return makeGeomBuffers(device, {
    vertices: mesh.vertices,
    indices: mesh.indices
  });
}

/**
 * @param {GPUDevice} device
 * @param {{
 *   position?: [number, number, number],
 *   rotation?: [number, number, number, number],
 *   ringIndex?: number,
 *   color?: [number, number, number],
 *   emissive?: number,
 * }} opts
 */
export function createGltfInstanceBuffer(device, opts = {}) {
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
  device.queue.writeBuffer(buf, 0, data);
  return buf;
}

/**
 * @param {GPUDevice} device
 * @param {GPUBuffer} instanceBuffer
 * @param {number} emissive
 */
export function updateGltfInstanceEmissive(device, instanceBuffer, emissive) {
  device.queue.writeBuffer(instanceBuffer, 44, new Float32Array([emissive]));
}
