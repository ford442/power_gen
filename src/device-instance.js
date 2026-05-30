import { DeviceGeometry } from './device-geometry.js';
import { DevicePipelineManager } from './device-pipeline-manager.js';
import { DeviceUniformManager } from './device-uniforms.js';
import { DeviceComputeManager } from './device-compute.js';

class DeviceInstance {
  constructor(device, id, config, visualizer) {
    this.device = device;
    this.id = id;
    this.config = config;
    this.visualizer = visualizer;
    this.particleCount = config.particleCount;
    this.geometry = new DeviceGeometry(device, id, config, visualizer);
    this.pipelineManager = new DevicePipelineManager(device, id, visualizer);
    this.uniformManager = new DeviceUniformManager(device, id, config, visualizer);
    this.computeManager = new DeviceComputeManager(device, id, config, this.pipelineManager, this.geometry);
    
    // Delegate properties
    Object.defineProperty(this, 'particles', { get: () => this.geometry.particles });
    Object.defineProperty(this, 'rollerInstances', { get: () => this.geometry.rollerInstances });
    Object.defineProperty(this, 'fieldLineParticles', { get: () => this.geometry.fieldLineParticles });
    Object.defineProperty(this, 'energyArcParticles', { get: () => this.geometry.energyArcParticles });
    Object.defineProperty(this, 'coreInstances', { get: () => this.geometry.coreInstances });
    Object.defineProperty(this, 'shaftInstanceBuffer', { get: () => this.geometry.shaftInstanceBuffer });
    Object.defineProperty(this, 'magnetInstanceBuffer', { get: () => this.geometry.magnetInstanceBuffer });
    Object.defineProperty(this, 'topPlateInstanceBuffer', { get: () => this.geometry.topPlateInstanceBuffer });
    Object.defineProperty(this, 'bottomPlateInstanceBuffer', { get: () => this.geometry.bottomPlateInstanceBuffer });
    Object.defineProperty(this, 'rollerPipeline', { get: () => this.pipelineManager.rollerPipeline });
    Object.defineProperty(this, 'particlePipeline', { get: () => this.pipelineManager.particlePipeline });
    Object.defineProperty(this, 'corePipeline', { get: () => this.pipelineManager.corePipeline });
    Object.defineProperty(this, 'fieldLinePipeline', { get: () => this.pipelineManager.fieldLinePipeline });
    Object.defineProperty(this, 'energyArcPipeline', { get: () => this.pipelineManager.energyArcPipeline });
    Object.defineProperty(this, 'electromagnetInstances', { get: () => this.geometry.electromagnetInstances });
    Object.defineProperty(this, 'coilPipeline', { get: () => this.pipelineManager.coilPipeline });
    Object.defineProperty(this, 'segEnhancedPipeline', { get: () => this.pipelineManager.segEnhancedPipeline });
    Object.defineProperty(this, 'ringPipeline', { get: () => this.pipelineManager.ringPipeline });
    
    // Delegate uniform buffers to uniform manager for backward compatibility
    Object.defineProperty(this, 'deviceUniformBuffer', { 
      get: () => this.uniformManager.deviceUniformBuffer,
      set: (v) => { this.uniformManager.deviceUniformBuffer = v; }
    });
    Object.defineProperty(this, 'materialUniformBuffer', { 
      get: () => this.uniformManager.materialUniformBuffer,
      set: (v) => { this.uniformManager.materialUniformBuffer = v; }
    });
    Object.defineProperty(this, 'coreMaterialBuffer', { 
      get: () => this.uniformManager.coreMaterialBuffer,
      set: (v) => { this.uniformManager.coreMaterialBuffer = v; }
    });
    Object.defineProperty(this, 'gaugeInstanceBuffer', { 
      get: () => this.uniformManager.gaugeInstanceBuffer,
      set: (v) => { this.uniformManager.gaugeInstanceBuffer = v; }
    });
    Object.defineProperty(this, 'coilMaterialBuffer', { 
      get: () => this.uniformManager.coilMaterialBuffer,
      set: (v) => { this.uniformManager.coilMaterialBuffer = v; }
    });
    Object.defineProperty(this, 'ringMaterialBuffer', { 
      get: () => this.uniformManager.ringMaterialBuffer,
      set: (v) => { this.uniformManager.ringMaterialBuffer = v; }
    });
    Object.defineProperty(this, 'coilInstances', { 
      get: () => this.uniformManager.coilInstances,
      set: (v) => { this.uniformManager.coilInstances = v; }
    });
    Object.defineProperty(this, 'batteryCharge', { 
      get: () => this.uniformManager.batteryCharge,
      set: (v) => { this.uniformManager.batteryCharge = v; }
    });
    
    // Delegate compute buffers to compute manager for backward compatibility
    Object.defineProperty(this, 'computePipeline', { 
      get: () => this.computeManager.computePipeline,
      set: (v) => { this.computeManager.computePipeline = v; }
    });
    Object.defineProperty(this, 'computeBindGroup', { 
      get: () => this.computeManager.computeBindGroup,
      set: (v) => { this.computeManager.computeBindGroup = v; }
    });
    Object.defineProperty(this, 'computeUniformBuffer', { 
      get: () => this.computeManager.computeUniformBuffer,
      set: (v) => { this.computeManager.computeUniformBuffer = v; }
    });
    Object.defineProperty(this, 'scaledParticleCount', { 
      get: () => this.computeManager.scaledParticleCount,
      set: (v) => { this.computeManager.scaledParticleCount = v; }
    });
    Object.defineProperty(this, 'speedMult', { 
      get: () => this.computeManager.speedMult,
      set: (v) => { this.computeManager.speedMult = v; }
    });
    
    this.position = config.position;
    this.rotation = config.rotation;
    this.renderMode = 0;  // 0=rollers, 1=base, 2=stator, 3=wiring

    // Field line visualization (SEG only)
    this.fieldLineCount = 1200;
    this.fieldLineParticles = null;
    this.fieldLinePipeline = null;
    this.fieldLineEnabled = true;

    // Energy arc visualization (SEG only)
    this.arcSegmentCount = 20;
    this.arcSegments = null;
    this.energyArcPipeline = null;
    this.energyArcEnabled = true;
    this.lastArcTime = 0;
    
    // Additional state for rendering
    this.coilEnergies = null;
    this._lastCoilCount = null;
  }

