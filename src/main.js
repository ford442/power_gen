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
import { resolveRenderer, exposeRenderer, RENDERER_WEBGPU, RENDERER_WEBGL2 } from './renderers/renderer-selector.js';
import { WebGL2MultiDeviceVisualizer } from './renderers/webgl2/index.js';

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

  generateSphere(radius, segments, rings) {
    const vertices = [], indices = [], normals = [];

    for (let ring = 0; ring <= rings; ring++) {
      const phi = (ring / rings) * Math.PI;
      for (let seg = 0; seg <= segments; seg++) {
        const theta = (seg / segments) * Math.PI * 2;
        const x = Math.sin(phi) * Math.cos(theta) * radius;
        const y = Math.cos(phi) * radius;
        const z = Math.sin(phi) * Math.sin(theta) * radius;

        vertices.push(x, y, z);
        const len = Math.sqrt(x*x + y*y + z*z);
        normals.push(x/len, y/len, z/len);
      }
    }

    for (let ring = 0; ring < rings; ring++) {
      for (let seg = 0; seg < segments; seg++) {
        const a = ring * (segments + 1) + seg;
        const b = a + 1;
        const c = a + segments + 1;
        const d = c + 1;

        indices.push(a, c, b);
        indices.push(b, c, d);
      }
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

  generateTorus(majorRadius, minorRadius, majorSegments, minorSegments) {
    const vertices = [], indices = [], normals = [];

    for (let major = 0; major <= majorSegments; major++) {
      const theta = (major / majorSegments) * Math.PI * 2;
      const cx = Math.cos(theta) * majorRadius;
      const cz = Math.sin(theta) * majorRadius;

      for (let minor = 0; minor <= minorSegments; minor++) {
        const phi = (minor / minorSegments) * Math.PI * 2;
        const x = cx + Math.cos(phi) * Math.cos(theta) * minorRadius;
        const y = Math.sin(phi) * minorRadius;
        const z = cz + Math.cos(phi) * Math.sin(theta) * minorRadius;

        vertices.push(x, y, z);
        const nx = Math.cos(phi) * Math.cos(theta);
        const ny = Math.sin(phi);
        const nz = Math.cos(phi) * Math.sin(theta);
        normals.push(nx, ny, nz);
      }
    }

    for (let major = 0; major < majorSegments; major++) {
      for (let minor = 0; minor < minorSegments; minor++) {
        const a = major * (minorSegments + 1) + minor;
        const b = a + 1;
        const c = a + minorSegments + 1;
        const d = c + 1;

        indices.push(a, c, b);
        indices.push(b, c, d);
      }
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

  // Flat horizontal ring disc (annulus) with top + bottom faces + inner/outer sides.
  // innerRadius == 0 gives a full disc with a tiny centre hole (degenerate-safe).
  generateRingDisc(innerRadius, outerRadius, segments = 64, thickness = 0.10) {
    const verts = [];
    const inds  = [];
    const h = thickness / 2;
    const inner = Math.max(innerRadius, 0.01);

    for (let i = 0; i <= segments; i++) {
      const theta = (i / segments) * Math.PI * 2;
      const c = Math.cos(theta), s = Math.sin(theta);
      // top face (normal up)
      verts.push(c * inner,  h, s * inner,  0, 1, 0);
      verts.push(c * outerRadius, h, s * outerRadius, 0, 1, 0);
      // bottom face (normal down)
      verts.push(c * inner, -h, s * inner,  0, -1, 0);
      verts.push(c * outerRadius, -h, s * outerRadius, 0, -1, 0);
      // outer side (normal outward)
      verts.push(c * outerRadius,  h, s * outerRadius, c, 0, s);
      verts.push(c * outerRadius, -h, s * outerRadius, c, 0, s);
      // inner side (normal inward)
      verts.push(c * inner,  h, s * inner, -c, 0, -s);
      verts.push(c * inner, -h, s * inner, -c, 0, -s);
    }
    // 8 vertices per angular step
    for (let i = 0; i < segments; i++) {
      const b = i * 8, n = (i + 1) * 8;
      // top quad
      inds.push(b,     n,     b + 1, b + 1, n,     n + 1);
      // bottom quad (reversed winding)
      inds.push(b + 2, b + 3, n + 2, n + 2, b + 3, n + 3);
      // outer side
      inds.push(b + 4, b + 5, n + 4, n + 4, b + 5, n + 5);
      // inner side (reversed)
      inds.push(b + 6, n + 6, b + 7, b + 7, n + 6, n + 7);
    }
    return { vertices: new Float32Array(verts), indices: new Uint16Array(inds) };
  }

  // Helper: create a GPU vertex+index buffer pair and return { vb, ib, count }
  _makeGeomBuffers(data) {
    const vb = this.device.createBuffer({
      size: data.vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(vb, 0, data.vertices);
    const ib = this.device.createBuffer({
      size: data.indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(ib, 0, data.indices);
    return { vb, ib, count: data.indices.length };
  }

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
  updateParticles() {
    const n = this.particleCount;
    const d = new Float32Array(n * 8);

    for (let i = 0; i < n; i++) {
      const b = i * 8;
      let px = 0, py = 0, pz = 0, vx = 0, vy = 0, vz = 0, aux = 0;
      const phase = Math.random();

      if (this.mode === 'seg') {
        const ring = i % 3;
        const R = ring === 0 ? 3.5 : ring === 1 ? 5.5 : 7.5;
        const a = Math.random() * Math.PI * 2;
        px = Math.cos(a) * R; pz = Math.sin(a) * R;
        py = (Math.random() - 0.5) * 1.6;
        vx = -Math.sin(a) * 1.0; vz = Math.cos(a) * 1.0;
      } else if (this.mode === 'heron') {
        const a = Math.random() * Math.PI * 2;
        const rr = Math.random() * 0.3;
        px = Math.cos(a) * rr; pz = Math.sin(a) * rr;
        py = 3.6 + Math.random() * 3.8;
        vy = 2.0;
      } else if (this.mode === 'kelvin') {
        const side = (i & 1) ? 1 : -1;
        px = side * 2.5 + (Math.random() - 0.5) * 0.2;
        pz = (Math.random() - 0.5) * 0.2;
        py = -2.0 + Math.random() * 7.0;
        vy = -0.5;
        aux = side * 0.3;
      } else {
        const ledIdx = i % 6;
        const ledX = (ledIdx - 2.5) * 1.6;
        const tx = (Math.random() - 0.5) * 9.0, tz = (Math.random() - 0.5) * 9.0;
        const dx = tx - ledX, dy = 0.05 - 3.5, dz = tz - 1.5;
        const len = Math.hypot(dx, dy, dz) || 1;
        const prog = Math.random();
        px = ledX + dx * prog; py = 3.5 + dy * prog; pz = 1.5 + dz * prog;
        vx = dx / len * 6.0; vy = dy / len * 6.0; vz = dz / len * 6.0;
      }

      d[b] = px; d[b + 1] = py; d[b + 2] = pz; d[b + 3] = phase;
      d[b + 4] = vx; d[b + 5] = vy; d[b + 6] = vz; d[b + 7] = aux;
    }

    if (this.particleBuffer) this.particleBuffer.destroy();

    this.particleBuffer = this.device.createBuffer({
      size: d.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(this.particleBuffer, 0, d);
  }

  // Fresnel reflectance (unpolarised) for an air→substrata interface.
  fresnelR(cosI, n2) {
    const n1 = 1.0;
    const ci = Math.max(0, Math.min(1, cosI));
    const sinI = Math.sqrt(Math.max(0, 1 - ci * ci));
    const sinT = (n1 / n2) * sinI;
    if (sinT >= 1) return 1;
    const ct = Math.sqrt(Math.max(0, 1 - sinT * sinT));
    const rs = (n1 * ci - n2 * ct) / (n1 * ci + n2 * ct);
    const rp = (n1 * ct - n2 * ci) / (n1 * ct + n2 * ci);
    return Math.max(0, Math.min(1, 0.5 * (rs * rs + rp * rp)));
  }

  // Mean transmittance of the six LEDs onto the panel (fixed geometry).
  computeSolarTransmittance() {
    const n2 = ValidatedConstants.SILICON_REFRACTIVE_INDEX;
    let sum = 0;
    for (let i = 0; i < 6; i++) {
      const ledX = (i - 2.5) * 1.6;
      const dx = -ledX, dy = -3.45, dz = -1.5;      // LED → panel centre
      const len = Math.hypot(dx, dy, dz);
      const cosI = Math.abs(dy) / len;              // vs panel normal (+Y)
      sum += 1 - this.fresnelR(cosI, n2);
    }
    return sum / 6;
  }

  // Bernoulli exit velocity reduced by Darcy–Weisbach pipe friction, with the
  // Darcy factor from the explicit Swamee–Jain correlation (no iteration).
  heronExitVelocity(H) {
    if (H <= 1e-3) return 0;
    const g = 9.81, D = 0.02, L = 1.2, eps = 1.5e-6, rho = 1000, mu = 1.0e-3;
    const vIdeal = Math.sqrt(2 * g * H);
    const Re = Math.max(1, rho * vIdeal * D / mu);
    let f;
    if (Re < 2000) {
      f = 64 / Re;                                  // Hagen–Poiseuille (laminar)
    } else {
      const t = Math.log10(eps / (3.7 * D) + 5.74 / Math.pow(Re, 0.9));
      f = 0.25 / (t * t);                           // Swamee–Jain (turbulent)
    }
    // H = (1 + f·L/D)·v²/2g  →  v = sqrt(2gH / (1 + f·L/D))
    return Math.sqrt(2 * g * H / (1 + f * L / D));
  }

  // Advance the global (per-device) ODE state by one clamped step.
  stepPhysics(dt, drive) {
    // ── SEG: rotational kinematics with eddy-current braking ──────────────
    const field = 0.4 + 0.6 * this.magneticFieldStrength;
    const tauDrive = drive * field;                  // Lorentz/Poynting thrust
    const w = this.segOmega;
    const wArm = 2.5, eddyK = 1.33, visc = 0.05, tScale = 2.5;
    const tauEddy = eddyK * w / (1 + w / wArm) + visc * w;  // Lenz + armature rolloff
    this.segOmega = Math.max(0, w + (tauDrive - tauEddy) / (this.rollerHeft * tScale) * dt);
    this.rotationSpeed = Math.min(120, this.segOmega * 100);
    this.corona = Math.max(0, Math.min(1, (this.segOmega - 0.6) / 0.4)) * field;

    // ── Heron: head dynamics + Bernoulli/Swamee–Jain exit velocity ────────
    const pump = 2.2, drain = 0.30;
    this.heronHead = Math.max(0, Math.min(this.heronHeadMax,
      this.heronHead + (pump * drive - drain * this.heronVExit) * dt));
    this.heronVExit = this.heronExitVelocity(this.heronHead);

    // ── Kelvin: capacitive voltage runaway → breakdown spark ──────────────
    const chargeRate = 8000, feedback = 2.0, leak = 0.3;
    this.kelvinV += (drive * (chargeRate + feedback * this.kelvinV) - leak * this.kelvinV) * dt;
    this.kelvinV = Math.max(0, this.kelvinV);
    if (this.kelvinV >= this.kelvinVbreak && this.kelvinSparkTimer <= 0) {
      this.kelvinV *= 0.02;                          // discharge neutralises the buckets
      this.kelvinSparkTimer = this.kelvinSparkDur;
      this.generateLightning();
    }
    this.kelvinSparkTimer = Math.max(0, this.kelvinSparkTimer - dt);
    this.kelvinVoltageN = Math.max(0, Math.min(1, this.kelvinV / this.kelvinVbreak));
    this.kelvinE = 15.0 * this.kelvinVoltageN;        // qE coefficient (levitation near breakdown)

    // ── Solar: Fresnel-gated battery loop ─────────────────────────────────
    if (this.mode === 'solar') {
      const ledPower = 0.3 + 0.7 * drive;
      const gain = this.solarTransmittance * ledPower * 0.45;
      const drainW = ledPower * 0.30;
      this.batteryCharge = Math.max(0, Math.min(1, this.batteryCharge + (gain - drainW) * dt));
    } else {
      this.batteryCharge += (0.5 - this.batteryCharge) * dt * 0.5;
    }
  }

  // Midpoint-displacement fractal bolt between the two spark-gap nodes.
  generateLightning() {
    let pts = [[-1.3, -2.6, 0.0], [1.3, -2.6, 0.0]];
    let amp = 0.9;
    const rough = 0.55;
    for (let it = 0; it < 6; it++) {
      const next = [pts[0]];
      for (let i = 0; i < pts.length - 1; i++) {
        const p = pts[i], q = pts[i + 1];
        const mid = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2];
        mid[1] += (Math.random() - 0.5) * amp;
        mid[2] += (Math.random() - 0.5) * amp;
        next.push(mid, q);
      }
      pts = next;
      amp *= Math.pow(2, -rough);
    }
    const data = new Float32Array(pts.length * 3);
    for (let i = 0; i < pts.length; i++) {
      data[i * 3] = pts[i][0]; data[i * 3 + 1] = pts[i][1]; data[i * 3 + 2] = pts[i][2];
    }
    this.device.queue.writeBuffer(this.lightningBuffer, 0, data);
    this.lightningCount = pts.length;
  }

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

  perspectiveMatrix(fov, aspect, near, far) {
    const f = 1.0 / Math.tan(fov / 2);
    const nf = 1 / (near - far);
    return new Float32Array([
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (far + near) * nf, -1,
      0, 0, 2 * far * near * nf, 0
    ]);
  }

  lookAt(eye, center, up) {
    const z = this.normalize([eye[0] - center[0], eye[1] - center[1], eye[2] - center[2]]);
    const x = this.normalize(this.cross(up, z));
    const y = this.cross(z, x);

    return new Float32Array([
      x[0], y[0], z[0], 0,
      x[1], y[1], z[1], 0,
      x[2], y[2], z[2], 0,
      -this.dot(x, eye), -this.dot(y, eye), -this.dot(z, eye), 1
    ]);
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
  } catch (e) {
    console.warn('[main] MultiDeviceVisualizer failed, falling back to SEGVisualizer:', e);
    if (navigator.gpu) {
      visualizer = new SEGVisualizer();
      exposeRenderer(canvas, RENDERER_WEBGPU);
    } else {
      try {
        window.multiVisualizer = new WebGL2MultiDeviceVisualizer();
        exposeRenderer(canvas, RENDERER_WEBGL2);
      } catch (e2) {
        console.error('[main] All renderers failed:', e2);
        alert('No compatible graphics API (WebGPU or WebGL2).');
      }
    }
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
});
