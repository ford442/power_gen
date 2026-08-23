/**
 * Narrow ArrayBufferView → GPU queue write (TS 5.x Float32Array&lt;ArrayBufferLike&gt;
 * is not assignable to GPUAllowSharedBufferSource without an explicit ArrayBuffer).
 */
export function writeQueueBuffer(
  device: GPUDevice,
  buffer: GPUBuffer,
  data: ArrayBufferView,
  bufferOffset = 0
): void {
  device.queue.writeBuffer(
    buffer,
    bufferOffset,
    data.buffer as ArrayBuffer,
    data.byteOffset,
    data.byteLength
  );
}
