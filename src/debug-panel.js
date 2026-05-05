export class DebugPanel {
  constructor(profiler) {
    this.profiler = profiler;
    this.visible = false;
    this.canvas = null;
    this.ctx = null;
    this.animationId = null;
    this.createPanel();
  }

  createPanel() {
    // Container
    const container = document.createElement('div');
    container.id = 'debugPanel';
    container.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      width: 400px;
      background: rgba(0, 10, 20, 0.95);
      border: 1px solid #0ff;
      border-radius: 8px;
      padding: 15px;
      color: #0ff;
      font-family: 'Segoe UI', monospace;
      font-size: 12px;
      z-index: 1000;
      display: none;
      box-shadow: 0 0 20px rgba(0, 255, 255, 0.3);
      max-height: 80vh;
      overflow-y: auto;
    `;

    // Header
    const header = document.createElement('div');
    header.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; border-bottom: 1px solid #0ff; padding-bottom: 10px;">
        <span style="font-weight: bold; font-size: 14px;">🔧 Performance Debug</span>
        <button id="closeDebug" style="background: #111; border: 1px solid #0ff; color: #0ff; cursor: pointer; padding: 4px 8px; border-radius: 4px;">✕</button>
      </div>
    `;
    container.appendChild(header);

    // Stats grid
    const statsDiv = document.createElement('div');
    statsDiv.id = 'debugStats';
    statsDiv.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 15px;';
    container.appendChild(statsDiv);

    // FPS Graph
    const graphContainer = document.createElement('div');
    graphContainer.innerHTML = `
      <div style="margin: 15px 0; font-size: 11px; color: #888;">FPS History (60s)</div>
      <canvas id="fpsGraph" width="370" height="80" style="background: rgba(0,20,40,0.8); border: 1px solid #0ff; border-radius: 4px;"></canvas>
    `;
    container.appendChild(graphContainer);

    // Particle vs FPS
    const correlationContainer = document.createElement('div');
    correlationContainer.innerHTML = `
      <div style="margin: 15px 0; font-size: 11px; color: #888;">Particle Count vs FPS</div>
      <canvas id="correlationGraph" width="370" height="80" style="background: rgba(0,20,40,0.8); border: 1px solid #0ff; border-radius: 4px;"></canvas>
    `;
    container.appendChild(correlationContainer);

    // Controls
    const controlsDiv = document.createElement('div');
    controlsDiv.style.cssText = 'margin-top: 15px; padding-top: 15px; border-top: 1px solid #333;';
    controlsDiv.innerHTML = `
      <div style="margin-bottom: 10px;">
        <label style="display: flex; align-items: center; cursor: pointer;">
          <input type="checkbox" id="autoQualityToggle" checked style="margin-right: 8px;">
          <span>Auto Quality Scaling</span>
        </label>
      </div>
      <div style="margin-bottom: 10px;">
        <label style="display: flex; align-items: center; cursor: pointer;">
          <input type="checkbox" id="gpuTimingToggle" style="margin-right: 8px;">
          <span>GPU Timing Queries</span>
        </label>
      </div>
      <div style="display: flex; gap: 8px; margin-top: 15px;">
        <button id="startBenchmark" style="flex: 1; padding: 8px; background: #0ff; color: #000; border: none; border-radius: 4px; cursor: pointer; font-weight: bold;">Start Benchmark</button>
        <button id="applyOptimal" style="flex: 1; padding: 8px; background: #111; color: #0ff; border: 1px solid #0ff; border-radius: 4px; cursor: pointer;">Apply Optimal</button>
      </div>
      <div id="benchmarkResults" style="margin-top: 10px; padding: 10px; background: rgba(0,50,50,0.5); border-radius: 4px; display: none; font-size: 11px;"></div>
    `;
    container.appendChild(controlsDiv);

    // Scientific Data Section (Wolfram Sources)
    const scientificDiv = document.createElement('div');
    scientificDiv.id = 'scientificData';
    scientificDiv.style.cssText = 'margin-top: 15px; padding-top: 15px; border-top: 1px solid #0ff; font-size: 11px;';
    scientificDiv.innerHTML = `
      <div style="color: #0ff; margin-bottom: 8px; font-weight: bold;">📊 Wolfram Scientific Data</div>
      <div id="wolframData" style="max-height: 200px; overflow-y: auto;"></div>
    `;
    container.appendChild(scientificDiv);

    // Memory details
    const memoryDiv = document.createElement('div');
    memoryDiv.id = 'memoryDetails';
    memoryDiv.style.cssText = 'margin-top: 15px; padding-top: 15px; border-top: 1px solid #333; font-size: 11px;';
    container.appendChild(memoryDiv);

    document.body.appendChild(container);

    // Get canvas contexts
    this.canvas = document.getElementById('fpsGraph');
    this.ctx = this.canvas.getContext('2d');
    this.correlationCanvas = document.getElementById('correlationGraph');
    this.correlationCtx = this.correlationCanvas.getContext('2d');

    // Event listeners
    document.getElementById('closeDebug').addEventListener('click', () => this.hide());
    document.getElementById('autoQualityToggle').addEventListener('change', (e) => {
      this.profiler.autoQualityEnabled = e.target.checked;
    });
    document.getElementById('gpuTimingToggle').addEventListener('change', (e) => {
      this.profiler.timingEnabled = e.target.checked;
    });
    document.getElementById('startBenchmark').addEventListener('click', () => this.startBenchmark());
    document.getElementById('applyOptimal').addEventListener('click', () => this.applyOptimalSettings());

    this.panel = container;
  }

  show() {
    this.visible = true;
    this.panel.style.display = 'block';
    this.startUpdateLoop();
  }

  hide() {
    this.visible = false;
    this.panel.style.display = 'none';
    this.stopUpdateLoop();
  }

  toggle() {
    if (this.visible) this.hide();
    else this.show();
  }

  startUpdateLoop() {
    const update = () => {
      if (!this.visible) return;
      this.update();
      this.animationId = requestAnimationFrame(update);
    };
    update();
  }

  stopUpdateLoop() {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  }

  update() {
    const stats = this.profiler.getStats();

    // Update quality indicator in main UI
    const qualityEl = document.getElementById('qualityLevel');
    if (qualityEl) {
      qualityEl.textContent = (stats.qualityLevel * 100).toFixed(0) + '%';
      const modeDiv = document.getElementById('performanceMode');
      if (modeDiv) {
        const indicator = modeDiv.querySelector('span');
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
    const gpuTierEl = document.getElementById('gpuTierDisplay');
    if (gpuTierEl) {
      gpuTierEl.textContent = stats.gpuTier.toUpperCase();
      gpuTierEl.style.color = stats.gpuTier === 'high' ? '#4f4' : (stats.gpuTier === 'medium' ? '#ff4' : '#f44');
    }

    // Update particle count
    const particleEl = document.getElementById('particleCount');
    if (particleEl) {
      const count = Math.floor(parseInt(particleEl.textContent) * stats.qualityLevel);
      particleEl.textContent = (count / 1000).toFixed(1) + 'K';
    }

    // Update stats grid
    const statsDiv = document.getElementById('debugStats');
    statsDiv.innerHTML = `
      <div style="color: #888;">Current FPS:</div>
      <div style="color: ${stats.currentFPS < 45 ? '#f44' : (stats.currentFPS < 55 ? '#ff4' : '#4f4')}; font-weight: bold;">${stats.currentFPS.toFixed(1)}</div>

      <div style="color: #888;">Average FPS:</div>
      <div style="color: #0ff;">${stats.averageFPS.toFixed(1)}</div>

      <div style="color: #888;">Min/Max FPS:</div>
      <div style="color: #0ff;">${stats.minFPS.toFixed(0)} / ${stats.maxFPS.toFixed(0)}</div>

      <div style="color: #888;">Quality Level:</div>
      <div style="color: ${stats.qualityLevel < 0.8 ? '#ff4' : '#4f4'};">${(stats.qualityLevel * 100).toFixed(0)}%</div>

      <div style="color: #888;">GPU Tier:</div>
      <div style="color: ${stats.gpuTier === 'high' ? '#4f4' : (stats.gpuTier === 'medium' ? '#ff4' : '#f44')}; text-transform: uppercase;">${stats.gpuTier}</div>

      <div style="color: #888;">GPU Timing:</div>
      <div style="color: ${stats.timingEnabled ? '#4f4' : '#888'};">${stats.timingEnabled ? 'Enabled' : 'Disabled'}</div>

      <div style="color: #888;">Buffer Memory:</div>
      <div style="color: #0ff;">${stats.bufferMemoryMB} MB (${stats.bufferCount} buffers)</div>

      <div style="color: #888;">Texture Memory:</div>
      <div style="color: #0ff;">${stats.textureMemoryMB} MB (${stats.textureCount} textures)</div>
    `;

    // Draw FPS graph
    this.drawFPSGraph();

    // Draw correlation graph
    this.drawCorrelationGraph();

    // Update memory details
    this.updateMemoryDetails();

    // Update scientific data
    this.updateScientificData();
  }

  drawFPSGraph() {
    const ctx = this.ctx;
    const width = this.canvas.width;
    const height = this.canvas.height;
    const points = this.profiler.getFPSGraphData(width, height);

    ctx.fillStyle = 'rgba(0, 20, 40, 1)';
    ctx.fillRect(0, 0, width, height);

    // Grid lines
    ctx.strokeStyle = 'rgba(0, 255, 255, 0.2)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = (i / 4) * height;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    // FPS line
    ctx.strokeStyle = '#0ff';
    ctx.lineWidth = 2;
    ctx.beginPath();

    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (i === 0) ctx.moveTo(p.x, Math.max(0, Math.min(height, p.y)));
      else ctx.lineTo(p.x, Math.max(0, Math.min(height, p.y)));
    }
    ctx.stroke();

    // Target FPS line (60fps)
    const targetY = height - (60 / 80) * height;
    ctx.strokeStyle = 'rgba(0, 255, 0, 0.5)';
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(0, targetY);
    ctx.lineTo(width, targetY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Labels
    ctx.fillStyle = '#888';
    ctx.font = '10px monospace';
    ctx.fillText('80 FPS', 4, 12);
    ctx.fillText('40 FPS', 4, height / 2);
    ctx.fillText('0 FPS', 4, height - 4);
  }

  drawCorrelationGraph() {
    const ctx = this.correlationCtx;
    const width = this.correlationCanvas.width;
    const height = this.correlationCanvas.height;
    const data = this.profiler.getParticleFPSCorrelation();

    ctx.fillStyle = 'rgba(0, 20, 40, 1)';
    ctx.fillRect(0, 0, width, height);

    if (data.length === 0) return;

    // Find ranges
    const maxParticles = Math.max(...data.map(d => d.particles));
    const maxFPS = 80;

    // Draw points
    for (const point of data) {
      const x = (point.particles / maxParticles) * width;
      const y = height - (point.fps / maxFPS) * height;

      const intensity = point.fps / 60;
      const r = Math.floor((1 - intensity) * 255);
      const g = Math.floor(intensity * 255);

      ctx.fillStyle = `rgba(${r}, ${g}, 100, 0.6)`;
      ctx.fillRect(x - 1, y - 1, 3, 3);
    }

    // Labels
    ctx.fillStyle = '#888';
    ctx.font = '10px monospace';
    ctx.fillText('0', 4, height - 4);
    ctx.fillText(maxParticles.toLocaleString(), width - 40, height - 4);
    ctx.fillText('80 FPS', 4, 12);
    ctx.fillText('Part', width / 2 - 15, height - 4);
  }

  updateMemoryDetails() {
    const memoryDiv = document.getElementById('memoryDetails');
    const recentBuffers = this.profiler.bufferAllocations.slice(-5);
    const recentTextures = this.profiler.textureAllocations.slice(-5);

    let html = '<div style="color: #888; margin-bottom: 8px;">Recent Allocations:</div>';

    html += '<div style="color: #0aa;">Buffers:</div>';
    for (const buf of recentBuffers) {
      const size = (buf.size / 1024 / 1024).toFixed(2);
      html += `<div style="margin-left: 8px; color: #888;">${buf.name}: ${size}MB</div>`;
    }

    html += '<div style="color: #0aa; margin-top: 8px;">Textures:</div>';
    for (const tex of recentTextures) {
      const size = (tex.size / 1024 / 1024).toFixed(2);
      html += `<div style="margin-left: 8px; color: #888;">${tex.name}: ${tex.width}x${tex.height} (${size}MB)</div>`;
    }

    memoryDiv.innerHTML = html;
  }

  updateScientificData() {
    const wolframDiv = document.getElementById('wolframData');
    if (!wolframDiv) return;

    let html = '';

    // SEG Data
    html += '<div style="color: #0ff; margin-top: 8px;">SEG (Magnetic):</div>';
    html += `<div style="margin-left: 8px; color: #888;">B-field @ surface: <span style="color: #0ff">${SEG_DATA.B_FIELD.surface.toFixed(3)} T</span></div>`;
    html += `<div style="margin-left: 8px; color: #888;">Magnetic moment: <span style="color: #0ff">${(SEG_DATA.MAGNETIC_MOMENT / 1e6).toFixed(2)} MA·m²</span></div>`;
    html += `<div style="margin-left: 8px; color: #888;">Energy density: <span style="color: #0ff">${(SEG_DATA.ENERGY_DENSITY.surface / 1e6).toFixed(2)} MJ/m³</span></div>`;
    html += `<div style="margin-left: 8px; color: #888;">Adjacent force: <span style="color: #0ff">${(SEG_DATA.ADJACENT_FORCE / 1e6).toFixed(1)} MN</span></div>`;

    // Kelvin Data
    html += '<div style="color: #f0f; margin-top: 8px;">Kelvin (Electrostatic):</div>';
    html += `<div style="margin-left: 8px; color: #888;">Bucket capacitance: <span style="color: #f0f">${(KELVIN_DATA.BUCKET.capacitance * 1e12).toFixed(1)} pF</span></div>`;
    html += `<div style="margin-left: 8px; color: #888;">Droplet charge: <span style="color: #f0f">${(KELVIN_DATA.DROPLET.charge * 1e9).toFixed(0)} nC</span></div>`;
    html += `<div style="margin-left: 8px; color: #888;">V @ 1s: <span style="color: #f0f">${(KELVIN_DATA.VOLTAGE_BUILDUP.at1s / 1e3).toFixed(0)} kV</span></div>`;
    html += `<div style="margin-left: 8px; color: #888;">Spark gap @ 10kV: <span style="color: #f0f">${(KELVIN_DATA.SPARK_GAPS.at10kV * 1e3).toFixed(2)} mm</span></div>`;

    // Heron Data
    html += '<div style="color: #08f; margin-top: 8px;">Heron (SPH Fluid):</div>';
    html += `<div style="margin-left: 8px; color: #888;">Smoothing length: <span style="color: #08f">${(HERON_DATA.SPH.smoothingLength * 1e3).toFixed(1)} mm</span></div>`;
    html += `<div style="margin-left: 8px; color: #888;">Gas constant: <span style="color: #08f">${(HERON_DATA.SPH.gasConstant / 1e3).toFixed(0)} kPa</span></div>`;
    html += `<div style="margin-left: 8px; color: #888;">Siphon velocity (1m): <span style="color: #08f">${HERON_DATA.SIPHON_VELOCITY.at1m.toFixed(2)} m/s</span></div>`;
    html += `<div style="margin-left: 8px; color: #888;">Pressure @ 2m: <span style="color: #08f">${(HERON_DATA.PRESSURE.at2m / 1e3).toFixed(1)} kPa</span></div>`;

    // Microvolt Data
    html += '<div style="color: #ff4; margin-top: 8px;">Microvolt Precision:</div>';
    html += `<div style="margin-left: 8px; color: #888;">Thermal noise (1Hz): <span style="color: #ff4">${(MICROVOLT_DATA.THERMAL_NOISE.at1Hz_1MOhm * 1e6).toFixed(3)} μV</span></div>`;
    html += `<div style="margin-left: 8px; color: #888;">Single e- on 1pF: <span style="color: #ff4">${(MICROVOLT_DATA.SINGLE_ELECTRON.at1pF * 1e6).toFixed(0)} nV</span></div>`;
    html += `<div style="margin-left: 8px; color: #888;">Min detectable: <span style="color: #ff4">${(MICROVOLT_DATA.SIMULATION.minVoltageStep * 1e6).toFixed(1)} μV</span></div>`;

    wolframDiv.innerHTML = html;
  }

  startBenchmark() {
    const duration = this.profiler.startBenchmark();
    const resultsDiv = document.getElementById('benchmarkResults');
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

  showBenchmarkResults() {
    const results = this.profiler.endBenchmark();
    const resultsDiv = document.getElementById('benchmarkResults');

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

  applyOptimalSettings() {
    const settings = this.profiler.getOptimalSettings();

    // Update sliders
    const particleSlider = document.getElementById('particleSlider');
    if (particleSlider) {
      particleSlider.value = settings.particleCount;
      document.getElementById('particleVal').textContent = settings.particleCount.toLocaleString();
    }

    // Show confirmation
    alert(`Optimal settings applied for ${this.profiler.gpuTier} GPU:\n` +
          `• Particles: ${settings.particleCount.toLocaleString()}\n` +
          `• Field Lines: ${settings.enableFieldLines ? 'Enabled' : 'Disabled'}\n` +
          `• SPH: ${settings.enableSPH ? 'Enabled' : 'Disabled'}\n` +
          `• Target FPS: ${settings.targetFPS}`);
  }
}

// ============================================
// DEVICE CONFIGURATION
// ============================================
export const DEVICE_CONFIG = {
  seg: {
    position: [0, 0, -8],
    rotation: [0, 0, 0, 1],
    cameraOffset: [0, 3, 8],
    particleCount: 10000,
    color: [0.0, 0.9, 1.0],
    core: {
      shaftRadius: 0.5,
      shaftHeight: 6.0,
      coreRadius: 1.2,
      coreHeight: 3.0,
      plateRadius: 3.0,
      plateThickness: 0.3,
      plateY: 2.5,
      boltCount: 24,
      boltRadius: 0.08,
      boltHeight: 0.25,
      baseColor: [0.53, 0.6, 0.67], // Steel gray #8899aa
      coreColor: [0.0, 0.8, 0.9],   // Cyan-tinted NdFeB
      glowColor: [0.0, 0.9, 1.0]    // Magnetic glow
    }
  },
  heron: {
    position: [-7, 0, 4],
    rotation: [0, Math.PI / 6, 0],
    cameraOffset: [0, 4, 8],
    particleCount: 10000,
    color: [0.0, 0.6, 1.0]
  },
  kelvin: {
    position: [7, 0, 4],
    rotation: [0, -Math.PI / 6, 0],
    cameraOffset: [0, 4, 8],
    particleCount: 10000,
    color: [0.8, 0.5, 1.0]
  },
  solar: {
    position: [0, 0, 8],
    rotation: [0, 0, 0],
    cameraOffset: [0, 4, 10],
    particleCount: 10000,
    color: [1.0, 0.9, 0.2]
  },
  peltier: {
    position: [15, 0, -15],
    rotation: [0, Math.PI / 4, 0],
    cameraOffset: [0, 4, 15],
    particleCount: 20000,
    color: [0.2, 0.9, 0.4]
  }
};