import rollerShaderCode from './shaders/roller.wgsl?raw';
import particleShaderCode from './shaders/particles.wgsl?raw';
import computeShaderCode from './shaders/compute.wgsl?raw';
import lightningShaderCode from './shaders/lightning.wgsl?raw';
import bloomVertCode from './shaders/bloom.wgsl?raw';
import bloomExtractCode from './shaders/bloom-extract.wgsl?raw';
import bloomCompositeCode from './shaders/bloom-composite.wgsl?raw';
import { SEGIntegrationManager } from './integration';
import { ValidatedConstants } from './ValidatedConstants';
import { SEGSim } from './wasm/sim';
import { MultiDeviceVisualizer } from './multi-device-visualizer.js';

import { SEGVisualizerGeometry } from './app/seg-visualizer-geometry.js';
import { SEGVisualizerMath } from './app/seg-visualizer-physics.js';

class SEGVisualizer {

  constructor() {
    this.canvas = document.getElementById('gpuCanvas');
    this.device = null;
    this.context = null;
    this.renderPipeline = null;
    this.particlePipeline = null;
    this.computePipeline = null;
    this.uniformBuffer = null;
    this.vertexBuffer = null;
    this.indexBuffer = null;
    this.particleBuffer = null;
    this.depthTexture = null;
    // Bloom post-processing
    this.sceneTexture = null;
    this.bloomTexture = null;
    this.bloomSampler = null;
    this.bloomParamsBuffer = null;
    this.bloomExtractPipeline = null;
    this.bloomCompositePipeline = null;
    this.coreVertexBuffer = null;
    this.coreIndexBuffer = null;
    this.coreIndexCount = 0;
    this.coilVertexBuffer = null;
    this.coilIndexBuffer = null;
    this.coilIndexCount = 0;

    // SEG ring-separator plates (4 flat annuli)
    this.segPlateVertexBuffers = [];
    this.segPlateIndexBuffers  = [];
    this.segPlateIndexCounts   = [];

    // SEG orbital stator rings (3 toruses at the 3 roller radii, instances 72–74)
    this.statorRingVertexBuffers = [];
    this.statorRingIndexBuffers  = [];
    this.statorRingIndexCounts   = [];

    // Kelvin induction-ring toruses (small, positioned via firstInstance offset)
    this.kelvinRingVertexBuffer = null;
    this.kelvinRingIndexBuffer  = null;
    this.kelvinRingIndexCount   = 0;

    // Solar panel flat disc
    this.solarPanelVertexBuffer = null;
    this.solarPanelIndexBuffer  = null;
    this.solarPanelIndexCount   = 0;

    // Additional buffers for roller.wgsl shader (bindings 1, 2, 3)
    this.deviceUniformBuffer = null;
    this.instanceBuffer = null;
    this.materialBuffer = null;

    // Lightning bolt (Kelvin discharge)
    this.lightningPipeline = null;
    this.lightningBuffer = null;
    this.lightningCount = 0;

    this.mode = 'seg';
    this.particleCount = 10000;
    this.time = 0;           // ω-scaled roller clock (advances with spin rate)
    this.simClock = 0;       // steady wall clock for shader hashing
    this.dt = 0;             // last clamped physics step (s)
    this.lastFrameTime = 0;
    this.fps = 60;
    this.indexCount = 0;

    // Solar mode battery simulation (0.0..1.0)
    this.batteryCharge = 0.5;

    this.camera = { distance: 20, rotation: 0, height: 3 };
    // Bind extracted methods
    this.generateCylinder = SEGVisualizerGeometry.generateCylinder.bind(this);
    this.generateSphere = SEGVisualizerGeometry.generateSphere.bind(this);
    this.generateTorus = SEGVisualizerGeometry.generateTorus.bind(this);
    this.generateRingDisc = SEGVisualizerGeometry.generateRingDisc.bind(this);
    this._makeGeomBuffers = SEGVisualizerGeometry._makeGeomBuffers.bind(this);
    this.perspectiveMatrix = SEGVisualizerMath.perspectiveMatrix.bind(this);
    this.lookAt = SEGVisualizerMath.lookAt.bind(this);
    this.fresnelR = SEGVisualizerMath.fresnelR.bind(this);
    this.updateParticles = SEGVisualizerMath.updateParticles.bind(this);
    this.computeSolarTransmittance = SEGVisualizerMath.computeSolarTransmittance.bind(this);
    this.heronExitVelocity = SEGVisualizerMath.heronExitVelocity.bind(this);
    this.stepPhysics = SEGVisualizerMath.stepPhysics.bind(this);
    this.generateLightning = SEGVisualizerMath.generateLightning.bind(this);

    // Dashboard / device state
    this.isRunning = false;
    this.rotationSpeed = 0;   // display speed (0–100), derived from segOmega
    this.targetSpeed = 0;     // drive setting from slider
    this.magneticFieldStrength = 0.5;
    this.loadResistance = 100;
    this.totalEnergy = 0;

    // ── Stateful physics integrators ──────────────────────────────────────
    // SEG rotational dynamics: I·ω̇ = τ_drive − τ_eddy. The composite roller's
    // moment of inertia gives the spin-up its "heft"; eddy-current braking
    // (Lenz) yields a self-regulating terminal velocity.
    const roller = ValidatedConstants.computeRollerInertia();
    const rhoCu = 8960, R = ValidatedConstants.SEG_CONFIG.rollerRadius,
          h = ValidatedConstants.SEG_CONFIG.rollerHeight;
    const inertiaSolidCu = 0.5 * Math.PI * rhoCu * h * R * R * R * R;
    this.rollerInertia = roller.inertia;
    this.rollerHeft = roller.inertia / inertiaSolidCu;  // dimensionless
    this.segOmega = 0;        // normalised angular velocity (terminal ≈ 1)
    this.corona = 0;          // plasma-halo intensity 0–1

    // Heron: reservoir head → Bernoulli exit velocity, depleted by outflow.
    this.heronHead = 0;       // m
    this.heronVExit = 0;      // scene units/s
    this.heronHeadMax = 4.5;

    // Kelvin: bucket voltage runaway → dielectric breakdown spark.
    this.kelvinV = 0;         // volts
    this.kelvinSparkTimer = 0;
    this.kelvinSparkDur = 0.18;
    const gap = 0.02;         // m spark gap
    this.kelvinVbreak = ValidatedConstants.KELVIN_CONSTANTS.E_BREAKDOWN.value * gap; // V
    this.kelvinE = 0;         // upward qE accel coefficient
    this.kelvinVoltageN = 0;

    // Solar: Fresnel transmittance of the LED light into the silicon panel.
    this.solarN2 = ValidatedConstants.SILICON_REFRACTIVE_INDEX;
    this.solarTransmittance = this.computeSolarTransmittance();

    // TypeScript integration layer
    this.integration = null;

    this.init();
  }

