import { DeviceGeometry } from './device-geometry.js';
import { DevicePipelineManager } from './device-pipeline-manager.js';

class DeviceInstance {
  constructor(device, id, config, visualizer) {
    this.device = device;
    this.id = id;
    this.config = config;
    this.visualizer = visualizer;
    this.particleCount = config.particleCount;
    this.geometry = new DeviceGeometry(device, id, config, visualizer);
    this.pipelineManager = new DevicePipelineManager(device, id, visualizer);
    
    // Delegate properties
    Object.defineProperty(this, 'particles', { get: () => this.geometry.particles });
    Object.defineProperty(this, 'rollerInstances', { get: () => this.geometry.rollerInstances });
    Object.defineProperty(this, 'fieldLineParticles', { get: () => this.geometry.fieldLineParticles });
    Object.defineProperty(this, 'energyArcParticles', { get: () => this.geometry.energyArcParticles });
    Object.defineProperty(this, 'coreInstances', { get: () => this.geometry.coreInstances });
    Object.defineProperty(this, 'rollerPipeline', { get: () => this.pipelineManager.rollerPipeline });
    Object.defineProperty(this, 'particlePipeline', { get: () => this.pipelineManager.particlePipeline });
    Object.defineProperty(this, 'corePipeline', { get: () => this.pipelineManager.corePipeline });
    Object.defineProperty(this, 'fieldLinePipeline', { get: () => this.pipelineManager.fieldLinePipeline });
    Object.defineProperty(this, 'energyArcPipeline', { get: () => this.pipelineManager.energyArcPipeline });
    this.position = config.position;
    this.rotation = config.rotation;
    this.deviceUniformBuffer = null;
    this.materialUniformBuffer = null;
    this.coreMaterialBuffer = null;
    this.rollerPipeline = null;
    this.particlePipeline = null;
    this.corePipeline = null;

    // Field line visualization (SEG only)
    this.fieldLineCount = 1000;
    this.fieldLineParticles = null;
    this.fieldLinePipeline = null;
    this.fieldLineEnabled = true;

    // Energy arc visualization (SEG only)
    this.arcSegmentCount = 20;
    this.arcSegments = null;
    this.energyArcPipeline = null;
    this.energyArcEnabled = true;
    this.lastArcTime = 0;
  }

  async init() {
    await this.setupUniforms();
    await this.pipelineManager.setupPipelines();
    await this.geometry.setupParticles();

    if (this.id === 'seg') {
      await this.geometry.setupRollers();
      await this.geometry.setupCore();
      await this.geometry.setupFieldLines();
      await this.geometry.setupEnergyArcs();
  async setupUniforms() {
    this.deviceUniformBuffer = this.device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.materialUniformBuffer = this.device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    this.visualizer.profiler.trackBuffer(`device-${this.id}-uniforms`, 80, GPUBufferUsage.UNIFORM);

    // Battery gauge instance buffer used by solar device
    if (this.id === 'solar') {
      this.gaugeInstanceBuffer = this.device.createBuffer({
        size: 32,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
      });
      this.visualizer.profiler.trackBuffer(`device-${this.id}-gauge-instance`, 32, GPUBufferUsage.STORAGE);
    }

    // MaterialUniforms: albedo(3) + metallic(1) + roughness(1) + ao(1) + emission(1) + ringIndex(1) + pad(2)
    // Total: 12 floats = 48 bytes
    // Material uniform setup (may be updated per-frame for dynamic effects)
    let baseColor = this.config.color;
    let glowColor = [0.0, 0.9, 1.0];
    let emission = 2.0;
    let pad = 0.0;

    if (this.id === 'solar') {
      // Solar device uses a warm glow color and will modulate emission based on battery charge.
      baseColor = this.config.color;
      glowColor = [1.0, 0.9, 0.4];
      emission = 1.2;
      this.batteryCharge = 0.5;
      pad = this.batteryCharge;
    }

    const materialData = new Float32Array([
      ...baseColor,        // baseColor
      pad,                 // _pad1 (battery / extra param)
      ...glowColor,        // glowColor
      emission             // emission
    ]);
    this.device.queue.writeBuffer(this.materialUniformBuffer, 0, materialData);

    // Setup core material buffer for SEG
    if (this.id === 'seg' && this.config.core) {
      this.coreMaterialBuffer = this.device.createBuffer({
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      });
      this.visualizer.profiler.trackBuffer(`device-${this.id}-core-material`, 32, GPUBufferUsage.UNIFORM);

      const core = this.config.core;
      // baseColor (3) + emission (1) + coreColor (3) + glowIntensity (1)
      const coreMaterialData = new Float32Array([
        ...core.baseColor, 0.0,  // baseColor + padding
        ...core.coreColor, 1.5   // coreColor + glowIntensity
      ]);
      this.device.queue.writeBuffer(this.coreMaterialBuffer, 0, coreMaterialData);
    }
  }

    }

  }

