import type { PerformanceProfiler } from './performance-profiler';
import { domMethods } from './debug-panel-dom';
import { paneMethods } from './debug-panel-panes';

export class DebugPanel {
  profiler: PerformanceProfiler;
  visible: boolean;
  canvas!: HTMLCanvasElement;
  ctx!: CanvasRenderingContext2D;
  correlationCanvas!: HTMLCanvasElement;
  correlationCtx!: CanvasRenderingContext2D;
  animationId: number | null;
  panel!: HTMLDivElement;
  wasmDiffEnabled?: boolean;

  // Not private: assigned from src/debug-panel-dom.ts, which is merged onto the
  // prototype below (see the Object.assign call at the end of this file).
  _refreshEnergyNetworkStatus?: () => void;
  _wasmRefreshStatus?: () => void;

  constructor(profiler: PerformanceProfiler) {
    this.profiler = profiler;
    this.visible = false;
    this.animationId = null;
    this.createPanel();
  }

  show(): void {
    this.visible = true;
    this.panel.style.display = 'block';
    this.startUpdateLoop();
    this._wasmRefreshStatus?.();
  }

  hide(): void {
    this.visible = false;
    this.panel.style.display = 'none';
    this.stopUpdateLoop();
  }

  toggle(): void {
    if (this.visible) this.hide();
    else this.show();
  }

  startUpdateLoop(): void {
    const update = () => {
      if (!this.visible) return;
      this.update();
      this.animationId = requestAnimationFrame(update);
    };
    update();
  }

  stopUpdateLoop(): void {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  }

  private async _updateWasmDiff(): Promise<void> {
    const el = document.getElementById('wasmDiffReadout');
    if (!el) return;
    const { segWasm } = await import('./wasm/seg-physics-bridge');
    if (!segWasm.enabled) {
      el.textContent = 'Diff: enable WASM physics first';
      return;
    }
    // Seed + step a small CPU particle set if empty
    if (segWasm.getParticleFloatView()?.length === 0) {
      segWasm.seedParticles(512);
      segWasm.stepParticles(1 / 60);
    }
    const wasmR = segWasm.meanParticleRadius(128);
    // GPU path: sample SEG device particle buffer is not easily readable without
    // staging; use energyLevel proxy from visualizer + published mean radius label.
    const v = window.multiVisualizer;
    const gpuProxy = v?.devices?.seg?.particleCount
      ? (v.segOmega || 0) * 5.5 // characteristic ring radius * normalized ω proxy
      : 0;
    el.textContent =
      `Diff: WASM mean |r|=${wasmR.toFixed(3)} · GPU proxy=${gpuProxy.toFixed(3)} · ` +
      `Δ=${(wasmR - gpuProxy).toFixed(3)} · zero-copy ω̄=${segWasm.lastRollerMeanOmega.toFixed(4)}`;
  }

