import { MultiDeviceShaders } from './multi-device-shaders.js';
import './devices/register-plugins.js';
import { MultiDeviceCamera } from './multi-device-camera.js';
import { SimRateController } from './sim-rate-controller.js';
import { WebGPUManager, DEPTH_FORMAT } from './webgpu-manager.js';
import { PipelineLayoutCache } from './pipeline-layout-cache.js';
import { CameraController } from './camera-controller.js';
import { PerformanceProfiler } from './performance-profiler.js';
import { DebugPanel, DEVICE_CONFIG } from './debug-panel.js';
import { getMergedDeviceConfig, getAllSimDeviceIds } from './devices/device-registry.js';
import { DeviceInstance } from './device-instance.js';
import { EnergyPipe } from './energy-pipe.js';
import {
  computeSEGLayout,
  SEG_LAYOUT_PRESETS,
  SEG_LAYOUT_UNIFORM_BYTES,
  packSEGLayoutUniforms
} from './seg-layout.js';
import {
  getHeronLayout,
  HERON_LAYOUT_PRESETS,
  parseHeronLayoutPreset
} from './heron-layout.js';
import { parseSegFrameLevel } from './seg-frame-model.js';
import {
  parseLightingLook,
  getLightingPreset,
} from './seg-lighting-presets.js';
import { segOperator } from './seg-operator-state.js';
import { telemetryHub, TelemetryHub } from './telemetry-hub.ts';
import { segWasm } from './wasm/seg-physics-bridge.js';
import { HardwareBridge, TWIN_MODES } from './hardware-bridge.js';
import { ElectromagnetController } from './electromagnet-controller.js';
import { initHardwarePanel } from './hardware-panel.js';
import { initSEGAnnotations } from './seg-annotations.js';
import { explainerState } from './seg-explainer/explainer-state.js';
import { isDeviceActive as isDeviceVisible } from './renderers/shared/device-view.js';
import {
  parsePrototypePreset,
  parseSegLayoutPreset,
  parseAnomalousEffects
} from './renderers/shared/url-params.js';
import {
  SEGIntegrationManager,
  PHYSICS_UNIFORM_BYTES
} from './integration.ts';
import { primitiveMethods } from './visualizer/primitives.js';
import { geometrySetupMethods } from './visualizer/setup-geometry.js';
import { sceneSetupMethods } from './visualizer/scene-setup.js';
import { renderLoopMethods } from './visualizer/render-loop.js';
import { hardwareTwinMethods } from './visualizer/hardware-twin.js';
import { materialMethods } from './visualizer/materials.js';
import { diagnosticsMethods } from './visualizer/diagnostics.js';
import { gltfSetupMethods } from './visualizer/setup-gltf.js';