  async init() {
    await this.uniformManager.setupUniforms();
    await this.pipelineManager.setupPipelines();
    await this.geometry.setupParticles();
    await this.computeManager.setupComputeResources();

    if (this.id === 'seg') {
      // Use the new unified initialization for SEG
      await this.geometry.initializeSEG();
    }
  }

  update(deltaTime, qualityScale) {
    // Scale particle count by quality
    const scaledParticleCount = Math.floor(this.particleCount * qualityScale);

    // Determine ring index for shaders: 0=SEG, 1=Heron, 2=Kelvin, 3=Solar, 4=Peltier
    const ringIndex = this.id === 'heron' ? 1 : (this.id === 'kelvin' ? 2 : (this.id === 'solar' ? 3 : (this.id === 'peltier' ? 4 : 0)));
    this.scaledParticleCount = scaledParticleCount;

    // Update battery charge for solar device (0..1)
    if (this.id === 'solar') {
      this.uniformManager.updateBatteryCharge(deltaTime);
      this.visualizer.updateBatteryGaugeMesh(this.batteryCharge);
      this.uniformManager.updateGaugeBuffer(this.position, ringIndex);
    }

    // Update device and material uniforms
    this.uniformManager.updateUniforms(this.position, this.rotation, this.renderMode);

    // Update compute uniforms for shader
    this.computeManager.updateComputeUniforms(this.visualizer.time, ringIndex, scaledParticleCount, this.speedMult);

    if (this.id === 'seg' && this.rollerInstances) {
      // 3-ring SEG system based on John Searl's design
      const instanceData = new Float32Array(36 * 12);
      const time = this.visualizer.time;

      // Ring specifications
      const rings = [
        { count: 8, radius: 2.5, scale: 0.6, speed: 2.0, index: 0 },   // Inner ring - fastest
        { count: 12, radius: 4.0, scale: 0.8, speed: 1.0, index: 1 },  // Middle ring - current
        { count: 16, radius: 5.5, scale: 1.0, speed: 0.5, index: 2 }   // Outer ring - slowest
      ];

      // Check if we should mirror real hardware phase
      const hw = this.visualizer.hardwareBridge;
      const useHardware = hw?.isConnected && hw?.mirrorEnabled;
      const hardwarePhaseRad = useHardware ? (hw.actualPhase * Math.PI / 180) : null;

      let rollerOffset = 0;

      for (const ring of rings) {
        // Per-ring startup ramp: inner ring spins up fastest
        const startupRamp = Math.min(time * (0.25 + ring.index * 0.1), 1.0);

        for (let i = 0; i < ring.count; i++) {
          const idx = rollerOffset * 12;

          // Per-roller speed jitter: subtle variation so motion feels organic, not mechanical
          const jitterNoise = Math.sin((rollerOffset * 127.3 + ring.index * 53.7));
          const speedJitter = 1.0 + 0.04 * Math.sin(time * 1.3 + jitterNoise * 12.7);

          // Orbital position around the central axis
          let angle;
          if (useHardware) {
            // Map hardware phase to this roller's position in the ring
            angle = (i / ring.count) * Math.PI * 2 + hardwarePhaseRad * ring.speed;
          } else {
            // Apply speed jitter and startup ramp for organic feel
            angle = (i / ring.count) * Math.PI * 2
                  + time * 0.5 * ring.speed * speedJitter * startupRamp
                  + ring.index * 0.22;   // slight per-ring phase offset
          }

          // Position in toroidal ring
          instanceData[idx] = Math.cos(angle) * ring.radius;     // x
          instanceData[idx + 1] = 0;                              // y
          instanceData[idx + 2] = Math.sin(angle) * ring.radius;  // z

          // Roller self-rotation (gear-like rolling motion)
          const gearRatio = ring.radius / ring.scale;
          const selfRotAngle = angle * gearRatio * 0.5;

          // Calculate proper rotation quaternion for rolling motion
          const tangentAngle = angle + Math.PI / 2;
          const rollAxisX = Math.cos(tangentAngle);
          const rollAxisZ = Math.sin(tangentAngle);

          // Store ring index and rotation
          instanceData[idx + 3] = ring.index;                     // ringIndex
          instanceData[idx + 4] = rollAxisX * Math.sin(selfRotAngle / 2);
          instanceData[idx + 5] = 0;
          instanceData[idx + 6] = rollAxisZ * Math.sin(selfRotAngle / 2);
          instanceData[idx + 7] = Math.cos(selfRotAngle / 2);

          // Alternating pole-band colors per roller (copper / oxide / neodymium / brass)
          const colorIdx = (i + ring.index * 3) % 4;
          const poleColors = [
            [0.85, 0.48, 0.22], // Fresh copper (N pole)
            [0.55, 0.30, 0.15], // Copper oxide (S pole)
            [0.72, 0.74, 0.76], // Neodymium silver
            [0.78, 0.58, 0.22], // Brass
          ];
          const color = poleColors[colorIdx];
          instanceData[idx + 8] = color[0];
          instanceData[idx + 9] = color[1];
          instanceData[idx + 10] = color[2];
          // Neodymium bands get slight emissive glow
          instanceData[idx + 11] = colorIdx === 2 ? 0.3 : 0.0;

          rollerOffset++;
        }
      }
      this.device.queue.writeBuffer(this.rollerInstances, 0, instanceData);

      // Update pickup coil energy levels based on roller positions
      this.updatePickupCoilEnergies(instanceData);

      // Update electromagnet coil activation visualization
      this.updateElectromagnetCoils();
    }
  }

