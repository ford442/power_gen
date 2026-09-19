// DOM construction + control wiring for the F3 debug overlay panel.
// Extracted from debug-panel.ts (mechanical split to respect the 700-line cap).
// Methods here are merged onto DebugPanel.prototype via Object.assign in debug-panel.ts,
// so `this` behaves exactly as it did when these were declared directly on the class.
import type { DebugPanel } from './debug-panel';

export const domMethods = {
  createPanel(this: DebugPanel): void {
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
        <div style="color: #8cf; font-weight: bold; margin-bottom: 6px;">Lab Energy Network</div>
        <label style="display: flex; align-items: center; cursor: pointer; margin-bottom: 6px;">
          <input type="checkbox" id="energyCouplingToggle" style="margin-right: 8px;">
          <span>Coupled power budget (vs visual-only pipes)</span>
        </label>
        <div id="energyNetworkStatus" style="font-size: 10px; color: #888; margin-bottom: 4px;">Pipes: visual only</div>
        <div style="font-size: 10px; color: #666;">Not calibrated metrology — education / demo only.</div>
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
      <div style="margin-bottom: 10px; padding: 8px; background: rgba(0,40,60,0.5); border-radius: 4px;">
        <div style="color: #8cf; font-weight: bold; margin-bottom: 6px;">Telemetry Replay</div>
        <button id="replayScrubberBtn" style="width: 100%; padding: 6px; background: #111; color: #f0a; border: 1px solid #f0a; border-radius: 4px; cursor: pointer; font-size: 11px;">
          Show replay scrubber
        </button>
        <div style="font-size: 10px; color: #666; margin-top: 6px;">Or open with <code>?replay=1</code>. Live plant is paused while a file is loaded.</div>
      </div>
      <div style="margin-bottom: 10px; padding: 8px; background: rgba(0,40,60,0.5); border-radius: 4px;">
        <div style="color: #8cf; font-weight: bold; margin-bottom: 6px;">gpu-chores meters</div>
        <div id="gpuChoresStatus" style="font-size: 10px; color: #888;">session — · backend —</div>
        <div style="font-size: 10px; color: #666; margin-top: 4px;">Exclusive API: chores adopt the boot renderer device. <code>?gpuChores=0</code> forces JS.</div>
      </div>
      <div style="display: flex; gap: 8px; margin-top: 15px;">
        <button id="startBenchmark" style="flex: 1; padding: 8px; background: #0ff; color: #000; border: none; border-radius: 4px; cursor: pointer; font-weight: bold;">Start Benchmark</button>
        <button id="applyOptimal" style="flex: 1; padding: 8px; background: #111; color: #0ff; border: 1px solid #0ff; border-radius: 4px; cursor: pointer;">Apply Optimal</button>
      </div>
      <div id="benchmarkResults" style="margin-top: 10px; padding: 10px; background: rgba(0,50,50,0.5); border-radius: 4px; display: none; font-size: 11px;"></div>
    `;
    container.appendChild(controlsDiv);

    // Validated Physics Data Section (source: ValidatedConstants, see ADR-0006)
    const scientificDiv = document.createElement('div');
    scientificDiv.id = 'scientificData';
    scientificDiv.style.cssText = 'margin-top: 15px; padding-top: 15px; border-top: 1px solid #0ff; font-size: 11px;';
    scientificDiv.innerHTML = `
      <div style="color: #0ff; margin-bottom: 8px; font-weight: bold;">📊 Validated Physics Data</div>
      <div id="validatedPhysicsData" style="max-height: 200px; overflow-y: auto;"></div>
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
    this.canvas = document.getElementById('fpsGraph') as HTMLCanvasElement;
    this.ctx = this.canvas.getContext('2d')!;
    this.correlationCanvas = document.getElementById('correlationGraph') as HTMLCanvasElement;
    this.correlationCtx = this.correlationCanvas.getContext('2d')!;

    // Event listeners
    document.getElementById('closeDebug')?.addEventListener('click', () => this.hide());
    document.getElementById('autoQualityToggle')?.addEventListener('change', (e) => {
      this.profiler.autoQualityEnabled = (e.target as HTMLInputElement).checked;
    });
    document.getElementById('gpuTimingToggle')?.addEventListener('change', (e) => {
      const target = e.target as HTMLInputElement;
      if (target.checked && !this.profiler.device.features.has('timestamp-query')) {
        target.checked = false;
        console.warn('[debug] GPU timing needs ?gpuTiming=1 and a page reload (may blank canvas on some GPUs)');
        return;
      }
      this.profiler.timingEnabled = target.checked;
    });
    document.getElementById('startBenchmark')?.addEventListener('click', () => this.startBenchmark());
    document.getElementById('applyOptimal')?.addEventListener('click', () => this.applyOptimalSettings());
    this._wireWasmControls();
    this._wireEnergyNetworkControls();
    const frameSelect = document.getElementById('segFrameLevelSelect') as HTMLSelectElement | null;
    if (frameSelect) {
      const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
      const initial = params.get('frame') || 'full';
      if (['off', 'minimal', 'full'].includes(initial)) frameSelect.value = initial;
      frameSelect.addEventListener('change', (e) => {
        if (typeof window.setSegFrameLevel === 'function') {
          window.setSegFrameLevel((e.target as HTMLSelectElement).value);
        }
      });
    }

    const lookSelect = document.getElementById('lightingLookSelect') as HTMLSelectElement | null;
    if (lookSelect) {
      const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
      const initialLook = params.get('look') || params.get('lighting') || 'studio';
      if (['studio', 'lab', 'drama'].includes(initialLook)) lookSelect.value = initialLook;
      lookSelect.addEventListener('change', (e) => {
        if (typeof window.setLightingLook === 'function') {
          window.setLightingLook((e.target as HTMLSelectElement).value);
        }
      });
    }

    const exposureSlider = document.getElementById('exposureSlider') as HTMLInputElement | null;
    const bloomSlider = document.getElementById('bloomSlider') as HTMLInputElement | null;
    const applyPost = () => {
      const v = window.multiVisualizer;
      if (!v) return;
      if (exposureSlider) v.postExposure = parseFloat(exposureSlider.value);
      if (bloomSlider) v.postBloomStrength = parseFloat(bloomSlider.value);
    };
    exposureSlider?.addEventListener('input', applyPost);
    bloomSlider?.addEventListener('input', applyPost);

    const annToggle = document.getElementById('segAnnotationsToggle') as HTMLInputElement | null;
    annToggle?.addEventListener('change', (e) => {
      window.segAnnotations?.setEnabled((e.target as HTMLInputElement).checked);
    });

    this.panel = container;
  },

  _wireEnergyNetworkControls(this: DebugPanel): void {
    const toggle = document.getElementById('energyCouplingToggle') as HTMLInputElement | null;
    const statusEl = document.getElementById('energyNetworkStatus');

    const getNetwork = () => window.multiVisualizer?.energyNetwork ?? null;

    const refresh = () => {
      const net = getNetwork();
      const coupled = net?.couplingEnabled ?? false;
      if (toggle) toggle.checked = coupled;
      const snap = net?.getSnapshot?.();
      if (statusEl) {
        if (!snap) {
          statusEl.textContent = 'Pipes: visual only';
        } else if (snap.couplingEnabled) {
          statusEl.textContent =
            `Coupled · budget ${snap.labBudgetW.toFixed(0)} W · allocated ${snap.totalAllocatedW.toFixed(0)} W · Δ ${snap.residualW.toFixed(0)} W`;
        } else {
          statusEl.textContent = 'Pipes: visual only (no watt clamping)';
        }
      }
    };

    refresh();

    toggle?.addEventListener('change', (e) => {
      const net = getNetwork();
      if (!net) return;
      net.setCouplingEnabled?.((e.target as HTMLInputElement).checked);
      refresh();
    });

    this._refreshEnergyNetworkStatus = refresh;
  },

  _wireWasmControls(this: DebugPanel): void {
    const choresEl = document.getElementById('gpuChoresStatus');
    const refreshChores = () => {
      const c = window.gpuChores?.breadcrumb?.();
      if (choresEl && c) {
        choresEl.textContent =
          `session ${c.sessionApi} · backend ${c.backend} · adoptedDevice=${c.adoptedDevice ? 'yes' : 'no'}`
          + (c.killSwitch ? ' · kill-switch' : '');
      }
    };
    refreshChores();
    setInterval(refreshChores, 2000);

    document.getElementById('replayScrubberBtn')?.addEventListener('click', async () => {
      const { showReplayBar } = await import('./telemetry/replay-ui');
      showReplayBar();
    });

    const statusEl = document.getElementById('wasmPhysicsStatus');
    const toggle = document.getElementById('wasmPhysicsToggle') as HTMLInputElement | null;
    const diffToggle = document.getElementById('wasmDiffToggle') as HTMLInputElement | null;
    const benchBtn = document.getElementById('wasmJsBenchBtn');
    const benchOut = document.getElementById('wasmBenchResults') as HTMLElement | null;

    const refreshStatus = async () => {
      try {
        const { segWasm } = await import('./wasm/seg-physics-bridge');
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
      const { segWasm } = await import('./wasm/seg-physics-bridge');
      await segWasm.init();
      segWasm.setEnabled((e.target as HTMLInputElement).checked);
      // Reload so MultiDeviceVisualizer picks enabled flag at init paths cleanly
      if ((e.target as HTMLInputElement).checked) {
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
      this.wasmDiffEnabled = (e.target as HTMLInputElement).checked;
    });

    benchBtn?.addEventListener('click', async () => {
      if (!benchOut) return;
      benchOut.style.display = 'block';
      benchOut.textContent = 'Running JS vs WASM benchmark…';
      try {
        const { segWasm } = await import('./wasm/seg-physics-bridge');
        await segWasm.init();
        const r = await segWasm.runJsVsWasmBenchmark(2000);
        benchOut.innerHTML = r.wasmAvailable
          ? `JS: <b>${r.jsStepsPerSecond.toFixed(0)}</b> step/s<br>` +
            `WASM: <b>${r.wasmStepsPerSecond.toFixed(0)}</b> step/s<br>` +
            `Ratio WASM/JS: <b>${r.ratio.toFixed(2)}×</b>`
          : 'WASM unavailable — build with npm run wasm:build';
      } catch (err) {
        benchOut.textContent = 'Benchmark failed: ' + ((err as Error)?.message || err);
      }
    });

    this._wasmRefreshStatus = refreshStatus;
  },
};