  async init() {
    if (!navigator.gpu) {
      alert("WebGPU not supported. Use Chrome 113+ or Edge 113+.");
      throw new Error("WebGPU not supported");
    }

    try {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
      if (!adapter) throw new Error("No adapter");

      this.device = await adapter.requestDevice();
      this.context = this.canvas.getContext('webgpu');

      this.resize();
      this.context.configure({
        device: this.device,
        format: navigator.gpu.getPreferredCanvasFormat(),
        alphaMode: 'premultiplied',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
      });

      await this.setupGeometry();
      await this.setupShaders();
      await this.setupComputePipeline();
      await this.setupDepthBuffer();
      await this.setupBloomPipeline();
      this.setupInteraction();
      
      // Initialize TypeScript integration layer
      this.integration = new SEGIntegrationManager(this.device, this.canvas);
      
      this.render(0);

      window.addEventListener('resize', () => this.resize());
    } catch (e) {
      console.error(e);
      alert("Init failed: " + e.message);
    }
  }

  resize() {
    const wrapper = document.getElementById('canvas-wrapper');
    this.canvas.width  = wrapper ? wrapper.clientWidth  : window.innerWidth;
    this.canvas.height = wrapper ? wrapper.clientHeight : window.innerHeight;
    if (this.device) this.setupDepthBuffer();
  }

  async setupDepthBuffer() {
    if (this.depthTexture) this.depthTexture.destroy();
    this.depthTexture = this.device.createTexture({
      size: [this.canvas.width, this.canvas.height, 1],
      format: 'depth24plus',
      usage: GPUTextureUsage.RENDER_ATTACHMENT
    });
    // Recreate HDR/bloom textures whenever the depth buffer is recreated
    this.setupBloomTextures();
  }

  setupBloomTextures() {
    const w = this.canvas.width  || 1;
    const h = this.canvas.height || 1;
    const fmt = navigator.gpu.getPreferredCanvasFormat();

    if (this.sceneTexture) this.sceneTexture.destroy();
    if (this.bloomTexture) this.bloomTexture.destroy();

    this.sceneTexture = this.device.createTexture({
      size: [w, h],
      format: fmt,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    });
    this.bloomTexture = this.device.createTexture({
      size: [w, h],
      format: fmt,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    });

    // Update bloom params with new texel sizes
    if (this.bloomParamsBuffer) {
      this.device.queue.writeBuffer(
        this.bloomParamsBuffer, 0,
        new Float32Array([1.0 / w, 1.0 / h, 0.60, 1.4])
      );
    }
  }