  update(deltaTime, qualityScale) {
    // Scale particle count by quality
    const scaledParticleCount = Math.floor(this.particleCount * qualityScale);

    // Determine ring index for shaders: 0=SEG, 1=Heron, 2=Kelvin, 3=Solar
    const ringIndex = this.id === 'heron' ? 1 : (this.id === 'kelvin' ? 2 : (this.id === 'solar' ? 3 : 0));

    // Battery charge for solar device (0..1) passed via the padding slot
    if (this.id === 'solar' && this.batteryCharge === undefined) {
      this.batteryCharge = 0.5;
    }

    if (this.id === 'solar') {
      const drain = 0.18;
      const gain = 0.3 + 0.2 * Math.sin(this.visualizer.time * 2.0);
      this.batteryCharge = Math.min(1.0, Math.max(0.0, this.batteryCharge + (gain - drain) * deltaTime));

      // Update battery gauge mesh (height)
      this.visualizer.updateBatteryGaugeMesh(this.batteryCharge);

      // Update gauge instance transform (position + ringIndex)
      if (this.gaugeInstanceBuffer) {
        const offset = 1.5;
        const position = [this.position[0] + offset, this.position[1] + 0.5, this.position[2]];
        const rotation = [0, 0, 0, 1];
        const instanceData = new Float32Array([
          position[0], position[1], position[2], ringIndex,
          rotation[0], rotation[1], rotation[2], rotation[3]
        ]);
        this.device.queue.writeBuffer(this.gaugeInstanceBuffer, 0, instanceData);
      }
    }

    const deviceData = new Float32Array([
      ...this.position,
      Math.sin(this.rotation[1] / 2),
      0,
      Math.cos(this.rotation[1] / 2),
      1.0,
      1.0,
      ringIndex,
      this.id === 'solar' ? this.batteryCharge : 0,
      this.id === 'solar' ? 1 : 0
    ]);
    this.device.queue.writeBuffer(this.deviceUniformBuffer, 0, deviceData);

    if (this.id === 'solar') {
      // Update material buffer to reflect battery charge
      const baseColor = this.config.color;
      const glowColor = [1.0, 0.9, 0.4];
      const emission = 1.2;
      const materialData = new Float32Array([
        ...baseColor,
        this.batteryCharge,
        ...glowColor,
        emission
      ]);
      this.device.queue.writeBuffer(this.materialUniformBuffer, 0, materialData);
    }

    if (this.id === 'seg' && this.rollerInstances) {
      // 3-ring SEG system based on John Searl's design
      const instanceData = new Float32Array(36 * 8);
      const time = this.visualizer.time;

      // Ring specifications
      const rings = [
        { count: 8, radius: 2.5, scale: 0.6, speed: 2.0, index: 0 },   // Inner ring - fastest
        { count: 12, radius: 4.0, scale: 0.8, speed: 1.0, index: 1 },  // Middle ring - current
        { count: 16, radius: 5.5, scale: 1.0, speed: 0.5, index: 2 }   // Outer ring - slowest
      ];

      let rollerOffset = 0;

      for (const ring of rings) {
        for (let i = 0; i < ring.count; i++) {
          // Orbital position around the central axis
          const angle = (i / ring.count) * Math.PI * 2 + time * 0.5 * ring.speed;

          // Position in toroidal ring
          instanceData[rollerOffset * 8] = Math.cos(angle) * ring.radius;     // x
          instanceData[rollerOffset * 8 + 1] = 0;                              // y
          instanceData[rollerOffset * 8 + 2] = Math.sin(angle) * ring.radius;  // z

          // Roller self-rotation (gear-like rolling motion)
          // Self-rotation = orbital_angle * (ring_radius / roller_radius)
          // roller_radius is proportional to scale, so gear ratio = ring_radius / scale
          const gearRatio = ring.radius / ring.scale;
          const selfRotAngle = angle * gearRatio * 0.5;

          // Quaternion for self-rotation (around Y axis)
          instanceData[rollerOffset * 8 + 3] = ring.index;                     // ringIndex (stored in position.w or use separate field)
          instanceData[rollerOffset * 8 + 4] = Math.sin(selfRotAngle / 2);     // rotation.x
          instanceData[rollerOffset * 8 + 5] = 0;                              // rotation.y
          instanceData[rollerOffset * 8 + 6] = Math.sin(selfRotAngle / 2);     // rotation.z (roll around tangent)
          instanceData[rollerOffset * 8 + 7] = Math.cos(selfRotAngle / 2);     // rotation.w

          // Calculate proper rotation quaternion for rolling motion
          // The roller should roll around its own axis tangent to the ring
          const tangentAngle = angle + Math.PI / 2; // tangent to the ring
          const rollAxisX = Math.cos(tangentAngle);
          const rollAxisZ = Math.sin(tangentAngle);

          // Update rotation: around tangent axis for rolling
          instanceData[rollerOffset * 8 + 3] = ring.index;                     // ringIndex
          instanceData[rollerOffset * 8 + 4] = rollAxisX * Math.sin(selfRotAngle / 2);
          instanceData[rollerOffset * 8 + 5] = 0;
          instanceData[rollerOffset * 8 + 6] = rollAxisZ * Math.sin(selfRotAngle / 2);
          instanceData[rollerOffset * 8 + 7] = Math.cos(selfRotAngle / 2);

          rollerOffset++;
        }
      }
      this.device.queue.writeBuffer(this.rollerInstances, 0, instanceData);

      // Update pickup coil energy levels based on roller positions
      this.updatePickupCoilEnergies(instanceData);
    }
  }

