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
  generatePoleBandedRoller,
  generateSupportStand,
  generateWireHarness
} from './seg-enhanced-geometry.js';

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

    // SimRateController for speed-scaled physics and visuals
    this.simRateController = new SimRateController();

    // Lighting configuration for PBR shaders
    this.lightingConfig = {
      key: { position: [5.0, 8.0, 5.0], color: [1.0, 0.98, 0.95], intensity: 1.2 },
      fill: { position: [-4.0, 3.0, -3.0], color: [0.75, 0.85, 1.0], intensity: 0.4 },
      rim: { position: [0.0, 2.0, -8.0], color: [0.4, 0.8, 1.0], intensity: 0.8 },
      ground: { position: [0.0, -5.0, 0.0], color: [0.3, 0.25, 0.2], intensity: 0.15 }
    };

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

      await this.setupSharedGeometry();
      await this.setupDevices();
      await this.setupEnergyPipes();
      await this.setupFloorGrid();
      await this.setupSkyGradient();

      // Match canvas backing store to layout before depth/bloom textures are allocated.
      await this._syncCanvasSize();
      await this.setupDepthBuffer();
      await this.setupBloomPipeline();

      // Track initial allocations
      this.profiler.trackBuffer('globalUniforms', 512, GPUBufferUsage.UNIFORM);

      // Create lighting uniform buffer for enhanced PBR shaders (192 bytes)
      this.lightingUniformBuffer = this.device.createBuffer({
        size: 192,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      });
      this.profiler.trackBuffer('lightingUniforms', 192, GPUBufferUsage.UNIFORM);

      this.setupMaterialTableBuffer();

      this.render(0);

      window.addEventListener('resize', () => this._syncCanvasSize());

      // Show optimal settings hint
      this.showOptimalSettingsHint();

    } catch (e) {
      console.error(e);
      alert("Init failed: " + e.message);
    }
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
      { baseColor: [0.92, 0.92, 0.90], metallic: 0.02, roughness: 0.48, accent: [0.20, 0.20, 0.22], detail: [30.0, 0.0, 0.06, 0.0] }  // 12 label paint
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

    // Shared cylinder geometry used by rollers, coils, base, stator rings, wiring
    const cylinderData = this.generateCylinder(0.8, 2.5, 64);
    const cylinderVertexBuffer = this.device.createBuffer({
      size: cylinderData.vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(cylinderVertexBuffer, 0, cylinderData.vertices);
    const cylinderIndexBuffer = this.device.createBuffer({
      size: cylinderData.indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(cylinderIndexBuffer, 0, cylinderData.indices);

    this.cylinderBuffer = {
      vertexBuffer: cylinderVertexBuffer,
      indexBuffer: cylinderIndexBuffer,
      indexCount: cylinderData.indices.length
    };
    this.profiler.trackBuffer('shared-cylinder-vertices', cylinderData.vertices.byteLength, GPUBufferUsage.VERTEX);
    this.profiler.trackBuffer('shared-cylinder-indices', cylinderData.indices.byteLength, GPUBufferUsage.INDEX);

    // Enhanced SEG roller with 6 magnetic pole bands
    this.enhancedRollerBuffer = generatePoleBandedRoller(this.device, {
      radius: 0.75, height: 2.8, bands: 6, segments: 64
    });
    this.profiler.trackBuffer('enhanced-roller-vertices', this.enhancedRollerBuffer.vertexBuffer.size, GPUBufferUsage.VERTEX);
    this.profiler.trackBuffer('enhanced-roller-indices', this.enhancedRollerBuffer.indexBuffer.size, GPUBufferUsage.INDEX);

    // Central bearing shaft (replaces sphere)
    this.coreShaftBuffer = generateBearingShaft(this.device, {
      shaftRadius: 0.5, shaftHeight: 3.5, flangeRadius: 1.8,
      topRingRadius: 1.3, segments: 48
    });
    this.profiler.trackBuffer('core-shaft-vertices', this.coreShaftBuffer.vertexBuffer.size, GPUBufferUsage.VERTEX);

    // Magnetic core (simple cylinder with UVs for enhanced pipeline)
    const magnetData = this.generateCylinderWithUVs(0.8, 2.5, 64);
    const magnetVB = this.device.createBuffer({ size: magnetData.vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(magnetVB, 0, magnetData.vertices);
    const magnetIB = this.device.createBuffer({ size: magnetData.indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(magnetIB, 0, magnetData.indices);
    this.coreMagnetBuffer = { vertexBuffer: magnetVB, indexBuffer: magnetIB, indexCount: magnetData.indices.length };

    // Core plate (simple annulus disc with UVs)
    const plateData = this.generateDiscWithUVs(0.8, 6.5, 0.25, 48);
    const plateVB = this.device.createBuffer({ size: plateData.vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(plateVB, 0, plateData.vertices);
    const plateIB = this.device.createBuffer({ size: plateData.indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(plateIB, 0, plateData.indices);
    this.corePlateBuffer = { vertexBuffer: plateVB, indexBuffer: plateIB, indexCount: plateData.indices.length };

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
    const boltRadius = 6.2;
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

    // Connection ring (torus-like using a thin cylinder)
    const ringData = this.generateCylinder(0.15, 0.3, 48);
    const ringVB = this.device.createBuffer({ size: ringData.vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(ringVB, 0, ringData.vertices);
    const ringIB = this.device.createBuffer({ size: ringData.indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(ringIB, 0, ringData.indices);
    this.connectionRingBuffer = { vertexBuffer: ringVB, indexBuffer: ringIB, indexCount: ringData.indices.length };

    // Coil buffer (cylinder drawn without index buffer for instanced rendering)
    this.coilBuffer = {
      vertexBuffer: this.cylinderBuffer.vertexBuffer,
      vertexCount: cylinderData.vertices.length / 6
    };

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
      legCount: 4, legLength: 5.0, baseRadius: 3.0, height: 3.0, segments: 24
    });

    // Wire harnesses (8 wires between coils)
    this.wireBuffers = [];
    const coilCount = 8;
    const coilRadius = 7.5;
    for (let i = 0; i < coilCount; i++) {
      const angle1 = (i / coilCount) * Math.PI * 2;
      const angle2 = ((i + 1) / coilCount) * Math.PI * 2;
      this.wireBuffers.push(generateWireHarness(this.device, {
        start: [Math.cos(angle1) * coilRadius, 0.8, Math.sin(angle1) * coilRadius],
        end: [Math.cos(angle2) * coilRadius, 0.8, Math.sin(angle2) * coilRadius],
        radius: 0.035, sag: 0.4, segments: 16
      }));
    }

    // Coil with windings
    this.coilWindingBuffer = generateCoilWithWindings(this.device, {
      majorRadius: 7.5, minorRadius: 0.6, turns: 60, majorSegments: 96
    });

    // Stator ring cylinder with UVs (for enhanced PBR pipeline)
    const statorCylData = this.generateCylinderWithUVs(1.0, 0.22, 64);
    const statorCylVB = this.device.createBuffer({ size: statorCylData.vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(statorCylVB, 0, statorCylData.vertices);
    const statorCylIB = this.device.createBuffer({ size: statorCylData.indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(statorCylIB, 0, statorCylData.indices);
    this.statorRingUVBuffer = { vertexBuffer: statorCylVB, indexBuffer: statorCylIB, indexCount: statorCylData.indices.length };

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
  
  /**
   * Resize the canvas backing store (DPR-aware) and recreate depth/bloom targets.
   */
  async _syncCanvasSize() {
    this.webgpu.resize();
    if (this.device && this.profiler) {
      await this.setupDepthBuffer();
      if (this.bloomParamsBuffer) {
        this.setupBloomTextures();
      }
    }
  }

  async setupDepthBuffer() {
    if (this.depthTexture) {
      this.profiler.textureAllocations = this.profiler.textureAllocations.filter(t => !t.name.includes('depth'));
      this.depthTexture.destroy();
    }
    this.depthTexture = this.device.createTexture({
      size: [this.canvas.width, this.canvas.height, 1],
      format: 'depth24plus-stencil8',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    });
    // Full aspect for render attachment; depth-only for shader sampling (bloom contact shadow).
    this.depthAttachmentView = this.depthTexture.createView();
    this.depthSampleView = this.depthTexture.createView({ aspect: 'depth-only' });
    this.profiler.trackTexture('depthBuffer', this.canvas.width, this.canvas.height, 'depth24plus-stencil8');
  }

  setupBloomTextures() {
    const w   = this.canvas.width  || 1;
    const h   = this.canvas.height || 1;
    const fmt = navigator.gpu.getPreferredCanvasFormat();

    if (this.bloomSceneTexture) this.bloomSceneTexture.destroy();
    if (this.bloomBlurTexture)  this.bloomBlurTexture.destroy();
    if (this.bloomTempTexture)  this.bloomTempTexture.destroy();

    this.bloomSceneTexture = this.device.createTexture({
      size: [w, h], format: fmt,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    });
    this.bloomBlurTexture = this.device.createTexture({
      size: [w, h], format: fmt,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    });
    this.bloomTempTexture = this.device.createTexture({
      size: [w, h], format: fmt,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
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
  
  render(timestamp) {
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
    // padding at 17-19 (3 floats = 12 bytes)
    globalData[20] = this.camera.camera.position[0];  // 20: cameraPos.x
    globalData[21] = this.camera.camera.position[1];  // 21: cameraPos.y
    globalData[22] = this.camera.camera.position[2];  // 22: cameraPos.z
    // padding at 23 (1 float = 4 bytes)
    
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

    // Upload lighting data for enhanced PBR shaders
    const lightingData = new Float32Array(48);
    lightingData[0] = key.position[0]; lightingData[1] = key.position[1]; lightingData[2] = key.position[2]; lightingData[3] = 0;
    lightingData[4] = key.color[0]; lightingData[5] = key.color[1]; lightingData[6] = key.color[2]; lightingData[7] = key.intensity;
    lightingData[8] = fill.position[0]; lightingData[9] = fill.position[1]; lightingData[10] = fill.position[2]; lightingData[11] = 0;
    lightingData[12] = fill.color[0]; lightingData[13] = fill.color[1]; lightingData[14] = fill.color[2]; lightingData[15] = fill.intensity;
    lightingData[16] = rim.position[0]; lightingData[17] = rim.position[1]; lightingData[18] = rim.position[2]; lightingData[19] = 0;
    lightingData[20] = rim.color[0]; lightingData[21] = rim.color[1]; lightingData[22] = rim.color[2]; lightingData[23] = rim.intensity;
    lightingData[24] = ground.position[0]; lightingData[25] = ground.position[1]; lightingData[26] = ground.position[2]; lightingData[27] = 0;
    lightingData[28] = ground.color[0]; lightingData[29] = ground.color[1]; lightingData[30] = ground.color[2]; lightingData[31] = ground.intensity;
    lightingData[32] = 0.3;  // ambient
    lightingData[33] = 0.5;  // envMapStrength
    this.device.queue.writeBuffer(this.lightingUniformBuffer, 0, lightingData);

    // Update devices with quality scaling
    const qualityScale = this.profiler.qualityLevel;
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

    // SEG-specific compute: roller kinematics + field line advection
    // These run first so rendering reads the freshly updated buffers.
    const segDevice = this.devices['seg'];
    if (segDevice && this.devicesEnabled['seg']) {
      if (segDevice.rollerComputePipeline && segDevice.rollerComputeBindGroup) {
        computePass.setPipeline(segDevice.rollerComputePipeline);
        computePass.setBindGroup(0, segDevice.rollerComputeBindGroup);
        computePass.dispatchWorkgroups(1);  // 1 workgroup × 64 threads, 36 active
      }
      if (segDevice.fieldAdvectPipeline && segDevice.fieldAdvectBindGroup) {
        computePass.setPipeline(segDevice.fieldAdvectPipeline);
        computePass.setBindGroup(0, segDevice.fieldAdvectBindGroup);
        const fieldWorkgroups = Math.ceil(segDevice.fieldLineCount / 64);
        computePass.dispatchWorkgroups(fieldWorkgroups);  // 19 workgroups × 64 = 1216 threads
      }
      // RK4 flux line tracer: 2 workgroups × 64 threads = 128 threads, 108 active.
      // Each thread traces one complete bidirectional flux line (100 RK4 steps).
      // Skipped at low quality to preserve frame budget on weaker GPUs.
      if (segDevice.fluxTracerPipeline && segDevice.fluxTracerBindGroup &&
          this.profiler.qualityLevel > 0.4) {
        computePass.setPipeline(segDevice.fluxTracerPipeline);
        computePass.setBindGroup(0, segDevice.fluxTracerBindGroup);
        computePass.dispatchWorkgroups(2);  // ceil(108 / 64) = 2
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
    
    renderPass.end();

    // ── Bloom post-processing ─────────────────────────────────────────────
    if (this.bloomExtractPipeline && this.bloomBlurPipeline && this.bloomCompositePipeline &&
        this.bloomSceneTexture && this.bloomBlurTexture && this.bloomTempTexture && this.depthTexture) {
      // Update bloom parameters dynamically based on current speed
      if (this.bloomParamsBuffer) {
        const w = this.canvas.width || 1;
        const h = this.canvas.height || 1;
        const speedEnergy = Math.min(1.0, this.simRateController.speedMult / 20.0);
        const energy = Math.min(1.0, Math.max(speedEnergy, this.globalEnergyLevel));
        const energyPow = Math.pow(energy, 1.35);
        this.device.queue.writeBuffer(
          this.bloomParamsBuffer, 0,
          new Float32Array([
            1.0 / w,
            1.0 / h,
            Math.max(0.20, this.simRateController.bloomThreshold - energyPow * 0.18),
            Math.max(0.08, this.simRateController.bloomThreshold * (0.18 + energy * 0.10)),
            this.simRateController.bloomStrength * (1.0 + energyPow * 0.9),
            1.3 + energyPow * 3.6,
            energyPow,
            0.010 + energyPow * 0.045,
            0.010 + energyPow * 0.040,
            0.08 + energyPow * 0.52,
            0.0,
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
          { binding: 4, resource: this.depthSampleView }
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
}
