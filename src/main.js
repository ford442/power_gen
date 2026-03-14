import rollerShaderCode from './shaders/roller.wgsl?raw';
import particleShaderCode from './shaders/particles.wgsl?raw';
import computeShaderCode from './shaders/compute.wgsl?raw';

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

    this.mode = 'seg';
    this.particleCount = 10000;
    this.time = 0;
    this.lastFrameTime = 0;
    this.fps = 60;
    this.indexCount = 0;
    this.camera = { distance: 12, rotation: 0, height: 3 };

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
      this.render(0);

      window.addEventListener('resize', () => this.resize());
    } catch (e) {
      console.error(e);
      alert("Init failed: " + e.message);
    }
  }

  resize() {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
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

  async setupGeometry() {
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
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' },
            { shaderLocation: 1, offset: 12, format: 'float32' }
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
      primitive: { topology: 'triangle-strip' }
    });

    this.uniformBuffer = this.device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
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

    this.canvas.addEventListener('mousedown', (e) => {
      isDragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
    });

    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      this.camera.rotation += (e.clientX - lastX) * 0.01;
      this.camera.height = Math.max(-5, Math.min(10, this.camera.height - (e.clientY - lastY) * 0.02));
      lastX = e.clientX;
      lastY = e.clientY;
    });

    window.addEventListener('mouseup', () => isDragging = false);

    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.camera.distance = Math.max(5, Math.min(20, this.camera.distance + e.deltaY * 0.01));
    });

    document.getElementById('speedSlider').addEventListener('input', (e) => {
      document.getElementById('speedVal').textContent = e.target.value;
    });

    document.getElementById('particleSlider').addEventListener('input', (e) => {
      const count = parseInt(e.target.value);
      document.getElementById('particleVal').textContent = count;
      if (count !== this.particleCount) {
        this.particleCount = count;
        this.updateParticles();
      }
    });
  }

  updateUniforms() {
    const aspect = this.canvas.width / this.canvas.height;
    const proj = this.perspectiveMatrix(45 * Math.PI / 180, aspect, 0.1, 100);
    const camX = Math.cos(this.camera.rotation) * this.camera.distance;
    const camZ = Math.sin(this.camera.rotation) * this.camera.distance;
    const view = this.lookAt([camX, this.camera.height, camZ], [0, 0, 0], [0, 1, 0]);
    const viewProj = this.multiplyMatrices(proj, view);

    const modeMap = { seg: 0.0, heron: 1.0, kelvin: 2.0 };
    const data = new Float32Array(20);
    data.set(viewProj);
    data[16] = this.time;
    data[17] = modeMap[this.mode] || 0;
    data[18] = this.particleCount;
    data[19] = 0;

    this.device.queue.writeBuffer(this.uniformBuffer, 0, data);
  }

  render(timestamp) {
    const deltaTime = (timestamp - this.lastFrameTime) / 1000;
    this.lastFrameTime = timestamp;

    if (timestamp % 500 < 20) {
      this.fps = Math.round(1 / (deltaTime || 0.016));
      document.getElementById('fps').textContent = this.fps;
    }

    const speed = parseFloat(document.getElementById('speedSlider').value) || 1.0;
    this.time += deltaTime * speed;
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

    const bindGroup = this.device.createBindGroup({
      layout: this.renderPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }]
    });

    renderPass.setPipeline(this.renderPipeline);
    renderPass.setBindGroup(0, bindGroup);
    renderPass.setVertexBuffer(0, this.vertexBuffer);
    renderPass.setIndexBuffer(this.indexBuffer, 'uint16');
    renderPass.drawIndexed(this.indexCount, 12);

    renderPass.setPipeline(this.particlePipeline);
    renderPass.setBindGroup(0, bindGroup);
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
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) {
          sum += a[i * 4 + k] * b[k * 4 + j];
        }
        out[i * 4 + j] = sum;
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
    seg: "Searl Effect Generator: 12 magnetic rollers in toroidal formation with spiral energy flux converging toward center.",
    heron: "Heron's Fountain: Fluid dynamics with siphon-driven water jets. Particles simulate hydraulic pressure differentials.",
    kelvin: "Kelvin's Thunderstorm: Electrostatic induction with falling water droplets charging conductors."
  };

  document.getElementById('info').textContent = descriptions[mode];
  document.getElementById('stats').innerHTML = 'FPS: <span id="fps">60</span> | Mode: ' + mode.toUpperCase();
};

window.addEventListener('load', () => {
  visualizer = new SEGVisualizer();
});
