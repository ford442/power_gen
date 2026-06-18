import { MultiDeviceShaders } from './multi-device-shaders.js';
import { MultiDeviceCamera } from './multi-device-camera.js';
import { SimRateController } from './sim-rate-controller.js';
import { WebGPUManager } from './webgpu-manager.js';
import { CameraController } from './camera-controller.js';
import { PerformanceProfiler } from './performance-profiler.js';
import { DebugPanel, DEVICE_CONFIG } from './debug-panel.js';
import { DeviceInstance } from './device-instance.js';
import { EnergyPipe } from './energy-pipe.js';
import { SEGMaterialPresets } from './seg-materials.js';
import {
  generateBearingShaft,
  generateCoilWithWindings,
  generateCCorePickupCoil,
  generateMagneticWallShells,
  generatePlateWithCutouts,
  generatePoleBandedRoller,
  generateSupportStand,
  generateWireHarness
} from './seg-enhanced-geometry.js';
import {
  computeSEGLayout,
  SEG_LAYOUT_PRESETS,
  SEG_LAYOUT_UNIFORM_BYTES,
  packSEGLayoutUniforms,
  buildRollerCutouts,
  MAX_ROLLERS
} from './seg-layout.js';

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export class MultiDeviceVisualizer {
  constructor() {
    console.log('MultiDeviceVisualizer v5 starting - depthStencil fix applied');
    this.canvas = document.getElementById('gpuCanvas');

    // Initialize managers
    this.webgpu = new WebGPUManager(this.canvas);
    this.camera = new CameraController();
    this.profiler = null;
    this.debugPanel = null;
    
    // Initialize shader provider and camera controller
    this.shaders = new MultiDeviceShaders();
    this.cameraController = null; // Will be initialized after debugPanel is ready

    // Convenience references
    Object.defineProperty(this, 'device', { get: () => this.webgpu.device });
    Object.defineProperty(this, 'context', { get: () => this.webgpu.context });
    Object.defineProperty(this, 'globalUniformBuffer', { get: () => this.webgpu.globalUniformBuffer });

    this.currentView = 'overview';
    this.devicesEnabled = { seg: true, heron: true, kelvin: true, solar: true, peltier: true, mhd: true };
    this.devices = {};
    this.energyPipes = [];

    // Hardware integration hooks
    this.hardwareBridge = null;
    this.emController = null;
    this.hardwareTargetPhase = 0;
    this.hardwareTargetSpeed = 0;

    this.time = 0;
    this.lastFrameTime = 0;
    this.fps = 60;
    this.speedMult = 1.0;
    this.globalEnergyLevel = 0.0;
    this.anomalousEffectsEnabled = (this.prototypePreset === 'lab');

    // SimRateController for speed-scaled physics and visuals
    this.simRateController = new SimRateController();

    // Lighting configuration for PBR shaders
    this.lightingConfig = {
      key: { position: [5.0, 8.0, 5.0], color: [1.0, 0.98, 0.95], intensity: 1.2 },
      fill: { position: [-4.0, 3.0, -3.0], color: [0.75, 0.85, 1.0], intensity: 0.4 },
      rim: { position: [0.0, 2.0, -8.0], color: [0.4, 0.8, 1.0], intensity: 0.8 },
      ground: { position: [0.0, -5.0, 0.0], color: [0.3, 0.25, 0.2], intensity: 0.15 },
      ambient: 0.3,
      envMapStrength: 0.5,
      shadowStrength: 1.0
    };

    // Prototype-accuracy preset for SEG rollers.
    //   'showroom' = Searl mock-up (nickel/brass/copper showroom finish)
    //   'lab'      = Roschin-Godin lab rig (aluminum sleeves, ceramic, wear)
    const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
    const protoParam = params.get('prototype');
    this.prototypePreset = 'showroom';
    if (protoParam === 'lab' || protoParam === 'roschin' || protoParam === 'godin') {
      this.prototypePreset = 'lab';
    } else if (protoParam === 'showroom' || protoParam === 'searl') {
      this.prototypePreset = 'showroom';
    } else if (typeof window !== 'undefined' && window.SEG_PROTOTYPE_PRESET) {
      this.prototypePreset = window.SEG_PROTOTYPE_PRESET;
    }

    // Literature-grounded SEG layout preset (roller counts, gap rule, scale).
  //   searl    = documented 10/25/35 three-ring device
  //   roschin  = Roschin–Godin 1 m single-ring 12-roller converter
  //   legacy   = previous 8/12/16 toy proportions (regression)
    const layoutParam = params.get('layout');
    this.segLayoutPreset = SEG_LAYOUT_PRESETS.searl;
    if (layoutParam === 'roschin' || layoutParam === 'lab' || layoutParam === 'godin') {
      this.segLayoutPreset = SEG_LAYOUT_PRESETS.roschin;
    } else if (layoutParam === 'legacy') {
      this.segLayoutPreset = SEG_LAYOUT_PRESETS.legacy;
    } else if (layoutParam === 'searl' || layoutParam === 'showroom') {
      this.segLayoutPreset = SEG_LAYOUT_PRESETS.searl;
    } else if (this.prototypePreset === 'lab') {
      this.segLayoutPreset = SEG_LAYOUT_PRESETS.roschin;
    } else if (typeof window !== 'undefined' && window.SEG_LAYOUT_PRESET) {
      this.segLayoutPreset = window.SEG_LAYOUT_PRESET;
    }
    this.segLayout = null;

    this.init();
  }
  
  async init() {
    try {
      await this.webgpu.init();
      this.webgpu.resize();

      // Initialize profiler
      this.profiler = new PerformanceProfiler(this.webgpu.device, this.canvas);
      await this.profiler.init();

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

      window.addEventListener('resize', () => this._syncCanvasSize());
      this._observeCanvasLayout();

      // Show optimal settings hint
      this.showOptimalSettingsHint();

      if (typeof window.syncSEGLayoutUI === 'function') {
        window.syncSEGLayoutUI();
      }

    } catch (e) {
      console.error(e);
      alert("Init failed: " + e.message);
    }
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

  showOptimalSettingsHint() {
    const settings = this.profiler.getOptimalSettings();
    console.log('Detected GPU Tier:', this.profiler.gpuTier);
    console.log('Recommended settings:', settings);
    
    // Could show a UI notification here
  }

  setupMaterialTableBuffer() {
    const materials = [
      { ...SEGMaterialPresets.copper, accent: [0.55, 0.30, 0.15], detail: [18.0, 0.06, 0.10, 0.0] },      // 0 copper
      { ...SEGMaterialPresets.steel, accent: [0.75, 0.77, 0.80], detail: [24.0, 0.04, 0.08, 0.0] },       // 1 steel
      { ...SEGMaterialPresets.brass, accent: [0.45, 0.32, 0.12], detail: [20.0, 0.05, 0.12, 0.0] },       // 2 brass
      { ...SEGMaterialPresets.insulation, accent: [0.72, 0.70, 0.62], detail: [14.0, 0.0, 0.06, 0.0] },   // 3 insulation
      { ...SEGMaterialPresets.neodymium, accent: [0.55, 0.58, 0.60], detail: [16.0, 0.03, 0.07, 0.0] },   // 4 neodymium
      { ...SEGMaterialPresets.copperOxide, accent: [0.26, 0.42, 0.34], detail: [26.0, 0.04, 0.12, 0.0] }, // 5 oxidized copper
      { ...SEGMaterialPresets.boltSteel, accent: [0.85, 0.86, 0.88], detail: [36.0, 0.02, 0.18, 0.0] },   // 6 bolt steel
      { baseColor: [0.08, 0.13, 0.22], metallic: 0.18, roughness: 0.36, accent: [0.15, 0.34, 0.52], detail: [46.0, 0.0, 0.04, 0.0] }, // 7 solar
      { baseColor: [0.73, 0.77, 0.82], metallic: 0.02, roughness: 0.08, accent: [0.84, 0.89, 0.95], detail: [8.0, 0.0, 0.03, 0.0] },  // 8 fluid/glass
      { baseColor: [0.83, 0.86, 0.88], metallic: 0.05, roughness: 0.62, accent: [0.35, 0.45, 0.58], detail: [22.0, 0.0, 0.05, 0.0] }, // 9 ceramic
      { baseColor: [0.74, 0.76, 0.80], metallic: 0.72, roughness: 0.28, accent: [0.94, 0.96, 0.99], detail: [28.0, 0.05, 0.08, 0.0] }, // 10 anodized can
      { baseColor: [0.18, 0.23, 0.28], metallic: 0.12, roughness: 0.52, accent: [0.72, 0.20, 0.14], detail: [40.0, 0.0, 0.05, 0.0] }, // 11 peltier junction
      { baseColor: [0.92, 0.92, 0.90], metallic: 0.02, roughness: 0.48, accent: [0.20, 0.20, 0.22], detail: [30.0, 0.0, 0.06, 0.0] }, // 12 label paint
      { baseColor: [0.07, 0.08, 0.10], metallic: 0.55, roughness: 0.42, accent: [0.16, 0.18, 0.22], detail: [24.0, 0.06, 0.12, 0.0] }, // 13 SEG dark base
      { ...SEGMaterialPresets.laminatedIron, accent: [0.10, 0.11, 0.12], detail: [48.0, 0.08, 0.18, 0.0] },                            // 14 C-core laminated iron
      { ...SEGMaterialPresets.windingCopperEnamel, accent: [0.95, 0.62, 0.12], detail: [64.0, 0.04, 0.10, 0.0] },                      // 15 enameled winding copper
      { ...SEGMaterialPresets.mountFootSteel, accent: [0.55, 0.57, 0.60], detail: [32.0, 0.05, 0.14, 0.0] }                            // 16 coil mounting foot
    ];

    const packed = new Float32Array(materials.length * 12);
    for (let i = 0; i < materials.length; i++) {
      const m = materials[i];
      const baseOffset = i * 12;
      packed.set([m.baseColor[0], m.baseColor[1], m.baseColor[2], m.metallic], baseOffset);
      packed.set([m.accent[0], m.accent[1], m.accent[2], m.roughness], baseOffset + 4);
      packed.set([m.detail[0], m.detail[1], m.detail[2], m.detail[3]], baseOffset + 8);
    }

    this.materialTableBuffer = this.device.createBuffer({
      size: packed.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(this.materialTableBuffer, 0, packed);
    this.profiler.trackBuffer('materialTable', packed.byteLength, GPUBufferUsage.STORAGE);
  }
  
  // ... [Rest of the MultiDeviceVisualizer methods remain the same]
  // Setup methods, camera methods, rendering loop, etc.
  
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

  async setupDevices() {
    for (const [deviceId, config] of Object.entries(DEVICE_CONFIG)) {
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
      { from: 'mhd', to: 'peltier', speed: 2.0 }
    ];
    
    for (const config of pipeConfigs) {
      const pipe = new EnergyPipe(this.device, config);
      await pipe.init();
      this.energyPipes.push(pipe);
    }
  }
  
  generateCylinder(radius, height, segments) {
    const vertices = [], indices = [], normals = [];

    for (let i = 0; i <= segments; i++) {
      const theta = (i / segments) * Math.PI * 2;
      const x = Math.cos(theta) * radius;
      const z = Math.sin(theta) * radius;

      vertices.push(x, height / 2, z);
      normals.push(0, 1, 0);

      vertices.push(x, -height / 2, z);
      normals.push(0, -1, 0);

      vertices.push(x, height / 2, z);
      normals.push(Math.cos(theta), 0, Math.sin(theta));

      vertices.push(x, -height / 2, z);
      normals.push(Math.cos(theta), 0, Math.sin(theta));
    }

    for (let i = 0; i < segments; i++) {
      const base = i * 4;
      const next = ((i + 1) % (segments + 1)) * 4;

      indices.push(base, next, base + 2, base + 2, next, next + 2);
      indices.push(base + 1, base + 3, next + 1, next + 1, base + 3, next + 3);
      indices.push(base + 2, next + 2, base + 3, base + 3, next + 2, next + 3);
    }

    const vertexData = new Float32Array(vertices.length / 3 * 6);
    for (let i = 0; i < vertices.length / 3; i++) {
      vertexData[i * 6] = vertices[i * 3];
      vertexData[i * 6 + 1] = vertices[i * 3 + 1];
      vertexData[i * 6 + 2] = vertices[i * 3 + 2];
      vertexData[i * 6 + 3] = normals[i * 3];
      vertexData[i * 6 + 4] = normals[i * 3 + 1];
      vertexData[i * 6 + 5] = normals[i * 3 + 2];
    }

    return { vertices: vertexData, indices: new Uint16Array(indices) };
  }

  generateDisc(innerRadius, outerRadius, thickness, segments) {
    const vertices = [], indices = [], normals = [];
    const h2 = thickness / 2;

    for (let i = 0; i <= segments; i++) {
      const theta = (i / segments) * Math.PI * 2;
      const c = Math.cos(theta), s = Math.sin(theta);

      vertices.push(c * innerRadius, h2, s * innerRadius);
      normals.push(0, 1, 0);

      vertices.push(c * outerRadius, h2, s * outerRadius);
      normals.push(0, 1, 0);

      vertices.push(c * outerRadius, -h2, s * outerRadius);
      normals.push(0, -1, 0);

      vertices.push(c * innerRadius, -h2, s * innerRadius);
      normals.push(0, -1, 0);

      vertices.push(c * outerRadius, h2, s * outerRadius);
      normals.push(c, 0, s);

      vertices.push(c * outerRadius, -h2, s * outerRadius);
      normals.push(c, 0, s);

      vertices.push(c * innerRadius, h2, s * innerRadius);
      normals.push(-c, 0, -s);

      vertices.push(c * innerRadius, -h2, s * innerRadius);
      normals.push(-c, 0, -s);
    }

    for (let i = 0; i < segments; i++) {
      const b = i * 8;
      const n = ((i + 1) % (segments + 1)) * 8;
      // Top face
      indices.push(b, n, b + 1, b + 1, n, n + 1);
      // Bottom face
      indices.push(b + 2, b + 3, n + 2, n + 2, b + 3, n + 3);
      // Outer wall
      indices.push(b + 4, b + 5, n + 4, n + 4, b + 5, n + 5);
      // Inner wall
      indices.push(b + 6, n + 6, b + 7, b + 7, n + 6, n + 7);
    }

    const vertexData = new Float32Array(vertices.length / 3 * 6);
    for (let i = 0; i < vertices.length / 3; i++) {
      vertexData[i * 6] = vertices[i * 3];
      vertexData[i * 6 + 1] = vertices[i * 3 + 1];
      vertexData[i * 6 + 2] = vertices[i * 3 + 2];
      vertexData[i * 6 + 3] = normals[i * 3];
      vertexData[i * 6 + 4] = normals[i * 3 + 1];
      vertexData[i * 6 + 5] = normals[i * 3 + 2];
    }
    return { vertices: vertexData, indices: new Uint16Array(indices) };
  }

  generateCylinderWithUVs(radius, height, segments) {
    const vertices = [], indices = [], normals = [], uvs = [];
    for (let i = 0; i <= segments; i++) {
      const theta = (i / segments) * Math.PI * 2;
      const x = Math.cos(theta) * radius;
      const z = Math.sin(theta) * radius;
      const u = i / segments;

      vertices.push(x, height / 2, z);
      normals.push(0, 1, 0);
      uvs.push(u, 1);

      vertices.push(x, -height / 2, z);
      normals.push(0, -1, 0);
      uvs.push(u, 0);

      vertices.push(x, height / 2, z);
      normals.push(Math.cos(theta), 0, Math.sin(theta));
      uvs.push(u, 1);

      vertices.push(x, -height / 2, z);
      normals.push(Math.cos(theta), 0, Math.sin(theta));
      uvs.push(u, 0);
    }

    for (let i = 0; i < segments; i++) {
      const base = i * 4;
      const next = ((i + 1) % (segments + 1)) * 4;
      indices.push(base, next, base + 2, base + 2, next, next + 2);
      indices.push(base + 1, base + 3, next + 1, next + 1, base + 3, next + 3);
      indices.push(base + 2, next + 2, base + 3, base + 3, next + 2, next + 3);
    }

    const vertexData = new Float32Array(vertices.length / 3 * 8);
    for (let i = 0; i < vertices.length / 3; i++) {
      vertexData[i * 8] = vertices[i * 3];
      vertexData[i * 8 + 1] = vertices[i * 3 + 1];
      vertexData[i * 8 + 2] = vertices[i * 3 + 2];
      vertexData[i * 8 + 3] = normals[i * 3];
      vertexData[i * 8 + 4] = normals[i * 3 + 1];
      vertexData[i * 8 + 5] = normals[i * 3 + 2];
      vertexData[i * 8 + 6] = uvs[i * 2];
      vertexData[i * 8 + 7] = uvs[i * 2 + 1];
    }
    return { vertices: vertexData, indices: new Uint16Array(indices) };
  }

  generateDiscWithUVs(innerRadius, outerRadius, thickness, segments) {
    const vertices = [], indices = [], normals = [], uvs = [];
    const h2 = thickness / 2;

    for (let i = 0; i <= segments; i++) {
      const theta = (i / segments) * Math.PI * 2;
      const c = Math.cos(theta), s = Math.sin(theta);
      const u = i / segments;

      vertices.push(c * innerRadius, h2, s * innerRadius);
      normals.push(0, 1, 0);
      uvs.push(0, u);

      vertices.push(c * outerRadius, h2, s * outerRadius);
      normals.push(0, 1, 0);
      uvs.push(1, u);

      vertices.push(c * outerRadius, -h2, s * outerRadius);
      normals.push(0, -1, 0);
      uvs.push(1, u);

      vertices.push(c * innerRadius, -h2, s * innerRadius);
      normals.push(0, -1, 0);
      uvs.push(0, u);

      vertices.push(c * outerRadius, h2, s * outerRadius);
      normals.push(c, 0, s);
      uvs.push(u, 1);

      vertices.push(c * outerRadius, -h2, s * outerRadius);
      normals.push(c, 0, s);
      uvs.push(u, 0);

      vertices.push(c * innerRadius, h2, s * innerRadius);
      normals.push(-c, 0, -s);
      uvs.push(u, 1);

      vertices.push(c * innerRadius, -h2, s * innerRadius);
      normals.push(-c, 0, -s);
      uvs.push(u, 0);
    }

    for (let i = 0; i < segments; i++) {
      const b = i * 8;
      const n = ((i + 1) % (segments + 1)) * 8;
      indices.push(b, n, b + 1, b + 1, n, n + 1);
      indices.push(b + 2, b + 3, n + 2, n + 2, b + 3, n + 3);
      indices.push(b + 4, b + 5, n + 4, n + 4, b + 5, n + 5);
      indices.push(b + 6, n + 6, b + 7, b + 7, n + 6, n + 7);
    }

    const vertexData = new Float32Array(vertices.length / 3 * 8);
    for (let i = 0; i < vertices.length / 3; i++) {
      vertexData[i * 8] = vertices[i * 3];
      vertexData[i * 8 + 1] = vertices[i * 3 + 1];
      vertexData[i * 8 + 2] = vertices[i * 3 + 2];
      vertexData[i * 8 + 3] = normals[i * 3];
      vertexData[i * 8 + 4] = normals[i * 3 + 1];
      vertexData[i * 8 + 5] = normals[i * 3 + 2];
      vertexData[i * 8 + 6] = uvs[i * 2];
      vertexData[i * 8 + 7] = uvs[i * 2 + 1];
    }
    return { vertices: vertexData, indices: new Uint16Array(indices) };
  }

  generateBoxWithUVs(width, height, depth) {
    const w = width / 2;
    const h = height / 2;
    const d = depth / 2;
    const vertices = new Float32Array([
      // front (+z)
      -w, -h,  d,  0, 0, 1,  0, 0,
       w, -h,  d,  0, 0, 1,  1, 0,
       w,  h,  d,  0, 0, 1,  1, 1,
      -w,  h,  d,  0, 0, 1,  0, 1,
      // back (-z)
       w, -h, -d,  0, 0, -1,  0, 0,
      -w, -h, -d,  0, 0, -1,  1, 0,
      -w,  h, -d,  0, 0, -1,  1, 1,
       w,  h, -d,  0, 0, -1,  0, 1,
      // top (+y)
      -w,  h,  d,  0, 1, 0,  0, 0,
       w,  h,  d,  0, 1, 0,  1, 0,
       w,  h, -d,  0, 1, 0,  1, 1,
      -w,  h, -d,  0, 1, 0,  0, 1,
      // bottom (-y)
       w, -h,  d,  0, -1, 0,  0, 0,
      -w, -h,  d,  0, -1, 0,  1, 0,
      -w, -h, -d,  0, -1, 0,  1, 1,
       w, -h, -d,  0, -1, 0,  0, 1,
      // right (+x)
       w, -h,  d,  1, 0, 0,  0, 0,
       w, -h, -d,  1, 0, 0,  1, 0,
       w,  h, -d,  1, 0, 0,  1, 1,
       w,  h,  d,  1, 0, 0,  0, 1,
      // left (-x)
      -w, -h, -d,  -1, 0, 0,  0, 0,
      -w, -h,  d,  -1, 0, 0,  1, 0,
      -w,  h,  d,  -1, 0, 0,  1, 1,
      -w,  h, -d,  -1, 0, 0,  0, 1,
    ]);
    const indices = new Uint16Array([
      0, 1, 2,  0, 2, 3,
      4, 5, 6,  4, 6, 7,
      8, 9, 10,  8, 10, 11,
      12, 13, 14,  12, 14, 15,
      16, 17, 18,  16, 18, 19,
      20, 21, 22,  20, 22, 23
    ]);
    return { vertices, indices };
  }

  async setupSharedGeometry() {
    console.log('Initializing structural mesh geometry layouts...');
    this.deviceGeometryBuffers = this.deviceGeometryBuffers || {};

    // Per-device hooks — never call undefined builders (peltier/mhd are compute-only).
    for (const [deviceId, config] of Object.entries(DEVICE_CONFIG)) {
      const targetBuilderName = `build${deviceId.toUpperCase()}Geometry`;
      const builderMethod = this[targetBuilderName];

      if (typeof builderMethod === 'function') {
        await builderMethod.call(this, config);
      } else {
        console.log(`[System Neutral]: Bypassing mesh generation for particle-only device: ${deviceId}`);
        await this.setupDefaultPrimitiveGeometry(deviceId, config);
      }
    }

    await this._setupCoreSEGSharedMeshes();
  }

  /**
   * Tiny placeholder mesh so particle-only devices never bind null geometry buffers.
   */
  async setupDefaultPrimitiveGeometry(deviceId, config) {
    if (this.deviceGeometryBuffers[deviceId]) return;

    const data = this.generateCylinder(0.05, 0.05, 8);
    const vertexBuffer = this.device.createBuffer({
      size: data.vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(vertexBuffer, 0, data.vertices);
    const indexBuffer = this.device.createBuffer({
      size: data.indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(indexBuffer, 0, data.indices);

    this.deviceGeometryBuffers[deviceId] = {
      vertexBuffer,
      indexBuffer,
      indexCount: data.indices.length,
      color: config.color
    };
    this.profiler.trackBuffer(`placeholder-${deviceId}-vertices`, data.vertices.byteLength, GPUBufferUsage.VERTEX);
  }

  async _setupCoreSEGSharedMeshes() {
    const layout = this.refreshSEGLayout(1.0);
    const ws = layout.worldScale;
    const statorH = layout.statorHeightM * ws;
    const outerR = layout.outerRadiusM * ws;
    const basePlateSize = layout.basePlateRadiusM * ws * 2;
    const coilRadius = outerR * 1.15;

    const generators = {
      generateBearingShaft,
      generatePoleBandedRoller,
      generateSupportStand,
      generateWireHarness,
      generateCoilWithWindings
    };
    for (const [name, fn] of Object.entries(generators)) {
      if (typeof fn !== 'function') {
        throw new Error(`[setupSharedGeometry] Missing geometry generator: ${name}`);
      }
    }

    // UV cylinder shared by pickup/electromagnet coils
    const coilCylData = this.generateCylinderWithUVs(0.8, 2.5, 64);
    const coilCylVB = this.device.createBuffer({ size: coilCylData.vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(coilCylVB, 0, coilCylData.vertices);
    const coilCylIB = this.device.createBuffer({ size: coilCylData.indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(coilCylIB, 0, coilCylData.indices);
    this.coilUVBuffer = { vertexBuffer: coilCylVB, indexBuffer: coilCylIB, indexCount: coilCylData.indices.length };
    this.profiler.trackBuffer('seg-coil-uv-vertices', coilCylData.vertices.byteLength, GPUBufferUsage.VERTEX);
    this.profiler.trackBuffer('seg-coil-uv-indices', coilCylData.indices.byteLength, GPUBufferUsage.INDEX);

    // Industrial base box (UV mesh for enhanced PBR pipeline)
    const baseBoxData = this.generateBoxWithUVs(basePlateSize, statorH * 0.45, basePlateSize);
    const baseBoxVB = this.device.createBuffer({ size: baseBoxData.vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(baseBoxVB, 0, baseBoxData.vertices);
    const baseBoxIB = this.device.createBuffer({ size: baseBoxData.indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(baseBoxIB, 0, baseBoxData.indices);
    this.basePlateBuffer = { vertexBuffer: baseBoxVB, indexBuffer: baseBoxIB, indexCount: baseBoxData.indices.length };
    this.profiler.trackBuffer('seg-base-plate-vertices', baseBoxData.vertices.byteLength, GPUBufferUsage.VERTEX);
    this.profiler.trackBuffer('seg-base-plate-indices', baseBoxData.indices.byteLength, GPUBufferUsage.INDEX);

    const baseY = -statorH * 0.35;
    this.baseInstanceBuffer = this.device.createBuffer({
      size: 48,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(this.baseInstanceBuffer, 0, new Float32Array([
      0, baseY, 0,  // position
      0.0,          // ringIndex
      0, 0, 0, 1,   // rotation
      0.08, 0.08, 0.12, // dark base color
      0.0           // emissive
    ]));
    this.profiler.trackBuffer('seg-base-instance', 48, GPUBufferUsage.STORAGE);

    // Enhanced SEG roller mesh at reference dimensions; per-ring scale in shader.
    this.enhancedRollerBuffer = generatePoleBandedRoller(this.device, {
      radius: 0.75, height: 2.8, bands: 8, segments: 64
    });
    this.profiler.trackBuffer('enhanced-roller-vertices', this.enhancedRollerBuffer.vertexBuffer.size, GPUBufferUsage.VERTEX);
    this.profiler.trackBuffer('enhanced-roller-indices', this.enhancedRollerBuffer.indexBuffer.size, GPUBufferUsage.INDEX);

    // Central bearing shaft (replaces sphere)
    this.coreShaftBuffer = generateBearingShaft(this.device, {
      shaftRadius: layout.shaftRadiusM * ws,
      shaftHeight: layout.shaftHeightM * ws,
      flangeRadius: layout.shaftRadiusM * ws * 3.6,
      topRingRadius: layout.shaftRadiusM * ws * 2.6,
      segments: 48
    });
    this.profiler.trackBuffer('core-shaft-vertices', this.coreShaftBuffer.vertexBuffer.size, GPUBufferUsage.VERTEX);

    // Magnetic core (simple cylinder with UVs for enhanced pipeline)
    const magnetData = this.generateCylinderWithUVs(0.8, 2.5, 64);
    const magnetVB = this.device.createBuffer({ size: magnetData.vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(magnetVB, 0, magnetData.vertices);
    const magnetIB = this.device.createBuffer({ size: magnetData.indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(magnetIB, 0, magnetData.indices);
    this.coreMagnetBuffer = { vertexBuffer: magnetVB, indexBuffer: magnetIB, indexCount: magnetData.indices.length };

    // Core plates with roller cutouts derived from layout (full roller counts).
    const rollerCutouts = buildRollerCutouts(layout);
    const plateData = generatePlateWithCutouts(this.device, {
      innerRadius: layout.shaftRadiusM * ws * 1.2,
      outerRadius: outerR * 1.08,
      thickness: statorH * 0.55,
      rollerCutouts,
      boltHoles: 16,
      hasRibs: true,
      ribCount: 8,
      segments: 96
    });
    this.corePlateBuffer = plateData;
    this.profiler.trackBuffer('seg-core-plate-vertices', plateData.vertexBuffer.size, GPUBufferUsage.VERTEX);
    this.profiler.trackBuffer('seg-core-plate-indices', plateData.indexBuffer.size, GPUBufferUsage.INDEX);

    // Bolt geometry (small cylinder with UVs)
    const boltData = this.generateCylinderWithUVs(0.08, 0.15, 8);
    const boltVB = this.device.createBuffer({ size: boltData.vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(boltVB, 0, boltData.vertices);
    const boltIB = this.device.createBuffer({ size: boltData.indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(boltIB, 0, boltData.indices);
    this.coreBoltBuffer = { vertexBuffer: boltVB, indexBuffer: boltIB, indexCount: boltData.indices.length };

    // Bolt positions (16 bolts around perimeter)
    const boltPositions = [];
    const boltInstanceData = [];
    const boltCount = 16;
    const boltRadius = outerR * 1.02;
    for (let i = 0; i < boltCount; i++) {
      const angle = (i / boltCount) * Math.PI * 2;
      boltPositions.push(Math.cos(angle) * boltRadius, 0, Math.sin(angle) * boltRadius);
      // Instance: position(3) + ringIndex(1) + rotation(4) + color(3) + emissive(1) = 12 floats
      boltInstanceData.push(
        Math.cos(angle) * boltRadius, 0, Math.sin(angle) * boltRadius,
        11.0, // ringIndex hack for plate/structural
        0, 0, 0, 1, // rotation
        0.70, 0.72, 0.74, // steel bolt color
        0.0 // emissive
      );
    }
    this.coreBoltPositions = new Float32Array(boltPositions);
    this.coreBoltInstanceBuffer = this.device.createBuffer({
      size: boltInstanceData.length * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(this.coreBoltInstanceBuffer, 0, new Float32Array(boltInstanceData));
    this.profiler.trackBuffer('core-bolt-instances', boltInstanceData.length * 4, GPUBufferUsage.STORAGE);

    // Connection rings (thin UV cylinders, instanced at y = +/-2.0)
    const ringData = this.generateCylinderWithUVs(0.15, 0.3, 48);
    const ringVB = this.device.createBuffer({ size: ringData.vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(ringVB, 0, ringData.vertices);
    const ringIB = this.device.createBuffer({ size: ringData.indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(ringIB, 0, ringData.indices);
    this.connectionRingBuffer = { vertexBuffer: ringVB, indexBuffer: ringIB, indexCount: ringData.indices.length };

    this.connectionRingInstances = this.device.createBuffer({
      size: 2 * 48,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(this.connectionRingInstances, 0, new Float32Array([
      // top ring
      0, 2.0, 0,  0.0,
      0, 0, 0, 1,
      0.85, 0.48, 0.25,
      0.0,
      // bottom ring
      0, -2.0, 0,  0.0,
      0, 0, 0, 1,
      0.85, 0.48, 0.25,
      0.0
    ]));
    this.profiler.trackBuffer('seg-connection-ring-instances', 2 * 48, GPUBufferUsage.STORAGE);

    // C-shaped pickup coil geometry (core, winding bundle, mounting foot)
    this.cCoreCoilBuffer = generateCCorePickupCoil(this.device, {
      coilRadius,
      jawReach: statorH * 2.2,
      coreWidth: statorH * 2.4,
      coreHeight: statorH * 1.1,
      coreThickness: statorH * 0.6,
      armWidth: statorH * 0.6,
      windingWidth: statorH * 1.9,
      windingHeight: statorH * 1.2,
      windingThickness: statorH * 1.15
    });

    // Battery gauge (simple cylinder)
    const gaugeData = this.generateCylinder(0.3, 0.1, 16);
    const gaugeVB = this.device.createBuffer({ size: gaugeData.vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(gaugeVB, 0, gaugeData.vertices);
    const gaugeIB = this.device.createBuffer({ size: gaugeData.indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(gaugeIB, 0, gaugeData.indices);
    this.batteryGaugeVertexBuffer = gaugeVB;
    this.batteryGaugeIndexBuffer = gaugeIB;
    this.batteryGaugeIndexCount = gaugeData.indices.length;

    // Support stand
    this.standBuffer = generateSupportStand(this.device, {
      legCount: 4, legLength: outerR * 1.1, baseRadius: outerR * 0.65, height: outerR * 0.55, segments: 24
    });

    // Wire harnesses (8 wires between coils)
    this.wireBuffers = [];
    const coilCount = 8;
    for (let i = 0; i < coilCount; i++) {
      const angle1 = (i / coilCount) * Math.PI * 2;
      const angle2 = ((i + 1) / coilCount) * Math.PI * 2;
      this.wireBuffers.push(generateWireHarness(this.device, {
        start: [Math.cos(angle1) * coilRadius, statorH * 1.2, Math.sin(angle1) * coilRadius],
        end: [Math.cos(angle2) * coilRadius, statorH * 1.2, Math.sin(angle2) * coilRadius],
        radius: statorH * 0.08, sag: statorH * 0.9, segments: 16
      }));
    }

    // Coil with windings
    this.coilWindingBuffer = generateCoilWithWindings(this.device, {
      majorRadius: coilRadius, minorRadius: statorH * 0.85, turns: 60, majorSegments: 96
    });

    // Magnetic wall shells for Roschin–Godin anomalous environmental effects.
    this.magneticWallBuffer = generateMagneticWallShells(this.device, {
      innerRadius: layout.shaftRadiusM * ws * 1.4,
      spacing: statorH * 0.9,
      shellThickness: statorH * 0.1,
      height: outerR * 2.2,
      maxShells: 5,
      segments: 96
    });

    // Stator rings: annular discs with square cross-section (h_s × h_s) per ring.
    const ringSegs = 96;
    const ringVCount = layout.rings.map((ring) => {
      const inner = ring.statorInnerM * ws;
      const outer = ring.statorOuterM * ws;
      const d = this.generateDiscWithUVs(inner, outer, statorH, ringSegs);
      return { data: d, vertexCount: d.vertices.length / 8 };
    });

    let ringTotalVerts = 0;
    let ringTotalIdx = 0;
    for (const r of ringVCount) {
      ringTotalVerts += r.vertexCount;
      ringTotalIdx += r.data.indices.length;
    }
    const ringVertices = new Float32Array(ringTotalVerts * 8);
    const ringIndices = new Uint16Array(ringTotalIdx);
    let vOff = 0;
    let iOff = 0;
    for (let ri = 0; ri < ringVCount.length; ri++) {
      const y = statorH * 0.5;
      const src = ringVCount[ri].data;
      const vCount = ringVCount[ri].vertexCount;
      for (let i = 0; i < vCount; i++) {
        ringVertices[(vOff + i) * 8 + 0] = src.vertices[i * 8 + 0];
        ringVertices[(vOff + i) * 8 + 1] = src.vertices[i * 8 + 1] + y;
        ringVertices[(vOff + i) * 8 + 2] = src.vertices[i * 8 + 2];
        ringVertices[(vOff + i) * 8 + 3] = src.vertices[i * 8 + 3];
        ringVertices[(vOff + i) * 8 + 4] = src.vertices[i * 8 + 4];
        ringVertices[(vOff + i) * 8 + 5] = src.vertices[i * 8 + 5];
        ringVertices[(vOff + i) * 8 + 6] = src.vertices[i * 8 + 6];
        ringVertices[(vOff + i) * 8 + 7] = src.vertices[i * 8 + 7];
      }
      for (let i = 0; i < src.indices.length; i++) {
        ringIndices[iOff + i] = src.indices[i] + vOff;
      }
      vOff += vCount;
      iOff += src.indices.length;
    }

    const statorRingVB = this.device.createBuffer({ size: ringVertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(statorRingVB, 0, ringVertices);
    const statorRingIB = this.device.createBuffer({ size: ringIndices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(statorRingIB, 0, ringIndices);
    this.statorRingUVBuffer = { vertexBuffer: statorRingVB, indexBuffer: statorRingIB, indexCount: ringIndices.length };
    this.profiler.trackBuffer('seg-stator-ring-vertices', ringVertices.byteLength, GPUBufferUsage.VERTEX);
    this.profiler.trackBuffer('seg-stator-ring-indices', ringIndices.byteLength, GPUBufferUsage.INDEX);

    // Single canonical instance entry for the merged stator-ring mesh.
    this.statorRingInstanceBuffer = this.device.createBuffer({
      size: 48,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(this.statorRingInstanceBuffer, 0, new Float32Array([
      0, 0, 0,       // position
      0.0,           // ringIndex
      0, 0, 0, 1,    // rotation
      0.85, 0.48, 0.25, // copper color
      0.0            // emissive
    ]));
    this.profiler.trackBuffer('seg-stator-ring-instance', 48, GPUBufferUsage.STORAGE);

    // Wiring cylinder with UVs (for enhanced PBR pipeline)
    const wireCylData = this.generateCylinderWithUVs(0.15, 2.0, 16);
    const wireCylVB = this.device.createBuffer({ size: wireCylData.vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(wireCylVB, 0, wireCylData.vertices);
    const wireCylIB = this.device.createBuffer({ size: wireCylData.indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(wireCylIB, 0, wireCylData.indices);
    this.wiringUVBuffer = { vertexBuffer: wireCylVB, indexBuffer: wireCylIB, indexCount: wireCylData.indices.length };
  }

  async setupFloorGrid() {
    this.gridPipeline = this.device.createRenderPipeline({
      label: 'gridPipeline',
      layout: 'auto',
      vertex: {
        module: this.device.createShaderModule({ code: this.shaders.gridVertShader }),
        entryPoint: 'main',
        buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] }]
      },
      fragment: {
        module: this.device.createShaderModule({ code: this.shaders.gridFragShader }),
        entryPoint: 'main',
        targets: [{ format: navigator.gpu.getPreferredCanvasFormat(), blend: { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' } } }]
      },
      primitive: { topology: 'triangle-list' },
      depthStencil: { depthWriteEnabled: false, depthCompare: 'less', format: 'depth24plus-stencil8' }
    });

    const gridVertices = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);
    this.gridVertexBuffer = this.device.createBuffer({
      size: gridVertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(this.gridVertexBuffer, 0, gridVertices);
    this.profiler.trackBuffer('gridVertices', gridVertices.byteLength, GPUBufferUsage.VERTEX);

    this.gridBindGroup = this.device.createBindGroup({
      layout: this.gridPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.globalUniformBuffer } }]
    });
  }

  async setupSkyGradient() {
    this.skyPipeline = this.device.createRenderPipeline({
      label: 'skyPipeline',
      layout: 'auto',
      vertex: {
        module: this.device.createShaderModule({ code: this.shaders.skyVertShader }),
        entryPoint: 'main'
        // No vertex buffers — uses @builtin(vertex_index) to generate a fullscreen triangle
      },
      fragment: {
        module: this.device.createShaderModule({ code: this.shaders.skyFragShader }),
        entryPoint: 'main',
        targets: [{ format: navigator.gpu.getPreferredCanvasFormat() }]
      },
      primitive: { topology: 'triangle-list' },
      depthStencil: { depthWriteEnabled: false, depthCompare: 'always', format: 'depth24plus-stencil8' }
    });

    this.skyBindGroup = this.device.createBindGroup({
      layout: this.skyPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.globalUniformBuffer } }]
    });
  }

  async setupAnomalyWallPipeline() {
    const fmt = navigator.gpu.getPreferredCanvasFormat();

    this.anomalyWallPipeline = this.device.createRenderPipeline({
      label: 'anomalyWallPipeline',
      layout: 'auto',
      vertex: {
        module: this.device.createShaderModule({ code: this.shaders.anomalyWallsShader }),
        entryPoint: 'vsMain',
        buffers: [{
          arrayStride: 32,
          attributes: [
            { shaderLocation: 0, offset: 0,  format: 'float32x3' },
            { shaderLocation: 1, offset: 12, format: 'float32x3' },
            { shaderLocation: 2, offset: 24, format: 'float32x2' }
          ]
        }]
      },
      fragment: {
        module: this.device.createShaderModule({ code: this.shaders.anomalyWallsShader }),
        entryPoint: 'fsMain',
        targets: [{
          format: fmt,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' }
          }
        }]
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { depthWriteEnabled: false, depthCompare: 'less', format: 'depth24plus-stencil8' }
    });

    this.anomalyWallParamsBuffer = this.device.createBuffer({
      label: 'anomaly-wall-params',
      size: 24,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.profiler.trackBuffer('anomaly-wall-params', 24, GPUBufferUsage.UNIFORM);
  }
  
  /**
   * Block until the canvas has non-zero CSS layout (flex can report height before width).
   */
  _waitForCanvasLayout() {
    const canvas = this.canvas;
    if (canvas.clientWidth >= 1 && canvas.clientHeight >= 1) {
      return Promise.resolve();
    }
    const target = canvas.parentElement || canvas;
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        if (canvas.clientWidth >= 1 && canvas.clientHeight >= 1) {
          settled = true;
          ro.disconnect();
          resolve();
        }
      };
      const ro = new ResizeObserver(finish);
      ro.observe(target);
      requestAnimationFrame(finish);
      setTimeout(() => {
        if (!settled) {
          settled = true;
          ro.disconnect();
          resolve();
        }
      }, 500);
    });
  }

  _observeCanvasLayout() {
    const target = this.canvas.parentElement || this.canvas;
    if (this._canvasResizeObserver) {
      this._canvasResizeObserver.disconnect();
    }
    this._canvasResizeObserver = new ResizeObserver(() => {
      this._syncCanvasSize();
    });
    this._canvasResizeObserver.observe(target);
  }

  /**
   * Resize the canvas backing store (DPR-aware) and recreate depth/bloom targets.
   */
  async _syncCanvasSize() {
    this.webgpu.resize();
    if (!this.device || !this.profiler) return;

    const { width, height, layoutReady } = WebGPUManager.canvasPixelSize(this.canvas);
    if (!layoutReady) return;
    if (this._lastCanvasWidth === width && this._lastCanvasHeight === height && this.depthTexture) {
      return;
    }

    this._lastCanvasWidth = width;
    this._lastCanvasHeight = height;
    await this.setupDepthBuffer();
    if (this.bloomParamsBuffer) {
      this.setupBloomTextures();
    }
  }

  async setupDepthBuffer() {
    const { width, height } = WebGPUManager.canvasPixelSize(this.canvas);
    if (this.depthTexture) {
      this.profiler.textureAllocations = this.profiler.textureAllocations.filter(t => !t.name.includes('depth'));
      this.depthTexture.destroy();
    }
    this.depthTexture = this.device.createTexture({
      size: [width, height, 1],
      format: 'depth24plus-stencil8',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    });
    // Full aspect for render attachment; depth-only for shader sampling (bloom contact shadow).
    this.depthAttachmentView = this.depthTexture.createView();
    this.depthSampleView = this.depthTexture.createView({ aspect: 'depth-only' });
    this.profiler.trackTexture('depthBuffer', width, height, 'depth24plus-stencil8');
  }

  setupBloomTextures() {
    const { width: w, height: h } = WebGPUManager.canvasPixelSize(this.canvas);
    const fmt = navigator.gpu.getPreferredCanvasFormat();

    if (this.bloomSceneTexture) this.bloomSceneTexture.destroy();
    if (this.bloomBlurTexture)  this.bloomBlurTexture.destroy();
    if (this.bloomTempTexture)  this.bloomTempTexture.destroy();
    if (this.prevSceneTexture)  this.prevSceneTexture.destroy();

    this.bloomSceneTexture = this.device.createTexture({
      size: [w, h], format: fmt,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    });
    this.bloomBlurTexture = this.device.createTexture({
      size: [w, h], format: fmt,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    });
    this.bloomTempTexture = this.device.createTexture({
      size: [w, h], format: fmt,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    });
    this.prevSceneTexture = this.device.createTexture({
      size: [w, h], format: fmt,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    });

    if (this.bloomParamsBuffer) {
      this.device.queue.writeBuffer(
        this.bloomParamsBuffer, 0,
        new Float32Array([
          1.0 / w, 1.0 / h, 0.60, 0.12,
          1.4, 1.8, 0.0, 0.02,
          0.04, 0.20, 0.0, 0.0
        ])
      );
    }
  }

  async setupBloomPipeline() {
    const fmt = navigator.gpu.getPreferredCanvasFormat();

    this.bloomSampler = this.device.createSampler({
      magFilter: 'linear', minFilter: 'linear',
      addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge'
    });

    this.bloomParamsBuffer = this.device.createBuffer({
      size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.bloomBlurDirXBuffer = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.bloomBlurDirYBuffer = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

    const vertModule    = this.device.createShaderModule({ code: this.shaders.bloomVertShader });
    const extractModule = this.device.createShaderModule({ code: this.shaders.bloomExtractShader });
    const blurModule    = this.device.createShaderModule({ code: this.shaders.bloomBlurShader });
    const compModule    = this.device.createShaderModule({ code: this.shaders.bloomCompositeShader });

    this.bloomExtractPipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex:   { module: vertModule,    entryPoint: 'main' },
      fragment: { module: extractModule, entryPoint: 'main', targets: [{ format: fmt }] },
      primitive: { topology: 'triangle-list' }
    });

    this.bloomBlurPipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex:   { module: vertModule, entryPoint: 'main' },
      fragment: { module: blurModule, entryPoint: 'main', targets: [{ format: fmt }] },
      primitive: { topology: 'triangle-list' }
    });

    this.bloomCompositePipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex:   { module: vertModule,  entryPoint: 'main' },
      fragment: { module: compModule,  entryPoint: 'main', targets: [{ format: fmt }] },
      primitive: { topology: 'triangle-list' }
    });

    this.device.queue.writeBuffer(this.bloomBlurDirXBuffer, 0, new Float32Array([1, 0, 0, 0]));
    this.device.queue.writeBuffer(this.bloomBlurDirYBuffer, 0, new Float32Array([0, 1, 0, 0]));
    this.setupBloomTextures();
  }
  
  renderAnomalyWalls(renderPass, globalUniformBuffer, segDevice) {
    if (!this.anomalyWallPipeline || !this.magneticWallBuffer || !segDevice) return;
    if (this.anomalousEffectsEnabled === false) return;

    const envelope = segDevice._anomalyT || 0;
    if (envelope <= 0.001) return;

    const quality = this.profiler.qualityLevel;
    const shellCount = quality < 0.6 ? 3 : 5;

    // WallParams: intensity, shellCount, innerRadius, spacing, shellThickness, height
    this.device.queue.writeBuffer(
      this.anomalyWallParamsBuffer, 0,
      new Float32Array([envelope, shellCount, 1.6, 0.55, 0.06, 8.0])
    );

    const bindGroup = this.device.createBindGroup({
      layout: this.anomalyWallPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: globalUniformBuffer } },
        { binding: 1, resource: { buffer: this.anomalyWallParamsBuffer } }
      ]
    });

    renderPass.setPipeline(this.anomalyWallPipeline);
    renderPass.setBindGroup(0, bindGroup);
    renderPass.setVertexBuffer(0, this.magneticWallBuffer.vertexBuffer);
    renderPass.setIndexBuffer(this.magneticWallBuffer.indexBuffer, 'uint16');
    renderPass.drawIndexed(this.magneticWallBuffer.indexCount, 1);
  }

  render(timestamp) {
    if (this.canvas.clientWidth < 1 || this.canvas.clientHeight < 1 || !this.depthAttachmentView) {
      requestAnimationFrame((t) => this.render(t));
      return;
    }

    const deltaTime = (timestamp - this.lastFrameTime) / 1000;
    this.lastFrameTime = timestamp;
    
    if (timestamp % 500 < 20) {
      this.fps = Math.round(1 / (deltaTime || 0.016));
      const fpsEl = document.getElementById('fps');
      if (fpsEl) fpsEl.textContent = this.fps;
    }
    
    const rawSpeed = parseFloat(document.getElementById('speedControl')?.value) ?? 50;
    // Logarithmic mapping: 0→0.05×, 50→1.0×, 100→20× (base 400)
    const speed = 0.05 * Math.pow(400, rawSpeed / 100);
    this.speedMult = speed;
    this.simRateController.tick(deltaTime, speed);
    this.time += deltaTime * speed;

    // Propagate current speedMult to all devices (needed by GPU compute uniforms)
    for (const device of Object.values(this.devices)) {
      device.speedMult = speed;
    }

    // Update speedVal label so the UI reflects the actual multiplier
    const speedValEl = document.getElementById('speedVal');
    if (speedValEl) speedValEl.textContent = speed.toFixed(2) + '×';

    // Update tachometer overlay
    this._updateTachometer();

    // Update hardware bridge comms (send phase commands, parse sensor data)
    if (this.hardwareBridge?.isConnected) {
      this.hardwareBridge.update();
      // If running in auto mode, integrate target phase from speed
      if (!this.hardwareBridge.manualMode && this.hardwareBridge.controlMode === 0) {
        this.hardwareTargetPhase += this.hardwareBridge.targetSpeed * 6.0 * deltaTime; // RPM -> deg/s
      }
      this.hardwareBridge.targetPhase = this.hardwareTargetPhase;
    }

    // Update camera
    this.cameraController.updateCamera(deltaTime);
    
    // Record frame in profiler
    const totalParticles = Object.values(this.devices).reduce((sum, d) => sum + (this.devicesEnabled[d.id] ? d.particleCount : 0), 0);
    this.profiler.recordFrame(deltaTime, totalParticles);

    // Update solar battery UI (only shown when viewing the solar device)
    const batteryEl = document.getElementById('batteryCharge');
    const batteryStat = document.getElementById('batteryStat');
    if (batteryEl && batteryStat) {
      const solarDevice = this.devices['solar'];
      if (solarDevice) {
        batteryEl.textContent = `${Math.round((solarDevice.batteryCharge || 0) * 100)}%`;
        batteryStat.style.display = this.currentView === 'solar' ? 'flex' : 'none';
      }
    }
    
    // Update global uniforms with extended lighting data
    const viewProj = this.cameraController.getViewProjMatrix();
    const globalData = new Float32Array(128); // 512 bytes / 4 = 128 floats
    
    // Base uniforms (offset 0-23: 96 bytes)
    globalData.set(viewProj, 0);                    // 0-15: viewProj matrix
    globalData[16] = this.time;                     // 16: time
    // padding at 17 (1 float = 4 bytes)
    globalData[18] = this.canvas.width  || 1.0;     // 18-19: resolution (vec2f)
    globalData[19] = this.canvas.height || 1.0;
    globalData[20] = this.camera.camera.position[0];  // 20: cameraPos.x
    globalData[21] = this.camera.camera.position[1];  // 21: cameraPos.y
    globalData[22] = this.camera.camera.position[2];  // 22: cameraPos.z
    globalData[23] = this.speedMult;                  // 23: speedMult
    
    // Key light (offset 24-31: 32 bytes)
    const key = this.lightingConfig.key;
    globalData[24] = key.position[0];
    globalData[25] = key.position[1];
    globalData[26] = key.position[2];
    globalData[27] = key.intensity;
    globalData[28] = key.color[0];
    globalData[29] = key.color[1];
    globalData[30] = key.color[2];
    // padding at 31
    
    // Fill light (offset 32-39: 32 bytes)
    const fill = this.lightingConfig.fill;
    globalData[32] = fill.position[0];
    globalData[33] = fill.position[1];
    globalData[34] = fill.position[2];
    globalData[35] = fill.intensity;
    globalData[36] = fill.color[0];
    globalData[37] = fill.color[1];
    globalData[38] = fill.color[2];
    // padding at 39
    
    // Rim light (offset 40-47: 32 bytes)
    const rim = this.lightingConfig.rim;
    globalData[40] = rim.position[0];
    globalData[41] = rim.position[1];
    globalData[42] = rim.position[2];
    globalData[43] = rim.intensity;
    globalData[44] = rim.color[0];
    globalData[45] = rim.color[1];
    globalData[46] = rim.color[2];
    // padding at 47
    
    // Ground light (offset 48-55: 32 bytes)
    const ground = this.lightingConfig.ground;
    globalData[48] = ground.position[0];
    globalData[49] = ground.position[1];
    globalData[50] = ground.position[2];
    globalData[51] = ground.intensity;
    globalData[52] = ground.color[0];
    globalData[53] = ground.color[1];
    globalData[54] = ground.color[2];
    // padding at 55
    
    this.device.queue.writeBuffer(this.globalUniformBuffer, 0, globalData);

    // Upload centralized 3-point + environment lighting rig for all lit passes
    const lightingData = new Float32Array(48);
    lightingData[0] = key.position[0]; lightingData[1] = key.position[1]; lightingData[2] = key.position[2]; lightingData[3] = 0;
    lightingData[4] = key.color[0]; lightingData[5] = key.color[1]; lightingData[6] = key.color[2]; lightingData[7] = key.intensity;
    lightingData[8] = fill.position[0]; lightingData[9] = fill.position[1]; lightingData[10] = fill.position[2]; lightingData[11] = 0;
    lightingData[12] = fill.color[0]; lightingData[13] = fill.color[1]; lightingData[14] = fill.color[2]; lightingData[15] = fill.intensity;
    lightingData[16] = rim.position[0]; lightingData[17] = rim.position[1]; lightingData[18] = rim.position[2]; lightingData[19] = 0;
    lightingData[20] = rim.color[0]; lightingData[21] = rim.color[1]; lightingData[22] = rim.color[2]; lightingData[23] = rim.intensity;
    lightingData[24] = ground.position[0]; lightingData[25] = ground.position[1]; lightingData[26] = ground.position[2]; lightingData[27] = 0;
    lightingData[28] = ground.color[0]; lightingData[29] = ground.color[1]; lightingData[30] = ground.color[2]; lightingData[31] = ground.intensity;
    lightingData[32] = this.lightingConfig.ambient;
    lightingData[33] = this.lightingConfig.envMapStrength;
    lightingData[34] = this.lightingConfig.shadowStrength;
    this.device.queue.writeBuffer(this.lightingUniformBuffer, 0, lightingData);

    // Update devices with quality scaling
    const qualityScale = this.profiler.qualityLevel;
    this.refreshSEGLayout(qualityScale);
    for (const device of Object.values(this.devices)) {
      if (this.devicesEnabled[device.id]) {
        device.update(deltaTime * speed, qualityScale);
      }
    }

    const enabledDevices = Object.values(this.devices).filter((d) => this.devicesEnabled[d.id]);
    const targetGlobalEnergy = enabledDevices.length
      ? enabledDevices.reduce((sum, d) => sum + (d.energyLevel || 0), 0) / enabledDevices.length
      : 0.0;
    const globalSmooth = 1.0 - Math.exp(-Math.max(0.0, deltaTime) * 10.0);
    this.globalEnergyLevel += (targetGlobalEnergy - this.globalEnergyLevel) * globalSmooth;
    
    // Begin command encoding
    const encoder = this.device.createCommandEncoder();
    
    // ─── COMPUTE PASS: animate particles on GPU ───
    const computePass = encoder.beginComputePass({ label: 'particle-compute' });

    // SEG-specific compute: roller kinematics + RK4 flux line tracing.
    // These run first so rendering reads the freshly updated buffers.
    const segDevice = this.devices['seg'];
    if (segDevice && this.devicesEnabled['seg']) {
      if (segDevice.rollerComputePipeline && segDevice.rollerComputeBindGroup) {
        computePass.setPipeline(segDevice.rollerComputePipeline);
        computePass.setBindGroup(0, segDevice.rollerComputeBindGroup);
        computePass.dispatchWorkgroups(Math.ceil(MAX_ROLLERS / 64));
      }
      // RK4 flux line tracer: one thread per flux line (up to 108).
      if (segDevice.fluxTracerPipeline && segDevice.fluxTracerBindGroup &&
          this.profiler.qualityLevel > 0.4) {
        computePass.setPipeline(segDevice.fluxTracerPipeline);
        computePass.setBindGroup(0, segDevice.fluxTracerBindGroup);
        const fluxLines = this.segLayout?.totalFluxLines ?? 108;
        computePass.dispatchWorkgroups(Math.ceil(fluxLines / 64));
      }
    }

    for (const device of Object.values(this.devices)) {
      if (this.devicesEnabled[device.id] && device.computePipeline && device.computeBindGroup) {
        // Write compute uniforms: time, mode, particleCount, speedMult
        const modeIndex = device.id === 'heron' ? 1.0 : (device.id === 'kelvin' ? 2.0 : (device.id === 'solar' ? 3.0 : (device.id === 'peltier' ? 4.0 : (device.id === 'mhd' ? 5.0 : 0.0))));
        const computeUniforms = new Float32Array([
          this.time,
          modeIndex,
          device.scaledParticleCount || device.particleCount,
          device.speedMult || 1.0
        ]);
        this.device.queue.writeBuffer(device.computeUniformBuffer, 0, computeUniforms);
        
        computePass.setPipeline(device.computePipeline);
        computePass.setBindGroup(0, device.computeBindGroup);
        const workgroups = Math.ceil((device.scaledParticleCount || device.particleCount) / 64);
        computePass.dispatchWorkgroups(workgroups);
      }
    }
    computePass.end();
    
    this.profiler.writeTimestamp(encoder, 0);
    
    const sceneView = (this.bloomSceneTexture)
      ? this.bloomSceneTexture.createView()
      : this.context.getCurrentTexture().createView();

    const renderPass = encoder.beginRenderPass({
      colorAttachments: [{
        view: sceneView,
        clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 1 },
        loadOp: 'clear',
        storeOp: 'store'
      }],
      depthStencilAttachment: {
        view: this.depthAttachmentView,
        depthClearValue: 1.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
        stencilClearValue: 0,
        stencilLoadOp: 'clear',
        stencilStoreOp: 'store'
      }
    });

    // Render sky gradient first (fullscreen, before all geometry)
    if (this.skyPipeline && this.skyBindGroup) {
      renderPass.setPipeline(this.skyPipeline);
      renderPass.setBindGroup(0, this.skyBindGroup);
      renderPass.draw(3);
    }

    // Render grid
    if (this.gridPipeline && this.gridBindGroup) {
      renderPass.setPipeline(this.gridPipeline);
      renderPass.setBindGroup(0, this.gridBindGroup);
      renderPass.setVertexBuffer(0, this.gridVertexBuffer);
      renderPass.draw(6);
    }

    // Render devices (scaled by quality)
    const scaledQuality = this.profiler.qualityLevel;
    for (const device of Object.values(this.devices)) {
      if (this.devicesEnabled[device.id]) {
        // Skip expensive SEG VFX (field lines, arcs, flux) at low quality — keep core mesh visible.
        const skipEffects = scaledQuality < 0.5 && device.id === 'seg';
        device.render(renderPass, this.globalUniformBuffer, skipEffects);
      }
    }

    // Roschin–Godin magnetic wall shells (drawn after SEG so they overlay the scene).
    if (segDevice && this.devicesEnabled['seg']) {
      this.renderAnomalyWalls(renderPass, this.globalUniformBuffer, segDevice);
    }

    renderPass.end();

    // Preserve this frame’s scene for next frame’s overdrive motion blur.
    if (this.bloomSceneTexture && this.prevSceneTexture) {
      encoder.copyTextureToTexture(
        { texture: this.bloomSceneTexture },
        { texture: this.prevSceneTexture },
        [this.canvas.width || 1, this.canvas.height || 1, 1]
      );
    }

    // ── Bloom post-processing ─────────────────────────────────────────────
    if (this.bloomExtractPipeline && this.bloomBlurPipeline && this.bloomCompositePipeline &&
        this.bloomSceneTexture && this.bloomBlurTexture && this.bloomTempTexture && this.prevSceneTexture && this.depthTexture) {
      // Update bloom parameters dynamically based on current speed
      if (this.bloomParamsBuffer) {
        const w = this.canvas.width || 1;
        const h = this.canvas.height || 1;
        const speedEnergy = Math.min(1.0, this.simRateController.speedMult / 20.0);
        const energy = Math.min(1.0, Math.max(speedEnergy, this.globalEnergyLevel));
        const energyPow = Math.pow(energy, 1.35);
        // Subtle temporal motion blur that ramps up in overdrive (speedMult > 7).
        const motionBlur = smoothstep(7.0, 20.0, this.simRateController.speedMult) * 0.12;
        this.device.queue.writeBuffer(
          this.bloomParamsBuffer, 0,
          new Float32Array([
            1.0 / w,
            1.0 / h,
            Math.max(0.45, this.simRateController.bloomThreshold - energyPow * 0.10),
            Math.max(0.08, this.simRateController.bloomThreshold * (0.18 + energy * 0.10)),
            this.simRateController.bloomStrength * (1.0 + energyPow * 0.35),
            1.3 + energyPow * 3.6,
            energyPow,
            0.010 + energyPow * 0.045,
            0.010 + energyPow * 0.040,
            0.08 + energyPow * 0.52,
            motionBlur,
            0.0
          ])
        );
      }

      // Pass 1: extract bright areas → bloomTempTexture
      const extractPass = encoder.beginRenderPass({
        colorAttachments: [{
          view: this.bloomTempTexture.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear', storeOp: 'store'
        }]
      });
      extractPass.setPipeline(this.bloomExtractPipeline);
      extractPass.setBindGroup(0, this.device.createBindGroup({
        layout: this.bloomExtractPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.bloomSceneTexture.createView() },
          { binding: 1, resource: this.bloomSampler },
          { binding: 2, resource: { buffer: this.bloomParamsBuffer } }
        ]
      }));
      extractPass.draw(3);
      extractPass.end();

      // Pass 2: horizontal blur bloomTemp → bloomBlur
      const blurXPass = encoder.beginRenderPass({
        colorAttachments: [{
          view: this.bloomBlurTexture.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear', storeOp: 'store'
        }]
      });
      blurXPass.setPipeline(this.bloomBlurPipeline);
      blurXPass.setBindGroup(0, this.device.createBindGroup({
        layout: this.bloomBlurPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.bloomTempTexture.createView() },
          { binding: 1, resource: this.bloomSampler },
          { binding: 2, resource: { buffer: this.bloomParamsBuffer } },
          { binding: 3, resource: { buffer: this.bloomBlurDirXBuffer } }
        ]
      }));
      blurXPass.draw(3);
      blurXPass.end();

      // Pass 3: vertical blur bloomBlur → bloomTemp
      const blurYPass = encoder.beginRenderPass({
        colorAttachments: [{
          view: this.bloomTempTexture.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear', storeOp: 'store'
        }]
      });
      blurYPass.setPipeline(this.bloomBlurPipeline);
      blurYPass.setBindGroup(0, this.device.createBindGroup({
        layout: this.bloomBlurPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.bloomBlurTexture.createView() },
          { binding: 1, resource: this.bloomSampler },
          { binding: 2, resource: { buffer: this.bloomParamsBuffer } },
          { binding: 3, resource: { buffer: this.bloomBlurDirYBuffer } }
        ]
      }));
      blurYPass.draw(3);
      blurYPass.end();

      // Pass 4: composite scene + bloom → canvas with tonemap/post FX
      const compositePass = encoder.beginRenderPass({
        colorAttachments: [{
          view: this.context.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear', storeOp: 'store'
        }]
      });
      compositePass.setPipeline(this.bloomCompositePipeline);
      compositePass.setBindGroup(0, this.device.createBindGroup({
        layout: this.bloomCompositePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.bloomSceneTexture.createView() },
          { binding: 1, resource: this.bloomTempTexture.createView() },
          { binding: 2, resource: this.bloomSampler },
          { binding: 3, resource: { buffer: this.bloomParamsBuffer } },
          { binding: 4, resource: this.depthSampleView },
          { binding: 5, resource: this.prevSceneTexture.createView() }
        ]
      }));
      compositePass.draw(3);
      compositePass.end();
    }
    this.profiler.writeTimestamp(encoder, 1);
    
    this.device.queue.submit([encoder.finish()]);
    
    // Resolve timestamps asynchronously (guarded against overlapping map/submit)
    if (this.profiler.timingEnabled) {
      this.profiler.scheduleResolveTimestamps();
    }
    
    requestAnimationFrame((t) => this.render(t));
  }

  /**
   * Handle simulation mode change (forwarded from window.setMode).
   * Focuses the camera on the named device, matching the single-device API.
   */
  onModeChange(mode) {
    if (this.cameraController) this.cameraController.focusOnDevice(mode);
  }

  /**
   * Update the tachometer DOM overlay with the current simulation speed.
   * Called once per render frame (before the GPU encode begins).
   */
  _updateTachometer() {
    const el = document.getElementById('tachometer');
    if (!el) return;
    const src = this.simRateController;
    const fill = el.querySelector('.tach-fill');
    const label = el.querySelector('.tach-label');
    if (fill) {
      fill.style.width = `${(src.tachFill * 100).toFixed(1)}%`;
      fill.style.background = `hsl(${src.tachHue}, 100%, 50%)`;
      if (src.isOverdrive) fill.classList.add('overdrive');
      else fill.classList.remove('overdrive');
    }
    if (label) {
      label.textContent = `${src.speedMult.toFixed(2)}×`;
      label.style.color = `hsl(${src.tachHue}, 100%, 65%)`;
    }
  }

  /**
   * Quality/perf test harness: step through a set of speed multipliers for a
   * fixed duration, then print average frame time, FPS, and SEG effect metrics.
   * Exposed as window.runSEGSpeedTest([0.1, 1, 10, 30], 3000).
   */
  async runSpeedTest(speeds = [0.1, 1, 10, 30], durationMs = 3000) {
    const slider = document.getElementById('speedControl');
    if (!slider) {
      console.warn('[SpeedTest] #speedControl not found');
      return;
    }
    const speedToSlider = (speed) => Math.max(0, Math.min(100, 100 * Math.log(speed / 0.05) / Math.log(400)));
    const segDevice = this.devices['seg'];

    console.log('[SpeedTest] starting — speeds:', speeds, 'duration:', durationMs, 'ms');
    const results = [];

    for (const speed of speeds) {
      slider.value = speedToSlider(speed);
      // Wait for the visualizer to pick up the new slider value and settle.
      await new Promise(r => setTimeout(r, 500));

      const startFps = this.fps || 0;
      const startFrame = this.profiler?.frameCount || 0;
      const startTime = performance.now();
      let minFps = 999;
      let maxFps = 0;
      let samples = 0;

      while (performance.now() - startTime < durationMs) {
        await new Promise(r => requestAnimationFrame(r));
        const f = this.fps || 0;
        if (f > 0) {
          minFps = Math.min(minFps, f);
          maxFps = Math.max(maxFps, f);
          samples++;
        }
      }

      const endFrame = this.profiler?.frameCount || startFrame;
      const avgFps = samples > 0 ? (startFps + this.fps) / 2 : 0; // rough
      results.push({
        speed,
        fps: this.fps || 0,
        minFps: minFps === 999 ? 0 : minFps,
        maxFps,
        frames: endFrame - startFrame,
        energy: segDevice?.energyLevel || 0,
        effectBudget: segDevice?._prevEffectBudget || 0
      });
      console.log(`[SpeedTest] ${speed.toFixed(2)}× — FPS ${this.fps} (min ${minFps === 999 ? 0 : minFps}, max ${maxFps}), energy ${(segDevice?.energyLevel || 0).toFixed(3)}`);
    }

    console.table(results);
    console.log('[SpeedTest] complete');
  }
}
