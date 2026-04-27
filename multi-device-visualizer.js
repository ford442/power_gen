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
  
  // Compute shader — GPU particle physics
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