  update(): void {
    const stats = this.profiler.getStats();
    this._refreshEnergyNetworkStatus?.();

    // WASM vs GPU particle radius diff (optional)
    if (this.wasmDiffEnabled) {
      this._updateWasmDiff().catch(() => {});
    }

    // Update quality indicator in main UI
    const qualityEl = document.getElementById('qualityLevel');
    if (qualityEl) {
      qualityEl.textContent = (stats.qualityLevel * 100).toFixed(0) + '%';
      const modeDiv = document.getElementById('performanceMode') as HTMLElement | null;
      if (modeDiv) {
        const indicator = modeDiv.querySelector('span') as HTMLElement | null;
        if (stats.qualityLevel < 0.5) {
          modeDiv.style.background = 'rgba(50,0,0,0.5)';
          if (indicator) indicator.style.color = '#f44';
        } else if (stats.qualityLevel < 0.8) {
          modeDiv.style.background = 'rgba(50,30,0,0.5)';
          if (indicator) indicator.style.color = '#ff4';
        } else {
          modeDiv.style.background = 'rgba(0,50,0,0.5)';
          if (indicator) indicator.style.color = '#4f4';
        }
      }
    }

    // Update GPU tier display
    const gpuTierEl = document.getElementById('gpuTierDisplay') as HTMLElement | null;
    if (gpuTierEl) {
      gpuTierEl.textContent = stats.gpuTier.toUpperCase();
      gpuTierEl.style.color = stats.gpuTier === 'high' ? '#4f4' : (stats.gpuTier === 'medium' ? '#ff4' : '#f44');
    }

    // Update particle count
    const particleEl = document.getElementById('particleCount');
    if (particleEl) {
      const count = Math.floor(parseInt(particleEl.textContent || '0') * stats.qualityLevel);
      particleEl.textContent = (count / 1000).toFixed(1) + 'K';
    }

    // Update stats grid
    const statsDiv = document.getElementById('debugStats')!;
    statsDiv.innerHTML = `
      <div style="color: #888;">Current FPS:</div>
      <div style="color: ${stats.currentFPS < 45 ? '#f44' : (stats.currentFPS < 55 ? '#ff4' : '#4f4')}; font-weight: bold;">${stats.currentFPS.toFixed(1)}</div>

      <div style="color: #888;">Average FPS:</div>
      <div style="color: #0ff;">${stats.averageFPS.toFixed(1)}</div>

      <div style="color: #888;">Min/Max FPS:</div>
      <div style="color: #0ff;">${stats.minFPS.toFixed(0)} / ${stats.maxFPS.toFixed(0)}</div>

      <div style="color: #888;">Quality Level:</div>
      <div style="color: ${stats.qualityLevel < 0.8 ? '#ff4' : '#4f4'};">${(stats.qualityLevel * 100).toFixed(0)}% (${stats.qualityTier || '—'})</div>

      <div style="color: #888;">Draw calls (est.):</div>
      <div style="color: #0ff;">${stats.drawCallsEstimate ?? '—'}</div>

      <div style="color: #888;">Draw prep (CPU):</div>
      <div style="color: #0ff;">${(stats.drawPrepMs ?? 0).toFixed(2)} ms${stats.overviewCullActive ? ' · GPU cull' : ''}</div>
      <div style="color: #888;">Post Quality:</div>
      <div style="color: ${stats.qualityTier === 'critical' || stats.qualityTier === 'low' ? '#ff4' : '#4f4'}; font-size: 10px;">${stats.postQualitySummary || '—'}</div>

      <div style="color: #888;">MSAA (ADR-0005 WS2):</div>
      <div style="color: ${stats.msaaActive ? '#4f4' : '#888'};">${stats.msaaActive ? '4x' : '1x (off)'}</div>

      <div style="color: #888;">TAA (ADR-0005 WS2):</div>
      <div style="color: ${stats.taaActive ? '#4f4' : '#888'};">${stats.taaActive ? 'on' : 'off'}</div>

      <div style="color: #888;">FDTD slice (ADR-0010):</div>
      <div style="color: ${stats.fdtdActive ? '#4f4' : '#888'};">${stats.fdtdActive ? 'on' : 'off'}</div>

      <div style="color: #888;">GPU Tier:</div>
      <div style="color: ${stats.gpuTier === 'high' ? '#4f4' : (stats.gpuTier === 'medium' ? '#ff4' : '#f44')}; text-transform: uppercase;">${stats.gpuTier}</div>

      <div style="color: #888;">Adapter:</div>
      <div style="color: #8cf; font-size: 10px;">${stats.adapterSummary || '—'}</div>

      <div style="color: #888;">Frame / CPU:</div>
      <div style="color: #0ff;">${(stats.frameTimeMs || 0).toFixed(1)} / ${(stats.frameCpuMs || 0).toFixed(1)} ms</div>

      <div style="color: #888;">GPU Timing:</div>
      <div style="color: ${stats.timingEnabled ? '#4f4' : '#888'};">${stats.timingEnabled ? `On · ${(stats.lastGpuTimeMs || 0).toFixed(2)} ms` : 'Disabled'}</div>

      <div style="color: #888;">Buffer Memory:</div>
      <div style="color: #0ff;">${stats.bufferMemoryMB} MB (${stats.bufferCount} buffers)</div>

      <div style="color: #888;">Texture Memory:</div>
      <div style="color: #0ff;">${stats.textureMemoryMB} MB (${stats.textureCount} textures)</div>
    `;

    // Per-device CPU time breakdown (acceptance: profiler shows per-device times)
    let deviceTimingEl = document.getElementById('deviceTimingBreakdown') as HTMLElement | null;
    if (!deviceTimingEl) {
      deviceTimingEl = document.createElement('div');
      deviceTimingEl.id = 'deviceTimingBreakdown';
      deviceTimingEl.style.cssText = 'margin: 12px 0; padding: 8px; background: rgba(0,20,40,0.6); border: 1px solid #244; border-radius: 4px; font-size: 11px;';
      statsDiv.parentNode?.insertBefore(deviceTimingEl, statsDiv.nextSibling);
    }
    const times = stats.deviceTimes || [];
    if (times.length) {
      const rows = times
        .slice(0, 14)
        .map(({ id, ms }) => {
          const color = ms > 2 ? '#f84' : ms > 0.8 ? '#ff4' : '#4f8';
          return `<div style="display:flex;justify-content:space-between;gap:8px;"><span style="color:#888;">${id}</span><span style="color:${color};">${ms.toFixed(2)} ms</span></div>`;
        })
        .join('');
      deviceTimingEl.innerHTML = `<div style="color:#8cf;font-weight:bold;margin-bottom:6px;">Per-device CPU</div>${rows}`;
    } else {
      deviceTimingEl.innerHTML = `<div style="color:#666;">Per-device CPU: —</div>`;
    }

    // Draw FPS graph
    this.drawFPSGraph();

    // Draw correlation graph
    this.drawCorrelationGraph();

    // Update memory details
    this.updateMemoryDetails();

    // Update scientific data
    this.updateScientificData();
    this.updateDevicePhysicsData();
  }