  updateElectromagnetCoils() {
    if (!this.electromagnetInstances) return;

    const hw = this.visualizer.hardwareBridge;
    const em = this.visualizer.emController;
    const useHardware = hw?.isConnected && hw?.mirrorEnabled;

    let numCoils = em?.numCoils || 8;
    let coilMask = 0;
    let pwmValues = null;

    // Determine phase to use for commutation
    let phaseDeg;
    if (useHardware) {
      phaseDeg = hw.actualPhase;
      numCoils = hw.config.numCoils;
      // Use hardware-reported coil mask if available, otherwise compute
      coilMask = hw.coilMask || 0;
    } else if (em) {
      // Simulated: compute from visualizer time
      const simulatedSpeed = 30; // RPM for demo visualization
      phaseDeg = (this.visualizer.time * simulatedSpeed * 6) % 360;
      if (phaseDeg < 0) phaseDeg += 360;
      coilMask = em.computeCoilMask(phaseDeg, 1);
      pwmValues = em.computePwmValues(phaseDeg, 1);
    } else {
      return;
    }

    // If hardware is connected but coil mask is stale/empty, fall back to computed
    if (useHardware && coilMask === 0 && em) {
      coilMask = em.computeCoilMask(phaseDeg, 1);
    }

    // Update layout if coil count changed
    if (this._lastCoilCount !== numCoils) {
      this.geometry.updateElectromagnetLayout(numCoils, em?.offsetAngle || 0);
      this._lastCoilCount = numCoils;
    }

    // Read current instance data, update only the activeIntensity field
    // Format per instance: position(3) + angle(1) + activeIntensity(1) + coilIndex(1) + pad(2)
    const maxCoils = 24;
    const instanceData = new Float32Array(maxCoils * 8);
    const radius = 7.2;
    const offsetRad = ((em?.offsetAngle || 0) * Math.PI) / 180;

    // Traveling wave parameters for electromagnet pulse animation
    const t = this.visualizer.time;
    const waveSpeed = 3.0;

    for (let i = 0; i < maxCoils; i++) {
      const idx = i * 8;
      if (i < numCoils) {
        const angle = (i / numCoils) * Math.PI * 2 + offsetRad;
        instanceData[idx] = Math.cos(angle) * radius;
        instanceData[idx + 1] = 0.0;
        instanceData[idx + 2] = Math.sin(angle) * radius;
        instanceData[idx + 3] = angle;

        // Determine base active intensity from commutation state
        let intensity = 0;
        if (coilMask & (1 << i)) {
          intensity = pwmValues ? (pwmValues[i] / 255) : 1.0;
        }

        // Apply traveling wave pulse with per-coil phase offset
        const phaseOffset = (i / numCoils) * Math.PI * 2;
        const wave = 0.5 + 0.5 * Math.sin(t * waveSpeed - phaseOffset);
        if (intensity > 0) {
          // Active coil: strong pulse modulation
          intensity = intensity * (0.65 + 0.35 * wave);
        } else {
          // Inactive coil: faint ambient traveling glow
          intensity = wave * 0.06;
        }

        instanceData[idx + 4] = intensity;
        instanceData[idx + 5] = i;
        instanceData[idx + 6] = 0;
        instanceData[idx + 7] = 0;
      } else {
        instanceData[idx] = 0;
        instanceData[idx + 1] = -1000;
        instanceData[idx + 2] = 0;
        instanceData[idx + 3] = 0;
        instanceData[idx + 4] = 0;
        instanceData[idx + 5] = i;
        instanceData[idx + 6] = 0;
        instanceData[idx + 7] = 0;
      }
    }

    this.device.queue.writeBuffer(this.electromagnetInstances, 0, instanceData);
  }

