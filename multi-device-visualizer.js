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
    this.devicesEnabled = { seg: true, heron: true, kelvin: true, solar: true };
    this.devices = {};
    this.energyPipes = [];

    this.time = 0;
    this.lastFrameTime = 0;
    this.fps = 60;

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

      await this.setupDevices();
      await this.setupEnergyPipes();
      await this.setupFloorGrid();

      // Track initial allocations
      this.profiler.trackBuffer('globalUniforms', 256, GPUBufferUsage.UNIFORM);

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
      { from: 'kelvin', to: 'seg', speed: 2.5 }
    ];
    
    for (const config of pipeConfigs) {
      const pipe = new EnergyPipe(this.device, config);
      await pipe.init();
      this.energyPipes.push(pipe);
    }
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
    
    // Update devices with quality scaling
    const qualityScale = this.profiler.qualityLevel;
    for (const device of Object.values(this.devices)) {
      if (this.devicesEnabled[device.id]) {
        device.update(deltaTime * speed, qualityScale);
      }
    }
    
    // Begin render pass with timestamp queries
    const encoder = this.device.createCommandEncoder();
    
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
