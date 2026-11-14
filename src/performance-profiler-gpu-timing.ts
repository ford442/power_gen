import type { PerformanceProfiler } from './performance-profiler';

/**
 * GPU timestamp query/resolve logic for {@link PerformanceProfiler}, split out to
 * keep performance-profiler.ts under the 700-line cap (see issues #142/#143/#187).
 *
 * Merged onto `PerformanceProfiler.prototype` via `Object.assign` in
 * performance-profiler.ts, so these run as ordinary prototype methods with
 * normal `this` binding at call time — no special binding helper needed.
 */
/** Timed passes per frame the query set has room for (two queries each). */
export const GPU_TIMING_MAX_PASSES = 16;

export const gpuTimingMethods = {
  /**
   * Where the frame graph writes pass timestamps, or `null` when timing is off.
   *
   * `GPUCommandEncoder.writeTimestamp` was removed from the spec (and from
   * Chrome); timestamps are only written at pass boundaries, which is what
   * per-pass timing needs anyway: slot `i` is queries `2i` (begin) and
   * `2i + 1` (end). `timestamp-query-inside-passes` is not requested.
   */
  gpuTimestampTarget(this: PerformanceProfiler): { querySet: GPUQuerySet; queryCount: number } | null {
    if (!this.timingEnabled || !this.timestampQuerySet || this.queryCount < 2) return null;
    return { querySet: this.timestampQuerySet, queryCount: this.queryCount };
  },

  /**
   * Queue a single in-flight timestamp resolve (avoids buffer-in-use-during-submit).
   * `passes` maps slots to names as the frame graph assigned them this frame.
   */
  scheduleResolveTimestamps(
    this: PerformanceProfiler,
    passes: ReadonlyArray<{ name: string; slot: number }>,
    queriesUsed: number
  ): void {
    if (!this.timingEnabled || this._timestampResolvePending || !passes.length || queriesUsed < 2) return;
    this._timestampResolvePending = true;
    this.resolveTimestamps(passes.slice(), queriesUsed)
      .catch(() => {})
      .finally(() => { this._timestampResolvePending = false; });
  },

  /**
   * Resolve one frame's pass timestamps into `gpuPassTimesMs` (F3) and
   * `lastGpuTimeMs` (first timed begin → last timed end).
   */
  async resolveTimestamps(
    this: PerformanceProfiler,
    passes: ReadonlyArray<{ name: string; slot: number }>,
    queriesUsed: number
  ): Promise<number | undefined> {
    if (!this.timingEnabled || !this.timestampQuerySet || !this.timestampResolveBuffer || !this.timestampMappedBuffer) return;
    const count = Math.min(queriesUsed, this.queryCount);

    const commandEncoder = this.device.createCommandEncoder({ label: 'gpu-timing-resolve' });
    commandEncoder.resolveQuerySet(this.timestampQuerySet, 0, count, this.timestampResolveBuffer, 0);
    commandEncoder.copyBufferToBuffer(this.timestampResolveBuffer, 0, this.timestampMappedBuffer, 0, count * 8);
    this.device.queue.submit([commandEncoder.finish({ label: 'gpu-timing-resolve' })]);

    await this.timestampMappedBuffer.mapAsync(GPUMapMode.READ, 0, count * 8);
    const timestamps = new BigUint64Array(this.timestampMappedBuffer.getMappedRange(0, count * 8));

    // Implementations may zero or clamp timestamps; a non-increasing pair is
    // a dropped sample, not 0 ms.
    const perPass: Record<string, number> = {};
    let first: bigint | null = null;
    let last: bigint | null = null;
    for (const { name, slot } of passes) {
      const begin = timestamps[2 * slot];
      const end = timestamps[2 * slot + 1];
      if (2 * slot + 1 >= count || end <= begin) continue;
      perPass[name] = Number(end - begin) / 1_000_000;
      if (first === null || begin < first) first = begin;
      if (last === null || end > last) last = end;
    }
    this.timestampMappedBuffer.unmap();
    if (first === null || last === null) return undefined;

    const gpuTimeMs = Number(last - first) / 1_000_000;
    this.lastGpuTimeMs = gpuTimeMs;
    this.gpuPassTimesMs = perPass;

    // Update history
    const idx = (this.fpsIndex - 1 + this.gpuTimeHistory.length) % this.gpuTimeHistory.length;
    this.gpuTimeHistory[idx] = gpuTimeMs;
    return gpuTimeMs;
  }
};