export class MultiDeviceVisualizer {
  constructor() {
    console.log('MultiDeviceVisualizer v5 starting - depthStencil fix applied');
    this.canvas = document.getElementById('gpuCanvas');

    // Initialize managers (single adapter path lives in WebGPUManager)
    this.webgpu = new WebGPUManager(this.canvas, {
      onDeviceLost: (info) => {
        console.error('[MultiDeviceVisualizer] GPU device lost — prompting reload', info);
        WebGPUManager.showDeviceLostUI(info);
      }
    });
    this.camera = new CameraController();
    this.profiler = null;
    this.debugPanel = null;
    /** @type {string} Matches WebGPUManager.depthFormat (depth24plus, no stencil). */
    this.depthFormat = DEPTH_FORMAT;
    
    // Initialize shader provider and camera controller
    this.shaders = new MultiDeviceShaders();
    this.cameraController = null; // Will be initialized after debugPanel is ready

    // Convenience references
    Object.defineProperty(this, 'device', { get: () => this.webgpu.device });
    Object.defineProperty(this, 'context', { get: () => this.webgpu.context });
    Object.defineProperty(this, 'globalUniformBuffer', { get: () => this.webgpu.globalUniformBuffer });

    this.currentView = 'overview';
    this.devicesEnabled = Object.fromEntries(getAllSimDeviceIds().map((id) => [id, true]));
    this.devices = {};
    this.energyPipes = [];

    // Hardware digital twin (Web Serial / mock)
    this.emController = new ElectromagnetController();
    this.hardwareBridge = new HardwareBridge({
      onError: (e) => console.error('[HardwareBridge]', e)
    });
    this.hardwareTargetPhase = 0;
    this.hardwareTargetSpeed = 0;
    this.hardwareShadow = { phaseError: 0, rpmError: 0 };

    /** @type {import('./integration.ts').SEGIntegrationManager | null} */
    this.integration = null;
    /** @type {GPUBuffer | null} Manager-owned physics uniform buffer (alias). */
    this.physicsUniformBuffer = null;

    this.time = 0;
    this.lastFrameTime = 0;
    this.fps = 60;
    this.speedMult = 1.0;
    this.globalEnergyLevel = 0.0;
    /** Integrated SEG spin state (from segOperator physics) */
    this.segOmega = 0;
    this.corona = 0;

    const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');

    // Prototype-accuracy preset for SEG rollers (parse before lighting / layout).
    this.prototypePreset = parsePrototypePreset(params);
    this.anomalousEffectsEnabled = parseAnomalousEffects(this.prototypePreset);

    // SimRateController for speed-scaled physics and visuals
    this.simRateController = new SimRateController();

    // Lighting / post look preset (studio | lab | drama)
    this.lightingLook = parseLightingLook(params);
    const lookPreset = getLightingPreset(this.lightingLook);

    // Lighting configuration for PBR shaders (from active look preset)
    this.lightingConfig = { ...lookPreset.lighting };
    this.postPreset = lookPreset;
    this.postExposure = lookPreset.post.exposure;
    this.postBloomStrength = lookPreset.post.bloomStrength;

    // Literature-grounded SEG layout preset (roller counts, gap rule, scale).
  //   searl    = documented 10/25/35 three-ring device
  //   roschin  = Roschin–Godin 1 m single-ring 12-roller converter
  //   legacy   = previous 8/12/16 toy proportions (regression)
    this.segLayoutPreset = parseSegLayoutPreset(params, this.prototypePreset);
    this.segLayout = null;

    this.heronLayoutPreset = parseHeronLayoutPreset(params);
    try {
      const storedHeron = localStorage.getItem('heron-layout');
      if (storedHeron && Object.values(HERON_LAYOUT_PRESETS).includes(storedHeron)) {
        this.heronLayoutPreset = storedHeron;
      }
    } catch (_) { /* ignore */ }
    this.heronLayout = getHeronLayout(this.heronLayoutPreset);

    this.segFrameLevel = parseSegFrameLevel(params);
    this.segFrameBuffers = null;
    this.frameStructuralInstanceBuffer = null;
    this.frameControlInstanceBuffer = null;
    this.frameCageInstanceBuffer = null;
    this.frameLabBenchInstanceBuffer = null;

    this.init();
  }
  