  updatePickupCoilEnergies(rollerData) {
    if (!this.coilInstances) return;

    const numCoils = 24;
    const coilRadius = 7.0;

    // Initialize coil energies array if needed
    if (!this.coilEnergies) {
      this.coilEnergies = new Float32Array(numCoils);
    }

    // Coil data packed as vec4f pairs for the shader
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
        const rollerX = rollerData[r * 12];
        const rollerZ = rollerData[r * 12 + 2];

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
      const energy = Math.max(0, 1 - minDistance / 3.0) * nearestRollerSpeed * 0.5;

      // Smooth energy transition
      this.coilEnergies[i] = this.coilEnergies[i] * 0.9 + energy * 0.1;

      // Rotation: face inward (toward center)
      const rotAngle = coilAngle + Math.PI;
      const rotY = Math.sin(rotAngle / 2);
      const rotW = Math.cos(rotAngle / 2);

      // Pack data into two vec4f
      coilInstanceData[i * 8] = coilX;
      coilInstanceData[i * 8 + 1] = 0;
      coilInstanceData[i * 8 + 2] = coilZ;
      coilInstanceData[i * 8 + 3] = 0;

      coilInstanceData[i * 8 + 4] = rotY;
      coilInstanceData[i * 8 + 5] = 0;
      coilInstanceData[i * 8 + 6] = rotW;
      coilInstanceData[i * 8 + 7] = this.coilEnergies[i];
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

    // Render base first (for SEG)
    if (this.id === 'seg' && this.geometry.baseBuffer && !skipEffects) {
      this.renderBase(renderPass, globalUniformBuffer);
    }

    // Render stator rings (for SEG)
    if (this.id === 'seg' && this.geometry.statorRingBuffer && !skipEffects) {
      this.renderStatorRings(renderPass, globalUniformBuffer);
    }

    // Render wiring (for SEG) — fallback if enhanced wires not available
    if (this.id === 'seg' && this.geometry.wiringBuffer && !skipEffects && !this.visualizer.wireBuffers) {
      this.renderWiring(renderPass, globalUniformBuffer);
    }

    // Render support stand (beneath the device)
    if (this.id === 'seg' && !skipEffects) {
      this.renderStand(renderPass, globalUniformBuffer);
    }

    // Render core (before rollers so rollers appear in front)
    if (this.id === 'seg' && !skipEffects) {
      this.renderCore(renderPass, globalUniformBuffer);
    }

    // Render pickup coils (outside the roller ring)
    if (this.id === 'seg' && !skipEffects) {
      this.renderPickupCoils(renderPass, globalUniformBuffer);
    }

    // Render wire harnesses between coils
    if (this.id === 'seg' && !skipEffects) {
      this.renderWires(renderPass, globalUniformBuffer);
    }

    if (this.id === 'seg' && this.rollerInstances && this.segEnhancedPipeline && !skipEffects) {
      // Reset renderMode to 0 (rollers)
      this.renderMode = 0;
      const deviceData = new Float32Array([
        this.renderMode,
        this.position[0],
        this.position[1],
        this.position[2],
        Math.sin(this.rotation[1] / 2),
        0,
        Math.cos(this.rotation[1] / 2),
        1.0,
        1.0,
        0,
        this.id === 'solar' ? this.batteryCharge : 0,
        this.id === 'solar' ? 1 : 0
      ]);
      this.device.queue.writeBuffer(this.deviceUniformBuffer, 0, deviceData);

      const enhancedBindGroup = this.device.createBindGroup({
        layout: this.segEnhancedPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: globalUniformBuffer } },
          { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
          { binding: 2, resource: { buffer: this.rollerInstances } },
          { binding: 3, resource: { buffer: this.materialUniformBuffer } },
          { binding: 5, resource: { buffer: this.visualizer.lightingUniformBuffer } }
        ]
      });

