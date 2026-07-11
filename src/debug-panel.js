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
      <div style="margin-bottom: 10px;">
        <label style="display: block; margin-bottom: 4px; color: #888;">Lighting look</label>
        <select id="lightingLookSelect" style="width: 100%; padding: 6px; background: #111; color: #0ff; border: 1px solid #0ff; border-radius: 4px;">
          <option value="studio">Studio (default)</option>
          <option value="lab">Lab (bright neutral)</option>
          <option value="drama">Drama (dark cinematic)</option>
        </select>
      </div>
      <div style="margin-bottom: 10px;">
        <label style="display: block; margin-bottom: 4px; color: #888;">Exposure / bloom</label>
        <input type="range" id="exposureSlider" min="0.6" max="1.6" step="0.02" value="1.05" style="width: 100%;">
        <input type="range" id="bloomSlider" min="0.5" max="2.2" step="0.05" value="1.15" style="width: 100%; margin-top: 4px;">
      </div>
      <div style="margin-bottom: 10px;">
        <label style="display: flex; align-items: center; cursor: pointer;">
          <input type="checkbox" id="segAnnotationsToggle" style="margin-right: 8px;">
          <span>SEG component labels (L)</span>
        </label>
      </div>
      <div style="margin-bottom: 10px;">
        <label style="display: block; margin-bottom: 4px; color: #888;">SEG frame complexity</label>
        <select id="segFrameLevelSelect" style="width: 100%; padding: 6px; background: #111; color: #0ff; border: 1px solid #0ff; border-radius: 4px;">
          <option value="full">Full (bench + cage + control box)</option>
          <option value="minimal">Minimal (bench + columns)</option>
          <option value="off">Off (rollers only)</option>
        </select>
      </div>
      <div style="margin-bottom: 10px; padding: 8px; background: rgba(0,40,60,0.5); border-radius: 4px;">
        <div style="color: #8cf; font-weight: bold; margin-bottom: 6px;">C++ WASM Physics</div>
        <label style="display: flex; align-items: center; cursor: pointer; margin-bottom: 6px;">
          <input type="checkbox" id="wasmPhysicsToggle" style="margin-right: 8px;">
          <span>Use C++ WASM Physics (RK4 / multi-mode)</span>
        </label>
        <label style="display: flex; align-items: center; cursor: pointer; margin-bottom: 6px;">
          <input type="checkbox" id="wasmDiffToggle" style="margin-right: 8px;">
          <span>Diff mode: WASM vs GPU particle radius</span>
        </label>
        <div id="wasmPhysicsStatus" style="font-size: 10px; color: #888; margin-bottom: 6px;">WASM: —</div>
        <div id="wasmDiffReadout" style="font-size: 10px; color: #8f8; margin-bottom: 6px;"></div>
        <button id="wasmJsBenchBtn" style="width: 100%; padding: 6px; background: #111; color: #0ff; border: 1px solid #0ff; border-radius: 4px; cursor: pointer; font-size: 11px;">
          Benchmark JS vs WASM
        </button>
        <div id="wasmBenchResults" style="margin-top: 6px; font-size: 10px; color: #aaa; display: none;"></div>
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
      <div style="color: #0ff; margin: 12px 0 6px; font-weight: bold;">⚙ Device Physics</div>
      <div id="devicePhysicsData" style="font-size: 10px; line-height: 1.5; color: #8cf;"></div>
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
      if (e.target.checked && !this.profiler.device.features.has('timestamp-query')) {
        e.target.checked = false;
        console.warn('[debug] GPU timing needs ?gpuTiming=1 and a page reload (may blank canvas on some GPUs)');
        return;
      }
      this.profiler.timingEnabled = e.target.checked;
    });
    document.getElementById('startBenchmark').addEventListener('click', () => this.startBenchmark());
    document.getElementById('applyOptimal').addEventListener('click', () => this.applyOptimalSettings());
    this._wireWasmControls();
    const frameSelect = document.getElementById('segFrameLevelSelect');
    if (frameSelect) {
      const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
      const initial = params.get('frame') || 'full';
      if (['off', 'minimal', 'full'].includes(initial)) frameSelect.value = initial;
      frameSelect.addEventListener('change', (e) => {
        if (typeof window.setSegFrameLevel === 'function') {
          window.setSegFrameLevel(e.target.value);
        }
      });
    }

    const lookSelect = document.getElementById('lightingLookSelect');
    if (lookSelect) {
      const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
      const initialLook = params.get('look') || params.get('lighting') || 'studio';
      if (['studio', 'lab', 'drama'].includes(initialLook)) lookSelect.value = initialLook;
      lookSelect.addEventListener('change', (e) => {
        if (typeof window.setLightingLook === 'function') {
          window.setLightingLook(e.target.value);
        }
      });
    }

    const exposureSlider = document.getElementById('exposureSlider');
    const bloomSlider = document.getElementById('bloomSlider');
    const applyPost = () => {
      const v = window.multiVisualizer;
      if (!v) return;
      if (exposureSlider) v.postExposure = parseFloat(exposureSlider.value);
      if (bloomSlider) v.postBloomStrength = parseFloat(bloomSlider.value);
    };
    exposureSlider?.addEventListener('input', applyPost);
    bloomSlider?.addEventListener('input', applyPost);

    const annToggle = document.getElementById('segAnnotationsToggle');
    annToggle?.addEventListener('change', (e) => {
      window.segAnnotations?.setEnabled(e.target.checked);
    });

    this.panel = container;
  }

  _wireWasmControls() {
    const statusEl = document.getElementById('wasmPhysicsStatus');
    const toggle = document.getElementById('wasmPhysicsToggle');
    const diffToggle = document.getElementById('wasmDiffToggle');
    const benchBtn = document.getElementById('wasmJsBenchBtn');
    const benchOut = document.getElementById('wasmBenchResults');

    const refreshStatus = async () => {
      try {
        const { segWasm } = await import('./wasm/seg-physics-bridge.js');
        await segWasm.init();
        if (toggle) toggle.checked = segWasm.enabled;
        if (statusEl) {
          statusEl.textContent = segWasm.available
            ? `WASM: available · ${segWasm.enabled ? 'ENABLED' : 'off'} · meanω=${segWasm.lastRollerMeanOmega.toFixed(3)}`
            : 'WASM: not built (npm run wasm:build)';
        }
      } catch {
        if (statusEl) statusEl.textContent = 'WASM: load error';
      }
    };
    refreshStatus();

    toggle?.addEventListener('change', async (e) => {
      const { segWasm } = await import('./wasm/seg-physics-bridge.js');
      await segWasm.init();
      segWasm.setEnabled(e.target.checked);
      // Reload so MultiDeviceVisualizer picks enabled flag at init paths cleanly
      if (e.target.checked) {
        const u = new URL(location.href);
        u.searchParams.set('wasmPhysics', '1');
        location.href = u.toString();
      } else {
        const u = new URL(location.href);
        u.searchParams.delete('wasmPhysics');
        try { localStorage.setItem('useWasmPhysics', 'false'); } catch { /* */ }
        location.href = u.toString();
      }
    });

    diffToggle?.addEventListener('change', (e) => {
      this.wasmDiffEnabled = e.target.checked;
    });

    benchBtn?.addEventListener('click', async () => {
      if (!benchOut) return;
      benchOut.style.display = 'block';
      benchOut.textContent = 'Running JS vs WASM benchmark…';
      try {
        const { segWasm } = await import('./wasm/seg-physics-bridge.js');
        await segWasm.init();
        const r = await segWasm.runJsVsWasmBenchmark(2000);
        benchOut.innerHTML = r.wasmAvailable
          ? `JS: <b>${r.jsStepsPerSecond.toFixed(0)}</b> step/s<br>` +
            `WASM: <b>${r.wasmStepsPerSecond.toFixed(0)}</b> step/s<br>` +
            `Ratio WASM/JS: <b>${r.ratio.toFixed(2)}×</b>`
          : 'WASM unavailable — build with npm run wasm:build';
      } catch (err) {
        benchOut.textContent = 'Benchmark failed: ' + (err?.message || err);
      }
    });

    this._wasmRefreshStatus = refreshStatus;
  }

  show() {
    this.visible = true;
    this.panel.style.display = 'block';
    this.startUpdateLoop();
    this._wasmRefreshStatus?.();
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

  async _updateWasmDiff() {
    const el = document.getElementById('wasmDiffReadout');
    if (!el) return;
    const { segWasm } = await import('./wasm/seg-physics-bridge.js');
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

  update() {
    const stats = this.profiler.getStats();

    // WASM vs GPU particle radius diff (optional)
    if (this.wasmDiffEnabled) {
      this._updateWasmDiff().catch(() => {});
    }

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
    this.updateDevicePhysicsData();
  }

  updateDevicePhysicsData() {
    const el = document.getElementById('devicePhysicsData');
    const viz = window.multiVisualizer;
    if (!el || !viz?.devices) return;

    const row = (label, value) =>
      `<div><span style="color:#666">${label}:</span> ${value}</div>`;

    const parts = [];
    for (const id of ['heron', 'kelvin', 'solar']) {
      const d = viz.devices[id];
      // WebGPU: physicsState; WebGL2: physics (aliased as physicsState too)
      const ps = d?.physicsState || d?.physics;
      if (!d || !ps) continue;
      parts.push(`<div style="color:#0cc;margin-top:4px;text-transform:uppercase">${id}</div>`);
      if (id === 'heron') {
        parts.push(row('Head', `${ps.heronHead.toFixed(2)} / ${ps.heronHeadMax.toFixed(1)} m`));
        parts.push(row('v_exit', `${ps.heronVExit.toFixed(2)} m/s`));
        parts.push(row('Flow', `${ps.heronFlowRateLmin.toFixed(1)} L/min`));
        parts.push(row('Pressure', `${ps.heronPressureKPa.toFixed(1)} kPa`));
        parts.push(row('Re', `${ps.heronReynolds.toFixed(0)}`));
        parts.push(row('Flow E', `${(d.flowEnergyLevel * 100).toFixed(0)}%`));
      } else if (id === 'kelvin') {
        parts.push(row('Voltage', `${(ps.kelvinVoltageN * ps.kelvinVbreak).toFixed(0)} V`));
        parts.push(row('Spark', ps.kelvinSparkTimer > 0 ? 'ACTIVE' : 'idle'));
      } else if (id === 'solar') {
        parts.push(row('Battery', `${(ps.batteryCharge * 100).toFixed(0)}%`));
      }
    }

    const pipeFlow = viz.energyPipes?.reduce((s, p) => s + (p.flowLevel || 0), 0) ?? 0;
    parts.push(`<div style="color:#0cc;margin-top:6px">ENERGY PIPES</div>`);
    parts.push(row('Total flow', `${(pipeFlow / Math.max(1, viz.energyPipes?.length || 1) * 100).toFixed(0)}% avg`));

    el.innerHTML = parts.join('') || '<div style="color:#666">No alternate devices active</div>';
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
  },
  mhd: {
    position: [-15, 0, -15],
    rotation: [0, -Math.PI / 4, 0],
    cameraOffset: [0, 5, 18],
    particleCount: 30000,
    color: [0.7, 0.6, 0.8]
  }
};