  async init() {
    try {
      await this.webgpu.init();
      this.depthFormat = this.webgpu.depthFormat || DEPTH_FORMAT;
      this.webgpu.resize();

      // Explicit bind-group / pipeline layouts + shared device pipelines (once)
      this.pipelineCache = new PipelineLayoutCache(this.device, {
        canvasFormat: this.webgpu.canvasFormat || navigator.gpu.getPreferredCanvasFormat(),
        depthFormat: this.depthFormat
      });
      await this.pipelineCache.ensureDevicePipelines(this.shaders);
      console.log(
        `[MultiDeviceVisualizer] Pipeline cache: ${this.pipelineCache.stats.pipelineCreates} creates ` +
        `(shared across all devices)`
      );

      // Typed physics hub (ValidatedConstants + fallback formulas → GPU uniforms)
      try {
        this.integration = new SEGIntegrationManager(this.device, this.canvas, {
          enableScientificOverlay: false
        });
        this.physicsUniformBuffer = this.integration.getPhysicsUniformBuffer();
        if (typeof window !== 'undefined') {
          window.SEGIntegration = window.SEGIntegration || { manager: null, initialize: null };
          window.SEGIntegration.manager = this.integration;
        }
        console.log('[MultiDeviceVisualizer] SEGIntegrationManager attached (typed physics uniforms)');
      } catch (e) {
        console.warn('[MultiDeviceVisualizer] SEGIntegrationManager init failed:', e);
        this.integration = null;
        this.physicsUniformBuffer = null;
      }

      // Profiler reuses the single adapter from WebGPUManager (no second requestAdapter)
      this.profiler = new PerformanceProfiler(this.webgpu.device, this.canvas, {
        adapter: this.webgpu.adapter,
        adapterInfo: this.webgpu.adapterInfo
      });
      await this.profiler.init();
      if (this.integration) {
        this.profiler.trackBuffer('physicsUniforms', PHYSICS_UNIFORM_BYTES, GPUBufferUsage.UNIFORM);
      }

      // Initialize debug panel
      this.debugPanel = new DebugPanel(this.profiler);
      
      // Initialize multi-device camera controller (for view transitions and matrix math)
      // Note: MultiDeviceCamera focuses on view transitions and matrix operations only.
      // Input handling is delegated to CameraController.setupInteraction() below.
      this.cameraController = new MultiDeviceCamera(this.canvas, this.camera.camera, this);

      this.camera.setupInteraction(this.canvas, (mode) => this.switchMode(mode));

      this.segLayoutUniformBuffer = this.device.createBuffer({
        label: 'seg-layout-uniforms',
        size: SEG_LAYOUT_UNIFORM_BYTES,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      });
      this.profiler.trackBuffer('seg-layout-uniforms', SEG_LAYOUT_UNIFORM_BYTES, GPUBufferUsage.UNIFORM);
      this.refreshSEGLayout(1.0);

      await this.setupSharedGeometry();
      await this.setupDevices();
      await this.setupEnergyPipes();
      await this.setupFloorGrid();
      await this.setupSkyGradient();

      // Match canvas backing store to layout before depth/bloom textures are allocated.
      await this._waitForCanvasLayout();
      await this._syncCanvasSize();
      await this.setupBloomPipeline();
      await this.setupAnomalyWallPipeline();

      // Track initial allocations
      this.profiler.trackBuffer('globalUniforms', 512, GPUBufferUsage.UNIFORM);

      // Create lighting uniform buffer for all lit SEG and solar-gauge passes (192 bytes)
      this.lightingUniformBuffer = this.device.createBuffer({
        size: 192,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      });
      this.profiler.trackBuffer('lightingUniforms', 192, GPUBufferUsage.UNIFORM);

      this.setupMaterialTableBuffer();

      this.render(0);

      window.runSEGSpeedTest = (speeds, durationMs) => this.runSpeedTest(speeds, durationMs);

      try {
        this.segAnnotations = initSEGAnnotations(() => this);
      } catch (e) {
        console.warn('[MultiDeviceVisualizer] SEG annotations init failed:', e);
      }

      window.addEventListener('resize', () => this._syncCanvasSize());
      this._observeCanvasLayout();

      // Show optimal settings hint
      this.showOptimalSettingsHint();

      // Hardware twin panel (feature-detects Web Serial; Mock always available)
      try {
        initHardwarePanel(this);
      } catch (e) {
        console.warn('[MultiDeviceVisualizer] Hardware panel init failed:', e);
      }
      // Auto mock when ?mockHardware=1
      try {
        if (new URLSearchParams(location.search).get('mockHardware') === '1') {
          this.hardwareBridge.connectMock();
        }
      } catch (_) { /* ignore */ }

      if (typeof window.syncSEGLayoutUI === 'function') {
        window.syncSEGLayoutUI();
      }
      if (typeof window.syncHeronLayoutUI === 'function') {
        window.syncHeronLayoutUI();
      }
      if (typeof window.syncLayoutPanelsVisibility === 'function') {
        window.syncLayoutPanelsVisibility();
      }

    } catch (e) {
      console.error(e);
      alert("Init failed: " + e.message);
    }
  }
  
  setSegFrameLevel(level) {
    const allowed = ['off', 'minimal', 'full'];
    if (!allowed.includes(level)) return;
    this.segFrameLevel = level;
    console.log(`[SEG] Frame level → ${level} (reload to rebuild geometry if buffers missing)`);
  }

  /** Switch studio / lab / drama lighting + post look at runtime. */
  setLightingLook(look) {
    const preset = getLightingPreset(look);
    if (!preset) return;
    this.lightingLook = look;
    this.postPreset = preset;
    this.lightingConfig = { ...preset.lighting };
    this.postExposure = preset.post.exposure;
    this.postBloomStrength = preset.post.bloomStrength;
    this._uploadSkyUniforms();
    console.log(`[SEG] Lighting look → ${look}`);
  }

