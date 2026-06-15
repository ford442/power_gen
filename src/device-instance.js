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
    Object.defineProperty(this, 'energyArcParticles', { get: () => this.geometry.energyArcParticles });
    Object.defineProperty(this, 'coreInstances', { get: () => this.geometry.coreInstances });
    Object.defineProperty(this, 'shaftInstanceBuffer', { get: () => this.geometry.shaftInstanceBuffer });
    Object.defineProperty(this, 'magnetInstanceBuffer', { get: () => this.geometry.magnetInstanceBuffer });
    Object.defineProperty(this, 'topPlateInstanceBuffer', { get: () => this.geometry.topPlateInstanceBuffer });
    Object.defineProperty(this, 'bottomPlateInstanceBuffer', { get: () => this.geometry.bottomPlateInstanceBuffer });
    Object.defineProperty(this, 'rollerPipeline', { get: () => this.pipelineManager.rollerPipeline });
    Object.defineProperty(this, 'particlePipeline', { get: () => this.pipelineManager.particlePipeline });
    Object.defineProperty(this, 'energyArcPipeline', { get: () => this.pipelineManager.energyArcPipeline });
    Object.defineProperty(this, 'electromagnetInstances', { get: () => this.geometry.electromagnetInstances });
    Object.defineProperty(this, 'segEnhancedPipeline', { get: () => this.pipelineManager.segEnhancedPipeline });
    Object.defineProperty(this, 'fluxSegmentBuffer', { get: () => this.geometry.fluxSegmentBuffer });
    Object.defineProperty(this, 'fluxSegmentPipeline', { get: () => this.pipelineManager.fluxSegmentPipeline });
    
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

    // Field line visualization (SEG only) - now driven by RK4 flux segment ribbons
    this.fieldLineEnabled = true;

    // Energy arc visualization (SEG only)
    this.arcSegmentCount = 20;
    this.arcSegments = null;
    this.energyArcEnabled = true;
    this.lastArcTime = 0;
    
    // Additional state for rendering
    this.coilEnergies = null;
    this._lastCoilCount = null;

    // Pre-allocated roller position buffer (36 rollers × 2 floats) to reduce per-frame GC
    this._rollerPositions = new Float32Array(36 * 2);

    // Dynamic emitter effects (sparks/corona/mist/photon streaks), encoded as vec4f
    // per particle: xyz = local position, w = encoded phase/type.
    this.maxEffectParticles = 512;
    this.effectParticleCount = 0;
    this.effectsParticles = null;
    this._effectParticleData = new Float32Array(this.maxEffectParticles * 4);

    // Dynamic simulation-driven energy proxies (0..1)
    this.energyLevel = 0.0;
    this.pwmEnergyLevel = 0.0;
    this.flowEnergyLevel = 0.0;
    this.voltageEnergyLevel = 0.0;
  }

  async init() {
    await this.uniformManager.setupUniforms();
    await this.pipelineManager.setupPipelines();
    if (this.id !== 'seg') {
      await this.geometry.setupParticles();
      await this.computeManager.setupComputeResources();
    }
    this.setupEffectsParticles();

    if (this.id === 'seg') {
      // Unified SEG geometry initialization
      await this.geometry.initializeSEG();

      // Connect energy arc buffer (fixes arcSegments = null bug)
      this.arcSegments = this.geometry.energyArcParticles;

      // Set up GPU compute pipelines for rollers and RK4 flux lines
      await this.setupRollerCompute();
      await this.setupFluxLineTracer();

      await this.computeManager.setupComputeResources();
    }
  }

  /**
   * Set up the SEG roller GPU compute pipeline.
   * The shader computes all 36 roller positions, quaternions and colours so
   * the CPU only needs to derive 36 (x,z) pairs for coil-energy lookups.
   */
  async setupRollerCompute() {
    this.rollerComputeUniformBuffer = this.device.createBuffer({
      label: 'seg-roller-compute-uniforms',
      size: 16,  // [time f32, speedMult f32, pad f32, pad f32]
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

    const module = this.device.createShaderModule({
      label: 'seg-roller-compute-module',
      code: this.visualizer.shaders.segRollerComputeShader
    });

    this.rollerComputePipeline = await this.device.createComputePipelineAsync({
      label: 'seg-roller-compute-pipeline',
      layout: 'auto',
      compute: { module, entryPoint: 'main' }
    });

    this.rollerComputeBindGroup = this.device.createBindGroup({
      label: 'seg-roller-compute-bg',
      layout: this.rollerComputePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.geometry.rollerInstances } },
        { binding: 1, resource: { buffer: this.rollerComputeUniformBuffer } }
      ]
    });
  }

  /**
   * Set up the RK4 magnetic flux line tracer compute pipeline.
   * Uses `traceBidirectional` entry point from flux-lines.wgsl:
   * 1 thread per flux line (108 lines → 2 workgroups × 64 threads).
   * Each thread traces 50 steps forward + 50 backward via RK4 integration.
   *
   * Also pre-creates `fluxSegmentRenderBindGroup` so the render loop can
   * reuse it every frame without a per-frame allocation.
   */
  async setupFluxLineTracer() {
    // FluxUniforms: time, deltaTime, integrationStep, lineOpacity, seedRadius, followStrength, _pad
    // = 7 × f32 = 28 bytes, aligned to 32 bytes
    this.fluxTracerUniformBuffer = this.device.createBuffer({
      label: 'flux-tracer-uniforms',
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

    const module = this.device.createShaderModule({
      label: 'flux-tracer-module',
      code: this.visualizer.shaders.fluxLineTracerShader
    });

    this.fluxTracerPipeline = await this.device.createComputePipelineAsync({
      label: 'flux-tracer-pipeline',
      layout: 'auto',
      compute: { module, entryPoint: 'traceBidirectional' }
    });

    this.fluxTracerBindGroup = this.device.createBindGroup({
      label: 'flux-tracer-bg',
      layout: this.fluxTracerPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.geometry.fluxSegmentBuffer } },
        { binding: 1, resource: { buffer: this.fluxTracerUniformBuffer } }
      ]
    });

    // Pre-create the render bind group so render() can reuse it every frame.
    // globalUniformBuffer and deviceUniformBuffer never change buffer identity
    // (only their contents are updated via writeBuffer), so this is safe.
    this.fluxSegmentRenderBindGroup = this.device.createBindGroup({
      label: 'flux-segment-render-bg',
      layout: this.pipelineManager.fluxSegmentPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.visualizer.globalUniformBuffer } },
        { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
        { binding: 2, resource: { buffer: this.geometry.fluxSegmentBuffer } }
      ]
    });
  }

  getRingIndex() {
    if (this.id === 'heron') return 1;
    if (this.id === 'kelvin') return 2;
    if (this.id === 'solar') return 3;
    if (this.id === 'peltier') return 4;
    if (this.id === 'mhd') return 5;
    return 0;
  }

  _computeEnergyLevel(deltaTime) {
    const speed = Math.max(0.0, this.speedMult || 1.0);
    const speedNorm = Math.min(1.0, Math.log2(speed + 1.0) / Math.log2(21.0));
    const overdrive = Math.max(0.0, speed - 1.0);
    const overdriveBoost = Math.min(1.0, 1.0 - Math.exp(-overdrive * 0.18));

    let deviceEnergy = speedNorm * 0.4 + overdriveBoost * 0.25;
    if (this.id === 'seg') {
      const coilMean = this.coilEnergies && this.coilEnergies.length
        ? this.coilEnergies.reduce((sum, v) => sum + v, 0) / this.coilEnergies.length
        : 0.0;
      const coilNorm = Math.min(1.0, coilMean * 1.6);
      deviceEnergy = speedNorm * 0.35 + coilNorm * 0.35 + this.pwmEnergyLevel * 0.30;
    } else if (this.id === 'kelvin') {
      this.voltageEnergyLevel = Math.min(1.0, speedNorm * 0.65 + (0.5 + 0.5 * Math.sin(this.visualizer.time * 3.2)) * 0.35);
      deviceEnergy = this.voltageEnergyLevel;
    } else if (this.id === 'heron') {
      this.flowEnergyLevel = Math.min(1.0, speedNorm * 0.7 + (0.5 + 0.5 * Math.sin(this.visualizer.time * 1.6)) * 0.3);
      deviceEnergy = this.flowEnergyLevel;
    } else if (this.id === 'solar') {
      const battery = Math.min(1.0, Math.max(0.0, this.batteryCharge || 0.0));
      deviceEnergy = battery * 0.65 + speedNorm * 0.35;
    } else if (this.id === 'peltier') {
      deviceEnergy = Math.min(1.0, speedNorm * 0.6 + overdriveBoost * 0.4);
    } else if (this.id === 'mhd') {
      deviceEnergy = Math.min(1.0, speedNorm * 0.5 + overdriveBoost * 0.5);
    }

    // Exponential response in high-energy regime to make overdrive feel dangerous.
    const boosted = Math.pow(Math.max(0.0, deviceEnergy), 0.75);
    const target = Math.min(1.0, boosted + overdriveBoost * 0.35);
    const smooth = 1.0 - Math.exp(-Math.max(0.0, deltaTime) * 14.0);
    this.energyLevel = this.energyLevel + (target - this.energyLevel) * smooth;
    this.energyLevel = Math.min(1.0, Math.max(0.0, this.energyLevel));
  }

  _buildDeviceUniformData(renderMode, yOffset = 0.0) {
    const ringIndex = this.getRingIndex();
    return new Float32Array([
      renderMode,
      this.position[0],
      this.position[1] + yOffset,
      this.position[2],
      Math.sin(this.rotation[1] / 2),
      0,
      Math.cos(this.rotation[1] / 2),
      1.0,
      this.energyLevel,
      ringIndex,
      this.id === 'solar' ? this.batteryCharge : 0,
      this.id === 'solar' ? 1 : 0
    ]);
  }

  update(deltaTime, qualityScale) {
    // Scale particle count by quality
    const scaledParticleCount = Math.floor(this.particleCount * qualityScale);

    // Determine ring index for shaders: 0=SEG, 1=Heron, 2=Kelvin, 3=Solar, 4=Peltier, 5=MHD
    const ringIndex = this.getRingIndex();
    this.scaledParticleCount = scaledParticleCount;

    // Update battery charge for solar device (0..1)
    if (this.id === 'solar') {
      this.uniformManager.updateBatteryCharge(deltaTime);
      this.visualizer.updateBatteryGaugeMesh(this.batteryCharge);
      this.uniformManager.updateGaugeBuffer(this.position, ringIndex);
    }

    // Update compute uniforms for shader
    this.computeManager.updateComputeUniforms(this.visualizer.time, ringIndex, scaledParticleCount, this.speedMult);

    if (this.id === 'seg' && this.rollerInstances) {
      const time = this.visualizer.time;
      const speedMult = this.speedMult || 1.0;

      // Write GPU compute uniforms BEFORE the compute pass is dispatched.
      // `time` is already speed-scaled by the visualizer; the shader uses it
      // directly so there is no double-multiplication.
      if (this.rollerComputeUniformBuffer) {
        this.device.queue.writeBuffer(
          this.rollerComputeUniformBuffer, 0,
          new Float32Array([time, speedMult, 0, 0])
        );
      }
      // Write flux tracer uniforms: time, deltaTime, integrationStep,
      // lineOpacity, seedRadius, followStrength, _pad, _pad.
      // seedRadius now controls the minor radius of the flux torus;
      // followStrength scales the poloidal twist (helicity).
      if (this.fluxTracerUniformBuffer) {
        this.device.queue.writeBuffer(
          this.fluxTracerUniformBuffer, 0,
          new Float32Array([time, deltaTime, 0.02, 0.45, 0.35, 2.0, 0.0, 0.0])
        );
      }

      // Lightweight CPU coil-energy calculation.
      // We only need 36 (x, z) pairs — no quaternions, no colour lookup, no
      // buffer write — so the tight inner-loop is ~10× cheaper than before.
      const hw = this.visualizer.hardwareBridge;
      const useHardware = hw?.isConnected && hw?.mirrorEnabled;
      const hardwarePhaseRad = useHardware ? (hw.actualPhase * Math.PI / 180) : null;

      const rings = [
        { count: 8,  radius: 2.5, speed: 2.0, index: 0 },
        { count: 12, radius: 4.0, speed: 1.0, index: 1 },
        { count: 16, radius: 5.5, speed: 0.5, index: 2 }
      ];

      // Compact roller positions: [x0,z0, x1,z1, ..., x35,z35] — reuse pre-allocated buffer
      const rollerPositions = this._rollerPositions;
      let rollerOffset = 0;
      for (const ring of rings) {
        const startupRamp = Math.min(time * (0.25 + ring.index * 0.1), 1.0);
        for (let i = 0; i < ring.count; i++) {
          const jitterNoise = Math.sin(rollerOffset * 127.3 + ring.index * 53.7);
          const speedJitter = 1.0 + 0.04 * Math.sin(time * 1.3 + jitterNoise * 12.7);
          let angle;
          if (useHardware) {
            angle = (i / ring.count) * Math.PI * 2 + hardwarePhaseRad * ring.speed;
          } else {
            angle = (i / ring.count) * Math.PI * 2
                  + time * 0.5 * ring.speed * speedJitter * startupRamp
                  + ring.index * 0.22;
          }
          rollerPositions[rollerOffset * 2]     = Math.cos(angle) * ring.radius;
          rollerPositions[rollerOffset * 2 + 1] = Math.sin(angle) * ring.radius;
          rollerOffset++;
        }
      }

      // Update pickup coil energy levels from compact positions
      this.updatePickupCoilEnergies(rollerPositions, true);

      // Update electromagnet coil activation visualization
      this.updateElectromagnetCoils();
    }

    this._computeEnergyLevel(deltaTime);
    this.uniformManager.updateUniforms(this.position, this.rotation, this.renderMode, this.energyLevel);
    this.updateEmitterEffects(deltaTime, qualityScale);
  }

  setupEffectsParticles() {
    this.effectsParticles = this.device.createBuffer({
      size: this.maxEffectParticles * 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    this.visualizer.profiler.trackBuffer(
      `device-${this.id}-effects-particles`,
      this.maxEffectParticles * 16,
      GPUBufferUsage.STORAGE
    );
  }

  updateEmitterEffects(deltaTime, qualityScale) {
    if (!this.effectsParticles) {
      this.effectParticleCount = 0;
      return;
    }

    const t = this.visualizer.time;
    const speedMult = this.speedMult || 1.0;
    const energy = this.energyLevel;
    const quality = Math.max(0.0, Math.min(1.0, Math.min(qualityScale, this.visualizer.profiler.qualityLevel)));
    const budget = Math.min(
      this.maxEffectParticles,
      Math.floor(this.maxEffectParticles * quality * Math.min(1.0, 0.28 + speedMult * 0.18 + Math.pow(energy, 1.35) * 0.7))
    );
    if (budget <= 0) {
      this.effectParticleCount = 0;
      return;
    }

    const gate = (value, low, high) => {
      if (high <= low) return value > high ? 1 : 0;
      return Math.max(0, Math.min(1, (value - low) / (high - low)));
    };

    const pushParticle = (x, y, z, phaseEncoded) => {
      if (this.effectParticleCount >= budget) return;
      const idx = this.effectParticleCount * 4;
      this._effectParticleData[idx] = x;
      this._effectParticleData[idx + 1] = y;
      this._effectParticleData[idx + 2] = z;
      this._effectParticleData[idx + 3] = phaseEncoded;
      this.effectParticleCount++;
    };

    this.effectParticleCount = 0;

    if (this.id === 'seg') {
      const coilEnergy = this.coilEnergies
        ? this.coilEnergies.reduce((sum, e) => sum + e, 0) / this.coilEnergies.length
        : 0;
      const coronaStrength = Math.max(0.0, Math.min(1.0, (speedMult - 1.0) * 0.08 + coilEnergy * 0.35 + Math.pow(energy, 1.4) * 0.45));
      const coronaCount = Math.floor((10 + budget * 0.22) * coronaStrength);
      for (let i = 0; i < coronaCount; i++) {
        const a = (i / Math.max(1, coronaCount)) * Math.PI * 2 + t * (0.35 + coronaStrength);
        const ring = i % 3;
        const radius = (ring === 0 ? 2.4 : ring === 1 ? 3.9 : 5.4) + Math.sin(i * 2.31 + t) * 0.16;
        const y = (Math.sin(i * 1.93 + t * 1.9) * 0.8 + (Math.random() - 0.5) * 0.3) * (0.45 + coronaStrength * 0.55);
        pushParticle(Math.cos(a) * radius, y, Math.sin(a) * radius, 2.0 + Math.random());
      }

      const burstBase = Math.floor(budget * (0.04 + coronaStrength * 0.18));
      for (let i = 0; i < burstBase; i++) {
        const a = Math.random() * Math.PI * 2;
        const radius = 3.0 + Math.random() * 2.6;
        const y = (Math.random() - 0.5) * 1.8;
        pushParticle(Math.cos(a) * radius, y, Math.sin(a) * radius, 1.0 + Math.random());
      }
    } else if (this.id === 'kelvin') {
      const voltageProxy = Math.max(0.0, Math.min(1.0, this.voltageEnergyLevel * 0.7 + Math.pow(energy, 1.2) * 0.5));
      const sparkGate = Math.pow(gate(voltageProxy, 0.24, 0.60), 1.4);
      const branchGate = Math.pow(gate(voltageProxy, 0.58, 0.92), 1.8);
      const sparkCount = Math.floor(budget * 0.58 * sparkGate);
      for (let i = 0; i < sparkCount; i++) {
        const side = i % 2 === 0 ? -1 : 1;
        const y = -2.4 + Math.random() * 8.0;
        const z = (Math.random() - 0.5) * 1.0;
        pushParticle(side * (2.2 + Math.random() * 0.8), y, z, 1.0 + Math.random());
      }

      const filamentCount = Math.floor(budget * 0.16 * sparkGate);
      for (let i = 0; i < filamentCount; i++) {
        const y = -2.8 + (i / Math.max(1, filamentCount)) * 8.8;
        const wobble = Math.sin(i * 1.7 + t * 7.0) * 0.22;
        pushParticle(wobble, y, (Math.random() - 0.5) * 0.4, 3.0 + Math.random());
      }
      const branchCount = Math.floor(budget * 0.24 * branchGate);
      for (let i = 0; i < branchCount; i++) {
        const side = i % 2 === 0 ? -1 : 1;
        const trunk = (Math.random() - 0.5) * 0.5;
        const y = -2.5 + Math.random() * 8.4;
        const z = (Math.random() - 0.5) * (0.5 + branchGate * 1.2);
        pushParticle(side * (0.6 + Math.random() * 2.0) + trunk, y, z, 6.0 + Math.random());
      }
    } else if (this.id === 'heron') {
      const flowGate = Math.pow(gate(this.flowEnergyLevel, 0.18, 0.58), 1.2);
      const impactGate = Math.pow(gate(this.flowEnergyLevel, 0.55, 0.90), 1.6);
      const mistCount = Math.floor(budget * 0.56 * flowGate);
      const clusterA = [Math.sin(t * 0.8) * 0.25, 5.2 + Math.sin(t * 1.2) * 0.12, Math.cos(t * 0.9) * 0.25];
      const clusterB = [-clusterA[0], 5.7 + Math.cos(t * 1.1) * 0.12, -clusterA[2]];
      for (let i = 0; i < mistCount; i++) {
        const c = i % 2 === 0 ? clusterA : clusterB;
        const r = Math.random() * 1.1;
        const a = Math.random() * Math.PI * 2;
        pushParticle(c[0] + Math.cos(a) * r, c[1] + (Math.random() - 0.5) * 1.5, c[2] + Math.sin(a) * r, Math.random());
      }
      const rippleCount = Math.floor(budget * 0.30 * impactGate);
      for (let i = 0; i < rippleCount; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = 0.3 + Math.random() * 1.3;
        const y = -1.9 + Math.random() * 0.35;
        pushParticle(Math.cos(a) * r, y, Math.sin(a) * r, 5.0 + Math.random());
      }
    } else if (this.id === 'solar') {
      const batteryGate = Math.pow(gate(this.batteryCharge * 0.75 + energy * 0.25, 0.20, 0.78), 1.3);
      const refractGate = Math.pow(gate(this.batteryCharge * 0.6 + energy * 0.4, 0.55, 0.92), 1.8);
      const photonCount = Math.floor(budget * 0.45 * batteryGate);
      for (let i = 0; i < photonCount; i++) {
        const led = i % 6;
        const a = (led / 6) * Math.PI * 2 + (Math.random() - 0.5) * 0.18;
        const r = 3.0 + Math.random() * 0.6;
        const y = 2.8 + Math.random() * 1.2;
        pushParticle(Math.cos(a) * r, y, Math.sin(a) * r, 1.0 + Math.random());
      }
      const refractCount = Math.floor(budget * 0.20 * refractGate);
      for (let i = 0; i < refractCount; i++) {
        const x = (Math.random() - 0.5) * 5.8;
        const z = (Math.random() - 0.5) * 5.8;
        const y = 0.9 + Math.random() * 0.5;
        pushParticle(x, y, z, 7.0 + Math.random());
      }
    } else if (this.id === 'peltier') {
      const thermalGate = Math.pow(gate(energy, 0.24, 0.70), 1.4);
      const thermalCount = Math.floor(budget * 0.36 * thermalGate);
      for (let i = 0; i < thermalCount; i++) {
        const x = (Math.random() - 0.5) * 3.2;
        const y = (Math.random() - 0.5) * 1.8;
        const z = (Math.random() - 0.5) * 2.6;
        pushParticle(x, y, z, 3.0 + Math.random());
      }
    } else if (this.id === 'mhd') {
      const channelGate = Math.pow(gate(energy, 0.22, 0.68), 1.45);
      const filamentCount = Math.floor(budget * 0.40 * channelGate);
      for (let i = 0; i < filamentCount; i++) {
        const drift = Math.sin(t * 1.6 + i * 0.23) * 0.8;
        const x = (Math.random() - 0.5) * 4.4 + drift;
        const y = (Math.random() - 0.5) * 2.4;
        const z = (Math.random() - 0.5) * 1.8;
        pushParticle(x, y, z, 3.0 + Math.random());
      }
    }

    // Subtle thermal haze billboards around hot devices.
    if ((this.id === 'seg' || this.id === 'peltier' || this.id === 'mhd') && energy > 0.35) {
      const hazeCount = Math.floor(budget * Math.pow(gate(energy, 0.35, 0.9), 1.4) * 0.18);
      for (let i = 0; i < hazeCount; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = 2.4 + Math.random() * 3.0;
        const y = (Math.random() - 0.5) * 2.2;
        pushParticle(Math.cos(a) * r, y, Math.sin(a) * r, 4.0 + Math.random());
      }
    }

    if (this.effectParticleCount > 0) {
      this.device.queue.writeBuffer(
        this.effectsParticles,
        0,
        this._effectParticleData,
        0,
        this.effectParticleCount * 4
      );
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
      this.pwmEnergyLevel = 0.0;
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

    // Instance data in canonical InstanceData format: position(3)+ringIndex(1)+rotation(4)+color(3)+emissive(1)
    const maxCoils = 24;
    const instanceData = new Float32Array(maxCoils * 12);
    const radius = 7.2;
    const offsetRad = ((em?.offsetAngle || 0) * Math.PI) / 180;

    // Traveling wave parameters for electromagnet pulse animation
    const t = this.visualizer.time;
    const waveSpeed = 3.0;

    for (let i = 0; i < maxCoils; i++) {
      const idx = i * 12;
      if (i < numCoils) {
        const angle = (i / numCoils) * Math.PI * 2 + offsetRad;
        instanceData[idx]     = Math.cos(angle) * radius;
        instanceData[idx + 1] = 0.0;
        instanceData[idx + 2] = Math.sin(angle) * radius;
        instanceData[idx + 3] = 0.0; // ringIndex

        // Y-axis quaternion from angle
        instanceData[idx + 4] = 0.0;
        instanceData[idx + 5] = Math.sin(angle / 2);
        instanceData[idx + 6] = 0.0;
        instanceData[idx + 7] = Math.cos(angle / 2);

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

        instanceData[idx + 8]  = 0.75; // copper R
        instanceData[idx + 9]  = 0.45; // copper G
        instanceData[idx + 10] = 0.25; // copper B
        instanceData[idx + 11] = intensity;
      } else {
        // Hide unused coils below the floor
        instanceData[idx]     = 0;
        instanceData[idx + 1] = -1000;
        instanceData[idx + 2] = 0;
        instanceData[idx + 3] = 0;
        instanceData[idx + 4] = 0;
        instanceData[idx + 5] = 0;
        instanceData[idx + 6] = 0;
        instanceData[idx + 7] = 1;
        instanceData[idx + 8]  = 0.75;
        instanceData[idx + 9]  = 0.45;
        instanceData[idx + 10] = 0.25;
        instanceData[idx + 11] = 0;
      }
    }

    if (numCoils > 0) {
      let activeSum = 0;
      for (let i = 0; i < numCoils; i++) activeSum += instanceData[i * 12 + 11];
      this.pwmEnergyLevel = Math.min(1.0, activeSum / numCoils);
    } else {
      this.pwmEnergyLevel = 0.0;
    }

    this.device.queue.writeBuffer(this.electromagnetInstances, 0, instanceData);
  }

  /**
   * Update pickup coil energy levels from roller positions.
   * @param {Float32Array} rollerData  Either:
   *   - compact=false (legacy): 36×12 floats, x at [r*12], z at [r*12+2]
   *   - compact=true (new GPU path): 36×2 floats, [x0,z0, x1,z1, ...]
   * @param {boolean} compact  True when using the lightweight 2-float-per-roller layout.
   */
  updatePickupCoilEnergies(rollerData, compact = false) {
    if (!this.coilInstances) return;

    const numCoils = 24;
    const coilRadius = 7.0;

    // Initialize coil energies array if needed
    if (!this.coilEnergies) {
      this.coilEnergies = new Float32Array(numCoils);
    }

    // Coil data in canonical InstanceData: position(3)+ringIndex(1)+rotation(4)+color(3)+emissive(1)
    const coilInstanceData = new Float32Array(numCoils * 12);

    for (let i = 0; i < numCoils; i++) {
      const coilAngle = (i / numCoils) * Math.PI * 2;
      const coilX = Math.cos(coilAngle) * coilRadius;
      const coilZ = Math.sin(coilAngle) * coilRadius;

      // Find nearest roller and calculate energy
      let minDistance = Infinity;
      let nearestRollerSpeed = 0;

      // Check all 36 rollers (3 rings: 8 + 12 + 16)
      for (let r = 0; r < 36; r++) {
        const rollerX = compact ? rollerData[r * 2]     : rollerData[r * 12];
        const rollerZ = compact ? rollerData[r * 2 + 1] : rollerData[r * 12 + 2];

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

      // Rotation around the local Y axis
      const rotAngle = coilAngle + Math.PI;
      const rotY = Math.sin(rotAngle / 2);
      const rotW = Math.cos(rotAngle / 2);

      const idx = i * 12;
      coilInstanceData[idx]     = coilX;
      coilInstanceData[idx + 1] = 0;
      coilInstanceData[idx + 2] = coilZ;
      coilInstanceData[idx + 3] = 0.0;          // ringIndex

      coilInstanceData[idx + 4] = 0.0;          // quaternion x
      coilInstanceData[idx + 5] = rotY;         // quaternion y
      coilInstanceData[idx + 6] = 0.0;          // quaternion z
      coilInstanceData[idx + 7] = rotW;         // quaternion w

      coilInstanceData[idx + 8]  = 0.75;        // copper R
      coilInstanceData[idx + 9]  = 0.45;        // copper G
      coilInstanceData[idx + 10] = 0.25;        // copper B
      coilInstanceData[idx + 11] = this.coilEnergies[i]; // emissive
    }

    this.device.queue.writeBuffer(this.coilInstances, 0, coilInstanceData);

    // Update energy arcs
    if (this.arcSegments && this.energyArcEnabled) {
      this.updateEnergyArcs();
    }
  }

  /**
   * Animate energy arc particles (called when arcSegments is non-null).
   * Distributes short arc segments around the stator coil ring.
   */
  updateEnergyArcs() {
    if (!this.arcSegments) return;
    const arcCount = 200;
    const arcData = new Float32Array(arcCount * 8);
    const time = this.visualizer.time;
    const speedMult = this.speedMult || 1.0;

    for (let i = 0; i < arcCount; i++) {
      const idx = i * 8;
      // Spread arcs around the outer coil ring
      const arcAngle = (i / arcCount) * Math.PI * 2 + time * 0.3 * speedMult;
      const arcRadius = 5.5 + (Math.random() - 0.5) * 0.8;
      const arcHeight = (Math.random() - 0.5) * 0.6;

      arcData[idx]     = Math.cos(arcAngle) * arcRadius;
      arcData[idx + 1] = arcHeight;
      arcData[idx + 2] = Math.sin(arcAngle) * arcRadius;

      // Velocity: outward radial
      arcData[idx + 3] = Math.cos(arcAngle) * 0.5;
      arcData[idx + 4] = 0.1;
      arcData[idx + 5] = Math.sin(arcAngle) * 0.5;

      // Life and intensity
      arcData[idx + 6] = Math.sin(time * 5.0 * speedMult + i * 0.3) * 0.3 + 0.5;
      arcData[idx + 7] = Math.min(0.55, 0.12 + 0.35 * speedMult * 0.12);
    }

    this.device.queue.writeBuffer(this.arcSegments, 0, arcData);
  }

  render(renderPass, globalUniformBuffer, skipEffects = false) {
    const scaledCount = Math.floor(this.particleCount * this.visualizer.profiler.qualityLevel);

    // Core SEG mesh — always drawn (skipEffects only gates VFX below).
    if (this.id === 'seg' && this.visualizer.basePlateBuffer) {
      this.renderBase(renderPass, globalUniformBuffer);
    }

    if (this.id === 'seg' && this.geometry.statorRingBuffer) {
      this.renderStatorRings(renderPass, globalUniformBuffer);
    }

    if (this.id === 'seg' && this.geometry.wiringBuffer && !this.visualizer.wireBuffers) {
      this.renderWiring(renderPass, globalUniformBuffer);
    }

    if (this.id === 'seg') {
      this.renderStand(renderPass, globalUniformBuffer);
    }

    if (this.id === 'seg') {
      this.renderCore(renderPass, globalUniformBuffer);
    }

    if (this.id === 'seg') {
      this.renderPickupCoils(renderPass, globalUniformBuffer);
    }

    if (this.id === 'seg') {
      this.renderWires(renderPass, globalUniformBuffer);
    }

    if (this.id === 'seg' && this.rollerInstances && this.segEnhancedPipeline) {
      // Reset renderMode to 0 (rollers)
      this.renderMode = 0;
      const deviceData = this._buildDeviceUniformData(this.renderMode);
      this.device.queue.writeBuffer(this.deviceUniformBuffer, 0, deviceData);

      const enhancedBindGroup = this.device.createBindGroup({
        layout: this.segEnhancedPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: globalUniformBuffer } },
          { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
          { binding: 2, resource: { buffer: this.rollerInstances } },
          { binding: 3, resource: { buffer: this.materialUniformBuffer } },
          { binding: 5, resource: { buffer: this.visualizer.lightingUniformBuffer } },
          { binding: 6, resource: { buffer: this.visualizer.materialTableBuffer } }
        ]
      });

      renderPass.setPipeline(this.segEnhancedPipeline);
      renderPass.setBindGroup(0, enhancedBindGroup);
      renderPass.setVertexBuffer(0, this.visualizer.enhancedRollerBuffer.vertexBuffer);
      renderPass.setIndexBuffer(this.visualizer.enhancedRollerBuffer.indexBuffer, 'uint16');
      renderPass.drawIndexed(this.visualizer.enhancedRollerBuffer.indexCount, 36);
    }

    // Render electromagnet coils (SEG only)
    if (this.id === 'seg' && this.electromagnetInstances && this.segEnhancedPipeline && !skipEffects) {
      this.renderMode = 3;
      const deviceData = this._buildDeviceUniformData(this.renderMode);
      this.device.queue.writeBuffer(this.deviceUniformBuffer, 0, deviceData);

      const coilBindGroup = this.device.createBindGroup({
        layout: this.segEnhancedPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: globalUniformBuffer } },
          { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
          { binding: 2, resource: { buffer: this.electromagnetInstances } },
          { binding: 3, resource: { buffer: this.materialUniformBuffer } },
          { binding: 5, resource: { buffer: this.visualizer.lightingUniformBuffer } },
          { binding: 6, resource: { buffer: this.visualizer.materialTableBuffer } }
        ]
      });

      renderPass.setPipeline(this.segEnhancedPipeline);
      renderPass.setBindGroup(0, coilBindGroup);
      renderPass.setVertexBuffer(0, this.visualizer.coilUVBuffer.vertexBuffer);
      renderPass.setIndexBuffer(this.visualizer.coilUVBuffer.indexBuffer, 'uint16');
      const numCoils = this.visualizer.emController?.numCoils || 8;
      renderPass.drawIndexed(this.visualizer.coilUVBuffer.indexCount, numCoils);
    }

    // Render battery gauge (solar device only)
    if (this.id === 'solar' && this.gaugeInstanceBuffer) {
      const gaugeBindGroup = this.device.createBindGroup({
        layout: this.rollerPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: globalUniformBuffer } },
          { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
          { binding: 2, resource: { buffer: this.gaugeInstanceBuffer } },
          { binding: 3, resource: { buffer: this.materialUniformBuffer } },
          { binding: 5, resource: { buffer: this.visualizer.lightingUniformBuffer } },
          { binding: 6, resource: { buffer: this.visualizer.materialTableBuffer } }
        ]
      });

      renderPass.setPipeline(this.rollerPipeline);
      renderPass.setBindGroup(0, gaugeBindGroup);
      renderPass.setVertexBuffer(0, this.visualizer.batteryGaugeVertexBuffer);
      renderPass.setIndexBuffer(this.visualizer.batteryGaugeIndexBuffer, 'uint16');
      renderPass.drawIndexed(this.visualizer.batteryGaugeIndexCount, 1);
    }

    // Render RK4 flux line segments (physically accurate, |B|-driven color).
    // The lower-quality circular-path field-line particle fallback has been
    // removed; the RK4 flux ribbons are now the sole magnetic-field-line viz.
    if (this.id === 'seg' && this.fluxSegmentRenderBindGroup && this.pipelineManager.fluxSegmentPipeline && this.fieldLineEnabled && !skipEffects) {
      const qualityScale = this.visualizer.profiler.qualityLevel;
      const totalSegments = Math.floor(this.geometry.fluxTotalSegments * qualityScale);

      renderPass.setPipeline(this.pipelineManager.fluxSegmentPipeline);
      renderPass.setBindGroup(0, this.fluxSegmentRenderBindGroup);
      renderPass.draw(4, totalSegments);
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

    if (this.effectParticleCount > 0 && this.effectsParticles && !skipEffects) {
      const effectsBindGroup = this.device.createBindGroup({
        layout: this.particlePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: globalUniformBuffer } },
          { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
          { binding: 3, resource: { buffer: this.materialUniformBuffer } },
          { binding: 4, resource: { buffer: this.effectsParticles } }
        ]
      });
      renderPass.setPipeline(this.particlePipeline);
      renderPass.setBindGroup(0, effectsBindGroup);
      renderPass.draw(4, this.effectParticleCount);
    }
  }

  renderBase(renderPass, globalUniformBuffer) {
    if (!this.visualizer.basePlateBuffer || !this.segEnhancedPipeline) return;

    // Set renderMode to 1 (base)
    this.renderMode = 1;
    const deviceData = this._buildDeviceUniformData(this.renderMode);
    this.device.queue.writeBuffer(this.deviceUniformBuffer, 0, deviceData);

    const bindGroup = this.device.createBindGroup({
      layout: this.segEnhancedPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: globalUniformBuffer } },
        { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
        { binding: 2, resource: { buffer: this.visualizer.baseInstanceBuffer } },
        { binding: 3, resource: { buffer: this.materialUniformBuffer } },
        { binding: 5, resource: { buffer: this.visualizer.lightingUniformBuffer } },
        { binding: 6, resource: { buffer: this.visualizer.materialTableBuffer } }
      ]
    });

    renderPass.setPipeline(this.segEnhancedPipeline);
    renderPass.setBindGroup(0, bindGroup);
    renderPass.setVertexBuffer(0, this.visualizer.basePlateBuffer.vertexBuffer);
    renderPass.setIndexBuffer(this.visualizer.basePlateBuffer.indexBuffer, 'uint16');
    renderPass.drawIndexed(this.visualizer.basePlateBuffer.indexCount, 1);
  }

  renderStatorRings(renderPass, globalUniformBuffer) {
    if (!this.geometry.statorRingBuffer || !this.segEnhancedPipeline) return;
    const v = this.visualizer;
    if (!v.statorRingUVBuffer || !v.lightingUniformBuffer) return;

    // Set renderMode to 2 (stator)
    this.renderMode = 2;
    const deviceData = this._buildDeviceUniformData(this.renderMode);
    this.device.queue.writeBuffer(this.deviceUniformBuffer, 0, deviceData);

    // Enhanced PBR pipeline with merged annular-disc geometry.
    const bindGroup = this.device.createBindGroup({
      layout: this.segEnhancedPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: globalUniformBuffer } },
        { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
        { binding: 2, resource: { buffer: this.geometry.statorRingBuffer } },
        { binding: 3, resource: { buffer: this.materialUniformBuffer } },
        { binding: 5, resource: { buffer: v.lightingUniformBuffer } },
        { binding: 6, resource: { buffer: v.materialTableBuffer } }
      ]
    });

    renderPass.setPipeline(this.segEnhancedPipeline);
    renderPass.setBindGroup(0, bindGroup);
    renderPass.setVertexBuffer(0, v.statorRingUVBuffer.vertexBuffer);
    renderPass.setIndexBuffer(v.statorRingUVBuffer.indexBuffer, 'uint16');
    renderPass.drawIndexed(v.statorRingUVBuffer.indexCount, 1);
  }

  renderWiring(renderPass, globalUniformBuffer) {
    if (!this.geometry.wiringBuffer || !this.segEnhancedPipeline) return;
    const v = this.visualizer;
    if (!v.wiringUVBuffer || !v.lightingUniformBuffer) return;

    // Set renderMode to 3 (wiring)
    this.renderMode = 3;
    const deviceData = this._buildDeviceUniformData(this.renderMode);
    this.device.queue.writeBuffer(this.deviceUniformBuffer, 0, deviceData);

    // Enhanced PBR pipeline with UV geometry is now the only wiring path.
    const bindGroup = this.device.createBindGroup({
      layout: this.segEnhancedPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: globalUniformBuffer } },
        { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
        { binding: 2, resource: { buffer: this.geometry.wiringBuffer } },
        { binding: 3, resource: { buffer: this.materialUniformBuffer } },
        { binding: 5, resource: { buffer: v.lightingUniformBuffer } },
        { binding: 6, resource: { buffer: v.materialTableBuffer } }
      ]
    });

    renderPass.setPipeline(this.segEnhancedPipeline);
    renderPass.setBindGroup(0, bindGroup);
    renderPass.setVertexBuffer(0, v.wiringUVBuffer.vertexBuffer);
    renderPass.setIndexBuffer(v.wiringUVBuffer.indexBuffer, 'uint16');
    renderPass.drawIndexed(v.wiringUVBuffer.indexCount, 8); // 8 wires
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
          { binding: 5, resource: { buffer: v.lightingUniformBuffer } },
          { binding: 6, resource: { buffer: v.materialTableBuffer } }
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
    if (!this.coilInstances || !this.segEnhancedPipeline) return;
    if (!this.visualizer.connectionRingBuffer || !this.visualizer.coilUVBuffer) return;

    this.renderMode = 3;
    const numCoils = 24;

    // Connection rings (top + bottom)
    const ringBindGroup = this.device.createBindGroup({
      layout: this.segEnhancedPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: globalUniformBuffer } },
        { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
        { binding: 2, resource: { buffer: this.visualizer.connectionRingInstances } },
        { binding: 3, resource: { buffer: this.materialUniformBuffer } },
        { binding: 5, resource: { buffer: this.visualizer.lightingUniformBuffer } },
        { binding: 6, resource: { buffer: this.visualizer.materialTableBuffer } }
      ]
    });
    renderPass.setPipeline(this.segEnhancedPipeline);
    renderPass.setBindGroup(0, ringBindGroup);
    renderPass.setVertexBuffer(0, this.visualizer.connectionRingBuffer.vertexBuffer);
    renderPass.setIndexBuffer(this.visualizer.connectionRingBuffer.indexBuffer, 'uint16');
    renderPass.drawIndexed(this.visualizer.connectionRingBuffer.indexCount, 2);

    // Pickup coils
    const coilBindGroup = this.device.createBindGroup({
      layout: this.segEnhancedPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: globalUniformBuffer } },
        { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
        { binding: 2, resource: { buffer: this.coilInstances } },
        { binding: 3, resource: { buffer: this.materialUniformBuffer } },
        { binding: 5, resource: { buffer: this.visualizer.lightingUniformBuffer } },
        { binding: 6, resource: { buffer: this.visualizer.materialTableBuffer } }
      ]
    });
    renderPass.setBindGroup(0, coilBindGroup);
    renderPass.setVertexBuffer(0, this.visualizer.coilUVBuffer.vertexBuffer);
    renderPass.setIndexBuffer(this.visualizer.coilUVBuffer.indexBuffer, 'uint16');
    renderPass.drawIndexed(this.visualizer.coilUVBuffer.indexCount, numCoils);
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
        { binding: 5, resource: { buffer: v.lightingUniformBuffer } },
        { binding: 6, resource: { buffer: v.materialTableBuffer } }
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
          { binding: 5, resource: { buffer: v.lightingUniformBuffer } },
          { binding: 6, resource: { buffer: v.materialTableBuffer } }
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
