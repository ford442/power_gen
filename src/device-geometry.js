import { MAX_ROLLERS } from './seg-layout.js';

// Matches TOTAL_FLUX_LINES × SEGMENTS_PER_LINE constants in flux-lines.wgsl
// (108 lines × 100 segments). Update both if the WGSL constants change.
const FLUX_TOTAL_SEGMENTS = 10800;

// Legacy circular-path field-line particles. Must match `fieldLineCount` in
// DeviceInstance. Each FieldParticle is 8 × f32 (pos3 + vel3 + life + strength)
// = 32 bytes; see getSegFieldAdvectShader() and updateFieldLines().
const FIELD_LINE_PARTICLE_COUNT = 1200;
const FIELD_LINE_PARTICLE_BYTES = 32;

/** WebGPU particle storage layout: vec4f (xyz + phase) = 16 bytes per particle. */
export const PARTICLE_BYTES_PER_INSTANCE = 16;

export class DeviceGeometry {
  constructor(device, id, config, visualizer) {
    this.device = device;
    this.id = id;
    this.config = config;
    this.visualizer = visualizer;
    this.particleCount = config.particleCount || 50000;
  }

  async initializeSEG() {
    await this.setupBase();
    await this.setupStatorRings();
    await this.setupRollers();
    await this.setupCore();
    await this.setupParticles();
    await this.setupFieldLineBuffer();
    await this.setupFluxLineBuffer();
    await this.setupEnergyArcs();
    await this.setupWiring();
    await this.setupElectromagnets();
  }

