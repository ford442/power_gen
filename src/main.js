/**
 * Application bootstrap: renderer selection, window API, control wiring.
 *
 * Live render paths:
 *   - MultiDeviceVisualizer (WebGPU, default)
 *   - WebGL2MultiDeviceVisualizer (fallback / ?renderer=webgl2)
 *
 * There is no legacy SEGVisualizer path. Physics, geometry, and pipelines live
 * under multi-device-visualizer.js, device-*, and renderers/shared/.
 */

import './devices/register-plugins.js';
import { SEGSim } from './wasm/sim';
import { MultiDeviceVisualizer } from './multi-device-visualizer.js';
import {
  resolveRenderer,
  exposeRenderer,
  RENDERER_WEBGPU,
  RENDERER_WEBGL2
} from './renderers/renderer-selector.js';
import { WebGL2MultiDeviceVisualizer } from './renderers/webgl2/index.js';
import { initSEGOperatorPanel } from './seg-operator-panel.js';
import { initSEGDiagram2D } from './seg-diagram-2d.js';
import { initTelemetryExportPanel } from './telemetry/telemetry-export-panel.js';
import { initExplainerUI } from './seg-explainer/explainer-ui.js';
import { restoreSimulationSeedFromStorage } from './telemetry/deterministic-rng.js';
import { applyReplay } from './telemetry/replay-format.js';
import { telemetryHub } from './telemetry-hub.ts';
import {
  downloadTelemetryCsv,
  downloadConfigJson,
  downloadBenchmarkPack
} from './telemetry/telemetry-export.js';
import {
  HERON_LAYOUT_DESCRIPTIONS,
  getHeronLayout
} from './heron-layout.js';

// ─────────────────────────────────────────────────────────────
// Mode / layout window API (used by index.html controls)
// ─────────────────────────────────────────────────────────────

const SEG_LAYOUT_DESCRIPTIONS = {
  searl: 'Searl documented configuration: 10 / 25 / 35 rollers on three rings, gap-derived proportions (~3 mm air gap).',
  roschin: 'Roschin–Godin 1 m converter: single ring of 12 rollers with 1 mm measured air gap; pairs with lab material preset.',
  legacy: 'Legacy 8 / 12 / 16 layout at 2.5 / 4.0 / 5.5 radii — retained for regression comparison.'
};

const MODE_DESCRIPTIONS = {
  seg: 'Searl Effect Generator: literature-grounded 10/25/35 or Roschin–Godin 12-roller layouts with gap-derived proportions, pole-banded rollers, and RK4 flux lines.',
  heron: "Heron's Fountain: Fluid dynamics with siphon-driven water jets. Particles simulate hydraulic pressure differentials.",
  kelvin: "Kelvin's Thunderstorm: Electrostatic induction with falling water droplets charging conductors.",
  solar: 'LEDs & Solar Cells: LEDs drain a battery while shining on solar panels that recharge it. Watch the charge level change.',
  mhd: 'MHD Generator: Molten bismuth (Bi, Tm=271°C) flows through a transverse magnetic field. The Lorentz force F=q(v×B) separates positive ions (red) from electrons (blue), generating direct current without moving parts.',
  maglev: 'Quanta Magnetics — Magnetic Levitation: Halbach ring stack lifts a conductive floater; eddy-current damping stabilises the gap. Watch air gap, B-field estimate, and lift proxy in telemetry.',
  homopolar: 'Quanta Magnetics — Homopolar Generator: rotating copper disc in an axial magnetic field. Brushed radial path produces EMF ∝ ω×B×r. Watch disc RPM, EMF, current proxy, and B-field in telemetry.'
};

window.setMode = (mode) => {
  if (window.multiVisualizer) window.multiVisualizer.onModeChange(mode);

  document.querySelectorAll('.mode-btn').forEach((btn) => btn.classList.remove('active'));
  const modeBtn = document.getElementById('btn-' + mode);
  if (modeBtn) modeBtn.classList.add('active');

  const info = document.getElementById('info');
  if (info && MODE_DESCRIPTIONS[mode]) info.textContent = MODE_DESCRIPTIONS[mode];

  const modeLabel = mode.toUpperCase();
  const modeLabelEl = document.getElementById('modeLabel');
  if (modeLabelEl) modeLabelEl.textContent = modeLabel;
  const modeFooterEl = document.getElementById('modeFooter');
  if (modeFooterEl) modeFooterEl.textContent = modeLabel;
};