  startBenchmark(): void {
    const duration = this.profiler.startBenchmark();
    const resultsDiv = document.getElementById('benchmarkResults') as HTMLElement;
    resultsDiv.style.display = 'block';
    resultsDiv.innerHTML = `Benchmark running... ${duration}s remaining`;

    // Update countdown
    let remaining = duration;
    const countdown = setInterval(() => {
      remaining--;
      if (remaining > 0 && this.profiler.benchmarkMode) {
        resultsDiv.innerHTML = `Benchmark running... ${remaining}s remaining`;
      } else {
        clearInterval(countdown);
      }
    }, 1000);

    // Wait for benchmark to complete
    setTimeout(() => {
      this.showBenchmarkResults();
    }, (duration + 1) * 1000);
  }

  showBenchmarkResults(): void {
    const results = this.profiler.endBenchmark();
    const resultsDiv = document.getElementById('benchmarkResults')!;

    resultsDiv.innerHTML = `
      <div style="color: #0ff; font-weight: bold; margin-bottom: 8px;">Benchmark Complete!</div>
      <div>Duration: ${results.duration.toFixed(1)}s</div>
      <div>Frames: ${results.totalFrames.toLocaleString()}</div>
      <div style="color: #4f4;">Average FPS: ${results.averageFPS.toFixed(1)}</div>
      <div>Min/Max: ${results.minFPS.toFixed(0)} / ${results.maxFPS.toFixed(0)}</div>
      <div>1% Low: ${results.onePercentLow.toFixed(1)} FPS</div>
      <div style="margin-top: 8px; color: ${results.averageFPS > 55 ? '#4f4' : (results.averageFPS > 40 ? '#ff4' : '#f44')};">
        ${results.averageFPS > 55 ? '✓ Excellent performance' : (results.averageFPS > 40 ? '⚠ Acceptable performance' : '✗ Poor performance')}
      </div>
    `;
  }

  applyOptimalSettings(): void {
    const settings = this.profiler.getOptimalSettings();

    // Update sliders
    const particleSlider = document.getElementById('particleSlider') as HTMLInputElement | null;
    if (particleSlider) {
      particleSlider.value = String(settings.particleCount);
      const particleVal = document.getElementById('particleVal');
      if (particleVal) particleVal.textContent = settings.particleCount.toLocaleString();
    }

    // Show confirmation
    alert(`Optimal settings applied for ${this.profiler.gpuTier} GPU:\n` +
          `• Particles: ${settings.particleCount.toLocaleString()}\n` +
          `• Field Lines: ${settings.enableFieldLines ? 'Enabled' : 'Disabled'}\n` +
          `• SPH: ${settings.enableSPH ? 'Enabled' : 'Disabled'}\n` +
          `• Target FPS: ${settings.targetFPS}`);
  }
}

// Declaration merging: these methods are implemented on the prototype (below) by
// src/debug-panel-dom.ts and src/debug-panel-panes.ts, but declared here so the
// class's own methods (constructor, update(), ...) type-check when calling them.
export interface DebugPanel {
  createPanel(): void;
  _wireEnergyNetworkControls(): void;
  _wireWasmControls(): void;
  updateDevicePhysicsData(): void;
  drawFPSGraph(): void;
  drawCorrelationGraph(): void;
  updateMemoryDetails(): void;
  updateScientificData(): void;
}

Object.assign(DebugPanel.prototype, domMethods, paneMethods);
