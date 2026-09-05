/**
 * DeviceUniformManager - Manages uniform buffer setup and updates for device instances
 * Handles: device uniforms, material uniforms, core material buffers, coil material buffers
 */
import { getDeviceModeIndex } from './devices/device-registry';
import { writeQueueBuffer } from './gpu-buffer-write';
import type { DeviceInstanceConfig } from './device-instance';
import type { VisualizerLike } from './devices/types';

class DeviceUniformManager {
  device: GPUDevice;
  id: string;
  config: DeviceInstanceConfig;
  visualizer: VisualizerLike;

  deviceUniformBuffer!: GPUBuffer;
  materialUniformBuffer!: GPUBuffer;
  coreMaterialBuffer: GPUBuffer | null = null;
  gaugeInstanceBuffer: GPUBuffer | null = null;
  coilMaterialBuffer: GPUBuffer | null = null;
  ringMaterialBuffer: GPUBuffer | null = null;
  coilInstances: GPUBuffer | null = null;

  renderMode = 0;
  /** State for battery charge (solar device) */
  batteryCharge = 0.5;

  constructor(device: GPUDevice, id: string, config: DeviceInstanceConfig, visualizer: VisualizerLike) {
    this.device = device;
    this.id = id;
    this.config = config;
    this.visualizer = visualizer;
  }

  getRingIndex(): number {
    return getDeviceModeIndex(this.id);
  }

