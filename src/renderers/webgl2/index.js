/**
 * WebGL2 fallback multi-device visualizer.
 * Shares simulation state, camera, and device layout with the WebGPU path.
 *
 * Architecture mirror:
 *   WebGPUManager          → WebGL2Context
 *   DeviceInstance         → WebGL2DeviceState (CPU particles + physics)
 *   MultiDeviceVisualizer  → WebGL2MultiDeviceVisualizer (this file)
 *   compute.wgsl           → passes/particle-compute.wgsl (shared/particle-physics.js CPU)
 *
 * Intentional visual gaps vs WebGPU (see docs/WEBGL2.md):
 *   bloom/post, RK4 flux lines, energy-arc meshes, full SEG enhanced PBR.
 */

import { MultiDeviceCamera } from '../../multi-device-camera';
import { exposeRenderer, RENDERER_WEBGL2 } from '../renderer-selector';
import { seedParticles } from '../shared/particle-physics';
import { getMergedDeviceConfig } from '../../devices/device-registry';
import { initEnergyCouplingDisclaimer } from '../shared/energy-network';
import { WebGL2Context } from './webgl2-context.js';
import { SkyGridRenderer } from './sky-grid-renderer.js';
import { MeshRenderer } from './mesh-renderer.js';
import { ParticleRenderer } from './particle-renderer.js';
import { WebGL2DebugControls } from './debug-controls.js';
import { EnergyPipeRenderer } from './energy-pipe-renderer.js';
import { HalbachFieldRenderer } from './halbach-field-renderer.js';
import { parseSegFrameLevel } from '../../seg-frame-model';
import { parseLightingLook, getLightingPreset } from '../../seg-lighting-presets';
import { telemetryHub } from '../../telemetry-hub';
import { gpuChores } from '../../gpu-chores';
import { initSEGAnnotations } from '../../seg-annotations';
import { segWasm } from '../../wasm/seg-physics-bridge';
import {
  HERON_LAYOUT_PRESETS
} from '../../heron-layout';
import {
  computeSEGLayout,
  SEG_LAYOUT_PRESETS
} from '../../seg-layout';
import { initHardwarePanel } from '../../hardware-panel';
import { WebGL2DeviceState } from './device-state.js';
import { renderMethods } from './render.js';

export class WebGL2MultiDeviceVisualizer {
  constructor(session) {
    console.log('WebGL2MultiDeviceVisualizer starting (agent / CI fallback path)');
    this.session = session;
    this.session.rendererId = 'webgl2';
    this.canvas = document.getElementById('gpuCanvas');
    this.ctx = new WebGL2Context(this.canvas);
    this.debug = new WebGL2DebugControls();

    this.devices = {};
    this.session.attachDevices(this.devices);
    this.time = 0;
    this.simClock = 0;
    this.lastFrameTime = 0;
    this.fps = 60;

    const params = new URLSearchParams(window.location.search);

    this.segFrameLevel = parseSegFrameLevel(params);
    this.lightingLook = parseLightingLook(params);
    this.lightingPreset = getLightingPreset(this.lightingLook);

    this.segLayout = computeSEGLayout(this.session.segLayoutPreset, 1.0);

    this.energyPipes = []; // filled after devices for debug panel total flow
    this.energyPipeRenderer = null;

    exposeRenderer(this.canvas, RENDERER_WEBGL2);
    this._exposeScreenshotHooks();

    this.init();
  }

  get camera() { return this.session.camera; }
  get cameraController() { return this.session.cameraController; }
  set cameraController(v) { this.session.cameraController = v; }
  get currentView() { return this.session.currentView; }
  set currentView(v) { this.session.currentView = v; }
  get devicesEnabled() { return this.session.devicesEnabled; }
  get energyNetwork() { return this.session.energyNetwork; }
  get fieldNetwork() { return this.session.fieldNetwork; }
  get hardwareBridge() { return this.session.hardwareBridge; }
  set hardwareBridge(v) { this.session.hardwareBridge = v; }
  get hardwareTargetPhase() { return this.session.hardwareTargetPhase; }
  set hardwareTargetPhase(v) { this.session.hardwareTargetPhase = v; }
  get hardwareTargetSpeed() { return this.session.hardwareTargetSpeed; }
  set hardwareTargetSpeed(v) { this.session.hardwareTargetSpeed = v; }
  get hardwareShadow() { return this.session.hardwareShadow; }
  set hardwareShadow(v) { this.session.hardwareShadow = v; }
  get hardwareTwinTelemetry() { return this.session.hardwareTwinTelemetry; }
  set hardwareTwinTelemetry(v) { this.session.hardwareTwinTelemetry = v; }
  get speedMult() { return this.session.speedMult; }
  set speedMult(v) { this.session.speedMult = v; }
  get segOmega() { return this.session.segOmega; }
  set segOmega(v) { this.session.segOmega = v; }
  get corona() { return this.session.corona; }
  set corona(v) { this.session.corona = v; }
  get simRateController() { return this.session.simRateController; }
  get prototypePreset() { return this.session.prototypePreset; }
  set prototypePreset(v) { this.session.prototypePreset = v; }
  get anomalousEffectsEnabled() { return this.session.anomalousEffectsEnabled; }
  set anomalousEffectsEnabled(v) { this.session.anomalousEffectsEnabled = v; }
  get segLayoutPreset() { return this.session.segLayoutPreset; }
  set segLayoutPreset(v) { this.session.segLayoutPreset = v; }
  get heronLayoutPreset() { return this.session.heronLayoutPreset; }
  set heronLayoutPreset(v) { this.session.heronLayoutPreset = v; }
  get heronLayout() { return this.session.heronLayout; }
  set heronLayout(v) { this.session.heronLayout = v; }

