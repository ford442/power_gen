/**
 * WebGL2 fallback multi-device visualizer.
 * Shares simulation state, camera, and device layout with the WebGPU path.
 *
 * Architecture mirror:
 *   WebGPUManager          → WebGL2Context
 *   DeviceInstance         → WebGL2DeviceState (CPU particles + physics)
 *   MultiDeviceVisualizer  → WebGL2MultiDeviceVisualizer (this file)
 *   compute.wgsl           → shared/particle-physics.js (CPU)
 *
 * Intentional visual gaps vs WebGPU (see docs/WEBGL2.md):
 *   bloom/post, RK4 flux lines, energy-arc meshes, full SEG enhanced PBR.
 */

import { CameraController } from '../../camera-controller.js';
import { MultiDeviceCamera } from '../../multi-device-camera.js';
import { SimRateController } from '../../sim-rate-controller.js';
import { DEVICE_CONFIG } from '../../debug-panel.js';
import { getMergedDeviceConfig, getAllSimDeviceIds } from '../../devices/device-registry.js';
import { exposeRenderer, RENDERER_WEBGL2 } from '../renderer-selector.js';
import { stepParticles, seedParticles } from '../shared/particle-physics.js';
import {
  createDevicePhysicsState,
  stepDevicePhysics,
  deviceModeIndex
} from '../shared/device-physics.js';
import { isDeviceActive as isDeviceVisible } from '../shared/device-view.js';
import { getDeviceParticleScale, getViewMeshLod } from '../shared/view-lod.js';
import { WebGL2Context } from './webgl2-context.js';
import { SkyGridRenderer } from './sky-grid-renderer.js';
import { MeshRenderer } from './mesh-renderer.js';
import { ParticleRenderer } from './particle-renderer.js';
import { WebGL2DebugControls } from './debug-controls.js';
import { EnergyPipeRenderer } from './energy-pipe-renderer.js';
import { parseSegFrameLevel } from '../../seg-frame-model.js';
import { parseLightingLook, getLightingPreset } from '../../seg-lighting-presets.js';
import { segOperator } from '../../seg-operator-state.js';
import { telemetryHub, TelemetryHub } from '../../telemetry-hub.js';
import { explainerState } from '../../seg-explainer/explainer-state.js';
import { segWasm } from '../../wasm/seg-physics-bridge.js';
import {
  getHeronLayout,
  HERON_LAYOUT_PRESETS,
  parseHeronLayoutPreset
} from '../../heron-layout.js';
import {
  computeSEGLayout,
  SEG_LAYOUT_PRESETS
} from '../../seg-layout.js';

class WebGL2DeviceState {
  constructor(id, config, visualizer) {
    this.id = id;
    this.config = config;
    this.visualizer = visualizer;
    this.position = config.position;
    this.particleCount = config.particleCount || 10000;
    this.particles = new Float32Array(this.particleCount * 8);
    const heronLayout = id === 'heron'
      ? (visualizer?.heronLayout || getHeronLayout(visualizer?.heronLayoutPreset))
      : null;
    this.physics = createDevicePhysicsState(id, { heronLayout });
    // Alias so TelemetryHub / debug panel can use physicsState like WebGPU
    this.physicsState = this.physics;
    seedParticles(this.particles, id, this.particleCount);
  }

  resetForModeEntry() {
    const heronLayout = this.id === 'heron'
      ? (this.visualizer?.heronLayout || getHeronLayout(this.visualizer?.heronLayoutPreset))
      : null;
    this.physics = createDevicePhysicsState(this.id, { heronLayout });
    this.physicsState = this.physics;
    seedParticles(this.particles, this.id, this.particleCount);
  }

  get energyLevel() {
    return this.physics?.energyLevel ?? 0;
  }

  get batteryCharge() {
    return this.physics?.batteryCharge ?? 0.5;
  }

  set batteryCharge(v) {
    if (this.physics) this.physics.batteryCharge = v;
  }
}

