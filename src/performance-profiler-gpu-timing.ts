import type { PerformanceProfiler } from './performance-profiler';

/**
 * GPU timestamp query/resolve logic for {@link PerformanceProfiler}, split out to
 * keep performance-profiler.ts under the 700-line cap (see issues #142/#143/#187).
 *
 * Plain functions that take the profiler; the PerformanceProfiler methods of
 * the same names delegate here (no prototype mixin — see
 * ADR-0016; #244 was a WebGPU boot break from that pattern).
 */
/** Timed passes per frame the query set has room for (two queries each). */
export const GPU_TIMING_MAX_PASSES = 16;

/**
 * Where the frame graph writes pass timestamps, or `null` when timing is off.
 *
 * `GPUCommandEncoder.writeTimestamp` was removed from the spec (and from
 * Chrome); timestamps are only written at pass boundaries, which is what
 * per-pass timing needs anyway: slot `i` is queries `2i` (begin) and
 * `2i + 1` (end). `timestamp-query-inside-passes` is not requested.
 */
export function gpuTimestampTarget(profiler: PerformanceProfiler): { querySet: GPUQuerySet; queryCount: number } | null {
  if (!profiler.timingEnabled || !profiler.timestampQuerySet || profiler.queryCount < 2) return null;
  return { querySet: profiler.timestampQuerySet, queryCount: profiler.queryCount };
}

/**
 * Queue a single in-flight timestamp resolve (avoids buffer-in-use-during-submit).
 * `passes` maps slots to names as the frame graph assigned them this frame.
 */
export function scheduleResolveTimestamps(
  profiler: PerformanceProfiler,
  passes: ReadonlyArray<{ name: string; slot: number }>,
  queriesUsed: number
): void {
  if (!profiler.timingEnabled || profiler._timestampResolvePending || !passes.length || queriesUsed < 2) return;
  profiler._timestampResolvePending = true;
  profiler.resolveTimestamps(passes.slice(), queriesUsed)
    .catch(() => {})
    .finally(() => { profiler._timestampResolvePending = false; });
}

/**
 * Resolve one frame's pass timestamps into `gpuPassTimesMs` (F3) and
 * `lastGpuTimeMs` (first timed begin → last timed end).
 */
export async function resolveTimestamps(
  profiler: PerformanceProfiler,
  passes: ReadonlyArray<{ name: string; slot: number }>,
  queriesUsed: number
): Promise<number | undefined> {
  if (!profiler.timingEnabled || !profiler.timestampQuerySet || !profiler.timestampResolveBuffer || !profiler.timestampMappedBuffer) return;
  const count = Math.min(queriesUsed, profiler.queryCount);

  const commandEncoder = profiler.device.createCommandEncoder({ label: 'gpu-timing-resolve' });
  commandEncoder.resolveQuerySet(profiler.timestampQuerySet, 0, count, profiler.timestampResolveBuffer, 0);
  commandEncoder.copyBufferToBuffer(profiler.timestampResolveBuffer, 0, profiler.timestampMappedBuffer, 0, count * 8);
  profiler.device.queue.submit([commandEncoder.finish({ label: 'gpu-timing-resolve' })]);

  await profiler.timestampMappedBuffer.mapAsync(GPUMapMode.READ, 0, count * 8);
  const timestamps = new BigUint64Array(profiler.timestampMappedBuffer.getMappedRange(0, count * 8));

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
  profiler.timestampMappedBuffer.unmap();
  if (first === null || last === null) return undefined;

  const gpuTimeMs = Number(last - first) / 1_000_000;
  profiler.lastGpuTimeMs = gpuTimeMs;
  profiler.gpuPassTimesMs = perPass;

  // Update history
  const idx = (profiler.fpsIndex - 1 + profiler.gpuTimeHistory.length) % profiler.gpuTimeHistory.length;
  profiler.gpuTimeHistory[idx] = gpuTimeMs;
  return gpuTimeMs;
}