  _exposeScreenshotHooks() {
    window.captureCanvasFrame = (opts = {}) => {
      const gl = this.ctx.gl;
      const w = this.canvas.width;
      const h = this.canvas.height;
      // Ensure a fresh frame is presented before readback when requested
      if (opts.flush !== false) {
        gl.finish();
      }
      const pixels = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      // Optional flip for top-left origin consumers
      if (opts.flipY) {
        const row = w * 4;
        const tmp = new Uint8Array(row);
        for (let y = 0; y < (h / 2) | 0; y++) {
          const top = y * row;
          const bot = (h - 1 - y) * row;
          tmp.set(pixels.subarray(top, top + row));
          pixels.copyWithin(top, bot, bot + row);
          pixels.set(tmp, bot);
        }
      }
      return {
        width: w,
        height: h,
        pixels,
        format: 'RGBA8',
        origin: opts.flipY ? 'top-left' : 'bottom-left',
        view: this.currentView,
        renderer: RENDERER_WEBGL2
      };
    };

    window.getRendererInfo = () => {
      const snap = telemetryHub.getSnapshot();
      const particleCount = Object.values(this.devices).reduce((s, d) => s + d.particleCount, 0);
      return {
        renderer: RENDERER_WEBGL2,
        fps: this.fps,
        particleCount,
        view: this.currentView,
        speedMult: this.speedMult,
        segOmega: this.segOmega,
        corona: this.corona,
        segLayoutPreset: this.segLayoutPreset,
        prototypePreset: this.prototypePreset,
        anomalousEffectsEnabled: this.anomalousEffectsEnabled,
        heronLayoutPreset: this.heronLayoutPreset,
        devicesEnabled: { ...this.devicesEnabled },
        wasmPhysics: !!(typeof window !== 'undefined' && window.segWasm?.enabled),
        telemetry: snap?.seg
          ? {
              rpm: snap.seg.rpmDisplay,
              voltage: snap.seg.voltage,
              current: snap.seg.current,
              power: snap.seg.power,
              fieldSim: snap.seg.fieldSim,
              status: snap.seg.status
            }
          : null,
        devices: Object.fromEntries(
          Object.entries(this.devices).map(([id, d]) => [
            id,
            {
              particleCount: d.particleCount,
              energyLevel: d.energyLevel,
              batteryCharge: d.batteryCharge,
              physics: { ...d.physics }
            }
          ])
        ),
        debug: {
          wireframe: this.debug.wireframe,
          debugParticles: this.debug.debugParticles,
          debugMode: this.debug.debugMode,
          paused: this.debug.paused,
          slowMo: this.debug.slowMo
        },
        intentionalGaps: [
          'bloom/post-process',
          'RK4 flux line tracer',
          'energy arc meshes',
          'SEG enhanced PBR / UV materials',
          'glTF CAD housing / coil former / stand / base plate',
          'Roschin–Godin magnetic wall shells',
          'WebGPU timestamp queries'
        ],
        hardwareTwin: snap?.hardwareTwin ?? null,
        chores: gpuChores.breadcrumb(),
        textureCompression: 'none'
      };
    };
  }