  _uploadSkyUniforms(energy = 0) {
    if (!this.skyUniformBuffer || !this.device) return;
    const sky = this.postPreset?.sky ?? getLightingPreset(this.lightingLook).sky;
    this.device.queue.writeBuffer(this.skyUniformBuffer, 0, new Float32Array([
      sky.mode,
      sky.energy + energy * 0.5,
      0, 0
    ]));
  }

  refreshSEGLayout(qualityScale = 1.0) {
    this.segLayout = computeSEGLayout(this.segLayoutPreset, qualityScale);
    if (this.segLayoutUniformBuffer && this.device) {
      this.device.queue.writeBuffer(
        this.segLayoutUniformBuffer,
        0,
        packSEGLayoutUniforms(this.segLayout)
      );
    }
    return this.segLayout;
  }

  getSEGLayoutPreset() {
    return this.segLayoutPreset;
  }

  /**
   * Switch SEG layout preset at runtime (rebuilds shared SEG meshes + uniform buffer).
   * @param {string} presetName - 'searl', 'roschin', or 'legacy'
   */
  async setSEGLayoutPreset(presetName) {
    const presets = Object.values(SEG_LAYOUT_PRESETS);
    if (!presets.includes(presetName)) {
      console.warn('[SEG] Unknown layout preset:', presetName);
      return null;
    }
    if (this.segLayoutPreset === presetName) {
      return this.segLayout;
    }

    this.segLayoutPreset = presetName;
    await this._setupCoreSEGSharedMeshes();

    const quality = this.profiler?.qualityLevel ?? 1.0;
    const layout = this.refreshSEGLayout(quality);

    if (DEVICE_CONFIG.seg && layout.cameraOffset) {
      DEVICE_CONFIG.seg.cameraOffset = layout.cameraOffset;
    }

    try {
      const url = new URL(window.location.href);
      url.searchParams.set('layout', presetName);
      window.history.replaceState(null, '', url);
    } catch (_) { /* ignore */ }

    if (this.currentView === 'seg' && this.cameraController) {
      this.cameraController.focusOnDevice('seg');
    }

    return layout;
  }

  getHeronLayoutPreset() {
    return this.heronLayoutPreset;
  }

  /**
   * Switch Heron's Fountain build shape (vessels, plumbing, hydraulic params).
   * @param {string} presetName - classic, compact, tower, wide, spiral
   */
  async setHeronLayoutPreset(presetName) {
    const presets = Object.values(HERON_LAYOUT_PRESETS);
    if (!presets.includes(presetName)) {
      console.warn('[Heron] Unknown layout preset:', presetName);
      return null;
    }
    if (this.heronLayoutPreset === presetName) {
      return this.heronLayout;
    }

    this.heronLayoutPreset = presetName;
    this.heronLayout = getHeronLayout(presetName);

    const heron = this.devices.heron;
    if (heron?.geometry?.applyHeronLayout) {
      await heron.geometry.applyHeronLayout(presetName);
    }
    if (heron?.physicsState) {
      heron.physicsState.heronLayoutId = presetName;
      heron.physicsState.heronHeadMax = this.heronLayout.headMaxM;
      heron.physicsState.heronHead = Math.min(heron.physicsState.heronHead, this.heronLayout.headMaxM);
    }

    try {
      localStorage.setItem('heron-layout', presetName);
    } catch (_) { /* ignore */ }
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('heronLayout', presetName);
      window.history.replaceState(null, '', url);
    } catch (_) { /* ignore */ }

    if (this.currentView === 'heron' && this.cameraController) {
      this.cameraController.focusOnDevice('heron');
    }

