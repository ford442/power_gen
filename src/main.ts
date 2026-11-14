/**
 * Application bootstrap: renderer selection, window API, control wiring.
 *
 * Default path: MultiDeviceVisualizer (WebGPU required).
 * WebGL2MultiDeviceVisualizer remains in-tree for explicit ?renderer=webgl2 only —
 * each backend is a dynamic import, so a visitor downloads only the one it runs;
 * automatic WebGL2 rescue on probe failure is disabled.
 */

import './devices/register-plugins';
import { assertParticleLayouts } from '../generated/physics-constants.js';
import { SEGSim } from './wasm/sim';
import { getSimCoreStatus } from './wasm/index';
import type { MultiDeviceVisualizer } from './multi-device-visualizer.js';
import { LabSession } from './session/lab-session';
import { onFrame } from './frame-clock';
import {
  resolveRenderer,
  exposeRenderer,
  RENDERER_WEBGPU,
  RENDERER_WEBGL2
} from './renderers/renderer-selector';
import { initLabConfig, labConfig, persistLabConfig } from './config/lab-config';
import { installLabApi } from './config/lab-api';
import { probeWebGPU, showWebGPUHardFail, showBootWarning, type WebGPUProbeResult } from './renderers/webgpu-probe';
import { initSEGOperatorPanel } from './seg-operator-panel';
import { renderModeButtons } from './mode-buttons';
import { initLabMode, setLabMode, getLabMode } from './lab-mode';
import { initFocusLiveRegion } from './focus-live-region';
import { renderSetpointPanels } from './setpoint-sliders';
import { initSEGDiagram2D } from './seg-diagram-2d';
import { initTelemetryExportPanel } from './telemetry/telemetry-export-panel';
import { initReplayUI } from './telemetry/replay-ui';
import { replayPlayer } from './telemetry/replay-player';
import { initExplainerUI } from './seg-explainer/explainer-ui';
import { restoreSimulationSeed } from './telemetry/deterministic-rng';
import { applyReplay, type ReplayFile } from './telemetry/replay-format';
import { telemetryHub } from './telemetry-hub';
import { gpuChores } from './gpu-chores';
import {
  downloadTelemetryCsv,
  downloadConfigJson,
  downloadBenchmarkPack
} from './telemetry/telemetry-export';
import type { TelemetryCsvRow } from './telemetry/telemetry-schema';
import { drawPulseCoilOscilloscope } from './devices/quanta/pulse-coil.js';
import { initFdtdHeatmapOverlay } from './fdtd-heatmap-overlay';
import { LabAudio } from './audio/lab-audio';
import { initLabAudioBadge } from './audio/lab-audio-badge';
import { wireChargeCouplingControls } from './charge-coupling-ui';
import { ScientificUIManager } from './scientific-ui/index';
import { installAnalysisEntry } from './analysis/entry';
import './multi-device-window-api';
// Assigns window.setMode / setSEGLayout / setFieldCoupling / … on import.
import {
  wireSEGLayoutControls,
  wireHeronLayoutControls,
  syncLayoutPanelsVisibility,
  wireFieldCouplingControls,
  wireSetpointRepaint
} from './bench-window-api';

// Agent / e2e hooks
window.telemetryHub = telemetryHub;

// Guard 16 B GpuParticle vs 32 B SimParticle stride contract at bootstrap.
assertParticleLayouts();

// ─────────────────────────────────────────────────────────────
// WASM sim_core initialisation
// ─────────────────────────────────────────────────────────────

let wasmSim: SEGSim | null = null;

function updateWasmBadge(state: string, text: string, tooltip = ''): void {
  const dot = document.getElementById('wasmDot');
  const span = document.getElementById('wasmStatus');
  if (!dot || !span) return;
  dot.className = `wasm-dot ${state}`;
  span.textContent = text;
  const badge = document.getElementById('wasm-badge');
  if (badge) badge.title = tooltip;
}

