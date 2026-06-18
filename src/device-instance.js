import { DeviceGeometry } from './device-geometry.js';
import { DevicePipelineManager } from './device-pipeline-manager.js';
import { DeviceUniformManager } from './device-uniforms.js';
import { DeviceComputeManager } from './device-compute.js';

import { DeviceSetupMixin } from './devices/device-setup.js';
import { DeviceRenderMixin } from './devices/device-render.js';
import { DeviceUpdateMixin } from './devices/device-update.js';

export class DeviceInstance {

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
    // Bind extracted mixin methods
    this.setupRollerCompute = DeviceSetupMixin.setupRollerCompute.bind(this);
    this.setupFieldAdvect = DeviceSetupMixin.setupFieldAdvect.bind(this);
    this.setupFluxLineTracer = DeviceSetupMixin.setupFluxLineTracer.bind(this);
    this.setupEffectsParticles = DeviceSetupMixin.setupEffectsParticles.bind(this);
    this.render = DeviceRenderMixin.render.bind(this);
    this.renderBase = DeviceRenderMixin.renderBase.bind(this);
    this.renderStatorRings = DeviceRenderMixin.renderStatorRings.bind(this);
    this.renderWiring = DeviceRenderMixin.renderWiring.bind(this);
    this.renderCore = DeviceRenderMixin.renderCore.bind(this);
    this.renderPickupCoils = DeviceRenderMixin.renderPickupCoils.bind(this);
    this.renderStand = DeviceRenderMixin.renderStand.bind(this);
    this.renderWires = DeviceRenderMixin.renderWires.bind(this);
    this.update = DeviceUpdateMixin.update.bind(this);
    this._computeEnergyLevel = DeviceUpdateMixin._computeEnergyLevel.bind(this);
    this._buildDeviceUniformData = DeviceUpdateMixin._buildDeviceUniformData.bind(this);
    this.updateEmitterEffects = DeviceUpdateMixin.updateEmitterEffects.bind(this);
    this.updateElectromagnetCoils = DeviceUpdateMixin.updateElectromagnetCoils.bind(this);
    this.updatePickupCoilEnergies = DeviceUpdateMixin.updatePickupCoilEnergies.bind(this);
    this.updateFieldLines = DeviceUpdateMixin.updateFieldLines.bind(this);
    this.updateEnergyArcs = DeviceUpdateMixin.updateEnergyArcs.bind(this);

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
    await this.geometry.setupParticles();
    await this.computeManager.setupComputeResources();
    this.setupEffectsParticles();

    if (this.id === 'seg') {
      // Unified SEG geometry initialization
      await this.geometry.initializeSEG();

      // Connect energy arc buffer (fixes arcSegments = null bug)
      this.arcSegments = this.geometry.energyArcParticles;

      // Set up GPU compute pipelines for rollers and field lines
      await this.setupRollerCompute();
      await this.setupFieldAdvect();
      await this.setupFluxLineTracer();
    }
  }

  /**
   * Set up the SEG roller GPU compute pipeline.
   * The shader computes all 36 roller positions, quaternions and colours so
   * the CPU only needs to derive 36 (x,z) pairs for coil-energy lookups.
   */


  /**
   * Set up the SEG field-line GPU advect compute pipeline.
   * Replaces the 1200-particle CPU loop (sin/cos/random per frame) with a
   * single GPU dispatch of 19 workgroups × 64 threads.
   */


  /**
   * Set up the RK4 magnetic flux line tracer compute pipeline.
   * Uses `traceBidirectional` entry point from flux-lines.wgsl:
   * 1 thread per flux line (108 lines → 2 workgroups × 64 threads).
   * Each thread traces 50 steps forward + 50 backward via RK4 integration.
   *
   * Also pre-creates `fluxSegmentRenderBindGroup` so the render loop can
   * reuse it every frame without a per-frame allocation.
   */


  getRingIndex() {
    if (this.id === 'heron') return 1;
    if (this.id === 'kelvin') return 2;
    if (this.id === 'solar') return 3;
    if (this.id === 'peltier') return 4;
    if (this.id === 'mhd') return 5;
    return 0;
  }


  /**
   * Update pickup coil energy levels from roller positions.
   * @param {Float32Array} rollerData  Either:
   *   - compact=false (legacy): 36×12 floats, x at [r*12], z at [r*12+2]
   *   - compact=true (new GPU path): 36×2 floats, [x0,z0, x1,z1, ...]
   * @param {boolean} compact  True when using the lightweight 2-float-per-roller layout.
   */


  /**
   * CPU fallback for field line animation (used when GPU field-advect pipeline
   * is not yet ready, e.g. during first frame before async pipeline creation).
   */


  /**
   * Animate energy arc particles (called when arcSegments is non-null).
   * Distributes short arc segments around the stator coil ring.
   */


}

export { DeviceInstance }