function syncSEGLayoutUI() {
  const v = window.multiVisualizer;
  const buttons = document.querySelectorAll('[data-seg-layout]');
  const infoEl = document.getElementById('seg-layout-info');
  if (!v || typeof v.getSEGLayoutPreset !== 'function') return;

  const preset = v.getSEGLayoutPreset();
  buttons.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.segLayout === preset);
  });

  const layout = v.segLayout;
  if (infoEl) {
    if (layout) {
      infoEl.textContent = `${layout.name} — ${layout.totalRollers} active rollers, ${layout.ringCount} ring(s)`;
    } else {
      infoEl.textContent = SEG_LAYOUT_DESCRIPTIONS[preset] || '';
    }
  }

  if (v.currentView === 'seg') {
    const info = document.getElementById('info');
    if (info) info.textContent = SEG_LAYOUT_DESCRIPTIONS[preset] || info.textContent;
  }
}

window.setSEGLayout = async (preset) => {
  const v = window.multiVisualizer;
  if (!v?.setSEGLayoutPreset) {
    console.warn('[main] Layout switching requires multi-device visualizer');
    return;
  }
  await v.setSEGLayoutPreset(preset);
  syncSEGLayoutUI();
};

window.setSegFrameLevel = (level) => {
  const v = window.multiVisualizer;
  if (v?.setSegFrameLevel) {
    v.setSegFrameLevel(level);
  } else if (v) {
    v.segFrameLevel = level;
  }
  console.log(`[main] SEG frame level → ${level}`);
};

window.setLightingLook = (look) => {
  const v = window.multiVisualizer;
  if (v?.setLightingLook) {
    v.setLightingLook(look);
  }
  console.log(`[main] Lighting look → ${look}`);
};

window.syncSEGLayoutUI = syncSEGLayoutUI;

function syncLayoutPanelsVisibility() {
  const view = window.multiVisualizer?.currentView || 'overview';
  const segSec = document.getElementById('seg-layout-section');
  const heronSec = document.getElementById('heron-layout-section');
  if (segSec) segSec.style.display = view === 'seg' ? '' : 'none';
  if (heronSec) heronSec.style.display = view === 'heron' ? '' : 'none';
}

window.syncLayoutPanelsVisibility = syncLayoutPanelsVisibility;

function syncHeronLayoutUI() {
  const v = window.multiVisualizer;
  const buttons = document.querySelectorAll('[data-heron-layout]');
  const infoEl = document.getElementById('heron-layout-info');
  if (!v || typeof v.getHeronLayoutPreset !== 'function') return;

  const preset = v.getHeronLayoutPreset();
  buttons.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.heronLayout === preset);
  });

  const layout = v.heronLayout || getHeronLayout(preset);
  if (infoEl) {
    const ps = v.devices?.heron?.physicsState;
    if (ps && v.currentView === 'heron') {
      infoEl.textContent = [
        layout.name,
        HERON_LAYOUT_DESCRIPTIONS[preset] || '',
        `L=${layout.pipeLengthM} m · D=${(layout.pipeDiameterM * 1000).toFixed(0)} mm`,
        `Head ${ps.heronHead.toFixed(2)}/${layout.headMaxM} m · Q ${ps.heronFlowRateLmin.toFixed(1)} L/min · P ${ps.heronPressureKPa.toFixed(1)} kPa`
      ].filter(Boolean).join(' — ');
    } else {
      infoEl.textContent = `${layout.name} — ${HERON_LAYOUT_DESCRIPTIONS[preset] || ''}`;
    }
  }

  if (v.currentView === 'heron') {
    const info = document.getElementById('info');
    if (info) info.textContent = HERON_LAYOUT_DESCRIPTIONS[preset] || info.textContent;
  }
}

window.setHeronLayout = async (preset) => {
  const v = window.multiVisualizer;
  if (!v?.setHeronLayoutPreset) {
    console.warn('[main] Heron layout switching requires multi-device visualizer');
    return;
  }
  await v.setHeronLayoutPreset(preset);
  syncHeronLayoutUI();
};

window.syncHeronLayoutUI = syncHeronLayoutUI;

function wireHeronLayoutControls() {
  document.querySelectorAll('[data-heron-layout]').forEach((btn) => {
    btn.addEventListener('click', () => {
      window.setHeronLayout(btn.dataset.heronLayout);
    });
  });
  syncHeronLayoutUI();
}

function wireSEGLayoutControls() {
  document.querySelectorAll('[data-seg-layout]').forEach((btn) => {
    btn.addEventListener('click', () => {
      window.setSEGLayout(btn.dataset.segLayout);
    });
  });
  syncSEGLayoutUI();
}

// ─────────────────────────────────────────────────────────────
// WASM sim_core initialisation
// ─────────────────────────────────────────────────────────────

/** @type {SEGSim | null} */
let wasmSim = null;