    return this.heronLayout;
  }

  showOptimalSettingsHint() {
    const settings = this.profiler.getOptimalSettings();
    console.log('Detected GPU Tier:', this.profiler.gpuTier);
    console.log('Recommended settings:', settings);
    
    // Could show a UI notification here
  }

  /**
   * Resize the 3D solar battery gauge cylinder to reflect charge level (0–1).
   * Called at init and each frame from DeviceInstance.update for the solar device.
   */
  updateBatteryGaugeMesh(charge = 0.5) {
    if (!this.device || !this.batteryGaugeVertexBuffer) return;
    const clamped = Math.max(0, Math.min(1, charge));
    const minH = 0.04;
    const maxH = 0.35;
    const height = minH + (maxH - minH) * clamped;
    const gaugeData = this.generateCylinder(0.3, height, 16);
    this.device.queue.writeBuffer(this.batteryGaugeVertexBuffer, 0, gaugeData.vertices);
    this.device.queue.writeBuffer(this.batteryGaugeIndexBuffer, 0, gaugeData.indices);
    this.batteryGaugeIndexCount = gaugeData.indices.length;
  }

  switchMode(mode) {
    this.onModeChange(mode);
  }

  /**
   * Whether a device should simulate and render this frame.
   * Overview shows all enabled devices; focused mode shows only the active device.
   */
  isDeviceActive(deviceId) {
    return isDeviceVisible(this.currentView, this.devicesEnabled, deviceId);
  }

  /** True when the multi-device overview (all devices) is active. */
  isOverviewMode() {
    return !this.currentView || this.currentView === 'overview';
  }

  async setupDevices() {
    const deviceConfig = getMergedDeviceConfig();
    for (const [deviceId, config] of Object.entries(deviceConfig)) {
      this.devices[deviceId] = new DeviceInstance(
        this.device,
        deviceId,
        config,
        this
      );
      await this.profiler.trackShaderCompile(`device-${deviceId}`, async () => {
        await this.devices[deviceId].init();
      });

      // Initialize battery gauge for solar device
      if (deviceId === 'solar') {
        this.updateBatteryGaugeMesh(this.devices[deviceId].batteryCharge || 0);
      }
    }
  }
  
  async setupEnergyPipes() {
    const pipeConfigs = [
      { from: 'seg', to: 'heron', speed: 2.0 },
      { from: 'heron', to: 'kelvin', speed: 1.5 },
      { from: 'kelvin', to: 'seg', speed: 2.5 },
      { from: 'kelvin', to: 'peltier', speed: 1.8 },
      { from: 'peltier', to: 'solar', speed: 2.2 },
      { from: 'seg', to: 'mhd', speed: 1.6 },
      { from: 'mhd', to: 'peltier', speed: 2.0 },
      { from: 'solar', to: 'maglev', speed: 1.4 },
      { from: 'maglev', to: 'seg', speed: 1.9 }
    ];

    for (const config of pipeConfigs) {
      const pipe = new EnergyPipe(this.device, config, this);
      await pipe.init();
      this.energyPipes.push(pipe);
    }
    await this.setupEnergyPipePipeline();
  }

  async setupEnergyPipePipeline() {
    this.energyPipePipeline = await this.pipelineCache.ensureEnergyPipePipeline(this.shaders);
    this.energyPipeComputePipeline = await this.pipelineCache.ensureEnergyPipeComputePipeline(this.shaders);
    for (const pipe of this.energyPipes) {
      pipe._setupComputeResources();
    }
  }

  /**
   * Handle simulation mode change (forwarded from window.setMode).
   * Focuses the camera on the named device, matching the single-device API.
   */
  onModeChange(mode) {
    const prev = this.currentView;
    this.currentView = mode;
    if (mode === 'overview') {
      this.cameraController?.showOverview();
    } else if (this.cameraController) {
      this.cameraController.focusOnDevice(mode);
    }
    document.querySelectorAll('.mode-btn').forEach((btn) => btn.classList.remove('active'));
    const activeBtn = document.getElementById(`btn-${mode}`);
    if (activeBtn) activeBtn.classList.add('active');

    // Re-initialize focused device simulation when entering from another view.
    if (mode && mode !== 'overview' && mode !== prev) {
      const device = this.devices[mode];
      device?.resetForModeEntry?.();
    }

    this._updateDeviceTelemetry();
    if (typeof window.syncLayoutPanelsVisibility === 'function') {
      window.syncLayoutPanelsVisibility();
    }
    if (mode === 'heron' && typeof window.syncHeronLayoutUI === 'function') {
      window.syncHeronLayoutUI();
    } else if (mode === 'seg' && typeof window.syncSEGLayoutUI === 'function') {
      window.syncSEGLayoutUI();
    }
  }

  /** Adjust SEG particle count from the operator panel slider */
  setParticleCount(count) {
    const seg = this.devices?.seg;
    if (!seg || count === seg.particleCount) return;
    seg.particleCount = count;
  }
}

Object.assign(
  MultiDeviceVisualizer.prototype,
  primitiveMethods,
  geometrySetupMethods,
  sceneSetupMethods,
  renderLoopMethods,
  hardwareTwinMethods,
  materialMethods,
  diagnosticsMethods,
  gltfSetupMethods
);