  updatePickupCoilEnergies(rollerData) {
    if (!this.coilInstances) return;

    const numCoils = 24;
    const coilRadius = 7.0;

    // Initialize coil energies array if needed
    if (!this.coilEnergies) {
      this.coilEnergies = new Float32Array(numCoils);
    }

    // Coil data packed as vec4f pairs for the shader:
    // vec4f[0] = (position.xyz, rotation.x)
    // vec4f[1] = (rotation.yzw, energy)
    // Total: 2 vec4f = 8 floats per coil = 32 bytes per coil
    const coilInstanceData = new Float32Array(numCoils * 8);

    for (let i = 0; i < numCoils; i++) {
      const coilAngle = (i / numCoils) * Math.PI * 2;
      const coilX = Math.cos(coilAngle) * coilRadius;
      const coilZ = Math.sin(coilAngle) * coilRadius;

      // Find nearest roller and calculate energy
      let minDistance = Infinity;
      let nearestRollerSpeed = 0;

      // Check all 36 rollers (3 rings: 8 + 12 + 16)
      for (let r = 0; r < 36; r++) {
        const rollerX = rollerData[r * 8];
        const rollerZ = rollerData[r * 8 + 2];

        const dx = coilX - rollerX;
        const dz = coilZ - rollerZ;
        const dist = Math.sqrt(dx * dx + dz * dz);

        if (dist < minDistance) {
          minDistance = dist;
          // Ring speed factors: inner=2.0, middle=1.0, outer=0.5
          if (r < 8) nearestRollerSpeed = 2.0;
          else if (r < 20) nearestRollerSpeed = 1.0;
          else nearestRollerSpeed = 0.5;
        }
      }

      // Calculate energy: higher when rollers are closer, modulated by roller speed
      // Energy falls off with distance
      const energy = Math.max(0, 1 - minDistance / 3.0) * nearestRollerSpeed * 0.5;

      // Smooth energy transition
      this.coilEnergies[i] = this.coilEnergies[i] * 0.9 + energy * 0.1;

      // Rotation: face inward (toward center)
      // For a rotation around Y axis by angle = coilAngle + PI (180 degrees to face inward)
      const rotAngle = coilAngle + Math.PI;
      const rotY = Math.sin(rotAngle / 2);  // sin of half angle for Y component
      const rotW = Math.cos(rotAngle / 2);  // cos of half angle for W component

      // Pack data into two vec4f:
      // data0: position.xyz, rotation.x
      coilInstanceData[i * 8] = coilX;           // position.x
      coilInstanceData[i * 8 + 1] = 0;           // position.y
      coilInstanceData[i * 8 + 2] = coilZ;       // position.z
      coilInstanceData[i * 8 + 3] = 0;           // rotation.x (not used for Y-axis rotation)

      // data1: rotation.yzw, energy
      coilInstanceData[i * 8 + 4] = rotY;        // rotation.y
      coilInstanceData[i * 8 + 5] = 0;           // rotation.z
      coilInstanceData[i * 8 + 6] = rotW;        // rotation.w
      coilInstanceData[i * 8 + 7] = this.coilEnergies[i]; // energy
    }

    this.device.queue.writeBuffer(this.coilInstances, 0, coilInstanceData);

    // Update field line particles
    if (this.fieldLineParticles && this.fieldLineEnabled) {
      this.updateFieldLines(0.016);
    }

    // Update energy arcs
    if (this.arcSegments && this.energyArcEnabled) {
      this.updateEnergyArcs();
    }
  }

