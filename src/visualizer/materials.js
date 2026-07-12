// PBR material table buffer for enhanced SEG mesh pipeline.
import { SEGMaterialPresets } from '../seg-materials.js';

export const materialMethods = {
  setupMaterialTableBuffer() {
    const materials = [
      { ...SEGMaterialPresets.copper, accent: [0.55, 0.30, 0.15], detail: [18.0, 0.06, 0.10, 0.0] },      // 0 copper
      { ...SEGMaterialPresets.steel, accent: [0.75, 0.77, 0.80], detail: [24.0, 0.04, 0.08, 0.0] },       // 1 steel
      { ...SEGMaterialPresets.brass, accent: [0.45, 0.32, 0.12], detail: [20.0, 0.05, 0.12, 0.0] },       // 2 brass
      { ...SEGMaterialPresets.insulation, accent: [0.72, 0.70, 0.62], detail: [14.0, 0.0, 0.06, 0.0] },   // 3 insulation
      { ...SEGMaterialPresets.neodymium, accent: [0.55, 0.58, 0.60], detail: [16.0, 0.03, 0.07, 0.0] },   // 4 neodymium
      { ...SEGMaterialPresets.copperOxide, accent: [0.26, 0.42, 0.34], detail: [26.0, 0.04, 0.12, 0.0] }, // 5 oxidized copper
      { ...SEGMaterialPresets.boltSteel, accent: [0.85, 0.86, 0.88], detail: [36.0, 0.02, 0.18, 0.0] },   // 6 bolt steel
      { baseColor: [0.08, 0.13, 0.22], metallic: 0.18, roughness: 0.36, accent: [0.15, 0.34, 0.52], detail: [46.0, 0.0, 0.04, 0.0] }, // 7 solar
      { baseColor: [0.73, 0.77, 0.82], metallic: 0.02, roughness: 0.08, accent: [0.84, 0.89, 0.95], detail: [8.0, 0.0, 0.03, 0.0] },  // 8 fluid/glass
      { baseColor: [0.83, 0.86, 0.88], metallic: 0.05, roughness: 0.62, accent: [0.35, 0.45, 0.58], detail: [22.0, 0.0, 0.05, 0.0] }, // 9 ceramic
      { baseColor: [0.74, 0.76, 0.80], metallic: 0.72, roughness: 0.28, accent: [0.94, 0.96, 0.99], detail: [28.0, 0.05, 0.08, 0.0] }, // 10 anodized can
      { baseColor: [0.18, 0.23, 0.28], metallic: 0.12, roughness: 0.52, accent: [0.72, 0.20, 0.14], detail: [40.0, 0.0, 0.05, 0.0] }, // 11 peltier junction
      { baseColor: [0.92, 0.92, 0.90], metallic: 0.02, roughness: 0.48, accent: [0.20, 0.20, 0.22], detail: [30.0, 0.0, 0.06, 0.0] }, // 12 label paint
      { baseColor: [0.07, 0.08, 0.10], metallic: 0.55, roughness: 0.42, accent: [0.16, 0.18, 0.22], detail: [24.0, 0.06, 0.12, 0.0] }, // 13 SEG dark base
      { ...SEGMaterialPresets.laminatedIron, accent: [0.10, 0.11, 0.12], detail: [48.0, 0.08, 0.18, 0.0] },                            // 14 C-core laminated iron
      { ...SEGMaterialPresets.windingCopperEnamel, accent: [0.95, 0.62, 0.12], detail: [64.0, 0.04, 0.10, 0.0] },                      // 15 enameled winding copper
      { ...SEGMaterialPresets.mountFootSteel, accent: [0.55, 0.57, 0.60], detail: [32.0, 0.05, 0.14, 0.0] },                            // 16 coil mounting foot
      { ...SEGMaterialPresets.brushedAluminum, accent: [0.94, 0.96, 0.98], detail: [42.0, 0.03, 0.10, 0.0] },                           // 17 stator / ring aluminum
      { ...SEGMaterialPresets.magnetSegment, accent: [0.12, 0.14, 0.18], detail: [36.0, 0.06, 0.14, 0.0] }                             // 18 magnet segment strips
    ];

    const packed = new Float32Array(materials.length * 12);
    for (let i = 0; i < materials.length; i++) {
      const m = materials[i];
      const baseOffset = i * 12;
      packed.set([m.baseColor[0], m.baseColor[1], m.baseColor[2], m.metallic], baseOffset);
      packed.set([m.accent[0], m.accent[1], m.accent[2], m.roughness], baseOffset + 4);
      packed.set([m.detail[0], m.detail[1], m.detail[2], m.detail[3]], baseOffset + 8);
    }

    this.materialTableBuffer = this.device.createBuffer({
      size: packed.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(this.materialTableBuffer, 0, packed);
    this.profiler.trackBuffer('materialTable', packed.byteLength, GPUBufferUsage.STORAGE);
  }
};