async function initWasm(): Promise<void> {
  updateWasmBadge('loading', 'WASM…', 'Loading sim_core.wasm…');
  try {
    wasmSim = await SEGSim.create();
    const st = getSimCoreStatus();
    if (st.state === 'ready' && wasmSim.wasmAvailable) {
      // A stale binary still runs: keep "loaded", tint the dot, say why on hover.
      if (st.stale) updateWasmBadge('loaded stale', 'WASM ✓', st.stale);
      else updateWasmBadge('loaded', 'WASM ✓', 'sim_core.wasm instantiated');
      gpuChores.refreshBackend();
    } else {
      updateWasmBadge('missing', 'WASM failed', st.error ?? 'sim_core.wasm unavailable');
    }
  } catch (err) {
    console.warn('[main] WASM init failed:', err);
    updateWasmBadge('missing', 'WASM failed', err instanceof Error ? err.message : String(err));
  }

  const benchBtn = document.getElementById('wasmBenchBtn') as HTMLButtonElement | null;
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

async function bootstrapVisualizer(): Promise<void> {
  const renderer = resolveRenderer();
  const canvas = document.getElementById('gpuCanvas') as HTMLCanvasElement | null;
  console.log(`[main] Selected renderer: ${renderer}`);
  const session = new LabSession();

  // Explicit opt-in only — not an automatic rescue when WebGPU fails.
  if (renderer === RENDERER_WEBGL2) {
    console.warn(
      '[main] Explicit ?renderer=webgl2 — automatic WebGL2 fallback is disabled; ' +
      'this path is agent/CI opt-in only.'
    );
    try {
      const { WebGL2MultiDeviceVisualizer } = await import('./renderers/webgl2/index.js');
      window.multiVisualizer = new WebGL2MultiDeviceVisualizer(session);
      exposeRenderer(canvas, RENDERER_WEBGL2);
      return;
    } catch (e) {
      console.error('[main] Explicit WebGL2 path failed (no WebGPU rescue):', e);
      const probe: WebGPUProbeResult = {
        ok: false,
        timestamp: new Date().toISOString(),
        browser: { brand: 'unknown', version: '', userAgent: navigator.userAgent, brands: [] },
        hasNavigatorGpu: !!navigator.gpu,
        adapter: null,
        features: [],
        limits: {},
        preferredCanvasFormat: null,
        error: e instanceof Error ? e.message : String(e),
        chromeVsEdge: 'Explicit WebGL2 opt-in failed; default path requires WebGPU.',
        probeDeviceDestroyed: false
      };
      window.webgpuProbe = probe;
      showWebGPUHardFail(probe);
      return;
    }
  }

  // Required WebGPU probe — never opens WebGL2 on failure.
  const probe = await probeWebGPU();
  window.webgpuProbe = probe;
  if (!probe.ok) {
    showWebGPUHardFail(probe);
    // Chores must not request a GPU device after probe failure.
    gpuChores.adopt({ sessionApi: 'webgpu', device: null, pipelineCache: null });
    return;
  }

  try {
    const { MultiDeviceVisualizer } = await import('./multi-device-visualizer.js');
    const vis = new MultiDeviceVisualizer(session);
    window.multiVisualizer = vis;
    await (vis as MultiDeviceVisualizer & { ready?: Promise<void> }).ready;
    if (window.webgpuProbe && !window.webgpuProbe.ok) {
      // init already showed hard-fail UI
      return;
    }
    exposeRenderer(canvas, RENDERER_WEBGPU);
  } catch (e) {
    console.error('[main] MultiDeviceVisualizer failed — hard-fail (no WebGL2):', e);
    if (!window.webgpuProbe || window.webgpuProbe.ok) {
      const failProbe: WebGPUProbeResult = {
        ...probe,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        chromeVsEdge: `${probe.chromeVsEdge} Visualizer init failed after probe OK.`
      };
      window.webgpuProbe = failProbe;
      showWebGPUHardFail(failProbe);
    }
    gpuChores.adopt({ sessionApi: 'webgpu', device: null, pipelineCache: null });
  }
}

window.setRenderer = (name: string): void => {
  const n = String(name).toLowerCase();
  if (n !== RENDERER_WEBGPU && n !== RENDERER_WEBGL2) {
    console.warn('Use setRenderer("webgpu") or setRenderer("webgl2")');
    return;
  }
  persistLabConfig('renderer', n);
  window.DEBUG_RENDERER = n;
  location.reload();
};

/**
 * Boot on DOMContentLoaded — do not wait for window `load`.
 * Optional WASM/assets can delay `load`; agent hooks and sciUI must still start.
 */
function bootApp(): void {
  restoreSimulationSeed();
  initWasm();
  renderModeButtons();
  renderSetpointPanels();

  initSEGOperatorPanel({
    onParticleCountChange(count: number) {
      const v = window.multiVisualizer;
      if (v?.setParticleCount) v.setParticleCount(count);
    }
  });

  // Scientific gauge panel (Ctrl+Shift+S). Construct before WebGL2 bootstrap —
  // SwiftShader can block the main thread so a late dynamic import never settles.
  try {
    if (!window.sciUI) {
      window.sciUI = new ScientificUIManager({ showToggle: true, subscribeToHub: true });
      window.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.shiftKey && (e.key === 'S' || e.key === 's')) {
          e.preventDefault();
          window.sciUI?.toggle();
        }
      });
    }
  } catch (e) {
    console.warn('[main] scientific-ui init skipped:', e);
  }

  bootstrapVisualizer().then(async () => {
    // Hard-fail page (no renderer): nothing to wire, and no rAF loop to leak.
    if (!window.currentRenderer) return;
    wireSEGLayoutControls();
    wireHeronLayoutControls();
    syncLayoutPanelsVisibility();
    initTelemetryExportPanel();
    initReplayUI();
    wireFieldCouplingControls();
    wireChargeCouplingControls();
    wireSetpointRepaint();
    const explainer = initExplainerUI();
    await explainer.applyLabFromHash();

    const hzSlider = document.getElementById('telemetrySampleHz') as HTMLInputElement | null;
    const hzVal = document.getElementById('telemetryHzVal');
    hzSlider?.addEventListener('input', () => {
      if (hzVal) hzVal.textContent = hzSlider.value;
    });

    try {
      initSEGDiagram2D(() => window.multiVisualizer);
    } catch (e) {
      console.warn('[main] SEG 2D diagram init failed:', e);
    }

    try {
      // WebGL2's stand-in for the WebGPU wave slice (ADR-0012). Gated on the
      // renderer + pulse-coil focus inside, so installing it on WebGPU costs
      // one hub subscription and nothing else.
      initFdtdHeatmapOverlay();
    } catch (e) {
      console.warn('[main] FDTD micro-grid heatmap init skipped:', e);
    }

    try {
      // Lab sonification (#203 WS D). Constructs nothing without `?audio=1`, and
      // even then waits for a user gesture before opening an AudioContext, so
      // default boot is silent rather than merely quiet.
      const labAudio = new LabAudio();
      window.labAudio = labAudio;
      initLabAudioBadge(labAudio);
    } catch (e) {
      console.warn('[main] lab audio init skipped:', e);
    }

    try {
      // Analysis panel (#224 §4): a button + window.openAnalysis; uPlot and the
      // panel are a lazy chunk fetched on first open.
      installAnalysisEntry();
    } catch (e) {
      console.warn('[main] analysis panel entry skipped:', e);
    }

    // Offline PWA + Record control (#224 §5, docs/CLASSROOM.md) — a lazy chunk;
    // registers a service worker only on production http(s) boots.
    const { offline, recordControl } = labConfig();
    import('./classroom/install')
      .then((m) => m.installClassroom({ serviceWorker: offline, recordControl }))
      .catch((e) => console.warn('[main] classroom init skipped:', e));

    // ?experiment=<id> (also carried by a #lab2= link) opens its panel.
    const experimentId = labConfig().experiment;
    if (experimentId) {
      window.lab?.openExperiment(experimentId).catch((e: unknown) => console.warn('[main] experiment panel skipped:', e));
    }

    // After the explainer, audio and hardware panel exist: the mode bundle
    // reaches into all three.
    window.setLabMode = (mode) => setLabMode(mode, 'user');
    window.getLabMode = getLabMode;
    initLabMode();
    initFocusLiveRegion(getLabMode);

    const anomalyToggle = document.getElementById('anomalyToggle') as HTMLInputElement | null;
    const v = window.multiVisualizer;
    if (anomalyToggle && v) {
      anomalyToggle.checked = !!v.anomalousEffectsEnabled;
      anomalyToggle.addEventListener('change', (e) => {
        v.anomalousEffectsEnabled = (e.target as HTMLInputElement).checked;
      });
    }

    if (v?.captureParticleSubset) {
      window.captureParticleSubset = (opts = {}) =>
        v.captureParticleSubset!(opts.deviceId || 'seg', opts.maxCount ?? 64);
    }

    if (v?.captureOverviewCull) {
      window.captureOverviewCull = () => v.captureOverviewCull!();
    }

    document.body.classList.toggle('overview-mode', v?.currentView === 'overview');

    const tickClassroomUi = (): void => {
      const canvas = document.getElementById('pulse-coil-scope') as HTMLCanvasElement | null;
      const wrap = document.getElementById('pulse-coil-scope-wrap');
      const vis = window.multiVisualizer;
      if (canvas && wrap && vis?.currentView === 'pulse-coil') {
        wrap.style.display = 'inline-block';
        const ctx = canvas.getContext('2d');
        drawPulseCoilOscilloscope(ctx, vis.devices?.['pulse-coil']?.physicsState, canvas.width, canvas.height);
        const note = document.getElementById('pulse-coil-fdtd-note');
        if (note) note.textContent = fdtdSliceNote(vis);
      } else if (wrap) {
        wrap.style.display = 'none';
      }
    };
    // Frame clock: ticks only while a renderer publishes frames.
    onFrame(tickClassroomUi);

    // `.lab.json` drop + classroom (student listener, ?embed=1, ?teacher=1). Lazy.
    import('./config/lab-post-boot').then((m) => m.startLabPostBoot())
      .catch((e: unknown) => console.warn('[main] lab extras skipped:', e));
  }).catch((e) => {
    // Renderer failures hard-fail inside bootstrapVisualizer; this is the UI
    // wiring after it (bad #lab= link, panel init throw) — report, don't swallow.
    console.error('[main] post-boot UI wiring failed:', e);
    showBootWarning(`Some controls failed to initialise: ${e instanceof Error ? e.message : String(e)}`);
  });
}

