import particleShaderCode from './shaders/particles.wgsl?raw';
import computeShaderCode from './shaders/compute.wgsl?raw';
import lightningShaderCode from './shaders/lightning.wgsl?raw';
import bloomVertCode from './shaders/bloom.wgsl?raw';
import bloomExtractCode from './shaders/bloom-extract.wgsl?raw';
import bloomCompositeCode from './shaders/bloom-composite.wgsl?raw';
import { SEGSim } from './wasm/sim';
import { MultiDeviceVisualizer } from './multi-device-visualizer.js';
import { resolveRenderer, exposeRenderer, RENDERER_WEBGPU, RENDERER_WEBGL2 } from './renderers/renderer-selector.js';
import { WebGL2MultiDeviceVisualizer } from './renderers/webgl2/index.js';


window.setMode = (mode) => {
  if (window.multiVisualizer) window.multiVisualizer.onModeChange(mode);
  document.querySelectorAll('.mode-btn').forEach(btn => btn.classList.remove('active'));
  document.getElementById('btn-' + mode).classList.add('active');

  const descriptions = {
    seg:    "Searl Effect Generator: 3 concentric rings of 12/22/32 rollers with alternating copper/neodymium magnetic pole bands. Rollers orbit at ring-specific speeds around glowing stator rings.",
    heron:  "Heron's Fountain: Fluid dynamics with siphon-driven water jets. Particles simulate hydraulic pressure differentials.",
    kelvin: "Kelvin's Thunderstorm: Electrostatic induction with falling water droplets charging conductors.",
    solar:  "LEDs & Solar Cells: LEDs drain a battery while shining on solar panels that recharge it. Watch the charge level change.",
    mhd:    "MHD Generator: Molten bismuth (Bi, Tm=271°C) flows through a transverse magnetic field. The Lorentz force F=q(v×B) separates positive ions (red) from electrons (blue), generating direct current without moving parts."
  };

  document.getElementById('info').textContent = descriptions[mode];

  const modeLabel = mode.toUpperCase();
  const modeLabelEl = document.getElementById('modeLabel');
  if (modeLabelEl) modeLabelEl.textContent = modeLabel;
  const modeFooterEl = document.getElementById('modeFooter');
  if (modeFooterEl) modeFooterEl.textContent = modeLabel;
};

// ─────────────────────────────────────────────────────────────
// WASM sim_core initialisation
// ─────────────────────────────────────────────────────────────

/** @type {SEGSim | null} */
let wasmSim = null;

function updateWasmBadge(state, text) {
  const dot  = document.getElementById('wasmDot');
  const span = document.getElementById('wasmStatus');
  if (!dot || !span) return;
  dot.className  = `wasm-dot ${state}`;
  span.textContent = text;
}

async function initWasm() {
  updateWasmBadge('loading', 'WASM…');
  try {
    wasmSim = await SEGSim.create();
    if (wasmSim.wasmAvailable) {
      updateWasmBadge('loaded', 'WASM ✓');
    } else {
      updateWasmBadge('missing', 'WASM –');
    }
  } catch (err) {
    console.warn('[main] WASM init failed:', err);
    updateWasmBadge('missing', 'WASM –');
  }

  // Wire up benchmark button
  const benchBtn = document.getElementById('wasmBenchBtn');
  if (!benchBtn) return;

  benchBtn.addEventListener('click', async () => {
    if (!wasmSim) return;
    benchBtn.disabled = true;
    benchBtn.textContent = '⏳ Running…';

    const resultsEl = document.getElementById('wasm-results');
    if (resultsEl) resultsEl.classList.add('visible');

    try {
      const version = await SEGSim.getVersion();
      const versionEl = document.getElementById('wasm-version');
      if (versionEl) versionEl.textContent = version;

      const result = await wasmSim.benchmark(1000, 0.01);
      const spsEl   = document.getElementById('wasm-sps');
      const rpmEl   = document.getElementById('wasm-rpm');
      const omegaEl = document.getElementById('wasm-omega');
      if (spsEl)   spsEl.textContent   = Math.round(result.stepsPerSecond).toLocaleString();
      if (rpmEl)   rpmEl.textContent   = result.finalRPM.toFixed(1);
      if (omegaEl) omegaEl.textContent = result.finalOmega.toFixed(4);
    } catch (err) {
      console.warn('[main] WASM benchmark error:', err);
    }

    benchBtn.disabled = false;
    benchBtn.textContent = '⚡ Benchmark';
  });
}

/**
 * Bootstrap the active graphics backend.
 * ?renderer=webgl2 | localStorage seg-renderer | DEBUG_RENDERER
 */
async function bootstrapVisualizer() {
  const renderer = resolveRenderer();
  const canvas = document.getElementById('gpuCanvas');
  console.log(`[main] Selected renderer: ${renderer}`);

  if (renderer === RENDERER_WEBGL2) {
    try {
      window.multiVisualizer = new WebGL2MultiDeviceVisualizer();
      exposeRenderer(canvas, RENDERER_WEBGL2);
      return;
    } catch (e) {
      console.warn('[main] WebGL2 path failed, trying WebGPU:', e);
    }
  }

  try {
    window.multiVisualizer = new MultiDeviceVisualizer();
    exposeRenderer(canvas, RENDERER_WEBGPU);
    return;
  } catch (e) {
    console.warn('[main] MultiDeviceVisualizer failed, trying WebGL2 fallback:', e);
  }

  try {
    window.multiVisualizer = new WebGL2MultiDeviceVisualizer();
    exposeRenderer(canvas, RENDERER_WEBGL2);
  } catch (e2) {
    console.error('[main] All renderers failed:', e2);
    alert('No compatible graphics API (WebGPU or WebGL2).');
  }
}

/** Hot-switch renderer without editing code (full reload). */
window.setRenderer = (name) => {
  const n = String(name).toLowerCase();
  if (n !== RENDERER_WEBGPU && n !== RENDERER_WEBGL2) {
    console.warn('Use setRenderer("webgpu") or setRenderer("webgl2")');
    return;
  }
  try { localStorage.setItem('seg-renderer', n); } catch (_) { /* ignore */ }
  window.DEBUG_RENDERER = n;
  location.reload();
};

window.addEventListener('load', () => {
  bootstrapVisualizer();
  initWasm();

  // Wire anomalous-effects toggle after visualizer is created.
  const anomalyToggle = document.getElementById('anomalyToggle');
  if (anomalyToggle && window.multiVisualizer) {
    anomalyToggle.checked = window.multiVisualizer.anomalousEffectsEnabled;
    anomalyToggle.addEventListener('change', (e) => {
      window.multiVisualizer.anomalousEffectsEnabled = e.target.checked;
    });
  }
});