  async setupBloomPipeline() {
    const fmt = navigator.gpu.getPreferredCanvasFormat();
    const vertModule    = this.device.createShaderModule({ code: bloomVertCode });
    const extractModule = this.device.createShaderModule({ code: bloomExtractCode });
    const compModule    = this.device.createShaderModule({ code: bloomCompositeCode });

    this.bloomSampler = this.device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge'
    });

    this.bloomParamsBuffer = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

    // Extract pipeline: sceneTex → bloomTex
    this.bloomExtractPipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex:   { module: vertModule,    entryPoint: 'bloomVertMain' },
      fragment: { module: extractModule, entryPoint: 'bloomExtractFrag',
                  targets: [{ format: fmt }] },
      primitive: { topology: 'triangle-list' }
    });

    // Composite pipeline: (sceneTex + bloomTex) → canvas
    this.bloomCompositePipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex:   { module: vertModule, entryPoint: 'bloomVertMain' },
      fragment: { module: compModule,  entryPoint: 'bloomCompositeFrag',
                  targets: [{ format: fmt }] },
      primitive: { topology: 'triangle-list' }
    });

    this.setupBloomTextures();
  }


  // Flat horizontal ring disc (annulus) with top + bottom faces + inner/outer sides.
  // innerRadius == 0 gives a full disc with a tiny centre hole (degenerate-safe).


  // Helper: create a GPU vertex+index buffer pair and return { vb, ib, count }


  async setupGeometry() {
    // ── Roller cylinders (shared for Heron / Kelvin / Solar structural objects) ─
    const cylinderData = this.generateCylinder(0.8, 2.5, 64);
    this.vertexBuffer = this.device.createBuffer({
      size: cylinderData.vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(this.vertexBuffer, 0, cylinderData.vertices);
    this.indexBuffer = this.device.createBuffer({
      size: cylinderData.indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(this.indexBuffer, 0, cylinderData.indices);
    this.indexCount = cylinderData.indices.length;

    // ── SEG: central stator hub ring disc (replaces sphere) ─────────────────
    // A flat annular disc represents the central stationary ring of the SEG.
    // generateRingDisc(innerRadius, outerRadius, segments, thickness)
    const coreData = this.generateRingDisc(0.35, 2.1, 64, 0.38);
    this.coreVertexBuffer = this.device.createBuffer({
      size: coreData.vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(this.coreVertexBuffer, 0, coreData.vertices);
    this.coreIndexBuffer = this.device.createBuffer({
      size: coreData.indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(this.coreIndexBuffer, 0, coreData.indices);
    this.coreIndexCount = coreData.indices.length;

    // ── SEG: outer electromagnetic coil (large torus) ────────────────────────
    const coilData = this.generateTorus(9.0, 0.5, 64, 16);
    this.coilVertexBuffer = this.device.createBuffer({
      size: coilData.vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(this.coilVertexBuffer, 0, coilData.vertices);
    this.coilIndexBuffer = this.device.createBuffer({
      size: coilData.indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(this.coilIndexBuffer, 0, coilData.indices);
    this.coilIndexCount = coilData.indices.length;

    // ── SEG: 4 ring-separator plates (flat annuli between roller rings) ───────
    // Rollers sit at radii 3.5, 5.5, 7.5 with radius 0.8.
    // Plates fill the gaps: centre hub, and separators between each ring pair.
    const plateSpecs = [
      { inner: 0.2,  outer: 2.55 },   // centre hub plate
      { inner: 4.35, outer: 4.65 },   // separator between inner & middle rings
      { inner: 6.35, outer: 6.65 },   // separator between middle & outer rings
      { inner: 8.15, outer: 9.10 },   // outer pickup-coil backing plate
    ];
    this.segPlateVertexBuffers = [];
    this.segPlateIndexBuffers  = [];
    this.segPlateIndexCounts   = [];
    for (const spec of plateSpecs) {
      const d = this.generateRingDisc(spec.inner, spec.outer, 64, 0.12);
      const { vb, ib, count } = this._makeGeomBuffers(d);
      this.segPlateVertexBuffers.push(vb);
      this.segPlateIndexBuffers.push(ib);
      this.segPlateIndexCounts.push(count);
    }

    // ── SEG: 3 orbital stator rings (thin toruses at the 3 roller radii) ─────
    // Instances 72, 73, 74 – pass-through in vertex shader (>= 66), fragment
    // shader colours them as glowing brass/energy rings.
    // generateTorus(majorRadius, minorRadius=0.14, majorSegments=80, minorSegments=14)
    this.statorRingVertexBuffers = [];
    this.statorRingIndexBuffers  = [];
    this.statorRingIndexCounts   = [];
    for (const r of [3.5, 5.5, 7.5]) {
      const d = this.generateTorus(r, 0.14, 80, 14);
      const { vb, ib, count } = this._makeGeomBuffers(d);
      this.statorRingVertexBuffers.push(vb);
      this.statorRingIndexBuffers.push(ib);
      this.statorRingIndexCounts.push(count);
    }

    // ── Kelvin: small induction-ring toruses (radius 1.0, minor 0.14) ────────
    const kelvinRingData = this.generateTorus(1.0, 0.14, 48, 14);
    const kr = this._makeGeomBuffers(kelvinRingData);
    this.kelvinRingVertexBuffer = kr.vb;
    this.kelvinRingIndexBuffer  = kr.ib;
    this.kelvinRingIndexCount   = kr.count;

    // ── Solar: flat panel disc (radius 5.5, thin) ─────────────────────────────
    const solarPanelData = this.generateRingDisc(0.05, 5.5, 64, 0.06);
    const sp = this._makeGeomBuffers(solarPanelData);
    this.solarPanelVertexBuffer = sp.vb;
    this.solarPanelIndexBuffer  = sp.ib;
    this.solarPanelIndexCount   = sp.count;

    this.updateParticles();
  }

  // Each particle is a stateful record of 8 floats:
  //   [0..2] position   [3] phase seed   [4..6] velocity   [7] aux scalar
  // Seeds are mode-aware so the streams look settled within a frame or two;
  // the compute shader then carries them statefully and recycles them.


  // Fresnel reflectance (unpolarised) for an air→substrata interface.


  // Mean transmittance of the six LEDs onto the panel (fixed geometry).


  // Bernoulli exit velocity reduced by Darcy–Weisbach pipe friction, with the
  // Darcy factor from the explicit Swamee–Jain correlation (no iteration).


  // Advance the global (per-device) ODE state by one clamped step.


  // Midpoint-displacement fractal bolt between the two spark-gap nodes.


  // Switch device: reset the entering device's accumulators and re-seed the
  // particle buffer (velocity/aux semantics differ per mode).
  onModeChange(mode) {
    this.mode = mode;
    this.heronHead = 0; this.heronVExit = 0;
    this.kelvinV = 0; this.kelvinSparkTimer = 0; this.kelvinVoltageN = 0; this.kelvinE = 0;
    this.lightningCount = 0;
    if (mode === 'solar') this.batteryCharge = 0.4;
    if (this.device) this.updateParticles();   // buffer re-seeded once GPU is ready
  }

  async setupShaders() {
    this.renderPipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: this.device.createShaderModule({ code: rollerShaderCode }),
        entryPoint: 'vertexMain',
        buffers: [{
          arrayStride: 24,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' },
            { shaderLocation: 1, offset: 12, format: 'float32x3' }
          ]
        }]
      },
      fragment: {
        module: this.device.createShaderModule({ code: rollerShaderCode }),
        entryPoint: 'fragmentMain',
        targets: [{
          format: navigator.gpu.getPreferredCanvasFormat(),
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }
          }
        }]
      },
      primitive: { topology: 'triangle-list', cullMode: 'back' },
      depthStencil: { depthWriteEnabled: true, depthCompare: 'less', format: 'depth24plus' }
    });

    this.particlePipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: this.device.createShaderModule({ code: particleShaderCode }),
        entryPoint: 'vertexMain',
        buffers: [{
          arrayStride: 32,
          stepMode: 'instance',   // one particle record (pos, phase, vel, aux) per instance
          attributes: [
            { shaderLocation: 0, offset: 0,  format: 'float32x3' },  // position
            { shaderLocation: 1, offset: 12, format: 'float32'   },  // phase
            { shaderLocation: 2, offset: 16, format: 'float32x3' },  // velocity
            { shaderLocation: 3, offset: 28, format: 'float32'   }   // aux
          ]
        }]
      },
      fragment: {
        module: this.device.createShaderModule({ code: particleShaderCode }),
        entryPoint: 'fragmentMain',
        targets: [{
          format: navigator.gpu.getPreferredCanvasFormat(),
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }
          }
        }]
      },
      primitive: { topology: 'triangle-strip' },
      depthStencil: { depthWriteEnabled: false, depthCompare: 'less', format: 'depth24plus' }
    });

    this.uniformBuffer = this.device.createBuffer({
      size: 384,  // Increased to accommodate physics uniforms
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

    // Create additional buffers required by roller.wgsl shader
    // Binding 1: DeviceUniforms (renderMode + padding)
    // Must be at least 32 bytes (WebGPU minimum uniform buffer binding size)
    this.deviceUniformBuffer = this.device.createBuffer({
      size: 32,  // 8 floats = 32 bytes (f32 renderMode + 7 floats padding)
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    // Initialize with renderMode = 0 (rollers)
    this.device.queue.writeBuffer(this.deviceUniformBuffer, 0, new Float32Array([0, 0, 0, 0, 0, 0, 0, 0]));

    // Binding 2: InstanceData storage buffer (position + data0 for each instance)
    // Max 256 instances (rollers + special geometry)
    this.instanceBuffer = this.device.createBuffer({
      size: 256 * 16,  // 256 instances * (vec3f position + f32 data0)
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    // Initialize with zeroes
    this.device.queue.writeBuffer(this.instanceBuffer, 0, new Float32Array(256 * 4));

    // Binding 3: MaterialData storage buffer (color + emissive for each material)
    // 8 materials should be enough
    this.materialBuffer = this.device.createBuffer({
      size: 8 * 16,  // 8 materials * (vec3f color + f32 emissive)
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    // Initialize with default copper color
    const defaultMaterial = new Float32Array([
      0.85, 0.48, 0.25, 0.0,  // copper color, no emissive
      0.75, 0.45, 0.25, 0.0,  // wiring copper
      0.08, 0.08, 0.12, 0.0,  // base black
      0.85, 0.48, 0.25, 1.0,  // copper with emissive
      0.22, 0.22, 0.28, 0.0,  // core iron
      0.55, 0.30, 0.08, 1.0,  // coil
      0.62, 0.68, 0.76, 0.0,  // silver
      0.05, 0.09, 0.25, 0.0   // solar cell
    ]);
    this.device.queue.writeBuffer(this.materialBuffer, 0, defaultMaterial);

    // ── Lightning bolt pipeline (Kelvin discharge) ──────────────────────────
    const lightningModule = this.device.createShaderModule({ code: lightningShaderCode });
    this.lightningPipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: lightningModule,
        entryPoint: 'vertexMain',
        buffers: [{
          arrayStride: 12,
          attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }]
        }]
      },
      fragment: {
        module: lightningModule,
        entryPoint: 'fragmentMain',
        targets: [{
          format: navigator.gpu.getPreferredCanvasFormat(),
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }
          }
        }]
      },
      primitive: { topology: 'line-strip' },
      depthStencil: { depthWriteEnabled: false, depthCompare: 'always', format: 'depth24plus' }
    });
    // Up to 2^7 + 1 points from 7 midpoint-displacement iterations
    this.lightningBuffer = this.device.createBuffer({
      size: 160 * 12,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
    });
  }

  async setupComputePipeline() {
    this.computePipeline = this.device.createComputePipeline({
      layout: 'auto',
      compute: {
        module: this.device.createShaderModule({ code: computeShaderCode }),
        entryPoint: 'main'
      }
    });
  }

  setupInteraction() {
    let isDragging = false, lastX = 0, lastY = 0;

    // Camera controls
    this.canvas.addEventListener('mousedown', (e) => { isDragging = true; lastX = e.clientX; lastY = e.clientY; });
    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      this.camera.rotation += (e.clientX - lastX) * 0.01;
      this.camera.height = Math.max(-5, Math.min(10, this.camera.height - (e.clientY - lastY) * 0.02));
      lastX = e.clientX; lastY = e.clientY;
    });
    window.addEventListener('mouseup', () => isDragging = false);
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.camera.distance = Math.max(5, Math.min(20, this.camera.distance + e.deltaY * 0.01));
    });

    // Dashboard: START button
    document.getElementById('startBtn').addEventListener('click', () => {
      this.isRunning = true;
      this.targetSpeed = parseInt(document.getElementById('speedControl').value);
      document.getElementById('status').textContent = 'OPERATIONAL';
      document.getElementById('status').style.color = '#00ff88';
      document.getElementById('statusDot').className = 'status-indicator status-active';
    });

    // Dashboard: STOP button
    document.getElementById('stopBtn').addEventListener('click', () => {
      this.isRunning = false;
      this.targetSpeed = 0;
      document.getElementById('status').textContent = 'STOPPING';
      document.getElementById('status').style.color = '#ffaa00';
      document.getElementById('statusDot').className = 'status-indicator status-inactive';
    });

    // Dashboard: speed slider
    document.getElementById('speedControl').addEventListener('input', (e) => {
      document.getElementById('speedVal').textContent = e.target.value;
      if (this.isRunning) this.targetSpeed = parseInt(e.target.value);
    });

    // Dashboard: magnetic field slider
    document.getElementById('fieldControl').addEventListener('input', (e) => {
      document.getElementById('fieldVal').textContent = e.target.value;
      this.magneticFieldStrength = parseInt(e.target.value) / 100;
    });

    // Dashboard: load resistance slider
    document.getElementById('loadControl').addEventListener('input', (e) => {
      document.getElementById('loadVal').textContent = e.target.value;
      this.loadResistance = parseInt(e.target.value);
    });

    // Particle count slider
    document.getElementById('particleSlider').addEventListener('input', (e) => {
      const count = parseInt(e.target.value);
      document.getElementById('particleVal').textContent = count;
      if (count !== this.particleCount) {
        this.particleCount = count;
        this.updateParticles();
      }
    });
  }

  updateReadings(deltaTime) {
    // speed 0–100 → 0–3000 RPM for the inner ring
    const rpmBase = this.rotationSpeed * 30;
    document.getElementById('rpm-inner').textContent = Math.round(rpmBase).toLocaleString();

    // Simulated electrical output: voltage ∝ speed × field, current = V/R, power = V×I
    const voltage = this.rotationSpeed * this.magneticFieldStrength * 2.5;
    const current = voltage / this.loadResistance;
    const power   = voltage * current;

    document.getElementById('voltage').textContent = voltage.toFixed(3) + ' V';
    document.getElementById('current').textContent = current.toFixed(3) + ' A';
    document.getElementById('power').textContent   = power.toFixed(3)   + ' W';

    // Field grows slightly with rotation (reluctance reduction)
    const fieldStrength = this.magneticFieldStrength * (1 + this.rotationSpeed / 200);
    document.getElementById('magnetic-field').textContent = fieldStrength.toFixed(3) + ' T';

    // Temperature: 25 °C idle + 0.3 °C per unit speed
    const temp = 25 + this.rotationSpeed * 0.3;
    const tempEl = document.getElementById('temperature');
    tempEl.textContent = temp.toFixed(1) + ' °C';
    const isWarn = temp > 60, isCrit = temp > 80;
    tempEl.className = 'reading-value' + (isCrit ? ' critical' : isWarn ? ' warning' : '');

    // Smooth efficiency: drift toward a target with small noise, base 85–95%
    if (this.rotationSpeed > 0) {
      const target = 85 + (this.rotationSpeed / 100) * 10;
      if (this._efficiency === undefined) this._efficiency = target;
      this._efficiency += (target - this._efficiency) * deltaTime * 2 + (Math.random() - 0.5) * 0.5;
      this._efficiency = Math.max(80, Math.min(95, this._efficiency));
    } else {
      this._efficiency = 0;
    }
    document.getElementById('efficiency').textContent = this._efficiency.toFixed(1) + '%';
    document.getElementById('efficiency-bar').style.width = this._efficiency.toFixed(1) + '%';

    // Accumulate energy: deltaTime is in seconds; divide by 3600 for Wh, by 1000 for kWh
    if (this.isRunning && this.rotationSpeed > 0) {
      this.totalEnergy += power * deltaTime / 3600000;
    }
    document.getElementById('energy').textContent = this.totalEnergy.toFixed(4) + ' kWh';
  }

  updateUniforms() {
    const aspect = this.canvas.width / this.canvas.height;
    const proj = this.perspectiveMatrix(45 * Math.PI / 180, aspect, 0.1, 100);
    const camX = Math.cos(this.camera.rotation) * this.camera.distance;
    const camZ = Math.sin(this.camera.rotation) * this.camera.distance;
    const view = this.lookAt([camX, this.camera.height, camZ], [0, 0, 0], [0, 1, 0]);
    const viewProj = this.multiplyMatrices(proj, view);

    const modeMap = { seg: 0.0, heron: 1.0, kelvin: 2.0, solar: 3.0, mhd: 5.0 };
    
    // Get physics uniforms from integration layer (if available)
    let physicsData = new Float32Array(4);
    if (this.integration) {
      const physicsUniforms = new Float32Array(this.integration.getPhysicsUniforms());
      // Extract key physics values for shader
      physicsData[0] = physicsUniforms[11] || 0.7048;  // maxFieldMagnitude
      physicsData[1] = physicsUniforms[12] || 1.976e6; // avgEnergyDensity
      physicsData[2] = physicsUniforms[9] || 1.0;      // middleRingTorque
      physicsData[3] = physicsUniforms[14] || 0;       // timestamp
    }
    
    const data = new Float32Array(24);
    data.set(viewProj);
    data[16] = this.time;
    data[17] = modeMap[this.mode] || 0;
    data[18] = this.particleCount;
    data[19] = this.batteryCharge;
    data[20] = this.dt;
    data[21] = this.segOmega;
    data[22] = this.magneticFieldStrength;
    data[23] = this.heronVExit;
    data[24] = this.heronHead / this.heronHeadMax;
    data[25] = this.kelvinE;
    data[26] = this.kelvinVoltageN;
    data[27] = this.kelvinSparkTimer > 0 ? this.kelvinSparkTimer / this.kelvinSparkDur : 0;
    data[28] = this.solarN2;
    data[29] = this.corona;
    data[30] = this.simClock;
    data[31] = 0;

    this.device.queue.writeBuffer(this.uniformBuffer, 0, data);
  }

  render(timestamp) {
    const deltaTime = (timestamp - this.lastFrameTime) / 1000;
    this.lastFrameTime = timestamp;

    // Update TypeScript integration layer
    if (this.integration) {
      this.integration.update(deltaTime);
    }

    if (timestamp % 500 < 20) {
      this.fps = Math.round(1 / (deltaTime || 0.016));
      document.getElementById('fps').textContent = this.fps;
    }

    // Clamp the physics step so a backgrounded tab can't explode the sim.
    const dt = Math.min(Math.max(deltaTime, 0), 0.033);
    this.dt = dt;
    this.simClock += dt;

    // Drive setting (0–1) from the speed slider, gated by Start/Stop. This
    // sets the SEG drive torque, the Heron pump, the Kelvin charging current
    // and the LED power; the integrators do the rest.
    const drive = (this.isRunning ? this.targetSpeed : 0) / 100;
    this.stepPhysics(dt, drive);

    // Once the rotor has coasted to rest (eddy braking + drag), settle to STANDBY.
    if (!this.isRunning && this.rotationSpeed < 0.5) {
      const statusEl = document.getElementById('status');
      if (statusEl.textContent === 'STOPPING') {
        statusEl.textContent = 'STANDBY';
        statusEl.style.color = '#00d4ff';
        document.getElementById('statusDot').className = 'status-indicator status-standby';
      }
    }

    // The roller geometry spins at the integrated angular velocity, so its
    // visual spin-up inherits the same momentum lag and terminal plateau.
    this.time += dt * this.segOmega * 5.0;

    // Update footer battery display
    const batteryEl = document.getElementById('batteryFooter');
    if (this.mode === 'solar') {
      batteryEl.textContent = Math.round(this.batteryCharge * 100) + '%';
    } else {
      batteryEl.textContent = '--';
    }

    this.updateReadings(deltaTime);
    this.updateUniforms();

    // Compute pass
    const computeEncoder = this.device.createCommandEncoder();
    const computePass = computeEncoder.beginComputePass();
    computePass.setPipeline(this.computePipeline);
    computePass.setBindGroup(0, this.device.createBindGroup({
      layout: this.computePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.particleBuffer } },
        { binding: 1, resource: { buffer: this.uniformBuffer } }
      ]
    }));
    computePass.dispatchWorkgroups(Math.ceil(this.particleCount / 64));
    computePass.end();
    this.device.queue.submit([computeEncoder.finish()]);

    // Render pass — render scene to intermediate sceneTexture (for bloom)
    const encoder = this.device.createCommandEncoder();
    const sceneView = this.sceneTexture ? this.sceneTexture.createView()
                                        : this.context.getCurrentTexture().createView();
    const renderPass = encoder.beginRenderPass({
      colorAttachments: [{
        view: sceneView,
        clearValue: { r: 0.02, g: 0.02, b: 0.05, a: 1 },
        loadOp: 'clear',
        storeOp: 'store'
      }],
      depthStencilAttachment: {
        view: this.depthTexture.createView(),
        depthClearValue: 1.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store'
      }
    });

    // Note: The render pipeline layout only has bindings 0 and 1
    // Bindings 2 and 3 (instanceBuffer, materialBuffer) are defined in shader
    // but may be accessed via storage buffers differently
    const renderBindGroup = this.device.createBindGroup({
      layout: this.renderPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.deviceUniformBuffer } }
      ]
    });

    const particleBindGroup = this.device.createBindGroup({
      layout: this.particlePipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }]
    });

    renderPass.setPipeline(this.renderPipeline);
    renderPass.setBindGroup(0, renderBindGroup);

    if (this.mode === 'seg') {
      // ── SEG: ring plates → stator rings → rollers → central stator → outer coil ──
      // Ring plates use firstInstance offsets 68–71 (pass-through in shader)
      for (let p = 0; p < 4; p++) {
        renderPass.setVertexBuffer(0, this.segPlateVertexBuffers[p]);
        renderPass.setIndexBuffer(this.segPlateIndexBuffers[p], 'uint16');
        renderPass.drawIndexed(this.segPlateIndexCounts[p], 1, 0, 0, 68 + p);
      }
      // 3 orbital stator rings (firstInstance 72, 73, 74 → pass-through)
      for (let r = 0; r < 3; r++) {
        renderPass.setVertexBuffer(0, this.statorRingVertexBuffers[r]);
        renderPass.setIndexBuffer(this.statorRingIndexBuffers[r], 'uint16');
        renderPass.drawIndexed(this.statorRingIndexCounts[r], 1, 0, 0, 72 + r);
      }
      // 66 rollers (instances 0–65)
      renderPass.setVertexBuffer(0, this.vertexBuffer);
      renderPass.setIndexBuffer(this.indexBuffer, 'uint16');
      renderPass.drawIndexed(this.indexCount, 66);
      // Central stator hub disc (firstInstance 66 → pass-through)
      renderPass.setVertexBuffer(0, this.coreVertexBuffer);
      renderPass.setIndexBuffer(this.coreIndexBuffer, 'uint16');
      renderPass.drawIndexed(this.coreIndexCount, 1, 0, 0, 66);
      // Outer electromagnetic coil (firstInstance 67 → pass-through)
      renderPass.setVertexBuffer(0, this.coilVertexBuffer);
      renderPass.setIndexBuffer(this.coilIndexBuffer, 'uint16');
      renderPass.drawIndexed(this.coilIndexCount, 1, 0, 0, 67);

    } else if (this.mode === 'heron') {
      // ── Heron's Fountain: 6 vessel/tube cylinder instances ───────────────
      renderPass.setVertexBuffer(0, this.vertexBuffer);
      renderPass.setIndexBuffer(this.indexBuffer, 'uint16');
      renderPass.drawIndexed(this.indexCount, 6);

    } else if (this.mode === 'kelvin') {
      // ── Kelvin's Thunderstorm: 6 cylinder instances + 2 induction rings ──
      renderPass.setVertexBuffer(0, this.vertexBuffer);
      renderPass.setIndexBuffer(this.indexBuffer, 'uint16');
      renderPass.drawIndexed(this.indexCount, 6);
      // Induction rings (firstInstance 100–101 → translate in shader)
      renderPass.setVertexBuffer(0, this.kelvinRingVertexBuffer);
      renderPass.setIndexBuffer(this.kelvinRingIndexBuffer, 'uint16');
      renderPass.drawIndexed(this.kelvinRingIndexCount, 2, 0, 0, 100);

    } else if (this.mode === 'mhd') {
      // ── MHD Generator: particles-only visualization (molten bismuth channel) ──
      // The bismuth flow and Lorentz deflection are fully represented by particles;
      // no additional geometry is needed.

    } else {
      // ── Solar / LED: panel disc + 7 cylinder instances ────────────────────
      // Solar panel (firstInstance 200 → pass-through)
      renderPass.setVertexBuffer(0, this.solarPanelVertexBuffer);
      renderPass.setIndexBuffer(this.solarPanelIndexBuffer, 'uint16');
      renderPass.drawIndexed(this.solarPanelIndexCount, 1, 0, 0, 200);
      // 6 LEDs + battery (instances 0–6)
      renderPass.setVertexBuffer(0, this.vertexBuffer);
      renderPass.setIndexBuffer(this.indexBuffer, 'uint16');
      renderPass.drawIndexed(this.indexCount, 7);
    }

    // Render particles (all modes)
    renderPass.setPipeline(this.particlePipeline);
    renderPass.setBindGroup(0, particleBindGroup);
    renderPass.setVertexBuffer(0, this.particleBuffer);
    renderPass.draw(4, this.particleCount);

    // Kelvin discharge: emissive fractal bolt during the spark window
    if (this.mode === 'kelvin' && this.kelvinSparkTimer > 0 && this.lightningCount > 1) {
      renderPass.setPipeline(this.lightningPipeline);
      renderPass.setBindGroup(0, this.device.createBindGroup({
        layout: this.lightningPipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }]
      }));
      renderPass.setVertexBuffer(0, this.lightningBuffer);
      renderPass.draw(this.lightningCount);
    }

    renderPass.end();

    // ── Bloom post-processing ─────────────────────────────────────────────
    if (this.bloomExtractPipeline && this.sceneTexture && this.bloomTexture) {
      // Pass 1: extract bright areas from scene → bloomTexture
      const extractPass = encoder.beginRenderPass({
        colorAttachments: [{
          view: this.bloomTexture.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear', storeOp: 'store'
        }]
      });
      extractPass.setPipeline(this.bloomExtractPipeline);
      extractPass.setBindGroup(0, this.device.createBindGroup({
        layout: this.bloomExtractPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.sceneTexture.createView() },
          { binding: 1, resource: this.bloomSampler },
          { binding: 2, resource: { buffer: this.bloomParamsBuffer } }
        ]
      }));
      extractPass.draw(3);
      extractPass.end();

      // Pass 2: composite scene + bloom → canvas with tonemap & vignette
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
          { binding: 0, resource: this.sceneTexture.createView() },
          { binding: 1, resource: this.bloomTexture.createView() },
          { binding: 2, resource: this.bloomSampler },
          { binding: 3, resource: { buffer: this.bloomParamsBuffer } }
        ]
      }));
      compositePass.draw(3);
      compositePass.end();
    }

    this.device.queue.submit([encoder.finish()]);

    requestAnimationFrame((t) => this.render(t));
  }


  normalize(v) {
    const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    return len > 0 ? [v[0] / len, v[1] / len, v[2] / len] : [0, 0, 0];
  }

  cross(a, b) {
    return [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0]
    ];
  }

  dot(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  }

  multiplyMatrices(a, b) {
    const out = new Float32Array(16);
    // col represents the column of the output matrix
    for (let col = 0; col < 4; col++) {
      // row represents the row of the output matrix
      for (let row = 0; row < 4; row++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) {
          // a[k * 4 + row] accesses a's row elements
          // b[col * 4 + k] accesses b's column elements
          sum += a[k * 4 + row] * b[col * 4 + k];
        }
        out[col * 4 + row] = sum;
      }
    }
    return out;
}

let visualizer;

window.setMode = (mode) => {
  // Prefer multi-device visualizer if active, fall back to single-device
  if (window.multiVisualizer) window.multiVisualizer.onModeChange(mode);
  else if (visualizer) visualizer.onModeChange(mode);
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

window.addEventListener('load', () => {
  // MultiDeviceVisualizer is the primary renderer for the multi-device SEG visualization.
  // SEGVisualizer is kept as fallback for single-device mode when multi-device init fails.
  try {
    window.multiVisualizer = new MultiDeviceVisualizer();
  } catch (e) {
    console.warn('[main] MultiDeviceVisualizer failed to construct, falling back to SEGVisualizer:', e);
    visualizer = new SEGVisualizer();
  }
  initWasm();
}
);
