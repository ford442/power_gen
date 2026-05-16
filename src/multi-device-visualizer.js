import { MultiDeviceShaders } from './multi-device-shaders.js';
import { MultiDeviceCamera } from './multi-device-camera.js';

class MultiDeviceVisualizer {
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

    this.currentView = 'overview';
    this.devicesEnabled = { seg: true, heron: true, kelvin: true, solar: true, peltier: true };
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

      // Initialize profiler
      this.profiler = new PerformanceProfiler(this.webgpu.device, this.canvas);
      await this.profiler.init();

      // Initialize debug panel
      this.debugPanel = new DebugPanel(this.profiler);
      
      // Initialize multi-device camera controller (for view transitions and matrix math)
      // Note: MultiDeviceCamera focuses on view transitions and matrix operations only.
      // Input handling is delegated to CameraController.setupInteraction() below.
      this.cameraController = new MultiDeviceCamera(this.canvas, this.camera, this);

      this.camera.setupInteraction(this.canvas, (mode) => this.switchMode(mode));

      await this.setupSharedGeometry();
      await this.setupDevices();
      await this.setupEnergyPipes();
      await this.setupFloorGrid();

      // Track initial allocations
      this.profiler.trackBuffer('globalUniforms', 256, GPUBufferUsage.UNIFORM);

      // Create lighting uniform buffer for enhanced PBR shaders (192 bytes)
      this.lightingUniformBuffer = this.device.createBuffer({
        size: 192,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      });
      this.profiler.trackBuffer('lightingUniforms', 192, GPUBufferUsage.UNIFORM);

      this.render(0);

      window.addEventListener('resize', () => this.webgpu.resize());

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
  
  // ... [Rest of the MultiDeviceVisualizer methods remain the same]
  // Setup methods, camera methods, rendering loop, etc.
  
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
      { from: 'peltier', to: 'solar', speed: 2.2 }
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
    // Shared cylinder geometry used by rollers, coils, base, stator rings, wiring
    const cylinderData = this.generateCylinder(0.8, 2.5, 32);
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

    // Import enhanced geometry generators
    const {
      generateBearingShaft, generatePoleBandedRoller, generatePlateWithCutouts,
      generateSupportStand, generateWireHarness, generateCoilWithWindings
    } = await import('./src/seg-enhanced-geometry.js');

    // Enhanced SEG roller with 6 magnetic pole bands
    this.enhancedRollerBuffer = generatePoleBandedRoller(this.device, {
      radius: 0.75, height: 2.8, bands: 6, segments: 32
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
    const magnetData = this.generateCylinderWithUVs(0.8, 2.5, 32);
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
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(this.coreBoltInstanceBuffer, 0, new Float32Array(boltInstanceData));

    // Connection ring (torus-like using a thin cylinder)
    const ringData = this.generateCylinder(0.15, 0.3, 32);
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
      depthStencil: { depthWriteEnabled: false, depthCompare: 'less', format: 'depth24plus' }
    });
    
    const gridVertices = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);
    this.gridVertexBuffer = this.device.createBuffer({
      size: gridVertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(this.gridVertexBuffer, 0, gridVertices);
    this.profiler.trackBuffer('gridVertices', gridVertices.byteLength, GPUBufferUsage.VERTEX);
  }
  
  resize() {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
    if (this.device) this.setupDepthBuffer();
  }
  
  async setupDepthBuffer() {
    if (this.depthTexture) {
      this.profiler.textureAllocations = this.profiler.textureAllocations.filter(t => !t.name.includes('depth'));
      this.depthTexture.destroy();
    }
    this.depthTexture = this.device.createTexture({
      size: [this.canvas.width, this.canvas.height, 1],
      format: 'depth24plus',
      usage: GPUTextureUsage.RENDER_ATTACHMENT
    });
    this.profiler.trackTexture('depthBuffer', this.canvas.width, this.canvas.height, 'depth24plus');
  }
  
  render(timestamp) {
    const deltaTime = (timestamp - this.lastFrameTime) / 1000;
    this.lastFrameTime = timestamp;
    
    if (timestamp % 500 < 20) {
      this.fps = Math.round(1 / (deltaTime || 0.016));
      const fpsEl = document.getElementById('fps');
      if (fpsEl) fpsEl.textContent = this.fps;
    }
    
    const speed = parseFloat(document.getElementById('speedSlider')?.value) || 1.0;
    this.time += deltaTime * speed;

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
    globalData[20] = this.camera.position[0];       // 20: cameraPos.x
    globalData[21] = this.camera.position[1];       // 21: cameraPos.y
    globalData[22] = this.camera.position[2];       // 22: cameraPos.z
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
    
    // Begin command encoding
    const encoder = this.device.createCommandEncoder();
    
    // ─── COMPUTE PASS: animate particles on GPU ───
    const computePass = encoder.beginComputePass({ label: 'particle-compute' });
    for (const device of Object.values(this.devices)) {
      if (this.devicesEnabled[device.id] && device.computePipeline && device.computeBindGroup) {
        // Write compute uniforms: time, mode, particleCount, speedMult
        const modeIndex = device.id === 'heron' ? 1.0 : (device.id === 'kelvin' ? 2.0 : (device.id === 'solar' ? 3.0 : (device.id === 'peltier' ? 4.0 : 0.0)));
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
    
    // Write start timestamp if enabled
    if (this.profiler.timingEnabled) {
      encoder.writeTimestamp(this.profiler.timestampQuerySet, 0);
    }
    
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
    
    // Render grid
    console.log('Setting grid pipeline, has depthStencil:', !!this.gridPipeline);
    renderPass.setPipeline(this.gridPipeline);
    renderPass.setBindGroup(0, this.device.createBindGroup({
      layout: this.gridPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.globalUniformBuffer } }]
    }));
    renderPass.setVertexBuffer(0, this.gridVertexBuffer);
    renderPass.draw(6);
    
    // Render devices (scaled by quality)
    const scaledQuality = this.profiler.qualityLevel;
    for (const device of Object.values(this.devices)) {
      if (this.devicesEnabled[device.id]) {
        // Skip field lines if quality is low
        const skipEffects = scaledQuality < 0.5 && device.id === 'seg';
        device.render(renderPass, this.globalUniformBuffer, skipEffects);
      }
    }
    
    renderPass.end();
    
    // Write end timestamp
    if (this.profiler.timingEnabled) {
      encoder.writeTimestamp(this.profiler.timestampQuerySet, 1);
    }
    
    this.device.queue.submit([encoder.finish()]);
    
    // Resolve timestamps asynchronously
    if (this.profiler.timingEnabled) {
      this.profiler.resolveTimestamps().catch(() => {});
    }
    
    requestAnimationFrame((t) => this.render(t));
  }
}