  async init() {
    try {
      const gl = this.ctx.init();
      this.skyGrid = new SkyGridRenderer(gl);
      this.meshRenderer = new MeshRenderer(gl);
      this.meshRenderer.setLightingPreset(this.lightingPreset);
      this.particleRenderer = new ParticleRenderer(gl);
      this.energyPipeRenderer = new EnergyPipeRenderer(gl, { energyNetwork: this.energyNetwork });
      this.halbachFieldRenderer = new HalbachFieldRenderer(gl);
      this.cameraController = new MultiDeviceCamera(this.canvas, this.camera.camera, this);
      this.camera.setupInteraction(this.canvas, (mode) => this.switchMode(mode));

      for (const [id, config] of Object.entries(getMergedDeviceConfig())) {
        this.devices[id] = new WebGL2DeviceState(id, config, this);
      }
      // Proxy for debug panel energy pipe flow readout
      this.energyPipes = this.energyPipeRenderer.pipes;
      initEnergyCouplingDisclaimer();

      // Optional WASM init (non-blocking; enable via ?wasmPhysics=1)
      segWasm.init().catch(() => {});
      gpuChores.adopt({ sessionApi: 'webgl2', device: null, pipelineCache: null });

      try {
        this.segAnnotations = initSEGAnnotations(() => this);
      } catch (e) {
        console.warn('[webgl2] SEG annotations init failed:', e);
      }

      try {
        initHardwarePanel(this);
      } catch (e) {
        console.warn('[webgl2] Hardware panel init failed:', e);
      }
      try {
        await this.session.maybeConnectMockHardware();
      } catch (_) { /* ignore */ }

      this.render(0);
      window.addEventListener('resize', () => this.ctx.resize());
      if (typeof window.syncHeronLayoutUI === 'function') window.syncHeronLayoutUI();
      if (typeof window.syncSEGLayoutUI === 'function') window.syncSEGLayoutUI();
      if (typeof window.syncLayoutPanelsVisibility === 'function') window.syncLayoutPanelsVisibility();
      console.log(
        '[webgl2] Ready. Keys: W=wireframe P=particle debug N=normals Space=pause .=step [/]=slow-mo. ' +
        'Telemetry via TelemetryHub; ?wasmPhysics=1 for C++ plant.'
      );
    } catch (e) {
      console.error(e);
      alert('WebGL2 init failed: ' + e.message);
    }
  }

  switchMode(mode) {
    this.onModeChange(mode);
  }

  /**
   * Mode / view focus — same contract as MultiDeviceVisualizer.onModeChange.
   * Called from window.setMode and keyboard shortcuts.
   */
  onModeChange(mode) {
    const { view } = this.session.setMode(mode);

    const el = document.getElementById('currentView');
    if (el) el.textContent = view.toUpperCase();

    if (typeof window.syncLayoutPanelsVisibility === 'function') {
      window.syncLayoutPanelsVisibility();
    }
    if (view === 'heron' && typeof window.syncHeronLayoutUI === 'function') {
      window.syncHeronLayoutUI();
    }
    if (view === 'seg' && typeof window.syncSEGLayoutUI === 'function') {
      window.syncSEGLayoutUI();
    }
  }

  _updateHardwareTwin(deltaTime) {
    this.session.syncHardwareTwin(deltaTime);
  }

  getSEGLayoutPreset() {
    return this.segLayoutPreset;
  }

  async setSEGLayoutPreset(presetName) {
    if (!Object.values(SEG_LAYOUT_PRESETS).includes(presetName)) return null;
    this.session.persistSegLayoutPreset(presetName);
    this.segLayout = computeSEGLayout(presetName, 1.0);
    return this.segLayout;
  }

  getHeronLayoutPreset() {
    return this.heronLayoutPreset;
  }

  async setHeronLayoutPreset(presetName) {
    if (!Object.values(HERON_LAYOUT_PRESETS).includes(presetName)) return null;
    if (this.heronLayoutPreset === presetName) return this.heronLayout;
    this.session.persistHeronLayoutPreset(presetName);
    return this.heronLayout;
  }

  setParticleCount(count) {
    const n = Math.max(100, Math.min(50000, count | 0));
    for (const d of Object.values(this.devices)) {
      if (d.particleCount === n) continue;
      d.particleCount = n;
      d.particles = new Float32Array(n * 8);
      seedParticles(d.particles, d.id, n);
    }
  }

  isDeviceActive(deviceId) {
    return this.session.isDeviceActive(deviceId);
  }

  isOverviewMode() {
    return this.session.isOverviewMode();
  }

  setSegFrameLevel(level) {
    if (['off', 'minimal', 'full'].includes(level)) {
      this.segFrameLevel = level;
    }
  }

  setLightingLook(look) {
    const preset = getLightingPreset(look);
    if (!preset) return;
    this.lightingLook = look;
    this.lightingPreset = preset;
    this.meshRenderer?.setLightingPreset(preset);
  }

  updateBatteryGaugeMesh(_charge) {}
}

// Draw-side methods (_stepSimulation, render) live in render.js — split
// orchestrator vs draw to keep this file under the 700-line cap (ADR-0001:
// this rescue path stays plain JS, no TS conversion).
Object.assign(WebGL2MultiDeviceVisualizer.prototype, renderMethods);