      renderPass.setPipeline(this.segEnhancedPipeline);
      renderPass.setBindGroup(0, enhancedBindGroup);
      renderPass.setVertexBuffer(0, this.visualizer.enhancedRollerBuffer.vertexBuffer);
      renderPass.setIndexBuffer(this.visualizer.enhancedRollerBuffer.indexBuffer, 'uint16');
      renderPass.drawIndexed(this.visualizer.enhancedRollerBuffer.indexCount, 36);
    }

    // Render electromagnet coils (SEG only)
    if (this.id === 'seg' && this.electromagnetInstances && this.coilPipeline && !skipEffects) {
      const deviceData = new Float32Array([
        this.renderMode,
        this.position[0],
        this.position[1],
        this.position[2],
        Math.sin(this.rotation[1] / 2),
        0,
        Math.cos(this.rotation[1] / 2),
        1.0,
        1.0,
        0,
        this.id === 'solar' ? this.batteryCharge : 0,
        this.id === 'solar' ? 1 : 0
      ]);
      this.device.queue.writeBuffer(this.deviceUniformBuffer, 0, deviceData);

      // Coil material: copper base with orange glow potential
      const coilMaterialData = new Float32Array([
        0.75, 0.45, 0.25, 0,    // baseColor + pad
        1.0, 0.55, 0.0, 2.5      // glowColor (orange) + emission
      ]);
      const coilMaterialBuffer = this.device.createBuffer({
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      });
      this.device.queue.writeBuffer(coilMaterialBuffer, 0, coilMaterialData);

      const coilBindGroup = this.device.createBindGroup({
        layout: this.coilPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: globalUniformBuffer } },
          { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
          { binding: 2, resource: { buffer: this.electromagnetInstances } },
          { binding: 3, resource: { buffer: coilMaterialBuffer } }
        ]
      });

      renderPass.setPipeline(this.coilPipeline);
      renderPass.setBindGroup(0, coilBindGroup);
      renderPass.setVertexBuffer(0, this.visualizer.cylinderBuffer.vertexBuffer);
      renderPass.setIndexBuffer(this.visualizer.cylinderBuffer.indexBuffer, 'uint16');
      const numCoils = this.visualizer.emController?.numCoils || 8;
      renderPass.drawIndexed(this.visualizer.cylinderBuffer.indexCount, numCoils);

      coilMaterialBuffer.destroy();
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
        renderPass.draw(4, arcCount * 2);
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

  renderBase(renderPass, globalUniformBuffer) {
    if (!this.geometry.baseBuffer) return;
    
    // Set renderMode to 1 (base)
    this.renderMode = 1;
    const deviceData = new Float32Array([
      this.renderMode,
      this.position[0],
      this.position[1],
      this.position[2],
      Math.sin(this.rotation[1] / 2),
      0,
      Math.cos(this.rotation[1] / 2),
      1.0,
      1.0,
      0,
      this.id === 'solar' ? this.batteryCharge : 0,
      this.id === 'solar' ? 1 : 0
    ]);
    this.device.queue.writeBuffer(this.deviceUniformBuffer, 0, deviceData);
    
    const bindGroup = this.device.createBindGroup({
      layout: this.rollerPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: globalUniformBuffer } },
        { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
        { binding: 2, resource: { buffer: this.geometry.baseBuffer } },
        { binding: 3, resource: { buffer: this.materialUniformBuffer } }
      ]
    });

    renderPass.setPipeline(this.rollerPipeline);
    renderPass.setBindGroup(0, bindGroup);
    // Draw base as a cube/quad
    renderPass.setVertexBuffer(0, this.visualizer.cylinderBuffer.vertexBuffer);
    renderPass.setIndexBuffer(this.visualizer.cylinderBuffer.indexBuffer, 'uint16');
    renderPass.drawIndexed(this.visualizer.cylinderBuffer.indexCount, 1);
  }

  renderStatorRings(renderPass, globalUniformBuffer) {
    if (!this.geometry.statorRingBuffer) return;
    const v = this.visualizer;
    
    // Set renderMode to 2 (stator)
    this.renderMode = 2;
    const deviceData = new Float32Array([
      this.renderMode,
      this.position[0],
      this.position[1],
      this.position[2],
      Math.sin(this.rotation[1] / 2),
      0,
      Math.cos(this.rotation[1] / 2),
      1.0,
      1.0,
      0,
      this.id === 'solar' ? this.batteryCharge : 0,
      this.id === 'solar' ? 1 : 0
    ]);
    this.device.queue.writeBuffer(this.deviceUniformBuffer, 0, deviceData);
    
    // Use enhanced PBR pipeline if available (with UV geometry)
    if (this.segEnhancedPipeline && v.statorRingUVBuffer && v.lightingUniformBuffer) {
      const bindGroup = this.device.createBindGroup({
        layout: this.segEnhancedPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: globalUniformBuffer } },
          { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
          { binding: 2, resource: { buffer: this.geometry.statorRingBuffer } },
          { binding: 3, resource: { buffer: this.materialUniformBuffer } },
          { binding: 5, resource: { buffer: v.lightingUniformBuffer } }
        ]
      });

      renderPass.setPipeline(this.segEnhancedPipeline);
      renderPass.setBindGroup(0, bindGroup);
      renderPass.setVertexBuffer(0, v.statorRingUVBuffer.vertexBuffer);
      renderPass.setIndexBuffer(v.statorRingUVBuffer.indexBuffer, 'uint16');
      renderPass.drawIndexed(v.statorRingUVBuffer.indexCount, 3); // 3 rings
    } else {
      // Fallback to basic Blinn-Phong pipeline
      const bindGroup = this.device.createBindGroup({
        layout: this.rollerPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: globalUniformBuffer } },
          { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
          { binding: 2, resource: { buffer: this.geometry.statorRingBuffer } },
          { binding: 3, resource: { buffer: this.materialUniformBuffer } }
        ]
      });

      renderPass.setPipeline(this.rollerPipeline);
      renderPass.setBindGroup(0, bindGroup);
      renderPass.setVertexBuffer(0, v.cylinderBuffer.vertexBuffer);
      renderPass.setIndexBuffer(v.cylinderBuffer.indexBuffer, 'uint16');
      renderPass.drawIndexed(v.cylinderBuffer.indexCount, 3); // 3 rings
    }
  }

  renderWiring(renderPass, globalUniformBuffer) {
    if (!this.geometry.wiringBuffer) return;
    const v = this.visualizer;
    
    // Set renderMode to 3 (wiring)
    this.renderMode = 3;
    const deviceData = new Float32Array([
      this.renderMode,
      this.position[0],
      this.position[1],
      this.position[2],
      Math.sin(this.rotation[1] / 2),
      0,
      Math.cos(this.rotation[1] / 2),
      1.0,
      1.0,
      0,
      this.id === 'solar' ? this.batteryCharge : 0,
      this.id === 'solar' ? 1 : 0
    ]);
    this.device.queue.writeBuffer(this.deviceUniformBuffer, 0, deviceData);
    
    // Use enhanced PBR pipeline if available (with UV geometry)
    if (this.segEnhancedPipeline && v.wiringUVBuffer && v.lightingUniformBuffer) {
      const bindGroup = this.device.createBindGroup({
        layout: this.segEnhancedPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: globalUniformBuffer } },
          { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
          { binding: 2, resource: { buffer: this.geometry.wiringBuffer } },
          { binding: 3, resource: { buffer: this.materialUniformBuffer } },
          { binding: 5, resource: { buffer: v.lightingUniformBuffer } }
        ]
      });

      renderPass.setPipeline(this.segEnhancedPipeline);
      renderPass.setBindGroup(0, bindGroup);
      renderPass.setVertexBuffer(0, v.wiringUVBuffer.vertexBuffer);
      renderPass.setIndexBuffer(v.wiringUVBuffer.indexBuffer, 'uint16');
      renderPass.drawIndexed(v.wiringUVBuffer.indexCount, 8); // 8 wires
    } else {
      // Fallback to basic Blinn-Phong pipeline
      const bindGroup = this.device.createBindGroup({
        layout: this.rollerPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: globalUniformBuffer } },
          { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
          { binding: 2, resource: { buffer: this.geometry.wiringBuffer } },
          { binding: 3, resource: { buffer: this.materialUniformBuffer } }
        ]
      });

      renderPass.setPipeline(this.rollerPipeline);
      renderPass.setBindGroup(0, bindGroup);
      renderPass.setVertexBuffer(0, v.cylinderBuffer.vertexBuffer);
      renderPass.setIndexBuffer(v.cylinderBuffer.indexBuffer, 'uint16');
      renderPass.drawIndexed(v.cylinderBuffer.indexCount, 8); // 8 wires
    }
  }

  renderCore(renderPass, globalUniformBuffer) {
    if (!this.segEnhancedPipeline || !this.config.core) return;
    const v = this.visualizer;
    if (!v.coreShaftBuffer) return;

    // Helper to draw a component with the enhanced pipeline
    const drawComponent = (geomBuffer, instanceBuffer, instanceCount = 1) => {
      const bindGroup = this.device.createBindGroup({
        layout: this.segEnhancedPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: globalUniformBuffer } },
          { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
          { binding: 2, resource: { buffer: instanceBuffer } },
          { binding: 3, resource: { buffer: this.coreMaterialBuffer || this.materialUniformBuffer } },
          { binding: 5, resource: { buffer: v.lightingUniformBuffer } }
        ]
      });
      renderPass.setPipeline(this.segEnhancedPipeline);
      renderPass.setBindGroup(0, bindGroup);
      renderPass.setVertexBuffer(0, geomBuffer.vertexBuffer);
      renderPass.setIndexBuffer(geomBuffer.indexBuffer, 'uint16');
      renderPass.drawIndexed(geomBuffer.indexCount, instanceCount);
    };

    // Render central bearing shaft
    if (v.coreShaftBuffer && this.shaftInstanceBuffer) {
      drawComponent(v.coreShaftBuffer, this.shaftInstanceBuffer, 1);
    }

    // Render magnetic core (central cylinder)
    if (v.coreMagnetBuffer && this.magnetInstanceBuffer) {
      drawComponent(v.coreMagnetBuffer, this.magnetInstanceBuffer, 1);
    }

    // Render top plate
    if (v.corePlateBuffer && this.topPlateInstanceBuffer) {
      drawComponent(v.corePlateBuffer, this.topPlateInstanceBuffer, 1);
    }

    // Render bottom plate
    if (v.corePlateBuffer && this.bottomPlateInstanceBuffer) {
      drawComponent(v.corePlateBuffer, this.bottomPlateInstanceBuffer, 1);
    }

    // Render bolts
    if (v.coreBoltBuffer && v.coreBoltInstanceBuffer) {
      drawComponent(v.coreBoltBuffer, v.coreBoltInstanceBuffer, v.coreBoltPositions.length / 3);
    }
  }

  renderPickupCoils(renderPass, globalUniformBuffer) {
    if (!this.coilInstances || !this.coilPipeline || !this.ringPipeline) return;
    if (!this.visualizer.connectionRingBuffer || !this.visualizer.coilBuffer) return;

    const numCoils = 24;

    // Render top connection ring (at y = +2.0)
    const topRingDeviceData = new Float32Array(12);
    topRingDeviceData.set([
      this.renderMode,
      this.position[0], this.position[1] + 2.0, this.position[2],
      Math.sin(this.rotation[1] / 2), 0, Math.cos(this.rotation[1] / 2), 1.0,
      1.0, 0,
      this.id === 'solar' ? this.batteryCharge : 0,
      this.id === 'solar' ? 1 : 0
    ]);
    const topRingDeviceBuffer = this.device.createBuffer({
      size: 48,
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
    const bottomRingDeviceData = new Float32Array(12);
    bottomRingDeviceData.set([
      this.renderMode,
      this.position[0], this.position[1] - 2.0, this.position[2],
      Math.sin(this.rotation[1] / 2), 0, Math.cos(this.rotation[1] / 2), 1.0,
      1.0, 0,
      this.id === 'solar' ? this.batteryCharge : 0,
      this.id === 'solar' ? 1 : 0
    ]);
    const bottomRingDeviceBuffer = this.device.createBuffer({
      size: 48,
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

  renderStand(renderPass, globalUniformBuffer) {
    if (!this.segEnhancedPipeline || !this.visualizer.standBuffer) return;
    const v = this.visualizer;

    const bindGroup = this.device.createBindGroup({
      layout: this.segEnhancedPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: globalUniformBuffer } },
        { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
        { binding: 2, resource: { buffer: this.shaftInstanceBuffer } },
        { binding: 3, resource: { buffer: this.materialUniformBuffer } },
        { binding: 5, resource: { buffer: v.lightingUniformBuffer } }
      ]
    });

    renderPass.setPipeline(this.segEnhancedPipeline);
    renderPass.setBindGroup(0, bindGroup);
    renderPass.setVertexBuffer(0, v.standBuffer.vertexBuffer);
    renderPass.setIndexBuffer(v.standBuffer.indexBuffer, 'uint16');
    renderPass.drawIndexed(v.standBuffer.indexCount, 1);
  }

  renderWires(renderPass, globalUniformBuffer) {
    if (!this.segEnhancedPipeline || !this.visualizer.wireBuffers) return;
    const v = this.visualizer;

    for (let i = 0; i < v.wireBuffers.length; i++) {
      const wire = v.wireBuffers[i];
      const bindGroup = this.device.createBindGroup({
        layout: this.segEnhancedPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: globalUniformBuffer } },
          { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
          { binding: 2, resource: { buffer: this.shaftInstanceBuffer } },
          { binding: 3, resource: { buffer: this.materialUniformBuffer } },
          { binding: 5, resource: { buffer: v.lightingUniformBuffer } }
        ]
      });
      renderPass.setPipeline(this.segEnhancedPipeline);
      renderPass.setBindGroup(0, bindGroup);
      renderPass.setVertexBuffer(0, wire.vertexBuffer);
      renderPass.setIndexBuffer(wire.indexBuffer, 'uint16');
      renderPass.drawIndexed(wire.indexCount, 1);
    }
  }
}

export { DeviceInstance };