  updateFieldLines(deltaTime) {
    // Animate field line particles flowing along magnetic field lines
    const fieldData = new Float32Array(this.fieldLineCount * 8);
    const time = this.visualizer.time;

    for (let i = 0; i < this.fieldLineCount; i++) {
      const idx = i * 8;

      // Get ring for this particle
      const ringIdx = i % 3;
      const ringRadii = [2.5, 4.0, 5.5];
      const ringRadius = ringRadii[ringIdx];

      // Flow along circular magnetic field line
      const baseAngle = (i / this.fieldLineCount) * Math.PI * 20 + time * (0.5 + ringIdx * 0.3);
      const heightOffset = Math.sin(time * 0.5 + i * 0.1) * 0.8;

      // Position along magnetic field line
      fieldData[idx] = Math.cos(baseAngle) * ringRadius;
      fieldData[idx + 1] = heightOffset + (Math.random() - 0.5) * 0.2;
      fieldData[idx + 2] = Math.sin(baseAngle) * ringRadius;

      // Velocity tangent to field line
      const speed = 1.0 + ringIdx * 0.5;
      fieldData[idx + 3] = -Math.sin(baseAngle) * speed;
      fieldData[idx + 4] = Math.cos(time * 2 + i * 0.05) * 0.1;
      fieldData[idx + 5] = Math.cos(baseAngle) * speed;

      // Life cycles through 0-1
      fieldData[idx + 6] = (Math.sin(time * 2 + i * 0.5) * 0.5 + 0.5);

      // Strength varies by position
      fieldData[idx + 7] = 0.3 + 0.7 * Math.sin(baseAngle * 3 + time);
    }

    this.device.queue.writeBuffer(this.fieldLineParticles, 0, fieldData);
  }

  render(renderPass, globalUniformBuffer, skipEffects = false) {
    const scaledCount = Math.floor(this.particleCount * this.visualizer.profiler.qualityLevel);

    // Render core first (before rollers so rollers appear in front)
    if (this.id === 'seg' && !skipEffects) {
      this.renderCore(renderPass, globalUniformBuffer);
    }

    // Render pickup coils (outside the roller ring)
    if (this.id === 'seg' && !skipEffects) {
      this.renderPickupCoils(renderPass, globalUniformBuffer);
    }

    if (this.id === 'seg' && this.rollerInstances && !skipEffects) {
      const bindGroup = this.device.createBindGroup({
        layout: this.rollerPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: globalUniformBuffer } },
          { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
          { binding: 2, resource: { buffer: this.rollerInstances } },
          { binding: 3, resource: { buffer: this.materialUniformBuffer } }
        ]
      });

