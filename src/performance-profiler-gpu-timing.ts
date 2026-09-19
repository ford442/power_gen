import type { PerformanceProfiler } from './performance-profiler';

/**
 * GPU timestamp query/resolve logic for {@link PerformanceProfiler}, split out to
 * keep performance-profiler.ts under the 700-line cap (see issues #142/#143/#187).
 *
 * Merged onto `PerformanceProfiler.prototype` via `Object.assign` in
 * performance-profiler.ts, so these run as ordinary prototype methods with
 * normal `this` binding at call time — no special binding helper needed.
 */
export const gpuTimingMethods = {
  // Write timestamp to encoder
  writeTimestamp(
    this: PerformanceProfiler,
    encoder: GPUCommandEncoder | GPURenderPassEncoder | GPUComputePassEncoder,
    index: number
  ): void {
    if (
      this.timingEnabled &&
      typeof (encoder as { writeTimestamp?: unknown }).writeTimestamp === 'function' &&
      index < this.queryCount &&
      this.timestampQuerySet
    ) {
      (encoder as unknown as { writeTimestamp(qs: GPUQuerySet, i: number): void }).writeTimestamp(this.timestampQuerySet, index);
    }
  },

  /** Queue a single in-flight timestamp resolve (avoids buffer-in-use-during-submit). */
  scheduleResolveTimestamps(this: PerformanceProfiler): void {
    if (!this.timingEnabled || this._timestampResolvePending) return;
    this._timestampResolvePending = true;
    this.resolveTimestamps()
      .catch(() => {})
      .finally(() => { this._timestampResolvePending = false; });
  },

  // Resolve timestamps
  async resolveTimestamps(this: PerformanceProfiler): Promise<number | undefined> {
    if (!this.timingEnabled || !this.timestampQuerySet || !this.timestampResolveBuffer || !this.timestampMappedBuffer) return;

    const commandEncoder = this.device.createCommandEncoder();
    commandEncoder.resolveQuerySet(
      this.timestampQuerySet,
      0,
      this.queryCount,
      this.timestampResolveBuffer,
      0
    );
    commandEncoder.copyBufferToBuffer(
      this.timestampResolveBuffer,
      0,
      this.timestampMappedBuffer,
      0,
      this.queryCount * 8
    );
    this.device.queue.submit([commandEncoder.finish()]);

    // Read results
    await this.timestampMappedBuffer.mapAsync(GPUMapMode.READ);
    const timestamps = new BigUint64Array(this.timestampMappedBuffer.getMappedRange());

    // Convert to milliseconds (nanoseconds to ms)
    const gpuTimeMs = Number(timestamps[1] - timestamps[0]) / 1_000_000;
    this.lastGpuTimeMs = gpuTimeMs;

    // Update history
    const idx = (this.fpsIndex - 1 + this.gpuTimeHistory.length) % this.gpuTimeHistory.length;
    this.gpuTimeHistory[idx] = gpuTimeMs;

    this.timestampMappedBuffer.unmap();
    return gpuTimeMs;
  }
};
