import { DeviceGeometry } from './device-geometry.js';
import { DevicePipelineManager } from './device-pipeline-manager.js';
import { DeviceUniformManager } from './device-uniforms.js';
import { DeviceComputeManager } from './device-compute.js';
import { computeRollerPositionsXZ, rollerIndexToRing, MAX_ROLLERS } from './seg-layout.js';

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

    // Pre-allocated roller position buffer (MAX_ROLLERS × 2 floats) to reduce per-frame GC
    this._rollerPositions = new Float32Array(MAX_ROLLERS * 2);

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

    // Roschin–Godin anomalous-effect envelopes (0..1)
    this._anomalyT = 0.0;  // magnetic walls
    this._coldT = 0.0;     // cold-zone fog / frost
    this._liftT = 0.0;     // weight-loss / levitation
    this._torusT = 0.0;    // ionization torus (driven earliest)
    this._anomalyLiftOffset = [0, 0, 0];
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
        { binding: 1, resource: { buffer: this.rollerComputeUniformBuffer } },
        { binding: 2, resource: { buffer: this.visualizer.segLayoutUniformBuffer } }
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
    // FluxUniforms: time, deltaTime, integrationStep, lineOpacity, seedRadius,
    // followStrength, coilBoostCount, coilBoostStrength = 8 × f32 = 32 bytes.
    this.fluxTracerUniformBuffer = this.device.createBuffer({
      label: 'flux-tracer-uniforms',
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

    // Coil boost data: world-space jaw-gap centre + energy, one per active coil.
    this.fluxCoilBoostBuffer = this.device.createBuffer({
      label: 'flux-coil-boost',
      size: 24 * 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    this.visualizer.profiler.trackBuffer('flux-coil-boost', 24 * 16, GPUBufferUsage.STORAGE);

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
        { binding: 1, resource: { buffer: this.fluxTracerUniformBuffer } },
        { binding: 2, resource: { buffer: this.fluxCoilBoostBuffer } },
        { binding: 3, resource: { buffer: this.visualizer.segLayoutUniformBuffer } }
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

  /**
   * Compute Roschin–Godin anomalous-effect envelopes from RPM proxy.
   * rpmProxy = speedMult * 60 (1x = 60 RPM). Effects ordered:
   *   ~200 RPM: ionization torus
   *   ~550 RPM: magnetic walls + cold zone
   *   ~595 RPM: levitation / weight-loss
   * Envelopes use exponential smoothing for temporal stability (#55).
   */
  _updateAnomalyEnvelopes(deltaTime) {
    const enabled = this.id === 'seg' && this.visualizer.anomalousEffectsEnabled;
    const speedMult = Math.max(0.0, this.speedMult || 1.0);
    const rpm = speedMult * 60.0;

    const gate = (value, low, high) => {
      if (high <= low) return value > high ? 1 : 0;
      return Math.max(0, Math.min(1, (value - low) / (high - low)));
    };

    const targetTorus   = enabled ? Math.pow(gate(rpm, 180, 220), 0.7) : 0.0;
    const targetWall    = enabled ? Math.pow(gate(rpm, 520, 580), 1.2) : 0.0;
    const targetCold    = enabled ? targetWall : 0.0;
    const targetLift    = enabled ? Math.pow(gate(rpm, 585, 620), 0.9) : 0.0;

    const smooth = (tau) => 1.0 - Math.exp(-Math.max(0.0, deltaTime) / tau);
    this._torusT   += (targetTorus   - this._torusT)   * smooth(1.5);
    this._anomalyT += (targetWall    - this._anomalyT) * smooth(2.0);
    this._coldT    += (targetCold    - this._coldT)    * smooth(2.5);
    this._liftT    += (targetLift    - this._liftT)    * smooth(3.5);

    // Levitation offset: vertical lift + slow precession + micro-jitter.
    const basePos = this.position;
    const maxLift = 0.22;
    const liftY = maxLift * this._liftT;
    const precessionRate = 0.35;
    const precessionRadius = 0.08 * this._liftT;
    const jitter = 0.01 * this._liftT * Math.sin(this.visualizer.time * 23.0);
    this._anomalyLiftOffset[0] = basePos[0] + Math.sin(this.visualizer.time * precessionRate) * precessionRadius;
    this._anomalyLiftOffset[1] = basePos[1] + liftY + jitter;
    this._anomalyLiftOffset[2] = basePos[2] + Math.cos(this.visualizer.time * precessionRate * 0.83) * precessionRadius;
  }

  _buildDeviceUniformData(renderMode, positionOverride = null) {
    const ringIndex = this.getRingIndex();
    const pos = positionOverride || this.position;
    return new Float32Array([
      renderMode,
      pos[0],
      pos[1],
      pos[2],
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
      // lineOpacity, seedRadius, followStrength, coilBoostCount, coilBoostStrength.
      // seedRadius now controls the minor radius of the flux torus;
      // followStrength scales the poloidal twist (helicity).
      const coilBoostCount = this.activePickupCoilCount || 0;
      const coilBoostStrength = 0.6 + 0.4 * Math.min(1.0, (this.speedMult || 1.0) / 5.0);
      if (this.fluxTracerUniformBuffer) {
        this.device.queue.writeBuffer(
          this.fluxTracerUniformBuffer, 0,
          new Float32Array([time, deltaTime, 0.02, 0.45, 0.35, 2.0, coilBoostCount, coilBoostStrength])
        );
      }

      // Upload jaw-gap centres and energies for the flux boost.
      if (this.fluxCoilBoostBuffer) {
        this.updateFluxCoilBoostData();
      }

      // Lightweight CPU coil-energy calculation.
      // We only need 36 (x, z) pairs — no quaternions, no colour lookup, no
      // buffer write — so the tight inner-loop is ~10× cheaper than before.
      const layout = this.visualizer.segLayout;
      if (layout) {
        const hw = this.visualizer.hardwareBridge;
        const useHardware = hw?.isConnected && hw?.mirrorEnabled;
        const hardwarePhaseRad = useHardware ? (hw.actualPhase * Math.PI / 180) : null;

        const computed = computeRollerPositionsXZ(time, layout, {
          useHardware,
          hardwarePhaseRad,
          speedMult: this.speedMult || 1.0
        });
        this._rollerPositions.set(computed.subarray(0, layout.totalRollers * 2));

        this.updatePickupCoilEnergies(this._rollerPositions, true);
      }

      // Update electromagnet coil activation visualization
      this.updateElectromagnetCoils();
    }

    this._computeEnergyLevel(deltaTime);
    this._updateAnomalyEnvelopes(deltaTime);

    // Apply levitation offset to SEG device position so the whole assembly lifts.
    const renderPosition = (this.id === 'seg')
      ? this._anomalyLiftOffset
      : this.position;
    this.uniformManager.updateUniforms(renderPosition, this.rotation, this.renderMode, this.energyLevel);
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
    const targetBudget = Math.min(
      this.maxEffectParticles,
      this.maxEffectParticles * quality * Math.min(1.0, 0.28 + speedMult * 0.18 + Math.pow(energy, 1.35) * 0.7)
    );
    // Smooth budget transitions so particle spawn count doesn’t pop when speed changes.
    if (this._prevEffectBudget === undefined) {
      this._prevEffectBudget = targetBudget;
    }
    this._prevEffectBudget += (targetBudget - this._prevEffectBudget) * Math.min(1.0, deltaTime * 8.0);
    const budget = Math.max(0, Math.floor(this._prevEffectBudget));
    if (budget <= 0) {
      this.effectParticleCount = 0;
      return;
    }

    const gate = (value, low, high) => {
      if (high <= low) return value > high ? 1 : 0;
      return Math.max(0, Math.min(1, (value - low) / (high - low)));
    };
    const smoothstep = (edge0, edge1, x) => {
      const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
      return t * t * (3 - 2 * t);
    };
    const fract = (x) => x - Math.floor(x);

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
      // Smooth speed envelope: quiet below 0.2x, full at 1x-8x, gentle saturation above 10x.
      const speedEnvelope = smoothstep(0.2, 1.5, speedMult) * (1.0 - smoothstep(8.0, 20.0, speedMult) * 0.35);
      const coronaStrength = Math.max(0.0, Math.min(1.0, speedEnvelope * 0.35 + coilEnergy * 0.35 + Math.pow(energy, 1.4) * 0.45));
      const coronaCount = Math.floor((10 + budget * 0.22) * coronaStrength);
      // Deterministic pseudo-random hash so corona particles don’t flicker every frame.
      const hash1 = (s) => fract(Math.sin(s * 127.1) * 43758.5453);
      const hash2 = (s) => fract(Math.sin(s * 269.5) * 43758.5453);
      for (let i = 0; i < coronaCount; i++) {
        const seed = i * 0.731 + t * 0.13;
        const a = (i / Math.max(1, coronaCount)) * Math.PI * 2 + t * (0.35 + coronaStrength);
        const ring = i % 3;
        const radius = (ring === 0 ? 2.4 : ring === 1 ? 3.9 : 5.4) + Math.sin(i * 2.31 + t) * 0.16;
        const y = (Math.sin(i * 1.93 + t * 1.9) * 0.8 + (hash1(seed) - 0.5) * 0.3) * (0.45 + coronaStrength * 0.55);
        pushParticle(Math.cos(a) * radius, y, Math.sin(a) * radius, 2.0 + hash2(seed));
      }

      const burstBase = Math.floor(budget * (0.04 + coronaStrength * 0.18) * speedEnvelope);
      for (let i = 0; i < burstBase; i++) {
        const seed = i * 1.237 + t * 0.21;
        const a = hash1(seed) * Math.PI * 2;
        const radius = 3.0 + hash2(seed) * 2.6;
        const y = (hash1(seed * 1.93) - 0.5) * 1.8;
        pushParticle(Math.cos(a) * radius, y, Math.sin(a) * radius, 1.0 + hash2(seed * 2.17));
      }

      // Jaw-gap brush discharge: fine sparks at each C-core pickup-coil gap.
      const coilCount = this.activePickupCoilCount || 0;
      const coilRadius = 7.2;
      const jawReach = 1.7;
      const jawBrushBudget = Math.floor(budget * 0.12 * coronaStrength * speedEnvelope);
      for (let i = 0; i < jawBrushBudget; i++) {
        const coilIdx = i % Math.max(1, coilCount);
        const angle = (coilIdx / coilCount) * Math.PI * 2;
        const cx = Math.cos(angle) * coilRadius;
        const cz = Math.sin(angle) * coilRadius;
        // Inward jaw-gap centre.
        const gx = cx - Math.cos(angle) * jawReach;
        const gz = cz - Math.sin(angle) * jawReach;
        const seed = i * 0.913 + t * 0.37 + coilIdx * 2.31;
        const spread = 0.08 + hash2(seed) * 0.10;
        const px = gx + (hash1(seed) - 0.5) * spread;
        const py = (hash2(seed * 1.71) - 0.5) * 0.35;
        const pz = gz + (hash1(seed * 2.13) - 0.5) * spread;
        pushParticle(px, py, pz, 1.0 + hash2(seed * 3.19));
      }

      // Cold-zone fog: slow downward-drifting white-blue particles inside the first magnetic wall.
      const coldFogBudget = Math.floor(budget * 0.18 * this._coldT);
      for (let i = 0; i < coldFogBudget; i++) {
        const seed = i * 0.617 + t * 0.07;
        const a = hash1(seed) * Math.PI * 2;
        const r = hash2(seed) * 1.8;
        const y = 2.2 - hash1(seed * 1.37) * 4.4;
        pushParticle(Math.cos(a) * r, y, Math.sin(a) * r, 8.0 + hash2(seed * 2.71));
      }

      // Inverse heat-haze: cool descending shimmer inside the first wall.
      const hazeBudget = Math.floor(budget * 0.10 * this._coldT);
      for (let i = 0; i < hazeBudget; i++) {
        const seed = i * 0.819 + t * 0.11;
        const a = hash1(seed) * Math.PI * 2;
        const r = 0.5 + hash2(seed) * 1.2;
        const y = 1.5 - hash1(seed * 2.11) * 3.0;
        pushParticle(Math.cos(a) * r, y, Math.sin(a) * r, 9.0 + hash2(seed * 1.93));
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

    const maxCoils = 24;
    const quality = this.visualizer.profiler?.qualityLevel ?? 1.0;
    // Quality-scalable coil count: 8 at low quality, 16 at high, capped by buffer.
    const numCoils = Math.max(8, Math.min(16, Math.floor(8 + quality * 8)));
    this.activePickupCoilCount = numCoils;
    const layout = this.visualizer.segLayout;
    const coilRadius = layout ? layout.outerRadiusM * layout.worldScale * 1.15 : 7.2;
    const rollerCount = layout?.totalRollers ?? MAX_ROLLERS;

    // Initialize coil energies array if needed
    if (!this.coilEnergies || this.coilEnergies.length !== maxCoils) {
      this.coilEnergies = new Float32Array(maxCoils);
    }

    // C-shaped coils: 3 instanced parts per coil (core, winding, foot).
    // Instance layout: position(3)+ringIndex(1)+rotation(4)+color(3)+emissive(1)
    const coilInstanceData = new Float32Array(maxCoils * 3 * 12);

    for (let i = 0; i < maxCoils; i++) {
      const active = i < numCoils;
      const coilAngle = (i / numCoils) * Math.PI * 2;
      const coilX = active ? Math.cos(coilAngle) * coilRadius : 0;
      const coilZ = active ? Math.sin(coilAngle) * coilRadius : 0;

      // Find nearest roller and calculate energy
      let minDistance = Infinity;
      let nearestRollerSpeed = 0;

      if (active) {
        for (let r = 0; r < rollerCount; r++) {
          const rollerX = compact ? rollerData[r * 2]     : rollerData[r * 12];
          const rollerZ = compact ? rollerData[r * 2 + 1] : rollerData[r * 12 + 2];

          const dx = coilX - rollerX;
          const dz = coilZ - rollerZ;
          const dist = Math.sqrt(dx * dx + dz * dz);

          if (dist < minDistance) {
            minDistance = dist;
            const mapped = layout ? rollerIndexToRing(layout, r) : null;
            nearestRollerSpeed = mapped ? mapped.ring.speed : 1.0;
          }
        }
      }

      // Calculate energy: higher when rollers are closer, modulated by roller speed
      const rawEnergy = active ? Math.max(0, 1 - minDistance / 3.0) * nearestRollerSpeed * 0.5 : 0;

      // Smooth energy transition
      this.coilEnergies[i] = this.coilEnergies[i] * 0.9 + rawEnergy * 0.1;

      // Rotation around the local Y axis so the C-core opening faces inward.
      // local -Z must align with the radial inward direction (-cosθ, 0, -sinθ),
      // which requires a Y-rotation of π/2 - θ.
      const rotAngle = active ? Math.PI / 2 - coilAngle : 0;
      const rotY = Math.sin(rotAngle / 2);
      const rotW = Math.cos(rotAngle / 2);

      const energy = this.coilEnergies[i];
      // Part selectors: 0 reserved for connection rings; 1=core, 2=winding, 3=foot
      const partSelectors = [1.0, 2.0, 3.0];

      for (let p = 0; p < 3; p++) {
        // Buffer layout: [core × maxCoils][winding × maxCoils][foot × maxCoils]
        // so each mesh can draw a contiguous instance range.
        const idx = (p * maxCoils + i) * 12;
        coilInstanceData[idx]     = coilX;
        coilInstanceData[idx + 1] = 0;
        coilInstanceData[idx + 2] = coilZ;
        coilInstanceData[idx + 3] = partSelectors[p];

        coilInstanceData[idx + 4] = 0.0;          // quaternion x
        coilInstanceData[idx + 5] = rotY;         // quaternion y
        coilInstanceData[idx + 6] = 0.0;          // quaternion z
        coilInstanceData[idx + 7] = rotW;         // quaternion w

        coilInstanceData[idx + 8]  = 0.75;        // copper R
        coilInstanceData[idx + 9]  = 0.45;        // copper G
        coilInstanceData[idx + 10] = 0.25;        // copper B
        coilInstanceData[idx + 11] = energy;      // emissive (winding pulse)
      }
    }

    this.device.queue.writeBuffer(this.coilInstances, 0, coilInstanceData);

    // Update energy arcs
    if (this.arcSegments && this.energyArcEnabled) {
      this.updateEnergyArcs(this.visualizer.frameDelta || 0.016);
    }
  }

  /**
   * Upload world-space jaw-gap centres and smoothed energies for the flux-line
   * compute shader. The boost pulls field lines through the C-core gaps as
   * rollers pass by, visualising the linked magnetic path.
   */
  updateFluxCoilBoostData() {
    if (!this.fluxCoilBoostBuffer || !this.coilEnergies) return;

    const numCoils = this.activePickupCoilCount || 0;
    const coilRadius = 7.2;
    const jawReach = 1.7;
    const data = new Float32Array(24 * 4);

    for (let i = 0; i < 24; i++) {
      const idx = i * 4;
      if (i < numCoils) {
        const angle = (i / numCoils) * Math.PI * 2;
        const cx = Math.cos(angle) * coilRadius;
        const cz = Math.sin(angle) * coilRadius;
        // Jaw gap sits jawReach metres inward from the coil centre.
        const gx = cx - Math.cos(angle) * jawReach;
        const gz = cz - Math.sin(angle) * jawReach;
        data[idx]     = gx;
        data[idx + 1] = 0.0;
        data[idx + 2] = gz;
        data[idx + 3] = this.coilEnergies[i];
      } else {
        data[idx] = data[idx + 1] = data[idx + 2] = 0.0;
        data[idx + 3] = 0.0;
      }
    }

    this.device.queue.writeBuffer(this.fluxCoilBoostBuffer, 0, data);
  }

  /**
   * Animate energy arc particles (called when arcSegments is non-null).
   * Distributes short arc segments around the stator coil ring.
   */
  updateEnergyArcs(deltaTime) {
    if (!this.arcSegments) return;
    const arcCount = 200;
    const arcData = new Float32Array(arcCount * 8);
    const time = this.visualizer.time;
    const speedMult = this.speedMult || 1.0;

    // Smooth speed envelope: quiet at low speed, gentle saturation at overdrive.
    const smoothstep = (edge0, edge1, x) => {
      const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
      return t * t * (3 - 2 * t);
    };
    const fract = (x) => x - Math.floor(x);
    const speedEnvelope = smoothstep(0.2, 1.5, speedMult) * (1.0 - smoothstep(8.0, 20.0, speedMult) * 0.35);
    const arcIntensity = Math.min(0.55, 0.12 + 0.25 * speedEnvelope);

    // Wall-time frequency so arcs don’t freeze at low speed or buzz at high speed.
    const wallTime = time / Math.max(speedMult, 0.001);

    for (let i = 0; i < arcCount; i++) {
      const idx = i * 8;
      const seed = i * 0.617 + wallTime * 0.05;
      const hash1 = fract(Math.sin(seed * 127.1) * 43758.5453);
      const hash2 = fract(Math.sin(seed * 269.5) * 43758.5453);

      // Spread arcs around the outer coil ring
      const arcAngle = (i / arcCount) * Math.PI * 2 + wallTime * 0.3;
      const outerR = (this.visualizer.segLayout?.outerRadiusM ?? 1.5)
        * (this.visualizer.segLayout?.worldScale ?? 2.0);
      const arcRadius = outerR * 1.05 + (hash1 - 0.5) * outerR * 0.12;
      const arcHeight = (hash2 - 0.5) * 0.6;

      arcData[idx]     = Math.cos(arcAngle) * arcRadius;
      arcData[idx + 1] = arcHeight;
      arcData[idx + 2] = Math.sin(arcAngle) * arcRadius;

      // Velocity: outward radial
      arcData[idx + 3] = Math.cos(arcAngle) * 0.5;
      arcData[idx + 4] = 0.1;
      arcData[idx + 5] = Math.sin(arcAngle) * 0.5;

      // Life and intensity
      arcData[idx + 6] = Math.sin(wallTime * 5.0 + i * 0.3) * 0.3 + 0.5;
      arcData[idx + 7] = arcIntensity;
    }

    this.device.queue.writeBuffer(this.arcSegments, 0, arcData);
  }

  render(renderPass, globalUniformBuffer, skipEffects = false) {
    const scaledCount = Math.floor(this.particleCount * this.visualizer.profiler.qualityLevel);
    const renderPosition = (this.id === 'seg')
      ? this._anomalyLiftOffset
      : this.position;

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
      const deviceData = this._buildDeviceUniformData(this.renderMode, renderPosition);
      this.device.queue.writeBuffer(this.deviceUniformBuffer, 0, deviceData);

      const enhancedBindGroup = this.device.createBindGroup({
        layout: this.segEnhancedPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: globalUniformBuffer } },
          { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
          { binding: 2, resource: { buffer: this.rollerInstances } },
          { binding: 3, resource: { buffer: this.materialUniformBuffer } },
          { binding: 5, resource: { buffer: this.visualizer.lightingUniformBuffer } },
          { binding: 6, resource: { buffer: this.visualizer.materialTableBuffer } },
          { binding: 4, resource: { buffer: this.visualizer.segLayoutUniformBuffer } },
          { binding: 7, resource: { buffer: this.rollerInstances } }
        ]
      });

      renderPass.setPipeline(this.segEnhancedPipeline);
      renderPass.setBindGroup(0, enhancedBindGroup);
      renderPass.setVertexBuffer(0, this.visualizer.enhancedRollerBuffer.vertexBuffer);
      renderPass.setIndexBuffer(this.visualizer.enhancedRollerBuffer.indexBuffer, 'uint16');
      renderPass.drawIndexed(this.visualizer.enhancedRollerBuffer.indexCount, this.visualizer.segLayout?.totalRollers ?? MAX_ROLLERS);
    }

    // Render electromagnet coils (SEG only)
    if (this.id === 'seg' && this.electromagnetInstances && this.segEnhancedPipeline && !skipEffects) {
      this.renderMode = 3;
      const deviceData = this._buildDeviceUniformData(this.renderMode, renderPosition);
      this.device.queue.writeBuffer(this.deviceUniformBuffer, 0, deviceData);

      const coilBindGroup = this.device.createBindGroup({
        layout: this.segEnhancedPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: globalUniformBuffer } },
          { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
          { binding: 2, resource: { buffer: this.electromagnetInstances } },
          { binding: 3, resource: { buffer: this.materialUniformBuffer } },
          { binding: 5, resource: { buffer: this.visualizer.lightingUniformBuffer } },
          { binding: 6, resource: { buffer: this.visualizer.materialTableBuffer } },
          { binding: 4, resource: { buffer: this.visualizer.segLayoutUniformBuffer } },
          { binding: 7, resource: { buffer: this.rollerInstances } }
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
    const deviceData = this._buildDeviceUniformData(this.renderMode, renderPosition);
    this.device.queue.writeBuffer(this.deviceUniformBuffer, 0, deviceData);

    const bindGroup = this.device.createBindGroup({
      layout: this.segEnhancedPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: globalUniformBuffer } },
        { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
        { binding: 2, resource: { buffer: this.visualizer.baseInstanceBuffer } },
        { binding: 3, resource: { buffer: this.materialUniformBuffer } },
        { binding: 5, resource: { buffer: this.visualizer.lightingUniformBuffer } },
        { binding: 6, resource: { buffer: this.visualizer.materialTableBuffer } },
        { binding: 4, resource: { buffer: this.visualizer.segLayoutUniformBuffer } },
        { binding: 7, resource: { buffer: this.rollerInstances } }
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
    const deviceData = this._buildDeviceUniformData(this.renderMode, renderPosition);
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
        { binding: 6, resource: { buffer: v.materialTableBuffer } },
        { binding: 4, resource: { buffer: v.segLayoutUniformBuffer } },
        { binding: 7, resource: { buffer: this.rollerInstances } }
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
    const deviceData = this._buildDeviceUniformData(this.renderMode, renderPosition);
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
        { binding: 6, resource: { buffer: v.materialTableBuffer } },
        { binding: 4, resource: { buffer: v.segLayoutUniformBuffer } },
        { binding: 7, resource: { buffer: this.rollerInstances } }
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
          { binding: 6, resource: { buffer: v.materialTableBuffer } },
          { binding: 4, resource: { buffer: v.segLayoutUniformBuffer } },
          { binding: 7, resource: { buffer: this.rollerInstances } }
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
    if (!this.visualizer.connectionRingBuffer || !this.visualizer.cCoreCoilBuffer) return;

    this.renderMode = 3;
    const numCoils = this.activePickupCoilCount || 24;
    const coil = this.visualizer.cCoreCoilBuffer;

    // Connection rings (top + bottom)
    const ringBindGroup = this.device.createBindGroup({
      layout: this.segEnhancedPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: globalUniformBuffer } },
        { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
        { binding: 2, resource: { buffer: this.visualizer.connectionRingInstances } },
        { binding: 3, resource: { buffer: this.materialUniformBuffer } },
        { binding: 5, resource: { buffer: this.visualizer.lightingUniformBuffer } },
        { binding: 6, resource: { buffer: this.visualizer.materialTableBuffer } },
        { binding: 4, resource: { buffer: this.visualizer.segLayoutUniformBuffer } },
        { binding: 7, resource: { buffer: this.rollerInstances } }
      ]
    });
    renderPass.setPipeline(this.segEnhancedPipeline);
    renderPass.setBindGroup(0, ringBindGroup);
    renderPass.setVertexBuffer(0, this.visualizer.connectionRingBuffer.vertexBuffer);
    renderPass.setIndexBuffer(this.visualizer.connectionRingBuffer.indexBuffer, 'uint16');
    renderPass.drawIndexed(this.visualizer.connectionRingBuffer.indexCount, 2);

    // C-shaped pickup coils: draw core, winding bundle, and mounting foot.
    // Each mesh uses the same instance buffer, offset by firstInstance so the
    // three parts align per coil (core=0, winding=1, foot=2 within every triplet).
    const coilBindGroup = this.device.createBindGroup({
      layout: this.segEnhancedPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: globalUniformBuffer } },
        { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
        { binding: 2, resource: { buffer: this.coilInstances } },
        { binding: 3, resource: { buffer: this.materialUniformBuffer } },
        { binding: 5, resource: { buffer: this.visualizer.lightingUniformBuffer } },
        { binding: 6, resource: { buffer: this.visualizer.materialTableBuffer } },
        { binding: 4, resource: { buffer: this.visualizer.segLayoutUniformBuffer } },
        { binding: 7, resource: { buffer: this.rollerInstances } }
      ]
    });
    renderPass.setBindGroup(0, coilBindGroup);

    const maxCoils = 24;
    const parts = [
      { buf: coil.core,     first: 0 },
      { buf: coil.winding,  first: maxCoils },
      { buf: coil.foot,     first: maxCoils * 2 }
    ];
    for (const part of parts) {
      if (!part.buf) continue;
      renderPass.setVertexBuffer(0, part.buf.vertexBuffer);
      renderPass.setIndexBuffer(part.buf.indexBuffer, 'uint16');
      renderPass.drawIndexed(part.buf.indexCount, numCoils, 0, 0, part.first);
    }
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
        { binding: 6, resource: { buffer: v.materialTableBuffer } },
        { binding: 4, resource: { buffer: v.segLayoutUniformBuffer } },
        { binding: 7, resource: { buffer: this.rollerInstances } }
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
          { binding: 6, resource: { buffer: v.materialTableBuffer } },
          { binding: 4, resource: { buffer: v.segLayoutUniformBuffer } },
          { binding: 7, resource: { buffer: this.rollerInstances } }
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