      renderPass.setPipeline(this.rollerPipeline);
      renderPass.setBindGroup(0, bindGroup);
      renderPass.setVertexBuffer(0, this.visualizer.cylinderBuffer.vertexBuffer);
      renderPass.setIndexBuffer(this.visualizer.cylinderBuffer.indexBuffer, 'uint16');
      renderPass.drawIndexed(this.visualizer.cylinderBuffer.indexCount, 36); // 3 rings: 8 + 12 + 16 = 36 rollers
    }

    // Render battery gauge (solar device only)
    if (this.id === 'solar' && this.gaugeInstanceBuffer) {
      const gaugeBindGroup = this.device.createBindGroup({
        layout: this.rollerPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: globalUniformBuffer } },
          { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
          { binding: 2, resource: { buffer: this.gaugeInstanceBuffer } },
          { binding: 3, resource: { buffer: this.materialUniformBuffer } }
        ]
      });

      renderPass.setPipeline(this.rollerPipeline);
      renderPass.setBindGroup(0, gaugeBindGroup);
      renderPass.setVertexBuffer(0, this.visualizer.batteryGaugeVertexBuffer);
      renderPass.setIndexBuffer(this.visualizer.batteryGaugeIndexBuffer, 'uint16');
      renderPass.drawIndexed(this.visualizer.batteryGaugeIndexCount, 1);
    }

    // Render field lines (before particles for proper blending)
    if (this.id === 'seg' && this.fieldLineParticles && this.fieldLineEnabled && !skipEffects) {
      const qualityScale = this.visualizer.profiler.qualityLevel;
      const fieldLineCount = Math.floor(this.fieldLineCount * qualityScale);

      const fieldLineBindGroup = this.device.createBindGroup({
        layout: this.fieldLinePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: globalUniformBuffer } },
          { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
          { binding: 4, resource: { buffer: this.fieldLineParticles } }
        ]
      });

      renderPass.setPipeline(this.fieldLinePipeline);
      renderPass.setBindGroup(0, fieldLineBindGroup);
      renderPass.draw(4, fieldLineCount);
    }

    // Render energy arcs (between nearby rollers)
    if (this.id === 'seg' && this.arcSegments && this.energyArcEnabled && !skipEffects) {
      const qualityScale = this.visualizer.profiler.qualityLevel;
      if (qualityScale > 0.5) {
        const arcCount = Math.floor(this.arcSegmentCount * qualityScale);

        const arcBindGroup = this.device.createBindGroup({
          layout: this.energyArcPipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: globalUniformBuffer } },
            { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
            { binding: 4, resource: { buffer: this.arcSegments } }
          ]
        });

        renderPass.setPipeline(this.energyArcPipeline);
        renderPass.setBindGroup(0, arcBindGroup);
        renderPass.draw(4, arcCount * 2); // Each arc uses 2 triangles
      }
    }

    const particleBindGroup = this.device.createBindGroup({
      layout: this.particlePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: globalUniformBuffer } },
        { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
        { binding: 3, resource: { buffer: this.materialUniformBuffer } },
        { binding: 4, resource: { buffer: this.particles } }
      ]
    });

    renderPass.setPipeline(this.particlePipeline);
    renderPass.setBindGroup(0, particleBindGroup);
    renderPass.draw(4, scaledCount);
  }

  renderCore(renderPass, globalUniformBuffer) {
    if (!this.corePipeline || !this.config.core) return;

    const coreBindGroup = this.device.createBindGroup({
      layout: this.corePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: globalUniformBuffer } },
        { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
        { binding: 3, resource: { buffer: this.coreMaterialBuffer } }
      ]
    });

    renderPass.setPipeline(this.corePipeline);
    renderPass.setBindGroup(0, coreBindGroup);

    const v = this.visualizer;

    // Render central shaft
    renderPass.setVertexBuffer(0, v.coreShaftBuffer.vertexBuffer);
    renderPass.setVertexBuffer(1, v.coreBoltInstanceBuffer); // Dummy, won't be used
    renderPass.setIndexBuffer(v.coreShaftBuffer.indexBuffer, 'uint16');
    renderPass.drawIndexed(v.coreShaftBuffer.indexCount, 1);

    // Render magnetic core (central cylinder)
    renderPass.setVertexBuffer(0, v.coreMagnetBuffer.vertexBuffer);
    renderPass.setIndexBuffer(v.coreMagnetBuffer.indexBuffer, 'uint16');
    renderPass.drawIndexed(v.coreMagnetBuffer.indexCount, 1);

    // Render top plate
    const plateOffsetTop = new Float32Array([0, this.config.core.plateY, 0]);
    const plateOffsetBottom = new Float32Array([0, -this.config.core.plateY, 0]);

    // Top plate - create temp buffer for offset
    const topPlateBuffer = this.device.createBuffer({
      size: 12,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(topPlateBuffer, 0, plateOffsetTop);

    renderPass.setVertexBuffer(0, v.corePlateBuffer.vertexBuffer);
    renderPass.setVertexBuffer(1, topPlateBuffer);
    renderPass.setIndexBuffer(v.corePlateBuffer.indexBuffer, 'uint16');
    renderPass.drawIndexed(v.corePlateBuffer.indexCount, 1);
    topPlateBuffer.destroy();

    // Bottom plate
    const bottomPlateBuffer = this.device.createBuffer({
      size: 12,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(bottomPlateBuffer, 0, plateOffsetBottom);

    renderPass.setVertexBuffer(1, bottomPlateBuffer);
    renderPass.drawIndexed(v.corePlateBuffer.indexCount, 1);
    bottomPlateBuffer.destroy();

    // Render bolts (instanced)
    renderPass.setVertexBuffer(0, v.coreBoltBuffer.vertexBuffer);
    renderPass.setVertexBuffer(1, v.coreBoltInstanceBuffer);
    renderPass.setIndexBuffer(v.coreBoltBuffer.indexBuffer, 'uint16');
    renderPass.drawIndexed(v.coreBoltBuffer.indexCount, v.coreBoltPositions.length / 3);
  }

  renderPickupCoils(renderPass, globalUniformBuffer) {
    if (!this.coilInstances || !this.coilPipeline) return;

    const numCoils = 24;

    // Render top connection ring (at y = +2.0)
    const topRingDeviceData = new Float32Array(8);
    topRingDeviceData.set([
      this.position[0], this.position[1] + 2.0, this.position[2],
      Math.sin(this.rotation[1] / 2), 0, Math.cos(this.rotation[1] / 2), 1.0,
      0, 0
    ]);
    const topRingDeviceBuffer = this.device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(topRingDeviceBuffer, 0, topRingDeviceData);

    const topRingBindGroup = this.device.createBindGroup({
      layout: this.ringPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: globalUniformBuffer } },
        { binding: 1, resource: { buffer: topRingDeviceBuffer } },
        { binding: 3, resource: { buffer: this.ringMaterialBuffer } }
      ]
    });

    renderPass.setPipeline(this.ringPipeline);
    renderPass.setBindGroup(0, topRingBindGroup);
    renderPass.setVertexBuffer(0, this.visualizer.connectionRingBuffer.vertexBuffer);
    renderPass.setIndexBuffer(this.visualizer.connectionRingBuffer.indexBuffer, 'uint16');
    renderPass.drawIndexed(this.visualizer.connectionRingBuffer.indexCount);

    // Render bottom connection ring (at y = -2.0)
    const bottomRingDeviceData = new Float32Array(8);
    bottomRingDeviceData.set([
      this.position[0], this.position[1] - 2.0, this.position[2],
      Math.sin(this.rotation[1] / 2), 0, Math.cos(this.rotation[1] / 2), 1.0,
      0, 0
    ]);
    const bottomRingDeviceBuffer = this.device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(bottomRingDeviceBuffer, 0, bottomRingDeviceData);

    const bottomRingBindGroup = this.device.createBindGroup({
      layout: this.ringPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: globalUniformBuffer } },
        { binding: 1, resource: { buffer: bottomRingDeviceBuffer } },
        { binding: 3, resource: { buffer: this.ringMaterialBuffer } }
      ]
    });

    renderPass.setBindGroup(0, bottomRingBindGroup);
    renderPass.drawIndexed(this.visualizer.connectionRingBuffer.indexCount);

    // Render coils
    const coilBindGroup = this.device.createBindGroup({
      layout: this.coilPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: globalUniformBuffer } },
        { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
        { binding: 2, resource: { buffer: this.coilInstances } },
        { binding: 3, resource: { buffer: this.coilMaterialBuffer } }
      ]
    });

    renderPass.setPipeline(this.coilPipeline);
    renderPass.setBindGroup(0, coilBindGroup);
    renderPass.setVertexBuffer(0, this.visualizer.coilBuffer.vertexBuffer);
    renderPass.draw(this.visualizer.coilBuffer.vertexCount, numCoils);
  }
}

export { DeviceInstance };