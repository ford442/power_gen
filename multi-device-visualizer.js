class MultiDeviceVisualizer {
  constructor() {
    console.log('MultiDeviceVisualizer v5 starting - depthStencil fix applied');
    this.canvas = document.getElementById('gpuCanvas');

    // Initialize managers
    this.webgpu = new WebGPUManager(this.canvas);
    this.camera = new CameraController();
    this.profiler = null;
    this.debugPanel = null;

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
        module: this.device.createShaderModule({ code: this.gridVertShader }),
        entryPoint: 'main',
        buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] }]
      },
      fragment: {
        module: this.device.createShaderModule({ code: this.gridFragShader }),
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
  
  setupInteraction() {
    let isDragging = false;
    let lastX = 0, lastY = 0;
    
    this.canvas.addEventListener('mousedown', (e) => { isDragging = true; lastX = e.clientX; lastY = e.clientY; });
    
    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const deltaX = (e.clientX - lastX) * 0.01;
      const deltaY = (e.clientY - lastY) * 0.01;
      
      if (this.currentView === 'overview') {
        const dist = Math.sqrt(this.camera.position[0]**2 + this.camera.position[2]**2);
        const angle = Math.atan2(this.camera.position[2], this.camera.position[0]) + deltaX;
        this.camera.position[0] = Math.cos(angle) * dist;
        this.camera.position[2] = Math.sin(angle) * dist;
        this.camera.position[1] = Math.max(2, Math.min(15, this.camera.position[1] - deltaY));
      }
      
      lastX = e.clientX;
      lastY = e.clientY;
    });
    
    window.addEventListener('mouseup', () => isDragging = false);
    
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const zoomSpeed = 0.001;
      const forward = [this.camera.target[0] - this.camera.position[0], this.camera.target[1] - this.camera.position[1], this.camera.target[2] - this.camera.position[2]];
      const len = Math.sqrt(forward[0]**2 + forward[1]**2 + forward[2]**2);
      const dir = [forward[0]/len, forward[1]/len, forward[2]/len];
      const move = e.deltaY * zoomSpeed * len;
      this.camera.position[0] += dir[0] * move;
      this.camera.position[1] += dir[1] * move;
      this.camera.position[2] += dir[2] * move;
    });
    
    window.focusDevice = (deviceId) => { this.focusOnDevice(deviceId); };
    window.showOverview = () => { this.showOverview(); };
    window.toggleDevice = (deviceId) => {
      this.devicesEnabled[deviceId] = !this.devicesEnabled[deviceId];
      const btn = document.getElementById(`toggle-${deviceId}`);
      if (btn) btn.classList.toggle('active', this.devicesEnabled[deviceId]);
    };
    window.toggleDebugPanel = () => { this.debugPanel.toggle(); };
    
    // Keyboard shortcut for debug panel
    window.addEventListener('keydown', (e) => {
      if (e.key === 'F3' || (e.key === 'd' && e.ctrlKey)) {
        e.preventDefault();
        this.debugPanel.toggle();
      }
    });
  }
  
  focusOnDevice(deviceId) {
    const config = DEVICE_CONFIG[deviceId];
    if (!config) return;
    
    this.currentView = deviceId;
    document.getElementById('currentView').textContent = deviceId.toUpperCase();
    
    const devicePos = config.position;
    const offset = config.cameraOffset;
    const rotY = config.rotation[1];
    const cosY = Math.cos(rotY);
    const sinY = Math.sin(rotY);
    const rotatedOffset = [offset[0] * cosY - offset[2] * sinY, offset[1], offset[0] * sinY + offset[2] * cosY];
    const endPos = [devicePos[0] + rotatedOffset[0], devicePos[1] + rotatedOffset[1], devicePos[2] + rotatedOffset[2]];
    
    this.startCameraTransition(endPos, devicePos);
  }
  
  showOverview() {
    this.currentView = 'overview';
    document.getElementById('currentView').textContent = 'Overview';
    this.startCameraTransition([0, 8, 18], [0, 0, 0]);
  }
  
  startCameraTransition(endPos, endTarget) {
    this.camera.transitionActive = true;
    this.camera.transitionStart = performance.now() / 1000;
    this.camera.startPos = [...this.camera.position];
    this.camera.startTarget = [...this.camera.target];
    this.camera.endPos = endPos;
    this.camera.endTarget = endTarget;
  }
  
  updateCamera(deltaTime) {
    if (!this.camera.transitionActive) return;
    
    const now = performance.now() / 1000;
    const elapsed = now - this.camera.transitionStart;
    const t = Math.min(elapsed / this.camera.transitionDuration, 1.0);
    const easeT = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    
    this.camera.position[0] = this.lerp(this.camera.startPos[0], this.camera.endPos[0], easeT);
    this.camera.position[1] = this.lerp(this.camera.startPos[1], this.camera.endPos[1], easeT);
    this.camera.position[2] = this.lerp(this.camera.startPos[2], this.camera.endPos[2], easeT);
    this.camera.target[0] = this.lerp(this.camera.startTarget[0], this.camera.endTarget[0], easeT);
    this.camera.target[1] = this.lerp(this.camera.startTarget[1], this.camera.endTarget[1], easeT);
    this.camera.target[2] = this.lerp(this.camera.startTarget[2], this.camera.endTarget[2], easeT);
    
    if (t >= 1.0) this.camera.transitionActive = false;
  }
  
  lerp(a, b, t) { return a + (b - a) * t; }
  
  getViewProjMatrix() {
    const aspect = this.canvas.width / this.canvas.height;
    const proj = this.perspectiveMatrix(this.camera.fov * Math.PI / 180, aspect, 0.1, 200);
    const view = this.lookAt(this.camera.position, this.camera.target, [0, 1, 0]);
    return this.multiplyMatrices(proj, view);
  }
  
  perspectiveMatrix(fov, aspect, near, far) {
    const f = 1.0 / Math.tan(fov / 2);
    const nf = 1 / (near - far);
    return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
  }
  
  lookAt(eye, center, up) {
    const z = this.normalize([eye[0] - center[0], eye[1] - center[1], eye[2] - center[2]]);
    const x = this.normalize(this.cross(up, z));
    const y = this.cross(z, x);
    return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -this.dot(x, eye), -this.dot(y, eye), -this.dot(z, eye), 1]);
  }
  
  normalize(v) { const len = Math.sqrt(v[0]**2 + v[1]**2 + v[2]**2); return len > 0 ? [v[0]/len, v[1]/len, v[2]/len] : [0, 0, 0]; }
  cross(a, b) { return [a[1]*b[2] - a[2]*b[1], a[2]*b[0] - a[0]*b[2], a[0]*b[1] - a[1]*b[0]]; }
  dot(a, b) { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; }
  multiplyMatrices(a, b) {
    const out = new Float32Array(16);
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { let sum = 0; for (let k = 0; k < 4; k++) sum += a[i*4+k] * b[k*4+j]; out[i*4+j] = sum; }
    return out;
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
    this.updateCamera(deltaTime);
    
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
    const viewProj = this.getViewProjMatrix();
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

  // ============================================
  // SHADER DEFINITIONS
  // ============================================
  
  // Roller vertex shader with instance transforms
  get rollerVertShader() {
    return /* wgsl */ `
      struct Uniforms {
        viewProj: mat4x4f,
        time: f32,
        cameraPos: vec3f
      }
      
      // Canonical 48-byte DeviceUniforms struct (12 x f32)
      // Memory layout matches CPU write order exactly
      struct DeviceUniforms {
        renderMode: f32,              // [0]
        posX: f32,                    // [1]
        posY: f32,                    // [2]
        posZ: f32,                    // [3]
        rotation: vec4f,              // [4-7]
        timeScale: f32,               // [8]
        ringIndex: f32,               // [9]
        batteryCharge: f32,           // [10]
        isSolar: f32                  // [11]
      }
      
      struct InstanceData {
        position: vec3f,
        ringIndex: f32,
        rotation: vec4f,
        copperColor: vec3f,
        greenEmissive: f32
      }
      
      @binding(0) @group(0) var<uniform> uniforms: Uniforms;
      @binding(1) @group(0) var<uniform> device: DeviceUniforms;
      @binding(2) @group(0) var<storage> instances: array<InstanceData>;
      
      struct VertexInput {
        @location(0) position: vec3f,
        @location(1) normal: vec3f
      }
      
      struct VertexOutput {
        @builtin(position) position: vec4f,
        @location(0) worldPos: vec3f,
        @location(1) normal: vec3f,
        @location(2) copperColor: vec3f,
        @location(3) greenEmissive: f32,
        @location(4) ringIndex: f32
      }
      
      fn quatMul(q: vec4f, v: vec3f) -> vec3f {
        let t = 2.0 * cross(q.xyz, v);
        return v + q.w * t + cross(q.xyz, t);
      }
      
      @vertex
      fn main(input: VertexInput, @builtin(instance_index) instanceIdx: u32) -> VertexOutput {
        let instance = instances[instanceIdx];
        
        // Apply self-rotation
        let rotatedPos = quatMul(instance.rotation, input.position);
        let rotatedNormal = quatMul(instance.rotation, input.normal);
        
        // Reconstruct device position from individual fields
        let devicePos = vec3f(device.posX, device.posY, device.posZ);
        // Apply orbital position
        let worldPos = rotatedPos + instance.position + devicePos;
        
        var output: VertexOutput;
        output.position = uniforms.viewProj * vec4f(worldPos, 1.0);
        output.worldPos = worldPos;
        output.normal = rotatedNormal;
        output.copperColor = instance.copperColor;
        output.greenEmissive = instance.greenEmissive;
        output.ringIndex = instance.ringIndex;
        
        return output;
      }
    `;
  }
  
  // Roller fragment shader with copper material + green underglow
  get rollerFragShader() {
    return /* wgsl */ `
      struct MaterialUniforms {
        baseColor: vec3f,
        pad1: f32,
        glowColor: vec3f,
        emission: f32
      }
      
      @binding(3) @group(0) var<uniform> material: MaterialUniforms;
      
      struct FragmentInput {
        @location(0) worldPos: vec3f,
        @location(1) normal: vec3f,
        @location(2) copperColor: vec3f,
        @location(3) greenEmissive: f32,
        @location(4) ringIndex: f32
      }
      
      @fragment
      fn main(input: FragmentInput) -> @location(0) vec4f {
        let normal = normalize(input.normal);
        
        // View direction
        let viewDir = normalize(vec3f(0.0, 5.0, 10.0) - input.worldPos);
        
        // Basic lighting
        let lightDir = normalize(vec3f(1.0, 1.0, 1.0));
        let diff = max(dot(normal, lightDir), 0.0);
        let ambient = 0.3;
        
        // Copper material color
        let copper = input.copperColor;
        
        // Specular highlight for metallic look
        let halfDir = normalize(lightDir + viewDir);
        let spec = pow(max(dot(normal, halfDir), 0.0), 32.0);
        
        // Base copper color with lighting
        var color = copper * (ambient + diff * 0.7) + vec3f(1.0) * spec * 0.5;
        
        // GREEN EMISSIVE GLOW on bottom half of roller (LED underglow effect)
        // worldNormal.y < 0 means bottom half
        let bottomGlow = max(0.0, -normal.y) * input.greenEmissive * 1.8;
        let greenGlow = vec3f(0.0, 1.2, 0.6) * bottomGlow;
        
        // Add material emission
        color = color + material.glowColor * material.emission * 0.3;
        
        // Add the green LED underglow
        color = color + greenGlow;
        
        return vec4f(color, 1.0);
      }
    `;
  }
  
  // Particle vertex shader
  get particleVertShader() {
    return /* wgsl */ `
      struct Uniforms {
        viewProj: mat4x4f,
        time: f32,
        cameraPos: vec3f
      }
      
      struct DeviceUniforms {
        renderMode: f32,
        posX: f32,
        posY: f32,
        posZ: f32,
        rotation: vec4f,
        timeScale: f32,
        ringIndex: f32,
        batteryCharge: f32,
        isSolar: f32
      }
      
      @binding(0) @group(0) var<uniform> uniforms: Uniforms;
      @binding(1) @group(0) var<uniform> device: DeviceUniforms;
      
      struct VertexOutput {
        @builtin(position) position: vec4f,
        @location(0) particlePhase: f32,
        @location(1) uv: vec2f
      }
      
      const quadVerts = array<vec2f, 4>(
        vec2f(-1.0, -1.0),
        vec2f( 1.0, -1.0),
        vec2f(-1.0,  1.0),
        vec2f( 1.0,  1.0)
      );
      
      @vertex
      fn main(
        @location(0) pos: vec3f,
        @location(1) phase: f32,
        @builtin(vertex_index) vertIdx: u32,
        @builtin(instance_index) instIdx: u32
      ) -> VertexOutput {
        let quadPos = quadVerts[vertIdx];
        
        let devicePos = vec3f(device.posX, device.posY, device.posZ);
        let toCamera = normalize(uniforms.cameraPos - pos - devicePos);
        let up = vec3f(0.0, 1.0, 0.0);
        let right = normalize(cross(up, toCamera));
        let billboardUp = cross(toCamera, right);
        
        // Particle size varies by mode
        var size: f32 = 0.07;
        if (device.ringIndex > 0.5 && device.ringIndex < 1.5) {
          size = 0.11;   // larger water droplets for Heron
        } else if (device.ringIndex >= 3.5) {
          size = 0.08;   // Peltier particles
        } else if (device.ringIndex >= 2.5) {
          size = 0.05;   // small photon dots for Solar
        }
        
        let worldPos = pos + devicePos + 
                       right * quadPos.x * size + 
                       billboardUp * quadPos.y * size;
        
        var output: VertexOutput;
        output.position = uniforms.viewProj * vec4f(worldPos, 1.0);
        output.particlePhase = phase;
        output.uv = quadPos * 0.5 + 0.5;
        
        return output;
      }
    `;
  }
  
  // Particle fragment shader
  get particleFragShader() {
    return /* wgsl */ `
      struct MaterialUniforms {
        baseColor: vec3f,
        pad1: f32,
        glowColor: vec3f,
        emission: f32
      }
      
      @binding(3) @group(0) var<uniform> material: MaterialUniforms;
      
      struct FragmentInput {
        @location(0) particlePhase: f32,
        @location(1) uv: vec2f
      }
      
      @fragment
      fn main(input: FragmentInput) -> @location(0) vec4f {
        let dist = length(input.uv - vec2f(0.5));
        if (dist > 0.5) {
          discard;
        }
        
        let edge = 1.0 - smoothstep(0.3, 0.5, dist);
        let alpha = edge * 0.85;
        
        let mode = device.ringIndex;
        let t = uniforms.time;
        let phase = input.particlePhase;
        var color: vec3f;
        
        if (mode < 0.5) {
          // SEG: cyan / electric-blue magnetic field lines
          let pulse = 0.6 + 0.4 * sin(t * 5.0 + phase * 6.28);
          color = mix(vec3f(0.0, 0.65, 1.0), vec3f(0.3, 1.0, 0.85), pulse);
        } else if (mode < 1.5) {
          // Heron: blue water droplets with slight white specular centre
          let h = clamp(input.uv.y * 0.5 + 0.5, 0.0, 1.0);
          let d = dist;
          color = mix(vec3f(0.0, 0.22, 0.70), vec3f(0.55, 0.82, 1.0), h * (1.0 - d));
        } else if (mode < 2.5) {
          // Kelvin: translucent water drops; rare bright spark particles
          let spark = step(0.97, fract(sin(f32(input.uv.x * 100.0)
                    + phase * 3137.1) * 43758.5453));
          color = mix(vec3f(0.72, 0.82, 0.96), vec3f(0.85, 0.15, 1.0), spark);
        } else if (mode < 3.5) {
          // Solar: warm yellow photons
          let intensity = 0.55 + 0.45 * device.batteryCharge;
          color = vec3f(1.0, 0.88, 0.28) * intensity;
        } else {
          // Peltier TEG: Colors based on thermal regions
          if (phase < 0.4) {
            // Hot particles: Red/Orange
            color = vec3f(1.0, 0.25 + 0.1 * sin(t * 3.0 + phase * 10.0), 0.0);
          } else if (phase < 0.8) {
            // Cold particles: Blue/Cyan
            color = vec3f(0.0, 0.5 + 0.2 * sin(t * 2.0 + phase * 8.0), 1.0);
          } else {
            // Electricity particles: Flashing Yellow/Green
            let spark = step(0.82, fract(sin(t * 18.0 + phase * 127.3) * 43758.5453));
            color = mix(vec3f(0.4, 0.95, 0.2), vec3f(1.0, 1.0, 0.6), spark * 0.7);
          }
        }
        
        // Add glow
        let glow = material.glowColor * material.emission * 0.5;
        color = color + glow;
        
        return vec4f(color, alpha);
      }
    `;
  }
  
  // Core vertex shader
  get coreVertShader() {
    return /* wgsl */ `
      struct Uniforms {
        viewProj: mat4x4f,
        time: f32,
        cameraPos: vec3f
      }
      
      // Canonical 48-byte DeviceUniforms struct (12 x f32)
      struct DeviceUniforms {
        renderMode: f32,              // [0]
        posX: f32,                    // [1]
        posY: f32,                    // [2]
        posZ: f32,                    // [3]
        rotation: vec4f,              // [4-7]
        timeScale: f32,               // [8]
        ringIndex: f32,               // [9]
        batteryCharge: f32,           // [10]
        isSolar: f32                  // [11]
      }
      
      @binding(0) @group(0) var<uniform> uniforms: Uniforms;
      @binding(1) @group(0) var<uniform> device: DeviceUniforms;
      
      struct VertexInput {
        @location(0) position: vec3f,
        @location(1) normal: vec3f
      }
      
      struct VertexOutput {
        @builtin(position) position: vec4f,
        @location(0) worldPos: vec3f,
        @location(1) normal: vec3f
      }
      
      @vertex
      fn main(input: VertexInput) -> VertexOutput {
        // Reconstruct device position from individual fields
        let devicePos = vec3f(device.posX, device.posY, device.posZ);
        let worldPos = input.position + devicePos;
        
        var output: VertexOutput;
        output.position = uniforms.viewProj * vec4f(worldPos, 1.0);
        output.worldPos = worldPos;
        output.normal = input.normal;
        
        return output;
      }
    `;
  }
  
  // Core fragment shader
  get coreFragShader() {
    return /* wgsl */ `
      struct CoreMaterialUniforms {
        baseColor: vec3f,
        emission: f32,
        coreColor: vec3f,
        glowIntensity: f32
      }
      
      @binding(3) @group(0) var<uniform> material: CoreMaterialUniforms;
      
      struct FragmentInput {
        @location(0) worldPos: vec3f,
        @location(1) normal: vec3f
      }
      
      @fragment
      fn main(input: FragmentInput) -> @location(0) vec4f {
        let normal = normalize(input.normal);
        let lightDir = normalize(vec3f(1.0, 1.0, 1.0));
        let diff = max(dot(normal, lightDir), 0.0);
        
        // Central core with green glow
        let baseColor = material.baseColor;
        let glowColor = material.coreColor * material.glowIntensity;
        
        let color = baseColor * (0.3 + diff * 0.7) + glowColor;
        
        return vec4f(color, 1.0);
      }
    `;
  }
  
  // Field line vertex shader
  get fieldLineVertShader() {
    return /* wgsl */ `
      struct Uniforms {
        viewProj: mat4x4f,
        time: f32,
        cameraPos: vec3f
      }
      
      // Canonical 48-byte DeviceUniforms struct (12 x f32)
      struct DeviceUniforms {
        renderMode: f32,              // [0]
        posX: f32,                    // [1]
        posY: f32,                    // [2]
        posZ: f32,                    // [3]
        rotation: vec4f,              // [4-7]
        timeScale: f32,               // [8]
        ringIndex: f32,               // [9]
        batteryCharge: f32,           // [10]
        isSolar: f32                  // [11]
      }
      
      struct FieldParticle {
        position: vec3f,
        velocity: vec3f,
        life: f32,
        strength: f32
      }
      
      @binding(0) @group(0) var<uniform> uniforms: Uniforms;
      @binding(1) @group(0) var<uniform> device: DeviceUniforms;
      @binding(4) @group(0) var<storage> particles: array<FieldParticle>;
      
      struct VertexOutput {
        @builtin(position) position: vec4f,
        @location(0) color: vec3f,
        @location(1) alpha: f32
      }
      
      @vertex
      fn main(@builtin(vertex_index) vertIdx: u32, @builtin(instance_index) instIdx: u32) -> VertexOutput {
        let particle = particles[instIdx];
        
        // Reconstruct device position from individual fields
        let devicePos = vec3f(device.posX, device.posY, device.posZ);
        let worldPos = particle.position + devicePos;
        
        var output: VertexOutput;
        output.position = uniforms.viewProj * vec4f(worldPos, 1.0);
        
        // Green energy field lines
        let copper = vec3f(0.85, 0.48, 0.25);
        let greenEnergy = vec3f(0.2, 1.0, 0.5);
        output.color = mix(copper, greenEnergy, particle.strength);
        output.alpha = particle.life * particle.strength;
        
        return output;
      }
    `;
  }
  
  // Field line fragment shader
  get fieldLineFragShader() {
    return /* wgsl */ `
      struct FragmentInput {
        @location(0) color: vec3f,
        @location(1) alpha: f32
      }
      
      @fragment
      fn main(input: FragmentInput) -> @location(0) vec4f {
        return vec4f(input.color, input.alpha * 0.6);
      }
    `;
  }
  
  // Energy arc vertex shader
  get energyArcVertShader() {
    return /* wgsl */ `
      struct Uniforms {
        viewProj: mat4x4f,
        time: f32,
        cameraPos: vec3f
      }
      
      // Canonical 48-byte DeviceUniforms struct (12 x f32)
      struct DeviceUniforms {
        renderMode: f32,              // [0]
        posX: f32,                    // [1]
        posY: f32,                    // [2]
        posZ: f32,                    // [3]
        rotation: vec4f,              // [4-7]
        timeScale: f32,               // [8]
        ringIndex: f32,               // [9]
        batteryCharge: f32,           // [10]
        isSolar: f32                  // [11]
      }
      
      struct ArcParticle {
        position: vec3f,
        velocity: vec3f,
        life: f32,
        intensity: f32
      }
      
      @binding(0) @group(0) var<uniform> uniforms: Uniforms;
      @binding(1) @group(0) var<uniform> device: DeviceUniforms;
      @binding(4) @group(0) var<storage> particles: array<ArcParticle>;
      
      struct VertexOutput {
        @builtin(position) position: vec4f,
        @location(0) color: vec3f,
        @location(1) intensity: f32
      }
      
      @vertex
      fn main(@builtin(vertex_index) vertIdx: u32, @builtin(instance_index) instIdx: u32) -> VertexOutput {
        let particle = particles[instIdx];
        // Reconstruct device position from individual fields
        let devicePos = vec3f(device.posX, device.posY, device.posZ);
        let worldPos = particle.position + devicePos;
        
        var output: VertexOutput;
        output.position = uniforms.viewProj * vec4f(worldPos, 1.0);
        
        // Electric arc colors - cyan/blue energy
        output.color = vec3f(0.3, 0.8, 1.0);
        output.intensity = particle.intensity;
        
        return output;
      }
    `;
  }
  
  // Energy arc fragment shader
  get energyArcFragShader() {
    return /* wgsl */ `
      struct FragmentInput {
        @location(0) color: vec3f,
        @location(1) intensity: f32
      }
      
      @fragment
      fn main(input: FragmentInput) -> @location(0) vec4f {
        let glow = input.color * input.intensity * 2.0;
        return vec4f(glow, input.intensity);
      }
    `;
  }
  
  // ============================================
  // Electromagnet coil shaders
  // ============================================
  
  get coilVertShader() {
    return /* wgsl */ `
      struct Uniforms {
        viewProj: mat4x4f,
        time: f32,
        cameraPos: vec3f
      }
      
      struct DeviceUniforms {
        renderMode: f32,
        posX: f32,
        posY: f32,
        posZ: f32,
        rotation: vec4f,
        timeScale: f32,
        ringIndex: f32,
        batteryCharge: f32,
        isSolar: f32
      }
      
      struct CoilInstance {
        position: vec3f,
        angle: f32,
        activeIntensity: f32,
        coilIndex: f32,
        pad1: f32,
        pad2: f32
      }
      
      @binding(0) @group(0) var<uniform> uniforms: Uniforms;
      @binding(1) @group(0) var<uniform> device: DeviceUniforms;
      @binding(2) @group(0) var<storage> instances: array<CoilInstance>;
      
      struct VertexInput {
        @location(0) position: vec3f,
        @location(1) normal: vec3f
      }
      
      struct VertexOutput {
        @builtin(position) position: vec4f,
        @location(0) worldPos: vec3f,
        @location(1) normal: vec3f,
        @location(2) activeIntensity: f32,
        @location(3) coilIndex: f32
      }
      
      @vertex
      fn main(input: VertexInput, @builtin(instance_index) instanceIdx: u32) -> VertexOutput {
        let instance = instances[instanceIdx];
        
        // Rotate cylinder to face tangent to the ring
        let ca = cos(instance.angle);
        let sa = sin(instance.angle);
        // Rotate around Y axis to align with ring tangent
        let rotPos = vec3f(
          input.position.x * ca + input.position.z * sa,
          input.position.y,
          -input.position.x * sa + input.position.z * ca
        );
        let rotNormal = vec3f(
          input.normal.x * ca + input.normal.z * sa,
          input.normal.y,
          -input.normal.x * sa + input.normal.z * ca
        );
        
        let devicePos = vec3f(device.posX, device.posY, device.posZ);
        let worldPos = rotPos + instance.position + devicePos;
        
        var output: VertexOutput;
        output.position = uniforms.viewProj * vec4f(worldPos, 1.0);
        output.worldPos = worldPos;
        output.normal = rotNormal;
        output.activeIntensity = instance.activeIntensity;
        output.coilIndex = instance.coilIndex;
        
        return output;
      }
    `;
  }
  
  get coilFragShader() {
    return /* wgsl */ `
      struct CoilMaterialUniforms {
        baseColor: vec3f,
        pad1: f32,
        glowColor: vec3f,
        emission: f32
      }
      
      @binding(3) @group(0) var<uniform> material: CoilMaterialUniforms;
      
      struct FragmentInput {
        @location(0) worldPos: vec3f,
        @location(1) normal: vec3f,
        @location(2) activeIntensity: f32,
        @location(3) coilIndex: f32
      }
      
      @fragment
      fn main(input: FragmentInput) -> @location(0) vec4f {
        let normal = normalize(input.normal);
        let lightDir = normalize(vec3f(1.0, 1.0, 1.0));
        let diff = max(dot(normal, lightDir), 0.0);
        let ambient = 0.3;
        
        // Copper base color
        var color = material.baseColor * (ambient + diff * 0.7);
        
        // Add specular for metallic look
        let viewDir = normalize(vec3f(0.0, 5.0, 10.0) - input.worldPos);
        let halfDir = normalize(lightDir + viewDir);
        let spec = pow(max(dot(normal, halfDir), 0.0), 32.0);
        color = color + vec3f(1.0) * spec * 0.5;
        
        // Orange emissive glow when active
        let active = input.activeIntensity;
        let orangeGlow = vec3f(1.0, 0.55, 0.0) * active * 2.5;
        let whiteCore = vec3f(1.0, 0.9, 0.7) * active * 0.8;
        color = color + orangeGlow + whiteCore;
        
        // Subtle pulsing when active
        let pulse = 1.0 + 0.15 * sin(input.coilIndex * 2.0) * active;
        color = color * pulse;
        
        return vec4f(color, 1.0);
      }
    `;
  }
  
  // ============================================
  // Enhanced SEG shaders (PBR + UV + pole bands)
  // ============================================

  get segEnhancedVertShader() {
    return /* wgsl */ `
      struct Uniforms {
        viewProj: mat4x4f,
        time: f32,
        cameraPos: vec3f
      }

      struct DeviceUniforms {
        renderMode: f32,
        posX: f32,
        posY: f32,
        posZ: f32,
        rotation: vec4f,
        timeScale: f32,
        ringIndex: f32,
        batteryCharge: f32,
        isSolar: f32
      }

      struct InstanceData {
        position: vec3f,
        ringIndex: f32,
        rotation: vec4f,
        copperColor: vec3f,
        greenEmissive: f32
      }

      @binding(0) @group(0) var<uniform> uniforms: Uniforms;
      @binding(1) @group(0) var<uniform> device: DeviceUniforms;
      @binding(2) @group(0) var<storage> instances: array<InstanceData>;

      struct VertexInput {
        @location(0) position: vec3f,
        @location(1) normal: vec3f,
        @location(2) uv: vec2f
      }

      struct VertexOutput {
        @builtin(position) position: vec4f,
        @location(0) worldPos: vec3f,
        @location(1) normal: vec3f,
        @location(2) uv: vec2f,
        @location(3) copperColor: vec3f,
        @location(4) greenEmissive: f32,
        @location(5) ringIndex: f32,
        @location(6) bandIndex: f32
      }

      fn quatMul(q: vec4f, v: vec3f) -> vec3f {
        let t = 2.0 * cross(q.xyz, v);
        return v + q.w * t + cross(q.xyz, t);
      }

      @vertex
      fn main(input: VertexInput, @builtin(instance_index) instanceIdx: u32) -> VertexOutput {
        let instance = instances[instanceIdx];
        let rotatedPos = quatMul(instance.rotation, input.position);
        let rotatedNormal = quatMul(instance.rotation, input.normal);
        let devicePos = vec3f(device.posX, device.posY, device.posZ);
        let worldPos = rotatedPos + instance.position + devicePos;

        let bandIdx = floor(input.uv.y * 6.0);

        var output: VertexOutput;
        output.position = uniforms.viewProj * vec4f(worldPos, 1.0);
        output.worldPos = worldPos;
        output.normal = rotatedNormal;
        output.uv = input.uv;
        output.copperColor = instance.copperColor;
        output.greenEmissive = instance.greenEmissive;
        output.ringIndex = instance.ringIndex;
        output.bandIndex = bandIdx;
        return output;
      }
    `;
  }

  get segEnhancedFragShader() {
    return /* wgsl */ `
      struct Uniforms {
        viewProj: mat4x4f,
        time: f32,
        cameraPos: vec3f
      }

      struct MaterialUniforms {
        baseColor: vec3f,
        pad1: f32,
        glowColor: vec3f,
        emission: f32
      }

      struct LightingConfig {
        keyDir: vec3f,
        keyColor: vec3f,
        keyIntensity: f32,
        fillDir: vec3f,
        fillColor: vec3f,
        fillIntensity: f32,
        rimDir: vec3f,
        rimColor: vec3f,
        rimIntensity: f32,
        ambient: f32,
        envMapStrength: f32,
      }

      @binding(0) @group(0) var<uniform> uniforms: Uniforms;
      @binding(3) @group(0) var<uniform> material: MaterialUniforms;
      @binding(5) @group(0) var<uniform> lighting: LightingConfig;

      struct FragmentInput {
        @location(0) worldPos: vec3f,
        @location(1) normal: vec3f,
        @location(2) uv: vec2f,
        @location(3) copperColor: vec3f,
        @location(4) greenEmissive: f32,
        @location(5) ringIndex: f32,
        @location(6) bandIndex: f32
      }

      fn hash3(p: vec3f) -> vec3f {
        let q = vec3f(
          dot(p, vec3f(127.1, 311.7, 74.7)),
          dot(p, vec3f(269.5, 183.3, 246.1)),
          dot(p, vec3f(113.5, 271.9, 124.6))
        );
        return fract(sin(q) * 43758.5453);
      }

      fn surfaceVariation(worldPos: vec3f, scale: f32) -> f32 {
        let h = hash3(floor(worldPos * scale));
        return h.x * 0.15 + h.y * 0.1;
      }

      fn fresnelSchlick(cosTheta: f32, f0: vec3f) -> vec3f {
        return f0 + (vec3f(1.0) - f0) * pow(1.0 - cosTheta, 5.0);
      }

      fn distributionGGX(NdotH: f32, roughness: f32) -> f32 {
        let a = roughness * roughness;
        let a2 = a * a;
        let denom = NdotH * NdotH * (a2 - 1.0) + 1.0;
        return a2 / (3.14159265 * denom * denom);
      }

      fn geometrySmith(NdotV: f32, NdotL: f32, roughness: f32) -> f32 {
        let k = (roughness + 1.0) * (roughness + 1.0) / 8.0;
        let ggx1 = NdotV / (NdotV * (1.0 - k) + k);
        let ggx2 = NdotL / (NdotL * (1.0 - k) + k);
        return ggx1 * ggx2;
      }

      fn poleBandColor(bandIndex: f32, baseColor: vec3f) -> vec3f {
        let idx = u32(bandIndex) % 4u;
        switch(idx) {
          case 0u: { return vec3f(0.85, 0.48, 0.22); }
          case 1u: { return vec3f(0.55, 0.30, 0.15); }
          case 2u: { return vec3f(0.72, 0.74, 0.76); }
          case 3u: { return vec3f(0.78, 0.58, 0.22); }
          default: { return baseColor; }
        }
      }

      @fragment
      fn main(input: FragmentInput) -> @location(0) vec4f {
        let N = normalize(input.normal);
        let V = normalize(uniforms.cameraPos - input.worldPos);
        let NdotV = max(dot(N, V), 0.0);

        var baseColor: vec3f;
        var metallic: f32;
        var roughness: f32;
        var emissive: f32;

        if (input.bandIndex >= 0.0 && input.bandIndex < 6.0) {
          baseColor = poleBandColor(input.bandIndex, input.copperColor);
          let isNeodymium = (u32(input.bandIndex) % 4u) == 2u;
          metallic = select(0.95, 0.88, isNeodymium);
          roughness = select(0.30, 0.20, isNeodymium);
          emissive = select(0.0, 0.15, isNeodymium);
        } else if (input.ringIndex < -0.5) {
          baseColor = vec3f(0.65, 0.67, 0.70);
          metallic = 0.96;
          roughness = 0.15;
          emissive = 0.0;
        } else if (input.ringIndex > 10.0) {
          baseColor = vec3f(0.78, 0.58, 0.22);
          metallic = 0.90;
          roughness = 0.22;
          emissive = 0.0;
        } else {
          baseColor = input.copperColor;
          metallic = 0.95;
          roughness = 0.30;
          emissive = input.greenEmissive;
        }

        let variation = surfaceVariation(input.worldPos, 8.0);
        baseColor = baseColor * (0.92 + variation);
        roughness = clamp(roughness + variation * 0.1, 0.05, 1.0);

        let f0 = mix(vec3f(0.04), baseColor, metallic);
        let albedo = mix(baseColor, vec3f(0.0), metallic);

        let L1 = normalize(-lighting.keyDir);
        let H1 = normalize(V + L1);
        let NdotL1 = max(dot(N, L1), 0.0);
        let NdotH1 = max(dot(N, H1), 0.0);
        let D1 = distributionGGX(NdotH1, roughness);
        let G1 = geometrySmith(NdotV, NdotL1, roughness);
        let F1 = fresnelSchlick(max(dot(H1, V), 0.0), f0);
        let specular1 = (D1 * G1 * F1) / (4.0 * NdotV * NdotL1 + 0.001);
        let kD1 = (vec3f(1.0) - F1) * (1.0 - metallic);

        let L2 = normalize(-lighting.fillDir);
        let H2 = normalize(V + L2);
        let NdotL2 = max(dot(N, L2), 0.0);
        let NdotH2 = max(dot(N, H2), 0.0);
        let D2 = distributionGGX(NdotH2, roughness);
        let G2 = geometrySmith(NdotV, NdotL2, roughness);
        let F2 = fresnelSchlick(max(dot(H2, V), 0.0), f0);
        let specular2 = (D2 * G2 * F2) / (4.0 * NdotV * NdotL2 + 0.001);
        let kD2 = (vec3f(1.0) - F2) * (1.0 - metallic);

        let rimFactor = pow(1.0 - NdotV, 3.0) * lighting.rimIntensity;
        let rimLight = lighting.rimColor * rimFactor;

        let diffuse = albedo * 3.14159265 * (
          kD1 * NdotL1 * lighting.keyColor * lighting.keyIntensity +
          kD2 * NdotL2 * lighting.fillColor * lighting.fillIntensity * 0.5
        );

        let specular = (
          specular1 * lighting.keyColor * lighting.keyIntensity * NdotL1 +
          specular2 * lighting.fillColor * lighting.fillIntensity * NdotL2 * 0.3
        );

        let ambient = albedo * lighting.ambient * vec3f(0.15, 0.18, 0.22);
        var color = ambient + diffuse + specular + rimLight;

        let bottomGlow = max(0.0, -N.y) * input.greenEmissive * 1.5;
        color += vec3f(0.0, 1.0, 0.5) * bottomGlow;
        color += baseColor * emissive * 0.5;

        let energyArc = smoothstep(0.7, 1.0, input.greenEmissive) * 0.3;
        color += vec3f(0.3, 0.8, 1.0) * energyArc * NdotV;

        color = color * (2.51 * color + 0.03) / (color * (2.43 * color + 0.59) + 0.14);

        let vignette = 1.0 - dot(input.uv - 0.5, input.uv - 0.5) * 0.3;
        color *= vignette;

        return vec4f(color, 1.0);
      }
    `;
  }

  // ============================================
  // Compute shader — GPU particle physics
  // ============================================
  get computeShader() {
    return /* wgsl */ `
      struct ComputeUniforms {
        time: f32,
        mode: f32,
        particleCount: f32,
        speedMult: f32,
      }

      @binding(0) @group(0) var<storage, read_write> particles: array<vec4f>;
      @binding(1) @group(0) var<uniform> uniforms: ComputeUniforms;

      const PI: f32 = 3.14159265359;

      fn posSEG(phase: f32, t: f32, idx: u32) -> vec3f {
        let cycleT  = fract(t * 0.12 + phase);
        let radius  = 8.5 - cycleT * 8.0;
        let angle   = phase * 6.28318 + cycleT * 18.84956;
        let height  = sin(cycleT * 6.28318 * 2.0 + phase * 6.28318) * 2.8;
        return vec3f(cos(angle) * radius, height, sin(angle) * radius);
      }

      fn posHeron(phase: f32, t: f32, idx: u32) -> vec3f {
        let cycleT  = fract(t * 0.22 + phase);
        let spread  = phase * 6.28318;
        let spreadR = fract(f32(idx) * 0.618034) * 0.55;
        var pos: vec3f;
        if (cycleT < 0.35) {
          let k = cycleT / 0.35;
          pos = vec3f(sin(spread) * spreadR * k * 1.4,
                      5.6 + k * 3.1 - k * k * 1.2,
                      cos(spread) * spreadR * k * 1.4);
        } else if (cycleT < 0.72) {
          let k = (cycleT - 0.35) / 0.37;
          pos = vec3f(sin(spread) * spreadR * (1.4 - k * 0.9),
                      8.5 - k * 4.2,
                      cos(spread) * spreadR * (1.4 - k * 0.9));
        } else {
          let k = (cycleT - 0.72) / 0.28;
          pos = vec3f(sin(spread) * spreadR * (0.5 - k * 0.5),
                      4.5 - k * 6.5,
                      cos(spread) * spreadR * (0.5 - k * 0.5));
        }
        return pos;
      }

      fn posKelvin(phase: f32, t: f32, idx: u32) -> vec3f {
        let cycleT = fract(t * 0.32 + phase);
        let side   = select(-1.0, 1.0, (idx & 1u) == 1u);
        let wobble = sin(t * 4.0 + phase * 20.0) * 0.09;
        var pos: vec3f;
        if (cycleT < 0.82) {
          let k = cycleT / 0.82;
          pos = vec3f(side * 2.5 + wobble, 5.5 - k * 8.8, wobble * 0.4);
        } else {
          let k = (cycleT - 0.82) / 0.18;
          pos = vec3f(side * 2.5 * (1.0 - k * 1.9), -3.2 + k * 1.4, 0.0);
        }
        return pos;
      }

      fn posSolar(phase: f32, t: f32, idx: u32, speedMult: f32) -> vec3f {
        let ledIdx = idx % 6u;
        let ledX   = (f32(ledIdx) - 2.5) * 1.6;
        let ledPos = vec3f(ledX, 3.5, 1.5);
        let panelX = (fract(f32(idx) * 0.61803) - 0.5) * 9.0;
        let panelZ = (fract(f32(idx) * 0.38490) - 0.5) * 9.0;
        let panelPos = vec3f(panelX, 0.05, panelZ);
        let speed = 1.0 + speedMult * 1.5;
        let life  = fract(t * speed * 0.18 + phase);
        return mix(ledPos, panelPos, min(life * 1.05, 1.0));
      }

      fn posPeltier(phase: f32, t: f32, idx: u32) -> vec3f {
        let isSetupA = (idx % 2u) == 0u;
        let xOffset = select(3.5, -3.5, isSetupA);
        let cycleT = fract(t * 0.4 + phase);
        var pos: vec3f;
        if (phase < 0.4) {
          let isBottom = isSetupA;
          let yStart = select(4.0, -4.0, isBottom);
          let currentY = mix(yStart, 0.0, cycleT);
          let px = xOffset + sin(phase * 123.45) * 1.5;
          let pz = cos(f32(idx) * 0.123) * 1.5;
          pos = vec3f(px, currentY, pz);
        } else if (phase < 0.8) {
          let isTop = isSetupA;
          let yStart = select(-4.0, 4.0, isTop);
          let currentY = mix(yStart, 0.0, cycleT);
          let px = xOffset + sin(phase * 123.45) * 1.5;
          let pz = cos(f32(idx) * 0.123) * 1.5;
          pos = vec3f(px, currentY, pz);
        } else {
          let angle = phase * 62.83 + f32(idx) * 0.1;
          let radius = 1.0 + cycleT * 3.0;
          let px = xOffset + cos(angle) * radius;
          let pz = sin(angle) * radius;
          let py = sin(t * 5.0 + phase * 20.0) * 0.15;
          pos = vec3f(px, py, pz);
        }
        return pos;
      }

      @compute @workgroup_size(64)
      fn main(@builtin(global_invocation_id) id: vec3u) {
        let idx = id.x;
        if (idx >= u32(uniforms.particleCount)) { return; }

        let p = particles[idx];
        let phase = p.w;
        let t = uniforms.time;
        let mode = uniforms.mode;

        var newPos: vec3f;
        if (mode < 0.5) {
          newPos = posSEG(phase, t, idx);
        } else if (mode < 1.5) {
          newPos = posHeron(phase, t, idx);
        } else if (mode < 2.5) {
          newPos = posKelvin(phase, t, idx);
        } else if (mode < 3.5) {
          newPos = posSolar(phase, t, idx, uniforms.speedMult);
        } else {
          newPos = posPeltier(phase, t, idx);
        }

        particles[idx] = vec4f(newPos, phase);
      }
    `;
  }

  // Grid vertex shader
  get gridVertShader() {
    return /* wgsl */ `
      struct Uniforms {
        viewProj: mat4x4f,
        time: f32,
        cameraPos: vec3f
      }
      
      @binding(0) @group(0) var<uniform> uniforms: Uniforms;
      
      struct VertexOutput {
        @builtin(position) position: vec4f,
        @location(0) uv: vec2f
      }
      
      @vertex
      fn main(@location(0) pos: vec2f) -> VertexOutput {
        var output: VertexOutput;
        output.position = vec4f(pos, 0.0, 1.0);
        output.uv = pos * 0.5 + 0.5;
        return output;
      }
    `;
  }
  
  // Grid fragment shader
  get gridFragShader() {
    return /* wgsl */ `
      struct FragmentInput {
        @location(0) uv: vec2f
      }
      
      @fragment
      fn main(input: FragmentInput) -> @location(0) vec4f {
        // Simple grid pattern on floor
        let gridSize = 20.0;
        let worldPos = input.uv * gridSize - gridSize * 0.5;
        
        let lineWidth = 0.05;
        let gridX = abs(fract(worldPos.x) - 0.5);
        let gridY = abs(fract(worldPos.y) - 0.5);
        
        let isLine = step(gridX, lineWidth) + step(gridY, lineWidth);
        
        let gridColor = vec3f(0.1, 0.15, 0.2);
        let lineColor = vec3f(0.2, 0.3, 0.4);
        
        let color = mix(gridColor, lineColor, isLine);
        
        return vec4f(color, 0.3);
      }
    `;
  }
}
