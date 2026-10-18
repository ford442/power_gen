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
  /**
   * `timestampWrites` for a pass descriptor, or `undefined` when timing is off.
   *
   * `GPUCommandEncoder.writeTimestamp` was removed from the spec (and from
   * Chrome); timestamps are now only written at pass boundaries. The frame is
   * bracketed by `'begin'` on the first compute pass (query 0, start of pass)
   * and `'end'` on the composite pass (query 1, end of pass), so the reading
   * covers compute → scene → post → composite.
   */
  passTimestampWrites(
    this: PerformanceProfiler,
    edge: 'begin' | 'end'
  ): GPUComputePassTimestampWrites | undefined {
    if (!this.timingEnabled || !this.timestampQuerySet || this.queryCount < 2) return undefined;
    if (edge === 'begin') {
      this._timestampEndWritten = false;
      return { querySet: this.timestampQuerySet, beginningOfPassWriteIndex: 0 };
    }
    this._timestampEndWritten = true;
    return { querySet: this.timestampQuerySet, endOfPassWriteIndex: 1 };
  },

  /** Queue a single in-flight timestamp resolve (avoids buffer-in-use-during-submit). */
  scheduleResolveTimestamps(this: PerformanceProfiler): void {
    // A frame without the composite pass (bloom stack not built yet) wrote
    // only query 0; resolving then would pair it with a stale query 1.
    if (!this.timingEnabled || this._timestampResolvePending || !this._timestampEndWritten) return;
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

    // Convert to milliseconds (nanoseconds to ms). Implementations may zero or
    // clamp timestamps; a non-increasing pair is a dropped sample, not 0 ms.
    if (timestamps[1] <= timestamps[0]) {
      this.timestampMappedBuffer.unmap();
      return undefined;
    }
    const gpuTimeMs = Number(timestamps[1] - timestamps[0]) / 1_000_000;
    this.lastGpuTimeMs = gpuTimeMs;

    // Update history
    const idx = (this.fpsIndex - 1 + this.gpuTimeHistory.length) % this.gpuTimeHistory.length;
    this.gpuTimeHistory[idx] = gpuTimeMs;

    this.timestampMappedBuffer.unmap();
    return gpuTimeMs;
  }
};