/** One-line status for the pulse-coil wave slice (ADR-0010) beside the scope. */
function fdtdSliceNote(vis: NonNullable<typeof window.multiVisualizer>): string {
  if (vis.fdtdEnabled === undefined) return 'Wave slice: WebGPU only';
  if (!vis.fdtdEnabled) return 'Wave slice off (?fdtd=0)';
  if (vis.fdtdSlice === null) return 'Wave slice unavailable (pipeline failed)';
  if (vis.profiler?.fdtdActive) return 'Wave slice: 2D TM, slowed light';
  const tier = vis.profiler?.qualityTier;
  if (tier !== 'high' && tier !== 'ultra') return 'Wave slice off (needs high tier)';
  return 'Wave slice: starting…';
}

/**
 * A `#lab2=` share link inflates asynchronously (CompressionStream); every
 * boot-time reader must already see it, so the boot waits for that one
 * decode. Without a #lab2= hash this resolves on the next microtask.
 */
function bootWhenConfigReady(): void {
  initLabConfig().catch(() => undefined).then(bootApp);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootWhenConfigReady);
} else {
  bootWhenConfigReady();
}
installLabApi();

// ── Telemetry / replay agent API ─────────────────────────────
window.exportTelemetryCsv = () => {
  const rows = telemetryHub.getRecordedRows();
  if (!rows.length) return { ok: false, error: 'No recorded samples' };
  downloadTelemetryCsv(rows as TelemetryCsvRow[]);
  return { ok: true, rows: rows.length };
};
window.exportConfigJson = () => downloadConfigJson();
window.startTelemetryRecording = (sec = 10, hz) => telemetryHub.startRecording(sec, hz);
window.stopTelemetryRecording = () => telemetryHub.stopRecording();
window.applyReplayFile = (replay) => {
  const file = replay as ReplayFile;
  if (file?.samples && (file.samples as unknown[]).length) {
    replayPlayer.attach(file, 'applyReplayFile.json', 'json');
    replayPlayer.play();
    return () => replayPlayer.exit();
  }
  return applyReplay(file);
};
window.loadReplayFile = (file: File) => replayPlayer.loadFile(file);
window.showReplayBar = () => {
  import('./telemetry/replay-ui').then((m) => m.setReplayBarVisible(true));
};
window.exportBenchmarkPack = () => {
  const p = window.multiVisualizer?.profiler;
  if (!p) return null;
  const bench = p.benchmarkSamples?.length ? p.endBenchmark?.() : { stats: p.getStats?.() };
  downloadBenchmarkPack(bench);
  return bench;
};
window.startSEGTour = () => window.segTour?.start(0);
window.shareLabLink = () => import('./seg-explainer/lab-url').then((m) => m.shareLabLink());
