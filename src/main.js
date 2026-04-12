import rollerShaderCode from './shaders/roller.wgsl?raw';
import particleShaderCode from './shaders/particles.wgsl?raw';
import computeShaderCode from './shaders/compute.wgsl?raw';
import { SEGIntegrationManager } from './integration';
import { ValidatedConstants } from './ValidatedConstants';

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

    this.mode = 'seg';
    this.particleCount = 10000;
    this.time = 0;
    this.lastFrameTime = 0;
    this.fps = 60;
    this.indexCount = 0;

    // Solar mode battery simulation (0.0..1.0)
    this.batteryCharge = 0.5;

    this.camera = { distance: 20, rotation: 0, height: 3 };

    // Dashboard / device state
    this.isRunning = false;
    this.rotationSpeed = 0;   // current smoothed speed (0–100)
    this.targetSpeed = 0;     // desired speed set by slider
    this.magneticFieldStrength = 0.5;
    this.loadResistance = 100;
    this.totalEnergy = 0;

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
    const cylinderData = this.generateCylinder(0.8, 2.5, 32);
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

    // ── SEG: core iron hub (sphere) ──────────────────────────────────────────
    const coreData = this.generateSphere(1.2, 32, 24);
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

  updateParticles() {
    const particleData = new Float32Array(this.particleCount * 4);

    for (let i = 0; i < this.particleCount; i++) {
      const theta = Math.random() * Math.PI * 2;
      const r = 2 + Math.random() * 4;
      const y = (Math.random() - 0.5) * 6;

      particleData[i * 4] = r * Math.cos(theta);
      particleData[i * 4 + 1] = y;
      particleData[i * 4 + 2] = r * Math.sin(theta);
      particleData[i * 4 + 3] = Math.random();
    }

    if (this.particleBuffer) this.particleBuffer.destroy();

    this.particleBuffer = this.device.createBuffer({
      size: particleData.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(this.particleBuffer, 0, particleData);
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
          arrayStride: 16,
          stepMode: 'instance',   // one particle record (xyz + phase) per instance
          attributes: [
            { shaderLocation: 0, offset: 0,  format: 'float32x3' },
            { shaderLocation: 1, offset: 12, format: 'float32'   }
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
    this.deviceUniformBuffer = this.device.createBuffer({
      size: 16,  // f32 renderMode + vec3f padding
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    // Initialize with renderMode = 0 (rollers)
    this.device.queue.writeBuffer(this.deviceUniformBuffer, 0, new Float32Array([0, 0, 0, 0]));

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

    const modeMap = { seg: 0.0, heron: 1.0, kelvin: 2.0, solar: 3.0 };
    
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
    data[20] = physicsData[0];  // maxFieldMagnitude
    data[21] = physicsData[1];  // avgEnergyDensity
    data[22] = physicsData[2];  // torque
    data[23] = physicsData[3];  // physics timestamp

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

    // Smoothly accelerate / decelerate toward targetSpeed
    if (!this.isRunning) {
      // Decelerate at 50 speed-units/second (full stop from 100% in ~2 s)
      this.rotationSpeed = Math.max(0, this.rotationSpeed - deltaTime * 50);
      if (this.rotationSpeed === 0) {
        const statusEl = document.getElementById('status');
        if (statusEl.textContent === 'STOPPING') {
          statusEl.textContent = 'STANDBY';
          statusEl.style.color = '#00d4ff';
          document.getElementById('statusDot').className = 'status-indicator status-standby';
        }
      }
    } else {
      // Exponential ramp: close ~86% of the gap each second (factor 2)
      const diff = this.targetSpeed - this.rotationSpeed;
      this.rotationSpeed += diff * deltaTime * 2;
    }

    // Map 0–100 speed to 0.0–5.0 shader speed
    const shaderSpeed = (this.rotationSpeed / 100) * 5.0;
    this.time += deltaTime * shaderSpeed;

    if (this.mode === 'solar') {
      const ledDrain = 0.18;
      const solarGain = 0.3 + 0.2 * Math.sin(this.time * 2.0);
      this.batteryCharge = Math.min(1.0, Math.max(0.0, this.batteryCharge + (solarGain - ledDrain) * deltaTime));
    } else {
      this.batteryCharge += (0.5 - this.batteryCharge) * deltaTime * 0.5;
    }

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

    // Render pass
    const encoder = this.device.createCommandEncoder();
    const renderPass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
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

    const renderBindGroup = this.device.createBindGroup({
      layout: this.renderPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
        { binding: 2, resource: { buffer: this.instanceBuffer } },
        { binding: 3, resource: { buffer: this.materialBuffer } }
      ]
    });

    const particleBindGroup = this.device.createBindGroup({
      layout: this.particlePipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }]
    });

    renderPass.setPipeline(this.renderPipeline);
    renderPass.setBindGroup(0, renderBindGroup);

    if (this.mode === 'seg') {
      // ── SEG: ring plates → rollers → core hub → outer coil ──────────────
      // Ring plates use firstInstance offsets 68–71 (pass-through in shader)
      for (let p = 0; p < 4; p++) {
        renderPass.setVertexBuffer(0, this.segPlateVertexBuffers[p]);
        renderPass.setIndexBuffer(this.segPlateIndexBuffers[p], 'uint16');
        renderPass.drawIndexed(this.segPlateIndexCounts[p], 1, 0, 0, 68 + p);
      }
      // 66 rollers (instances 0–65)
      renderPass.setVertexBuffer(0, this.vertexBuffer);
      renderPass.setIndexBuffer(this.indexBuffer, 'uint16');
      renderPass.drawIndexed(this.indexCount, 66);
      // Core sphere (firstInstance 66 → pass-through)
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

    renderPass.end();
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
  if (visualizer) visualizer.mode = mode;
  document.querySelectorAll('.mode-btn').forEach(btn => btn.classList.remove('active'));
  document.getElementById('btn-' + mode).classList.add('active');

  const descriptions = {
    seg:    "Searl Effect Generator: 12 magnetic rollers in toroidal formation with spiral energy flux converging toward centre.",
    heron:  "Heron's Fountain: Fluid dynamics with siphon-driven water jets. Particles simulate hydraulic pressure differentials.",
    kelvin: "Kelvin's Thunderstorm: Electrostatic induction with falling water droplets charging conductors.",
    solar:  "LEDs & Solar Cells: LEDs drain a battery while shining on solar panels that recharge it. Watch the charge level change."
  };

  document.getElementById('info').textContent = descriptions[mode];

  const modeLabel = mode.toUpperCase();
  const modeLabelEl = document.getElementById('modeLabel');
  if (modeLabelEl) modeLabelEl.textContent = modeLabel;
  const modeFooterEl = document.getElementById('modeFooter');
  if (modeFooterEl) modeFooterEl.textContent = modeLabel;
};

window.addEventListener('load', () => {
  visualizer = new SEGVisualizer();
});
