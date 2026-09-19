import type { PerformanceProfiler, FpsGraphPoint, ParticleFpsCorrelationPoint } from './performance-profiler';

/**
 * F3 overlay display-data helpers for {@link PerformanceProfiler}, split out to
 * keep performance-profiler.ts under the 700-line cap (see issues #142/#143/#187).
 *
 * Merged onto `PerformanceProfiler.prototype` via `Object.assign` in
 * performance-profiler.ts, so these run as ordinary prototype methods with
 * normal `this` binding at call time — no special binding helper needed.
 */
export const displayMethods = {
  // Generate FPS graph data for canvas
  getFPSGraphData(this: PerformanceProfiler, width: number, height: number): FpsGraphPoint[] {
    const points: FpsGraphPoint[] = [];
    const count = Math.min(width, this.fpsHistoryFilled ? this.fpsHistory.length : this.fpsIndex);

    for (let i = 0; i < count; i++) {
      const idx = (this.fpsIndex - count + i + this.fpsHistory.length) % this.fpsHistory.length;
      const fps = this.fpsHistory[idx];
      const x = (i / (count - 1)) * width;
      const y = height - (fps / 80) * height; // Scale 0-80 FPS to height
      points.push({ x, y, fps });
    }

    return points;
  },

  // Get particle vs FPS correlation data
  getParticleFPSCorrelation(this: PerformanceProfiler): ParticleFpsCorrelationPoint[] {
    const data: ParticleFpsCorrelationPoint[] = [];
    const count = this.fpsHistoryFilled ? this.fpsHistory.length : this.fpsIndex;

    for (let i = 0; i < count; i++) {
      data.push({
        particles: this.particleHistory[i],
        fps: this.fpsHistory[i],
        frameTime: this.frameTimeHistory[i]
      });
    }

    return data;
  }
};
