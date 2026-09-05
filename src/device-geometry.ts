import { MAX_ROLLERS } from './seg-layout';
import {
  DEVICE_MESH_LAYOUTS,
  instancesToBufferData,
  countInstances,
  type DeviceMeshLayout,
  type InstanceArray
} from './device-mesh-layouts';
import { getPluginMeshLayouts } from './devices/device-registry';
import { MATERIAL_COPPER, MATERIAL_SHAFT, MATERIAL_STRUCTURAL } from './devices/material-roles';
import { simRandom } from './telemetry/deterministic-rng';
import { writeQueueBuffer } from './gpu-buffer-write';
import { PARTICLE_LAYOUTS } from '../generated/physics-constants.js';
import type { DeviceInstanceConfig } from './device-instance';
import type { VisualizerLike, HeronFlowGeometry } from './devices/types';

// Matches TOTAL_FLUX_LINES × SEGMENTS_PER_LINE constants in passes/flux-line-tracer.wgsl
// (168 lines × 120 segments). Update both if the WGSL constants change.
const FLUX_TOTAL_SEGMENTS = 20160;

// Legacy circular-path field-line particles. Must match `fieldLineCount` in
// DeviceInstance. Each FieldParticle is 8 × f32 (pos3 + vel3 + life + strength)
// = 32 bytes; see getSegFieldAdvectShader() and updateFieldLines().
const FIELD_LINE_PARTICLE_COUNT = 1200;
const FIELD_LINE_PARTICLE_BYTES: number = PARTICLE_LAYOUTS.fieldLineBytes;

/** WebGPU particle storage layout: vec4f (xyz + phase) = 16 bytes per particle. */
export const PARTICLE_BYTES_PER_INSTANCE: number = PARTICLE_LAYOUTS.gpuBytes;

export class DeviceGeometry {
  device: GPUDevice;
  id: string;
  config: DeviceInstanceConfig;
  visualizer: VisualizerLike;
  particleCount: number;

  particles!: GPUBuffer;
  rollerInstances: GPUBuffer | null = null;
  fieldLineParticles: GPUBuffer | null = null;
  energyArcParticles: GPUBuffer | null = null;
  coreInstances: GPUBuffer | null = null;
  shaftInstanceBuffer: GPUBuffer | null = null;
  magnetInstanceBuffer: GPUBuffer | null = null;
  topPlateInstanceBuffer: GPUBuffer | null = null;
  bottomPlateInstanceBuffer: GPUBuffer | null = null;
  electromagnetInstances: GPUBuffer | null = null;
  fluxSegmentBuffer: GPUBuffer | null = null;
  statorRingBuffer: GPUBuffer | null = null;
  wiringBuffer: GPUBuffer | null = null;
  baseBuffer: GPUBuffer | null = null;
  ringInstances: GPUBuffer | null = null;
  tubeInstances: GPUBuffer | null = null;
  panelInstances: GPUBuffer | null = null;
  flowPathParticles: GPUBuffer | null = null;
  flowPathCount = 0;

  meshCylinderCount?: number;
  meshRingCount?: number;
  meshTubeCount?: number;
  meshPanelCount?: number;
  fluxTotalSegments?: number;
  heronFlow?: HeronFlowGeometry | null;
  heronLayoutId?: string;

  constructor(device: GPUDevice, id: string, config: DeviceInstanceConfig, visualizer: VisualizerLike) {
    this.device = device;
    this.id = id;
    this.config = config;
    this.visualizer = visualizer;
    this.particleCount = config.particleCount || 50000;
  }

