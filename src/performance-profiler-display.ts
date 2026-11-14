import type { PerformanceProfiler, FpsGraphPoint, ParticleFpsCorrelationPoint } from './performance-profiler';

/**
 * F3 overlay display-data helpers for {@link PerformanceProfiler}, split out to
 * keep performance-profiler.ts under the 700-line cap (see issues #142/#143/#187).
 *
 * Plain functions that take the profiler; the PerformanceProfiler methods of
 * the same names delegate here (no prototype mixin — see
 * ADR-0016; #244 was a WebGPU boot break from that pattern).
 */
// Generate FPS graph data for canvas
export function getFPSGraphData(profiler: PerformanceProfiler, width: number, height: number): FpsGraphPoint[] {
  const points: FpsGraphPoint[] = [];
  const count = Math.min(width, profiler.fpsHistoryFilled ? profiler.fpsHistory.length : profiler.fpsIndex);

  for (let i = 0; i < count; i++) {
    const idx = (profiler.fpsIndex - count + i + profiler.fpsHistory.length) % profiler.fpsHistory.length;
    const fps = profiler.fpsHistory[idx];
    const x = (i / (count - 1)) * width;
    const y = height - (fps / 80) * height; // Scale 0-80 FPS to height
    points.push({ x, y, fps });
  }

  return points;
}

// Get particle vs FPS correlation data
export function getParticleFPSCorrelation(profiler: PerformanceProfiler): ParticleFpsCorrelationPoint[] {
  const data: ParticleFpsCorrelationPoint[] = [];
  const count = profiler.fpsHistoryFilled ? profiler.fpsHistory.length : profiler.fpsIndex;

  for (let i = 0; i < count; i++) {
    data.push({
      particles: profiler.particleHistory[i],
      fps: profiler.fpsHistory[i],
      frameTime: profiler.frameTimeHistory[i]
    });
  }

  return data;
}

