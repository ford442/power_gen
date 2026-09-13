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
import { buildMagLevMesh } from '../../devices/quanta/magnetic-levitation';
import { buildHomopolarMesh } from '../../devices/quanta/homopolar-generator';
import { buildHalbachVizMesh, halbachConfigFromState } from '../../devices/quanta/halbach-viz';
import { buildPulseCoilMesh } from '../../devices/quanta/pulse-coil';
import { buildTransformerMesh } from '../../devices/quanta/transformer';
import { buildVdgMesh, VDG_V_BREAK } from '../../devices/quanta/van-de-graaff';
import { buildHallMesh } from '../../devices/quanta/hall-effect';
import { buildLorentzSledMesh, LORENTZ } from '../../devices/quanta/lorentz-sled';
import { buildPeltierMesh } from '../../devices/core/peltier-mesh';
import { buildMhdMesh } from '../../devices/core/mhd-mesh';
import { exposeRenderer, RENDERER_WEBGL2 } from '../renderer-selector';
import { stepParticles, seedParticles } from '../shared/particle-physics';
import {
  createDevicePhysicsState,
  stepDevicePhysics,
  deviceModeIndex
} from '../shared/device-physics';
import { shouldSimulateDevice } from '../shared/device-view';
import {
  getOverviewCullOpts,
  getViewParticleLod,
  getViewMeshLod,
  getMeshDrawDetail,
  getDeviceParticleScale
} from '../shared/view-lod';
import { resolveScaledParticleCount } from '../../devices/particle-budgets';
import { getMergedDeviceConfig } from '../../devices/device-registry';
import { initEnergyCouplingDisclaimer } from '../shared/energy-network';
import { segLayoutRingsForDraw } from '../shared/url-params';
import { WebGL2Context } from './webgl2-context.js';
import { SkyGridRenderer } from './sky-grid-renderer.js';
import { MeshRenderer } from './mesh-renderer.js';
import { ParticleRenderer } from './particle-renderer.js';
import { WebGL2DebugControls } from './debug-controls.js';
import { EnergyPipeRenderer } from './energy-pipe-renderer.js';
import { HalbachFieldRenderer } from './halbach-field-renderer.js';
import { parseSegFrameLevel } from '../../seg-frame-model';
import { parseLightingLook, getLightingPreset } from '../../seg-lighting-presets';
import { segOperator } from '../../seg-operator-state';
import { telemetryHub } from '../../telemetry-hub';
import { gpuChores } from '../../gpu-chores';
import { initSEGAnnotations } from '../../seg-annotations';
import { segWasm } from '../../wasm/seg-physics-bridge';
import {
  getHeronLayout,
  HERON_LAYOUT_PRESETS
} from '../../heron-layout';
import {
  computeSEGLayout,
  SEG_LAYOUT_PRESETS
} from '../../seg-layout';
import { initHardwarePanel } from '../../hardware-panel';
import { wasmOwnsJsDevicePhysics } from '../../session/apply-wasm-plant';

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

  /**
   * Physics step: LabSession plant + CPU device/particle visuals.
   */
  _stepSimulation(deltaTime, speed) {
    const { simSteps, replayLocked, useWasm, drive } = this.session.stepPlant(deltaTime, speed, {
      qualityLevel: this.profiler?.qualityLevel,
      frameTimeMs: this.profiler?.lastFrameTimeMs,
      gpuTimeMs: this.profiler?.lastGpuTimeMs
    });
    const focus = this.session.plantFocus();

    const substeps = simSteps.length || 1;
    const subDt = deltaTime / Math.max(substeps, 1);
    let totalParticles = 0;
    const canvasAspect = (this.canvas.width || 1) / Math.max(1, this.canvas.height || 1);
    const cullCamera = this.camera?.camera;
    const cullOpts = getOverviewCullOpts({ aspect: canvasAspect });
    const qualityTier = this.profiler?.qualityTier || 'high';

    for (const device of Object.values(this.devices)) {
      if (!shouldSimulateDevice(
        this.currentView,
        this.devicesEnabled,
        device.id,
        device.config?.position,
        cullCamera,
        cullOpts
      )) continue;

      if (device.id === 'seg') {
        device.physics.segOmega = segOperator.physics.segOmega;
        device.physics.corona = segOperator.physics.corona;
        device.physics.magneticFieldStrength = segOperator.magneticFieldStrength;
        device.physics.energyLevel = segOperator.physics.segOmega;
      } else {
        const wasmOwnsFocus = wasmOwnsJsDevicePhysics(
          device.id, focus, useWasm, device.physics
        );
        if (!wasmOwnsFocus && !replayLocked) {
          for (let s = 0; s < substeps; s++) {
            const heronLayout = device.id === 'heron' ? this.heronLayout : null;
            stepDevicePhysics(device.physics, subDt, drive, { heronLayout });
          }
        }
        if (device.physics._wasmPlantActive) device.physics._wasmPlantActive = false;
      }

      for (let s = 0; s < substeps; s++) {
        const mode = deviceModeIndex(device.id);
        const viewLod = getViewParticleLod(this.currentView, device.id);
        const scaledCount = Math.max(
          64,
          resolveScaledParticleCount({
            deviceId: device.id,
            baseCount: device.particleCount,
            qualityLevel: this.profiler?.qualityLevel ?? 1,
            qualityTier,
            viewLod,
            isPlugin: !!device.config?.plugin
          }) || Math.floor(
            device.particleCount * getDeviceParticleScale({
              currentView: this.currentView,
              deviceId: device.id,
              qualityLevel: this.profiler?.qualityLevel ?? 1
            })
          )
        );
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
          homopolarRpm: device.physics.homopolarRpm,
          homopolarEmfV: device.physics.homopolarEmfV,
          homopolarAngle: device.physics.homopolarAngle,
          halbachSegmentCount: device.physics.halbachSegmentCount,
          halbachPeakBT: device.physics.halbachPeakBT,
          pulseCoilCurrentA: device.physics.pulseCoilCurrentA,
          pulseCoilBPeakT: device.physics.pulseCoilBPeakT,
          pulseCoilArmatureM: device.physics.pulseCoilArmatureM,
          peltierDeltaT: device.physics.peltierDeltaT,
          peltierCOP: device.physics.peltierCOP,
          mhdFlowU: device.physics.mhdFlowU,
          mhdBFieldT: device.physics.mhdBFieldT,
          transformerIpA: device.physics.transformerIpA,
          transformerIsA: device.physics.transformerIsA,
          transformerFluxN: device.physics.transformerFluxN,
          vdgVoltage: device.physics.vdgVoltage,
          vdgSparkHz: device.physics.vdgSparkHz,
          hallCurrent: device.physics.hallCurrent,
          hallFieldT: device.physics.hallFieldT,
          lorentzSledVms: device.physics.lorentzSledVms,
          lorentzCurrentA: device.physics.lorentzCurrentA,
          lorentzFieldT: device.physics.lorentzFieldT,
          lorentzPositionM: device.physics.lorentzPositionM,
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

    this._updateHardwareTwin(deltaTime);

    const speedValEl = document.getElementById('speedVal');
    if (speedValEl) speedValEl.textContent = speed.toFixed(2) + '×';

    this.cameraController.updateCamera(deltaTime);
    const viewProj = this.cameraController.getViewProjMatrix();
    const cameraPos = this.camera.camera.position;

    this.session.publishFrame(deltaTime, totalParticles);

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

    const canvasAspect = (this.canvas.width || 1) / Math.max(1, this.canvas.height || 1);
    const cullCamera = this.camera?.camera;
    const cullOpts = getOverviewCullOpts({ aspect: canvasAspect });
    const meshDetail = getMeshDrawDetail(
      getViewMeshLod(this.currentView, this.profiler?.qualityLevel ?? 1)
    );
    this._overviewMeshDetail = meshDetail;

    for (const device of Object.values(this.devices)) {
      if (!shouldSimulateDevice(
        this.currentView,
        this.devicesEnabled,
        device.id,
        device.config?.position,
        cullCamera,
        cullOpts
      )) continue;
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
    frameLevel: this.segFrameLevel,
    layout: this.segLayout
  });
  this.meshRenderer.drawStatorRings(viewProj, pos, renderOpts);
  this.meshRenderer.drawRollers(viewProj, pos, rollers, this.time, {
    ...renderOpts,
    corona: device.physics.corona,
    prototypePreset: this.prototypePreset,
    rings: segLayoutRingsForDraw(this.segLayout)
  });
} else if (meshDetail !== 'skip') {
  // Overview mesh LOD: skip barely-visible plugin meshes when quality is critical.
  const drawMeshes = meshDetail !== 'proxy' || this.currentView === device.id;

  if (drawMeshes && (device.id === 'heron' || device.id === 'kelvin' || device.id === 'solar')) {
    this.meshRenderer.drawAlternateDevice(viewProj, pos, device.id, {
      ...renderOpts,
      heronLayoutPreset: device.id === 'heron' ? this.heronLayoutPreset : undefined
    });
  } else if (drawMeshes && device.id === 'peltier') {
    this.meshRenderer.drawPluginDevice(
      viewProj,
      pos,
      buildPeltierMesh(
        device.physics.peltierHotK,
        device.physics.peltierColdK,
        device.physics.peltierDeltaT
      ).cylinders(),
      renderOpts
    );
  } else if (drawMeshes && device.id === 'mhd') {
    this.meshRenderer.drawPluginDevice(
      viewProj,
      pos,
      buildMhdMesh(
        device.physics.mhdFlowU,
        device.physics.mhdBFieldT,
        device.physics.mhdHartmann
      ).cylinders(),
      renderOpts
    );
  } else if (drawMeshes && device.id === 'maglev') {
    const gap = device.physics.maglevGap ?? 0.018;
    this.meshRenderer.drawPluginDevice(
      viewProj, pos, buildMagLevMesh(gap).cylinders(), renderOpts
    );
  } else if (drawMeshes && device.id === 'homopolar') {
    const angle = device.physics.homopolarAngle ?? 0;
    this.meshRenderer.drawPluginDevice(
      viewProj, pos, buildHomopolarMesh(angle).cylinders(), renderOpts
    );
  } else if (drawMeshes && device.id === 'halbach-viz') {
    const config = halbachConfigFromState(device.physics);
    this.meshRenderer.drawPluginDevice(
      viewProj, pos, buildHalbachVizMesh(config).cylinders(), renderOpts
    );
  } else if (drawMeshes && device.id === 'pulse-coil') {
    const travel = device.physics.pulseCoilArmatureM ?? 0;
    const iA = device.physics.pulseCoilCurrentA ?? 0;
    const vCap = device.physics.pulseCoilVCap ?? 0;
    this.meshRenderer.drawPluginDevice(
      viewProj, pos, buildPulseCoilMesh(travel, iA, vCap).cylinders(), renderOpts
    );
  } else if (drawMeshes && device.id === 'transformer') {
    this.meshRenderer.drawPluginDevice(
      viewProj,
      pos,
      buildTransformerMesh(
        device.physics.transformerIpA,
        device.physics.transformerIsA,
        device.physics.transformerFluxN
      ).cylinders(),
      renderOpts
    );
  } else if (drawMeshes && device.id === 'vdg') {
    const chargeNorm = Math.min(1, (device.physics.vdgVoltage ?? 0) / VDG_V_BREAK);
    const sparkGlow = (device.physics.vdgSparkHz ?? 0) > 0 ? 1 : 0;
    this.meshRenderer.drawPluginDevice(
      viewProj, pos, buildVdgMesh(chargeNorm, sparkGlow).cylinders(), renderOpts
    );
  } else if (drawMeshes && device.id === 'hall') {
    const currentNorm = Math.min(1, (device.physics.hallCurrent ?? 0) / 1.2);
    const fieldNorm = Math.min(1, (device.physics.hallFieldT ?? 0) / 0.65);
    this.meshRenderer.drawPluginDevice(
      viewProj, pos, buildHallMesh(currentNorm, fieldNorm).cylinders(), renderOpts
    );
  } else if (drawMeshes && device.id === 'lorentz-sled') {
    const posNorm = ((device.physics.lorentzPositionM ?? 0) % LORENTZ.railLengthM) / LORENTZ.railLengthM;
    const currentNorm = Math.min(1, Math.abs(device.physics.lorentzCurrentA ?? 0) / LORENTZ.iMaxA);
    const fieldNorm = Math.min(1, (device.physics.lorentzFieldT ?? 0) / LORENTZ.fieldTMax);
    this.meshRenderer.drawPluginDevice(
      viewProj, pos, buildLorentzSledMesh(posNorm, currentNorm, fieldNorm).cylinders(), renderOpts
    );
  }

  if (this.currentView === 'halbach-viz' && device.id === 'halbach-viz' && this.halbachFieldRenderer) {
    this.halbachFieldRenderer.draw(
      viewProj,
      pos,
      device.physics.halbachFieldLines,
      device.physics.halbachHeatmap,
      { extent: 3.1, gridSize: 24 }
    );
  }
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
      this.energyPipeRenderer.draw(viewProj, this.devices, this.time, {
        devicesEnabled: this.devicesEnabled
      });
    }

    if (this.segAnnotations?.enabled) {
      this.segAnnotations.update();
    }

    requestAnimationFrame((t) => this.render(t));
  }
}