function updateWasmBadge(state, text) {
  const dot = document.getElementById('wasmDot');
  const span = document.getElementById('wasmStatus');
  if (!dot || !span) return;
  dot.className = `wasm-dot ${state}`;
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
      const spsEl = document.getElementById('wasm-sps');
      const rpmEl = document.getElementById('wasm-rpm');
      const omegaEl = document.getElementById('wasm-omega');
      if (spsEl) spsEl.textContent = Math.round(result.stepsPerSecond).toLocaleString();
      if (rpmEl) rpmEl.textContent = result.finalRPM.toFixed(1);
      if (omegaEl) omegaEl.textContent = result.finalOmega.toFixed(4);
    } catch (err) {
      console.warn('[main] WASM benchmark error:', err);
    }

    benchBtn.disabled = false;
    benchBtn.textContent = '⚡ Benchmark';
  });
}

// ─────────────────────────────────────────────────────────────
// Renderer bootstrap
// ─────────────────────────────────────────────────────────────

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

window.setRenderer = (name) => {
  const n = String(name).toLowerCase();
  if (n !== RENDERER_WEBGPU && n !== RENDERER_WEBGL2) {
    console.warn('Use setRenderer("webgpu") or setRenderer("webgl2")');
    return;
  }
  try {
    localStorage.setItem('seg-renderer', n);
  } catch (_) {
    /* ignore */
  }
  window.DEBUG_RENDERER = n;
  location.reload();
};

window.addEventListener('load', () => {
  restoreSimulationSeedFromStorage();
  initWasm();

  initSEGOperatorPanel({
    onParticleCountChange(count) {
      const v = window.multiVisualizer;
      if (v?.setParticleCount) v.setParticleCount(count);
    }
  });

  // Optional scientific gauge panel (Ctrl+Shift+S / toggle); subscribes to TelemetryHub
  try {
    import('./scientific-ui/index.js').then(({ ScientificUIManager }) => {
      if (window.sciUI) return;
      window.sciUI = new ScientificUIManager({ showToggle: true, subscribeToHub: true });
      window.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.shiftKey && (e.key === 'S' || e.key === 's')) {
          e.preventDefault();
          window.sciUI?.toggle();
        }
      });
    }).catch((err) => console.warn('[main] scientific-ui load skipped:', err));
  } catch (e) {
    console.warn('[main] scientific-ui init skipped:', e);
  }

  bootstrapVisualizer().then(async () => {
    wireSEGLayoutControls();
    wireHeronLayoutControls();
    syncLayoutPanelsVisibility();
    initTelemetryExportPanel();
    const explainer = initExplainerUI();
    await explainer.applyLabFromHash();

    const hzSlider = document.getElementById('telemetrySampleHz');
    const hzVal = document.getElementById('telemetryHzVal');
    hzSlider?.addEventListener('input', () => {
      if (hzVal) hzVal.textContent = hzSlider.value;
    });

    try {
      initSEGDiagram2D(() => window.multiVisualizer);
    } catch (e) {
      console.warn('[main] SEG 2D diagram init failed:', e);
    }

    const anomalyToggle = document.getElementById('anomalyToggle');
    const v = window.multiVisualizer;
    if (anomalyToggle && v) {
      anomalyToggle.checked = v.anomalousEffectsEnabled;
      anomalyToggle.addEventListener('change', (e) => {
        v.anomalousEffectsEnabled = e.target.checked;
      });
    }

    if (v?.captureParticleSubset) {
      window.captureParticleSubset = (opts = {}) =>
        v.captureParticleSubset(opts.deviceId || 'seg', opts.maxCount ?? 64);
    }
  });
});

// ── Telemetry / replay agent API ─────────────────────────────
window.exportTelemetryCsv = () => {
  const rows = telemetryHub.getRecordedRows();
  if (!rows.length) return { ok: false, error: 'No recorded samples' };
  downloadTelemetryCsv(rows);
  return { ok: true, rows: rows.length };
};
window.exportConfigJson = () => downloadConfigJson();
window.startTelemetryRecording = (sec = 10, hz) => telemetryHub.startRecording(sec, hz);
window.stopTelemetryRecording = () => telemetryHub.stopRecording();
window.applyReplayFile = (replay) => applyReplay(replay);
window.exportBenchmarkPack = () => {
  const p = window.multiVisualizer?.profiler;
  if (!p) return null;
  const bench = p.benchmarkSamples?.length ? p.endBenchmark?.() : { stats: p.getStats() };
  downloadBenchmarkPack(bench);
  return bench;
};
window.startSEGTour = () => window.segTour?.start(0);
window.shareLabLink = () => import('./seg-explainer/lab-url.js').then((m) => m.shareLabLink());