  async initializeSEG(): Promise<void> {
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

  /**
   * Initialize instanced cylinder / disc geometry for Heron, Kelvin, or Solar.
   */
  async initializeDeviceMesh(): Promise<void> {
    const layoutDef: DeviceMeshLayout | undefined = DEVICE_MESH_LAYOUTS[this.id] || getPluginMeshLayouts()[this.id];
    if (!layoutDef) return;

    if (this.id === 'heron' && layoutDef.build) {
      await this.applyHeronLayout(this.visualizer.heronLayoutPreset ?? '');
      return;
    }

    const instanceParts: InstanceArray[] = [];
    if (layoutDef.cylinders) {
      const cylInstances = layoutDef.cylinders();
      instanceParts.push(cylInstances);
      this.meshCylinderCount = countInstances(cylInstances.flat());
    }

    if (layoutDef.rings) {
      const ringData = layoutDef.rings();
      this.ringInstances = this._createInstanceBuffer(() => ringData);
      this.meshRingCount = countInstances(ringData.flat());
    }

    if (layoutDef.tubes) {
      const tubeData = layoutDef.tubes();
      this.tubeInstances = this._createInstanceBuffer(() => tubeData);
      this.meshTubeCount = countInstances(tubeData.flat());
    }

    if (layoutDef.panel) {
      const panelData = layoutDef.panel();
      this.panelInstances = this._createInstanceBuffer(() => panelData);
      this.meshPanelCount = countInstances(panelData.flat());
    }

    if (layoutDef.platform) {
      const platformData = layoutDef.platform();
      instanceParts.push(platformData);
      this.meshCylinderCount = (this.meshCylinderCount || 0) + countInstances(platformData.flat());
    }

    if (instanceParts.length > 0) {
      this._writeRollerInstances(instanceParts);
    }

    await this.setupDeviceFlowPaths();
  }

  /**
   * Hot-swap Heron vessel + plumbing geometry when the build-shape preset changes.
   */
  async applyHeronLayout(presetId: string): Promise<void> {
    const layoutDef = DEVICE_MESH_LAYOUTS.heron;
    if (!layoutDef?.build) return;

    const mesh = layoutDef.build(presetId);
    this.heronFlow = mesh.flow;
    this.heronLayoutId = presetId;

    this._writeRollerInstances([mesh.cylinders]);
    this.meshCylinderCount = countInstances(mesh.cylinders.flat());

    if (mesh.tubes?.length) {
      const tubeData = instancesToBufferData([mesh.tubes]);
      if (!this.tubeInstances || this.tubeInstances.size < tubeData.byteLength) {
        this.tubeInstances?.destroy?.();
        this.tubeInstances = this.device.createBuffer({
          size: tubeData.byteLength,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        });
        this.visualizer.profiler?.trackBuffer?.(
          `device-${this.id}-tubes`,
          tubeData.byteLength,
          GPUBufferUsage.STORAGE
        );
      }
      writeQueueBuffer(this.device, this.tubeInstances, tubeData);
      this.meshTubeCount = countInstances(mesh.tubes.flat());
    }

    await this.setupDeviceFlowPaths();
  }

  private _writeRollerInstances(instanceParts: InstanceArray[]): void {
    const data = instancesToBufferData(instanceParts);
    if (!this.rollerInstances || this.rollerInstances.size < data.byteLength) {
      this.rollerInstances?.destroy?.();
      this.rollerInstances = this.device.createBuffer({
        size: data.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
      });
      this.visualizer.profiler?.trackBuffer?.(
        `device-${this.id}-mesh-instances`,
        data.byteLength,
        GPUBufferUsage.STORAGE
      );
    }
    writeQueueBuffer(this.device, this.rollerInstances, data);
  }

  /** Local-space flow visualization paths (siphon, electrostatic, photon beams). */
  async setupDeviceFlowPaths(): Promise<void> {
    if (!['heron', 'kelvin', 'solar'].includes(this.id)) return;

    this.flowPathCount = this.id === 'kelvin' ? 72 : this.id === 'solar' ? 42 : 56;
    const bytes = this.flowPathCount * 32;
    this.flowPathParticles = this.device.createBuffer({
      label: `device-${this.id}-flow-paths`,
      size: bytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    this.visualizer.profiler?.trackBuffer?.(
      `device-${this.id}-flow-paths`,
      bytes,
      GPUBufferUsage.STORAGE
    );
  }

  private _createInstanceBuffer(buildFn: () => InstanceArray): GPUBuffer {
    const built = buildFn();
    const data = instancesToBufferData([built]);
    const buf = this.device.createBuffer({
      size: data.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    writeQueueBuffer(this.device, buf, data);
    this.visualizer.profiler?.trackBuffer?.(
      `device-${this.id}-extra-instances`,
      data.byteLength,
      GPUBufferUsage.STORAGE
    );
    return buf;
  }

  async setupFieldLineBuffer(): Promise<void> {
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
    this.visualizer.profiler?.trackBuffer?.(
      `device-${this.id}-field-lines`,
      size,
      GPUBufferUsage.STORAGE
    );
  }

  async setupFluxLineBuffer(): Promise<void> {
    // 168 lines × 120 segments × 32 bytes per FluxSegment
    // (FluxSegment: 6 x f32 position scalars + strength f32 + age f32 = 32 B)
    this.fluxTotalSegments = FLUX_TOTAL_SEGMENTS;
    this.fluxSegmentBuffer = this.device.createBuffer({
      label: 'flux-segment-buffer',
      size: FLUX_TOTAL_SEGMENTS * 32,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    this.visualizer.profiler?.trackBuffer?.(
      `device-${this.id}-flux-segments`,
      FLUX_TOTAL_SEGMENTS * 32,
      GPUBufferUsage.STORAGE
    );
  }

  async setupBase(): Promise<void> {
    if (this.visualizer?.baseInstanceBuffer) {
      this.baseBuffer = this.visualizer.baseInstanceBuffer;
    }
  }

  async setupStatorRings(): Promise<void> {
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
    writeQueueBuffer(this.device, this.statorRingBuffer, new Float32Array([
      0, 0, 0,       // position
      0.0,           // ringIndex
      0, 0, 0, 1,    // rotation
      0.85, 0.48, 0.25, // copper color
      0.0            // emissive
    ]));
  }

  async setupRollers(): Promise<void> {
    // Up to 72 roller instances (Searl 10+25+35); active count comes from layout.
    const totalRollers = MAX_ROLLERS;
    this.rollerInstances = this.device.createBuffer({
      size: totalRollers * 48,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    this.visualizer.profiler?.trackBuffer?.(`device-${this.id}-rollers`, totalRollers * 48, GPUBufferUsage.STORAGE);

    const rollerData = new Float32Array(totalRollers * 12);
    writeQueueBuffer(this.device, this.rollerInstances, rollerData);
  }

  async setupWiring(): Promise<void> {
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
    writeQueueBuffer(this.device, this.wiringBuffer, wireData);
  }

  async setupParticles(): Promise<void> {
    this.particles = this.device.createBuffer({
      size: this.particleCount * PARTICLE_BYTES_PER_INSTANCE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    this.visualizer.profiler?.trackBuffer?.(
      `device-${this.id}-particles`,
      this.particleCount * PARTICLE_BYTES_PER_INSTANCE,
      GPUBufferUsage.STORAGE
    );

    this.reseedParticles();
  }

  /** Re-seed particle buffer (phase + initial xyz) — called on init and mode entry. */
  reseedParticles(): void {
    if (!this.particles) return;

    const particleData = new Float32Array(this.particleCount * 4);
    for (let i = 0; i < this.particleCount; i++) {
      const idx = i * 4;
      particleData[idx + 3] = simRandom();

      if (this.id === 'seg') {
        const theta = simRandom() * Math.PI * 2;
        const r = 2 + simRandom() * 4;
        particleData[idx] = r * Math.cos(theta);
        particleData[idx + 1] = (simRandom() - 0.5) * 6;
        particleData[idx + 2] = r * Math.sin(theta);
      } else if (this.id === 'solar') {
        const ledCount = 6;
        const ledIdx = Math.floor(simRandom() * ledCount);
        const ledAngle = (ledIdx / ledCount) * Math.PI * 2;
        const ledRadius = 3.0;
        particleData[idx] = Math.cos(ledAngle) * ledRadius;
        particleData[idx + 1] = 3.0 + simRandom() * 0.5;
        particleData[idx + 2] = Math.sin(ledAngle) * ledRadius;
      } else if (this.id === 'maglev') {
        const r = 0.8 + simRandom() * 2.2;
        const a = simRandom() * Math.PI * 2;
        particleData[idx] = Math.cos(a) * r;
        particleData[idx + 1] = 0.6 + simRandom() * 0.8;
        particleData[idx + 2] = Math.sin(a) * r;
      } else if (this.id === 'homopolar') {
        const r = 0.2 + simRandom() * 0.9;
        const a = simRandom() * Math.PI * 2;
        particleData[idx] = Math.cos(a) * r;
        particleData[idx + 1] = 0.14 + simRandom() * 0.06;
        particleData[idx + 2] = Math.sin(a) * r;
      } else if (this.id === 'halbach-viz') {
        const r = 0.6 + simRandom() * 2.0;
        const a = simRandom() * Math.PI * 2;
        particleData[idx] = Math.cos(a) * r;
        particleData[idx + 1] = 0.2 + simRandom() * 0.6;
        particleData[idx + 2] = Math.sin(a) * r;
      } else if (this.id === 'peltier') {
        particleData[idx] = 0.0;
        particleData[idx + 1] = 0.0;
        particleData[idx + 2] = 0.0;
      } else {
        particleData[idx + 1] = (simRandom() - 0.5) * 6;
      }
    }
    writeQueueBuffer(this.device, this.particles, particleData);
  }

  async setupEnergyArcs(): Promise<void> {
    this.energyArcParticles = this.device.createBuffer({
      size: 200 * 32,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    this.visualizer.profiler?.trackBuffer?.(`device-${this.id}-energyarcs`, 200 * 32, GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE);

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
    writeQueueBuffer(this.device, this.energyArcParticles, arcData);
  }

  async setupCore(): Promise<void> {
    this.coreInstances = this.device.createBuffer({
      size: 100 * 32,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    this.visualizer.profiler?.trackBuffer?.(`device-${this.id}-core`, 100 * 32, GPUBufferUsage.STORAGE);

    const core = this.config.core;
    const frameDims = this.visualizer?.segFrameBuffers?.dims;
    const plateY = frameDims?.plateY ?? core?.plateY ?? 2.5;

    // Instance buffer for bearing shaft (ringIndex = -1 signals steel to shader)
    this.shaftInstanceBuffer = this.device.createBuffer({
      size: 48,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    const shaftInstanceData = new Float32Array([
      0, 0, 0,       // position
      MATERIAL_SHAFT,
      0, 0, 0, 1,    // rotation quaternion
      0.65, 0.67, 0.70, // steel color
      0.0            // emissive
    ]);
    writeQueueBuffer(this.device, this.shaftInstanceBuffer, shaftInstanceData);
    this.visualizer.profiler?.trackBuffer?.(`device-${this.id}-shaft-instance`, 48, GPUBufferUsage.STORAGE);

    // Instance buffer for magnet core (default copper look)
    this.magnetInstanceBuffer = this.device.createBuffer({
      size: 48,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    const magnetInstanceData = new Float32Array([
      0, 0, 0,       // position
      MATERIAL_COPPER,           // ringIndex (default copper)
      0, 0, 0, 1,    // rotation quaternion
      0.85, 0.48, 0.25, // copper color
      0.0            // emissive
    ]);
    writeQueueBuffer(this.device, this.magnetInstanceBuffer, magnetInstanceData);
    this.visualizer.profiler?.trackBuffer?.(`device-${this.id}-magnet-instance`, 48, GPUBufferUsage.STORAGE);

    // Instance buffer for top plate (structural brass / aluminum)
    this.topPlateInstanceBuffer = this.device.createBuffer({
      size: 48,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    const topPlateData = new Float32Array([
      0, plateY, 0,  // position
      MATERIAL_STRUCTURAL,
      0, 0, 0, 1,    // rotation quaternion
      0.78, 0.58, 0.22, // brass color
      0.0            // emissive
    ]);
    writeQueueBuffer(this.device, this.topPlateInstanceBuffer, topPlateData);
    this.visualizer.profiler?.trackBuffer?.(`device-${this.id}-top-plate-instance`, 48, GPUBufferUsage.STORAGE);

    // Instance buffer for bottom plate
    this.bottomPlateInstanceBuffer = this.device.createBuffer({
      size: 48,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    const bottomPlateData = new Float32Array([
      0, -plateY, 0, // position
      MATERIAL_STRUCTURAL,
      0, 0, 0, 1,    // rotation quaternion
      0.78, 0.58, 0.22, // brass color
      0.0            // emissive
    ]);
    writeQueueBuffer(this.device, this.bottomPlateInstanceBuffer, bottomPlateData);
    this.visualizer.profiler?.trackBuffer?.(`device-${this.id}-bottom-plate-instance`, 48, GPUBufferUsage.STORAGE);
  }

  async setupElectromagnets(): Promise<void> {
    // Electromagnet coils arranged in a circle around the SEG rollers
    // Instance format: position(3) + angle(1) + activeIntensity(1) + coilIndex(1) + pad(2) = 8 floats = 32 bytes
    const maxCoils = 24;
    this.electromagnetInstances = this.device.createBuffer({
      size: maxCoils * 48,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    this.visualizer.profiler?.trackBuffer?.(`device-${this.id}-electromagnets`, maxCoils * 48, GPUBufferUsage.STORAGE);

    // Initialize with default 8-coil layout at radius 7.0
    this.updateElectromagnetLayout(8, 0);
  }

  updateElectromagnetLayout(numCoils: number, offsetAngleDeg: number): void {
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
    writeQueueBuffer(this.device, this.electromagnetInstances, instanceData);
  }
}