  async setupUniforms(): Promise<void> {
    // DeviceUniforms: 48 bytes (12 x f32) - canonical unified struct
    // [0] renderMode, [1-3] position, [4-7] rotation, [8] timeScale, [9] ringIndex, [10] batteryCharge, [11] isSolar
    this.deviceUniformBuffer = this.device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.materialUniformBuffer = this.device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.renderMode = 0;  // 0=rollers, 1=base, 2=stator, 3=wiring

    this.visualizer.profiler?.trackBuffer?.(`device-${this.id}-uniforms`, 80, GPUBufferUsage.UNIFORM);

    // Battery gauge instance buffer used by solar device
    if (this.id === 'solar') {
      // 48 B — matches InstanceData in rollerVertShader (pos+ring+quat+copper+emissive)
      this.gaugeInstanceBuffer = this.device.createBuffer({
        size: 48,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
      });
      this.visualizer.profiler?.trackBuffer?.(`device-${this.id}-gauge-instance`, 48, GPUBufferUsage.STORAGE);
    }

    // MaterialUniforms: albedo(3) + metallic(1) + roughness(1) + ao(1) + emission(1) + ringIndex(1) + pad(2)
    // Total: 12 floats = 48 bytes
    // Material uniform setup (may be updated per-frame for dynamic effects)
    let baseColor: number[] = this.config.color ?? [0.7, 0.7, 0.75];
    let glowColor = [0.0, 0.9, 1.0];
    let emission = 2.0;
    let pad = 0.0;

    if (this.id === 'seg') {
      // SEG uses copper base with green energy glow
      baseColor = [0.85, 0.48, 0.25]; // Copper
      glowColor = [0.0, 1.2, 0.6];    // Green energy
      emission = 1.8;
      pad = this.visualizer.prototypePreset === 'lab' ? 1.0 : 0.0;
    } else if (this.id === 'solar') {
      // Solar device uses a warm glow color and will modulate emission based on battery charge.
      baseColor = this.config.color ?? baseColor;
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
    writeQueueBuffer(this.device, this.materialUniformBuffer, materialData);

    // Setup core material buffer for SEG
    if (this.id === 'seg' && this.config.core) {
      this.coreMaterialBuffer = this.device.createBuffer({
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      });
      this.visualizer.profiler?.trackBuffer?.(`device-${this.id}-core-material`, 32, GPUBufferUsage.UNIFORM);

      const core = this.config.core;
      // baseColor (3) + emission (1) + coreColor (3) + glowIntensity (1)
      const coreMaterialData = new Float32Array([
        ...core.baseColor, 0.0,  // baseColor + padding
        ...core.coreColor, 1.5   // coreColor + glowIntensity
      ]);
      writeQueueBuffer(this.device, this.coreMaterialBuffer, coreMaterialData);
    }

    // Setup coil and ring material buffers for SEG pickup coils
    if (this.id === 'seg') {
      // C-shaped pickup coils: up to 24 coils, 3 parts each (core/winding/foot).
      this.coilInstances = this.device.createBuffer({
        size: 24 * 3 * 12 * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
      });
      this.visualizer.profiler?.trackBuffer?.(`device-${this.id}-coil-instances`, 24 * 3 * 48, GPUBufferUsage.STORAGE);

      this.coilMaterialBuffer = this.device.createBuffer({
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      });
      this.visualizer.profiler?.trackBuffer?.(`device-${this.id}-coil-material`, 32, GPUBufferUsage.UNIFORM);
      const coilMatData = new Float32Array([0.75, 0.45, 0.25, 0, 1.0, 0.55, 0.0, 2.5]);
      writeQueueBuffer(this.device, this.coilMaterialBuffer, coilMatData);

      this.ringMaterialBuffer = this.device.createBuffer({
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      });
      this.visualizer.profiler?.trackBuffer?.(`device-${this.id}-ring-material`, 32, GPUBufferUsage.UNIFORM);
      const ringMatData = new Float32Array([0.85, 0.48, 0.25, 0, 0.0, 1.2, 0.6, 1.8]);
      writeQueueBuffer(this.device, this.ringMaterialBuffer, ringMatData);
    }
  }

  updateUniforms(position: ArrayLike<number>, rotation: ArrayLike<number>, renderMode = 0, energyLevel = 0.0): void {
    // Determine ring index for shaders: 0=SEG, 1=Heron, 2=Kelvin, 3=Solar, 4=Peltier, 5=MHD
    const ringIndex = this.getRingIndex();

    // Battery charge for solar device (0..1) passed via the padding slot
    if (this.id === 'solar' && this.batteryCharge === undefined) {
      this.batteryCharge = 0.5;
    }

    const deviceData = new Float32Array([
      renderMode,                           // [0] renderMode
      position[0],                          // [1] posX
      position[1],                          // [2] posY
      position[2],                          // [3] posZ
      Math.sin(rotation[1] / 2),            // [4] rotation.x (quaternion)
      0,                                    // [5] rotation.y
      Math.cos(rotation[1] / 2),            // [6] rotation.z
      1.0,                                  // [7] rotation.w
      energyLevel,                          // [8] energyLevel (reuses timeScale slot)
      ringIndex,                            // [9] ringIndex
      this.id === 'solar' ? this.batteryCharge : 0,  // [10] batteryCharge
      this.id === 'solar' ? 1 : 0           // [11] isSolar
    ]);
    writeQueueBuffer(this.device, this.deviceUniformBuffer, deviceData);

    if (this.id === 'solar') {
      // Update material buffer to reflect battery charge
      const baseColor = this.config.color ?? [0.7, 0.7, 0.75];
      const glowColor = [1.0, 0.9, 0.4];
      const emission = 1.2 + energyLevel * 1.8;
      const materialData = new Float32Array([
        ...baseColor,
        this.batteryCharge,
        ...glowColor,
        emission
      ]);
      writeQueueBuffer(this.device, this.materialUniformBuffer, materialData);
    }
  }

  updateBatteryCharge(deltaTime: number): number | null {
    if (this.id === 'solar') {
      const drain = 0.18;
      const gain = 0.3 + 0.2 * Math.sin(this.visualizer.time * 2.0);
      this.batteryCharge = Math.min(1.0, Math.max(0.0, this.batteryCharge + (gain - drain) * deltaTime));
      return this.batteryCharge;
    }
    return null;
  }

  updateGaugeBuffer(position: ArrayLike<number>, ringIndex: number): void {
    if (this.id === 'solar' && this.gaugeInstanceBuffer) {
      const offset = 1.5;
      const gaugePos = [position[0] + offset, position[1] + 0.5, position[2]];
      const rotation = [0, 0, 0, 1];
      const instanceData = new Float32Array([
        gaugePos[0], gaugePos[1], gaugePos[2], ringIndex,
        rotation[0], rotation[1], rotation[2], rotation[3],
        1.0, 0.9, 0.2,   // copperColor (solar gold)
        this.batteryCharge // greenEmissive slot → reuse for charge visualization
      ]);
      writeQueueBuffer(this.device, this.gaugeInstanceBuffer, instanceData);
    }
  }
}

export { DeviceUniformManager };