/** Build flat [x,z,...] roller positions from SEG layout + spin. */
function layoutRollerPositions(layout, time, speedMult, segOmega) {
  if (!layout?.rings?.length) return new Float32Array(0);
  const total = layout.totalRollers || 0;
  const out = new Float32Array(total * 2);
  let offset = 0;
  const spin = Math.max(0.05, segOmega || 0) * speedMult;
  for (const ring of layout.rings) {
    const R = ring.orbitRadiusM * layout.worldScale;
    const n = ring.count;
    const speed = (ring.speed ?? 1) * spin * 0.5;
    for (let i = 0; i < n; i++) {
      const angle = (i / n) * Math.PI * 2 + time * speed + (ring.index ?? 0) * 0.22;
      out[offset * 2] = Math.cos(angle) * R;
      out[offset * 2 + 1] = Math.sin(angle) * R;
      offset++;
    }
  }
  return out;
}

export class WebGL2MultiDeviceVisualizer {
  constructor() {
    console.log('WebGL2MultiDeviceVisualizer starting (agent / CI fallback path)');
    this.canvas = document.getElementById('gpuCanvas');
    this.ctx = new WebGL2Context(this.canvas);
    this.camera = new CameraController();
    this.simRateController = new SimRateController();
    this.debug = new WebGL2DebugControls();

    this.devices = {};
    this.devicesEnabled = Object.fromEntries(getAllSimDeviceIds().map((id) => [id, true]));
    this.currentView = 'overview';
    this.time = 0;
    this.simClock = 0;
    this.lastFrameTime = 0;
    this.fps = 60;
    this.speedMult = 1.0;
    this.segOmega = 0;
    this.corona = 0;
    this.segFrameLevel = parseSegFrameLevel();
    this.lightingLook = parseLightingLook();
    this.lightingPreset = getLightingPreset(this.lightingLook);

    const params = new URLSearchParams(window.location.search);
    this.heronLayoutPreset = parseHeronLayoutPreset(params);
    try {
      const storedHeron = localStorage.getItem('heron-layout');
      if (storedHeron && Object.values(HERON_LAYOUT_PRESETS).includes(storedHeron)) {
        this.heronLayoutPreset = storedHeron;
      }
    } catch (_) { /* ignore */ }
    this.heronLayout = getHeronLayout(this.heronLayoutPreset);

    // SEG layout (same presets as WebGPU; visual proportions only for rollers)
    this.segLayoutPreset = SEG_LAYOUT_PRESETS.searl;
    const layoutParam = params.get('layout');
    if (layoutParam === 'roschin' || layoutParam === 'lab' || layoutParam === 'godin') {
      this.segLayoutPreset = SEG_LAYOUT_PRESETS.roschin;
    } else if (layoutParam === 'legacy') {
      this.segLayoutPreset = SEG_LAYOUT_PRESETS.legacy;
    } else if (layoutParam === 'searl' || layoutParam === 'showroom') {
      this.segLayoutPreset = SEG_LAYOUT_PRESETS.searl;
    }
    this.segLayout = computeSEGLayout(this.segLayoutPreset, 1.0);

    this.energyPipes = []; // filled after devices for debug panel total flow
    this.energyPipeRenderer = null;

    exposeRenderer(this.canvas, RENDERER_WEBGL2);
    this._exposeScreenshotHooks();

    this.init();
  }

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
          'WebGPU timestamp queries'
        ]
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
      this.energyPipeRenderer = new EnergyPipeRenderer(gl);
      this.cameraController = new MultiDeviceCamera(this.canvas, this.camera.camera, this);
      this.camera.setupInteraction(this.canvas, (mode) => this.switchMode(mode));

      for (const [id, config] of Object.entries(getMergedDeviceConfig())) {
        this.devices[id] = new WebGL2DeviceState(id, config, this);
      }
      // Proxy for debug panel energy pipe flow readout
      this.energyPipes = this.energyPipeRenderer.pipes;

      // Optional WASM init (non-blocking; enable via ?wasmPhysics=1)
      segWasm.init().catch(() => {});

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
    const prev = this.currentView;
    this.currentView = mode || 'overview';

    const el = document.getElementById('currentView');
    if (el) el.textContent = this.currentView.toUpperCase();

    if (this.currentView === 'overview') {
      this.cameraController?.showOverview?.();
    } else {
      this.cameraController?.focusOnDevice?.(this.currentView);
    }

    if (this.currentView && this.currentView !== 'overview' && this.currentView !== prev) {
      this.devices[this.currentView]?.resetForModeEntry?.();
    }

    if (typeof window.syncLayoutPanelsVisibility === 'function') {
      window.syncLayoutPanelsVisibility();
    }
    if (this.currentView === 'heron' && typeof window.syncHeronLayoutUI === 'function') {
      window.syncHeronLayoutUI();
    }
    if (this.currentView === 'seg' && typeof window.syncSEGLayoutUI === 'function') {
      window.syncSEGLayoutUI();
    }

    telemetryHub.publishFrame({
      dt: 0,
      view: this.currentView,
      renderer: 'webgl2',
      devicePhysics: TelemetryHub.collectDevicePhysics(this.devices)
    });
  }

  getSEGLayoutPreset() {
    return this.segLayoutPreset;
  }

  async setSEGLayoutPreset(presetName) {
    if (!Object.values(SEG_LAYOUT_PRESETS).includes(presetName)) return null;
    this.segLayoutPreset = presetName;
    this.segLayout = computeSEGLayout(presetName, 1.0);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('layout', presetName);
      window.history.replaceState(null, '', url);
    } catch (_) { /* ignore */ }
    return this.segLayout;
  }

  getHeronLayoutPreset() {
    return this.heronLayoutPreset;
  }

  async setHeronLayoutPreset(presetName) {
    if (!Object.values(HERON_LAYOUT_PRESETS).includes(presetName)) return null;
    if (this.heronLayoutPreset === presetName) return this.heronLayout;
    this.heronLayoutPreset = presetName;
    this.heronLayout = getHeronLayout(presetName);
    const heron = this.devices.heron;
    if (heron?.physics) {
      heron.physics.heronLayoutId = presetName;
      heron.physics.heronHeadMax = this.heronLayout.headMaxM;
      heron.physics.heronHead = Math.min(heron.physics.heronHead, this.heronLayout.headMaxM);
    }
    try { localStorage.setItem('heron-layout', presetName); } catch (_) { /* ignore */ }
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('heronLayout', presetName);
      window.history.replaceState(null, '', url);
    } catch (_) { /* ignore */ }
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
    return isDeviceVisible(this.currentView, this.devicesEnabled, deviceId);
  }

  isOverviewMode() {
    return !this.currentView || this.currentView === 'overview';
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

  /**
   * Physics step shared with WebGPU: SimRateController substeps + device-physics
   * (+ optional WASM plant when ?wasmPhysics=1).
   */
  _stepSimulation(deltaTime, speed) {
    const simSteps = this.simRateController.tick(deltaTime, speed, {
      qualityLevel: this.profiler?.qualityLevel,
      frameTimeMs: this.profiler?.lastFrameTimeMs,
      gpuTimeMs: this.profiler?.lastGpuTimeMs
    });
    const drive = segOperator.getDrive();
    const useWasm = segWasm.enabled;
    const focus = this.currentView === 'overview' ? 'seg' : this.currentView;

    if (useWasm) {
      const loadT = 0.01 * (1 - drive * 0.5);
      if (['seg', 'heron', 'kelvin', 'solar'].includes(focus)) {
        segWasm.setMode(focus);
      }
      for (const subDt of simSteps) {
        if (subDt <= 0) continue;
        segOperator.step(subDt);
        const wr = segWasm.step(subDt, loadT, drive);
        if (focus === 'seg' || focus === 'overview') {
          const wNorm = Math.min(1, Math.abs(wr.meanOmega ?? wr.omega) / 50);
          segOperator.physics.segOmega = Math.max(segOperator.physics.segOmega * 0.2, wNorm);
          segOperator.physics.corona = Math.max(0, Math.min(1, (wNorm - 0.6) / 0.4));
        } else if (focus === 'heron') {
          const plant = segWasm.getModePlant();
          const heron = this.devices.heron?.physics;
          if (heron && plant) {
            heron.heronHead = plant.head ?? heron.heronHead;
            heron.heronVExit = plant.vExit ?? heron.heronVExit;
            heron.heronFlowRateLmin = plant.flowLmin ?? 0;
            heron.heronPressureKPa = plant.pressureKPa ?? 0;
            heron.energyLevel = Math.min(1, heron.heronVExit / 4);
          }
        } else if (focus === 'kelvin') {
          const plant = segWasm.getModePlant();
          const kelvin = this.devices.kelvin?.physics;
          if (kelvin && plant) {
            kelvin.kelvinV = plant.voltage ?? 0;
            kelvin.kelvinVoltageN = plant.voltageN ?? 0;
            kelvin.kelvinE = plant.E ?? 0;
            kelvin.kelvinSparkTimer = plant.sparkTimer ?? 0;
            kelvin.energyLevel = kelvin.kelvinVoltageN;
          }
        } else if (focus === 'solar') {
          const plant = segWasm.getModePlant();
          const solar = this.devices.solar?.physics;
          if (solar && typeof plant?.battery === 'number') {
            solar.batteryCharge = plant.battery;
            solar.energyLevel = plant.battery;
          }
        }
      }
    } else {
      for (const subDt of simSteps) {
        if (subDt > 0) segOperator.step(subDt);
      }
    }

    this.segOmega = segOperator.physics.segOmega;
    this.corona = segOperator.physics.corona;

    const substeps = simSteps.length || 1;
    const subDt = deltaTime / Math.max(substeps, 1);
    let totalParticles = 0;

    for (const device of Object.values(this.devices)) {
      if (!this.isDeviceActive(device.id)) continue;

      if (device.id === 'seg') {
        device.physics.segOmega = segOperator.physics.segOmega;
        device.physics.corona = segOperator.physics.corona;
        device.physics.magneticFieldStrength = segOperator.magneticFieldStrength;
        device.physics.energyLevel = segOperator.physics.segOmega;
      } else if (!useWasm || device.id !== focus) {
        // When WASM owns the focused plant, skip double-stepping that device
        for (let s = 0; s < substeps; s++) {
          const heronLayout = device.id === 'heron' ? this.heronLayout : null;
          stepDevicePhysics(device.physics, subDt, drive, { heronLayout });
        }
      }

      for (let s = 0; s < substeps; s++) {
        const mode = deviceModeIndex(device.id);
        const lod = getDeviceParticleScale({
          currentView: this.currentView,
          deviceId: device.id,
          qualityLevel: this.profiler?.qualityLevel ?? 1
        });
        const scaledCount = Math.max(64, Math.floor(device.particleCount * lod));
        device.scaledParticleCount = scaledCount;
        totalParticles += scaledCount;
        stepParticles(device.particles, {
          time: this.time,
          mode,
          particleCount: scaledCount,
          dt: subDt,
          segOmega: device.physics.segOmega,
          heronVExit: device.physics.heronVExit,
          kelvinE: device.physics.kelvinE,
          kelvinVoltageN: device.physics.kelvinVoltageN,
          solarN2: device.physics.solarN2,
          corona: device.physics.corona,
          maglevGap: device.physics.maglevGap,
          maglevFieldT: device.physics.maglevFieldT,
          simClock: this.simClock,
          speedMult: speed
        });
      }
    }

    return totalParticles;
  }

  render(timestamp) {
    const rawDelta = (timestamp - this.lastFrameTime) / 1000;
    this.lastFrameTime = timestamp;
    const deltaTime = this.debug.effectiveDelta(rawDelta || 0.016);

    if (timestamp % 500 < 20 && deltaTime > 0) {
      this.fps = Math.round(1 / (deltaTime || 0.016));
      const fpsEl = document.getElementById('fps');
      if (fpsEl) fpsEl.textContent = this.fps;
    }

    const rawSpeed = parseFloat(document.getElementById('speedControl')?.value) ?? 50;
    const speed = 0.05 * Math.pow(400, rawSpeed / 100);
    this.speedMult = speed;

    this.time += deltaTime * speed;
    this.simClock += deltaTime;

    const totalParticles = this._stepSimulation(deltaTime, speed);

    const speedValEl = document.getElementById('speedVal');
    if (speedValEl) speedValEl.textContent = speed.toFixed(2) + '×';

    this.cameraController.updateCamera(deltaTime);
    const viewProj = this.cameraController.getViewProjMatrix();
    const cameraPos = this.camera.camera.position;

    // Telemetry hub — same path as WebGPU (START → non-zero RPM/V/I/P)
    const omega = this.segOmega || 0;
    telemetryHub.publishFrame({
      dt: deltaTime,
      view: this.currentView || 'overview',
      renderer: 'webgl2',
      devicePhysics: TelemetryHub.collectDevicePhysics(this.devices),
      scientific: {
        particleFlux: totalParticles * Math.max(0.05, speed),
        maxFieldMagnitude: 0.7048 * (0.35 + 0.65 * Math.min(1, Math.abs(omega))),
        avgEnergyDensity: 1.976e6 * (0.2 + 0.8 * Math.min(1, Math.abs(omega)))
      }
    });

    const gl = this.ctx.gl;
    this.ctx.resize();
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    this.skyGrid.drawSky(this.time, this.lightingPreset?.sky?.mode ?? 1);
    this.skyGrid.drawGrid(viewProj, cameraPos);

    const renderOpts = {
      wireframe: this.debug.wireframe,
      debugMode: this.debug.debugMode,
      cameraPos,
      corona: this.devices.seg?.physics.corona || 0
    };

    for (const device of Object.values(this.devices)) {
      if (!this.isDeviceActive(device.id)) continue;
      const pos = device.config.position;
      const tint = device.config.color || [0.5, 0.8, 1.0];
      const mode = deviceModeIndex(device.id);
      const scaledCount = device.scaledParticleCount || device.particleCount;

      if (device.id === 'seg') {
        const rollers = layoutRollerPositions(
          this.segLayout,
          this.time,
          speed,
          this.segOmega
        );
        this.meshRenderer.drawSegStructure(viewProj, pos, {
          ...renderOpts,
          frameLevel: this.segFrameLevel
        });
        this.meshRenderer.drawStatorRings(viewProj, pos, renderOpts);
        this.meshRenderer.drawRollers(viewProj, pos, rollers, this.time, {
          ...renderOpts,
          corona: device.physics.corona
        });
      } else if (device.id === 'heron' || device.id === 'kelvin' || device.id === 'solar') {
        this.meshRenderer.drawAlternateDevice(viewProj, pos, device.id, {
          ...renderOpts,
          heronLayoutPreset: device.id === 'heron' ? this.heronLayoutPreset : undefined
        });
      }

      this.particleRenderer.draw(
        device.particles,
        scaledCount,
        viewProj,
        pos,
        mode,
        tint,
        {
          debugParticles: this.debug.debugParticles,
          battery: device.physics.batteryCharge,
          particleScale: this.debug.particleScale
        }
      );
    }

    // Overview energy pipes (line-strip Bézier arcs)
    if (this.isOverviewMode() && this.energyPipeRenderer) {
      this.energyPipeRenderer.draw(viewProj, this.devices, this.time);
    }

    requestAnimationFrame((t) => this.render(t));
  }
}