  async setupFieldLineBuffer() {
    // Storage buffer for the legacy circular field-line particles. Written by
    // the GPU advect compute pass (setupFieldAdvect, read_write) and the CPU
    // fallback (updateFieldLines, writeBuffer), read by the field-line render
    // pipeline (binding 4).
    const size = FIELD_LINE_PARTICLE_COUNT * FIELD_LINE_PARTICLE_BYTES;
    this.fieldLineParticles = this.device.createBuffer({
      label: 'seg-field-line-particles',
      size,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    this.visualizer.profiler.trackBuffer(
      `device-${this.id}-field-lines`,
      size,
      GPUBufferUsage.STORAGE
    );
  }

  async setupFluxLineBuffer() {
    // 108 lines × 100 segments × 32 bytes per FluxSegment
    // (FluxSegment: 6 x f32 position scalars + strength f32 + age f32 = 32 B)
    this.fluxTotalSegments = FLUX_TOTAL_SEGMENTS;
    this.fluxSegmentBuffer = this.device.createBuffer({
      label: 'flux-segment-buffer',
      size: FLUX_TOTAL_SEGMENTS * 32,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    this.visualizer.profiler.trackBuffer(
      `device-${this.id}-flux-segments`,
      FLUX_TOTAL_SEGMENTS * 32,
      GPUBufferUsage.STORAGE
    );
  }

  async setupBase() {
    // Base geometry is now a shared UV mesh in the visualizer (basePlateBuffer).
    // This method is intentionally a no-op; the instance data lives in
    // MultiDeviceVisualizer.baseInstanceBuffer.
  }

  async setupStatorRings() {
    // The enhanced SEG vertex shader expects the canonical InstanceData layout:
    //   position(3) + ringIndex(1) + rotation(4) + copperColor(3) + greenEmissive(1).
    // The actual ring meshes (three concentric annular discs) now live in the
    // shared visualizer buffer; this instance buffer supplies the single identity
    // transform that places the merged mesh at the origin.
    if (this.visualizer && this.visualizer.statorRingInstanceBuffer) {
      this.statorRingBuffer = this.visualizer.statorRingInstanceBuffer;
      return;
    }

    // Fallback: create a minimal canonical instance buffer if the shared buffer
    // is not available (should not happen in the normal enhanced path).
    this.statorRingBuffer = this.device.createBuffer({
      size: 48,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(this.statorRingBuffer, 0, new Float32Array([
      0, 0, 0,       // position
      0.0,           // ringIndex
      0, 0, 0, 1,    // rotation
      0.85, 0.48, 0.25, // copper color
      0.0            // emissive
    ]));
  }

  async setupRollers() {
    // Up to 72 roller instances (Searl 10+25+35); active count comes from layout.
    const totalRollers = MAX_ROLLERS;
    this.rollerInstances = this.device.createBuffer({
      size: totalRollers * 48,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    this.visualizer.profiler.trackBuffer(`device-${this.id}-rollers`, totalRollers * 48, GPUBufferUsage.STORAGE);

    const rollerData = new Float32Array(totalRollers * 12);
    this.device.queue.writeBuffer(this.rollerInstances, 0, rollerData);
  }

  async setupWiring() {
    // Visible wiring on the base - thin copper cables
    const wireCount = 8;
    this.wiringBuffer = this.device.createBuffer({
      size: wireCount * 48,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });

    const wireData = new Float32Array(wireCount * 12);
    for (let i = 0; i < wireCount; i++) {
      const idx = i * 12;
      const angle = (i / wireCount) * Math.PI * 2;
      const radius = 6.5;

      // Wire position on base
      wireData[idx] = Math.cos(angle) * radius;
      wireData[idx + 1] = -0.25;
      wireData[idx + 2] = Math.sin(angle) * radius;
      wireData[idx + 3] = 0.15; // wire thickness

      // Direction to center
      wireData[idx + 4] = -Math.cos(angle);
      wireData[idx + 5] = 0.1;
      wireData[idx + 6] = -Math.sin(angle);
      wireData[idx + 7] = 2.0; // wire length

      // Copper wire color
      wireData[idx + 8] = 0.75;
      wireData[idx + 9] = 0.45;
      wireData[idx + 10] = 0.25;
      wireData[idx + 11] = 0.0; // not emissive
    }
    this.device.queue.writeBuffer(this.wiringBuffer, 0, wireData);
  }

  async setupParticles() {
    this.particles = this.device.createBuffer({
      size: this.particleCount * PARTICLE_BYTES_PER_INSTANCE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    this.visualizer.profiler.trackBuffer(
      `device-${this.id}-particles`,
      this.particleCount * PARTICLE_BYTES_PER_INSTANCE,
      GPUBufferUsage.STORAGE
    );

    const particleData = new Float32Array(this.particleCount * 4);
    for (let i = 0; i < this.particleCount; i++) {
      const idx = i * 4;
      // Phase is the only persistent data; position is computed each frame by GPU
      particleData[idx + 3] = Math.random(); // phase (w component)
      
      if (this.id === 'seg') {
        const theta = Math.random() * Math.PI * 2;
        const r = 2 + Math.random() * 4;
        particleData[idx] = r * Math.cos(theta);
        particleData[idx + 1] = (Math.random() - 0.5) * 6;
        particleData[idx + 2] = r * Math.sin(theta);
      } else if (this.id === 'solar') {
        const ledCount = 6;
        const ledIdx = Math.floor(Math.random() * ledCount);
        const ledAngle = (ledIdx / ledCount) * Math.PI * 2;
        const ledRadius = 3.0;
        particleData[idx] = Math.cos(ledAngle) * ledRadius;
        particleData[idx + 1] = 3.0 + Math.random() * 0.5;
        particleData[idx + 2] = Math.sin(ledAngle) * ledRadius;
      } else if (this.id === 'peltier') {
        // Phase regions: 0.0-0.4 = hot, 0.4-0.8 = cold, 0.8-1.0 = electricity
        // Position is fully compute-driven; seed only matters for randomness
        particleData[idx] = 0.0;
        particleData[idx + 1] = 0.0;
        particleData[idx + 2] = 0.0;
      } else {
        particleData[idx + 1] = (Math.random() - 0.5) * 6;
      }
    }
    this.device.queue.writeBuffer(this.particles, 0, particleData);
  }

  async setupEnergyArcs() {
    this.energyArcParticles = this.device.createBuffer({
      size: 200 * 32,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    this.visualizer.profiler.trackBuffer(`device-${this.id}-energyarcs`, 200 * 32, GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE);

    const arcData = new Float32Array(200 * 8);
    for (let i = 0; i < 200; i++) {
      const idx = i * 8;
      const angle = Math.random() * Math.PI * 2;
      const radius = 3.0 + Math.random() * 2.0;
      arcData[idx] = Math.cos(angle) * radius;
      arcData[idx + 1] = (Math.random() - 0.5) * 4.0;
      arcData[idx + 2] = Math.sin(angle) * radius;
      arcData[idx + 3] = (Math.random() - 0.5) * 2.0;
      arcData[idx + 4] = Math.random() * 0.5;
      arcData[idx + 5] = (Math.random() - 0.5) * 2.0;
      arcData[idx + 6] = Math.random();
      arcData[idx + 7] = 0.3 + Math.random() * 0.7;
    }
    this.device.queue.writeBuffer(this.energyArcParticles, 0, arcData);
  }

  async setupCore() {
    this.coreInstances = this.device.createBuffer({
      size: 100 * 32,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    this.visualizer.profiler.trackBuffer(`device-${this.id}-core`, 100 * 32, GPUBufferUsage.STORAGE);

    const core = this.config.core || {};
    const plateY = core.plateY || 2.5;

    // Instance buffer for bearing shaft (ringIndex = -1 signals steel to shader)
    this.shaftInstanceBuffer = this.device.createBuffer({
      size: 48,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    const shaftInstanceData = new Float32Array([
      0, 0, 0,       // position
      -1.0,          // ringIndex (shaft hack)
      0, 0, 0, 1,    // rotation quaternion
      0.65, 0.67, 0.70, // steel color
      0.0            // emissive
    ]);
    this.device.queue.writeBuffer(this.shaftInstanceBuffer, 0, shaftInstanceData);
    this.visualizer.profiler.trackBuffer(`device-${this.id}-shaft-instance`, 48, GPUBufferUsage.STORAGE);

    // Instance buffer for magnet core (default copper look)
    this.magnetInstanceBuffer = this.device.createBuffer({
      size: 48,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    const magnetInstanceData = new Float32Array([
      0, 0, 0,       // position
      0.0,           // ringIndex (default)
      0, 0, 0, 1,    // rotation quaternion
      0.85, 0.48, 0.25, // copper color
      0.0            // emissive
    ]);
    this.device.queue.writeBuffer(this.magnetInstanceBuffer, 0, magnetInstanceData);
    this.visualizer.profiler.trackBuffer(`device-${this.id}-magnet-instance`, 48, GPUBufferUsage.STORAGE);

    // Instance buffer for top plate (ringIndex = 11 signals brass/structural to shader)
    this.topPlateInstanceBuffer = this.device.createBuffer({
      size: 48,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    const topPlateData = new Float32Array([
      0, plateY, 0,  // position
      11.0,          // ringIndex (plate hack)
      0, 0, 0, 1,    // rotation quaternion
      0.78, 0.58, 0.22, // brass color
      0.0            // emissive
    ]);
    this.device.queue.writeBuffer(this.topPlateInstanceBuffer, 0, topPlateData);
    this.visualizer.profiler.trackBuffer(`device-${this.id}-top-plate-instance`, 48, GPUBufferUsage.STORAGE);

    // Instance buffer for bottom plate
    this.bottomPlateInstanceBuffer = this.device.createBuffer({
      size: 48,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    const bottomPlateData = new Float32Array([
      0, -plateY, 0, // position
      11.0,          // ringIndex (plate hack)
      0, 0, 0, 1,    // rotation quaternion
      0.78, 0.58, 0.22, // brass color
      0.0            // emissive
    ]);
    this.device.queue.writeBuffer(this.bottomPlateInstanceBuffer, 0, bottomPlateData);
    this.visualizer.profiler.trackBuffer(`device-${this.id}-bottom-plate-instance`, 48, GPUBufferUsage.STORAGE);
  }

  async setupElectromagnets() {
    // Electromagnet coils arranged in a circle around the SEG rollers
    // Instance format: position(3) + angle(1) + activeIntensity(1) + coilIndex(1) + pad(2) = 8 floats = 32 bytes
    const maxCoils = 24;
    this.electromagnetInstances = this.device.createBuffer({
      size: maxCoils * 48,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    this.visualizer.profiler.trackBuffer(`device-${this.id}-electromagnets`, maxCoils * 48, GPUBufferUsage.STORAGE);

    // Initialize with default 8-coil layout at radius 7.0
    this.updateElectromagnetLayout(8, 0);
  }

  updateElectromagnetLayout(numCoils, offsetAngleDeg) {
    if (!this.electromagnetInstances) return;
    const maxCoils = 24;
    const instanceData = new Float32Array(maxCoils * 8);
    const radius = 7.2; // Just outside outer roller ring (5.5)
    const offsetRad = (offsetAngleDeg * Math.PI) / 180;

    for (let i = 0; i < maxCoils; i++) {
      const idx = i * 8;
      if (i < numCoils) {
        const angle = (i / numCoils) * Math.PI * 2 + offsetRad;
        instanceData[idx] = Math.cos(angle) * radius;     // x
        instanceData[idx + 1] = 0.0;                       // y
        instanceData[idx + 2] = Math.sin(angle) * radius; // z
        instanceData[idx + 3] = angle;                     // orientation angle
        instanceData[idx + 4] = 0.0;                       // activeIntensity
        instanceData[idx + 5] = i;                         // coilIndex
        instanceData[idx + 6] = 0.0;                       // pad
        instanceData[idx + 7] = 0.0;                       // pad
      } else {
        // Hide unused coils
        instanceData[idx] = 0; instanceData[idx + 1] = -1000; instanceData[idx + 2] = 0;
        instanceData[idx + 3] = 0; instanceData[idx + 4] = 0; instanceData[idx + 5] = i;
        instanceData[idx + 6] = 0; instanceData[idx + 7] = 0;
      }
    }
    this.device.queue.writeBuffer(this.electromagnetInstances, 0, instanceData);
  }
}
