/**
 * AUTO-GENERATED from src/pipeline-layout/bind-group-schema.json — do not edit.
 * Regenerate: npm run codegen:bindings
 */

export type SchemaBindGroupLayoutName =
  | 'roller'
  | 'particle'
  | 'segEnhanced'
  | 'fluxSegment'
  | 'fieldParticles'
  | 'energyPipe'
  | 'energyPipeCompute'
  | 'coil'
  | 'particleCompute'
  | 'overviewCull'
  | 'rollerCompute'
  | 'fieldAdvect'
  | 'transformerFlux'
  | 'choresReduce'
  | 'fluxTracer'
  | 'sky'
  | 'empty'
  | 'anomalyWall'
  | 'bloomExtract'
  | 'bloomBlur'
  | 'bloomComposite'
  | 'ssr'
  | 'iblPrefilter'
  | 'taaResolve'
  | 'depthResolve'
  | 'fdtdCompute'
  | 'fdtdSlice';

/** `GPUBindGroupLayoutDescriptor.entries` per named layout (visibility: 1=VERTEX 2=FRAGMENT 4=COMPUTE). */
export const BGL: Readonly<Record<SchemaBindGroupLayoutName, readonly GPUBindGroupLayoutEntry[]>> = {
  roller: [
    { binding: 0, visibility: 3, buffer: { type: 'uniform' } },
    { binding: 1, visibility: 3, buffer: { type: 'uniform' } },
    { binding: 2, visibility: 1, buffer: { type: 'read-only-storage' } },
    { binding: 3, visibility: 2, buffer: { type: 'uniform' } },
    { binding: 5, visibility: 2, buffer: { type: 'read-only-storage' } },
  ],
  particle: [
    { binding: 0, visibility: 3, buffer: { type: 'uniform' } },
    { binding: 1, visibility: 3, buffer: { type: 'uniform' } },
    { binding: 3, visibility: 2, buffer: { type: 'uniform' } },
    { binding: 4, visibility: 1, buffer: { type: 'read-only-storage' } },
  ],
  segEnhanced: [
    { binding: 0, visibility: 3, buffer: { type: 'uniform' } },
    { binding: 1, visibility: 3, buffer: { type: 'uniform' } },
    { binding: 2, visibility: 1, buffer: { type: 'read-only-storage' } },
    { binding: 3, visibility: 2, buffer: { type: 'uniform' } },
    { binding: 4, visibility: 1, buffer: { type: 'uniform' } },
    { binding: 5, visibility: 2, buffer: { type: 'uniform' } },
    { binding: 6, visibility: 2, buffer: { type: 'read-only-storage' } },
    { binding: 7, visibility: 2, texture: { sampleType: 'float', viewDimension: '2d-array' } },
    { binding: 8, visibility: 2, sampler: { type: 'filtering' } },
  ],
  fluxSegment: [
    { binding: 0, visibility: 3, buffer: { type: 'uniform' } },
    { binding: 1, visibility: 3, buffer: { type: 'uniform' } },
    { binding: 2, visibility: 1, buffer: { type: 'read-only-storage' } },
  ],
  fieldParticles: [
    { binding: 0, visibility: 3, buffer: { type: 'uniform' } },
    { binding: 1, visibility: 3, buffer: { type: 'uniform' } },
    { binding: 4, visibility: 1, buffer: { type: 'read-only-storage' } },
  ],
  energyPipe: [
    { binding: 0, visibility: 3, buffer: { type: 'uniform' } },
    { binding: 1, visibility: 3, buffer: { type: 'uniform' } },
    { binding: 2, visibility: 1, buffer: { type: 'read-only-storage' } },
  ],
  energyPipeCompute: [
    { binding: 0, visibility: 4, buffer: { type: 'storage' } },
    { binding: 1, visibility: 4, buffer: { type: 'uniform' } },
  ],
  coil: [
    { binding: 0, visibility: 3, buffer: { type: 'uniform' } },
    { binding: 1, visibility: 3, buffer: { type: 'uniform' } },
    { binding: 2, visibility: 1, buffer: { type: 'read-only-storage' } },
    { binding: 3, visibility: 2, buffer: { type: 'uniform' } },
  ],
  particleCompute: [
    { binding: 0, visibility: 4, buffer: { type: 'storage' } },
    { binding: 1, visibility: 4, buffer: { type: 'uniform' } },
  ],
  overviewCull: [
    { binding: 0, visibility: 4, buffer: { type: 'read-only-storage' } },
    { binding: 1, visibility: 4, buffer: { type: 'uniform' } },
    { binding: 2, visibility: 4, buffer: { type: 'storage' } },
    { binding: 3, visibility: 4, buffer: { type: 'storage' } },
  ],
  rollerCompute: [
    { binding: 0, visibility: 4, buffer: { type: 'storage' } },
    { binding: 1, visibility: 4, buffer: { type: 'uniform' } },
    { binding: 2, visibility: 4, buffer: { type: 'uniform' } },
  ],
  fieldAdvect: [
    { binding: 0, visibility: 4, buffer: { type: 'storage' } },
    { binding: 1, visibility: 4, buffer: { type: 'uniform' } },
  ],
  transformerFlux: [
    { binding: 0, visibility: 4, buffer: { type: 'storage' } },
    { binding: 1, visibility: 4, buffer: { type: 'uniform' } },
  ],
  choresReduce: [
    { binding: 0, visibility: 4, buffer: { type: 'read-only-storage' } },
    { binding: 1, visibility: 4, buffer: { type: 'storage' } },
    { binding: 2, visibility: 4, buffer: { type: 'uniform' } },
  ],
  fluxTracer: [
    { binding: 0, visibility: 4, buffer: { type: 'storage' } },
    { binding: 1, visibility: 4, buffer: { type: 'uniform' } },
    { binding: 2, visibility: 4, buffer: { type: 'read-only-storage' } },
    { binding: 3, visibility: 4, buffer: { type: 'uniform' } },
  ],
  sky: [
    { binding: 0, visibility: 2, buffer: { type: 'uniform' } },
  ],
  empty: [],
  anomalyWall: [
    { binding: 0, visibility: 3, buffer: { type: 'uniform' } },
    { binding: 1, visibility: 2, buffer: { type: 'uniform' } },
  ],
  bloomExtract: [
    { binding: 0, visibility: 2, texture: { sampleType: 'float', viewDimension: '2d' } },
    { binding: 1, visibility: 2, sampler: { type: 'filtering' } },
    { binding: 2, visibility: 2, buffer: { type: 'uniform' } },
  ],
  bloomBlur: [
    { binding: 0, visibility: 2, texture: { sampleType: 'float', viewDimension: '2d' } },
    { binding: 1, visibility: 2, sampler: { type: 'filtering' } },
    { binding: 2, visibility: 2, buffer: { type: 'uniform' } },
    { binding: 3, visibility: 2, buffer: { type: 'uniform' } },
  ],
  bloomComposite: [
    { binding: 0, visibility: 2, texture: { sampleType: 'float', viewDimension: '2d' } },
    { binding: 1, visibility: 2, texture: { sampleType: 'float', viewDimension: '2d' } },
    { binding: 2, visibility: 2, sampler: { type: 'filtering' } },
    { binding: 3, visibility: 2, buffer: { type: 'uniform' } },
    { binding: 4, visibility: 2, texture: { sampleType: 'depth', viewDimension: '2d' } },
    { binding: 5, visibility: 2, texture: { sampleType: 'float', viewDimension: '2d' } },
    { binding: 6, visibility: 2, texture: { sampleType: 'float', viewDimension: '2d' } },
  ],
  ssr: [
    { binding: 0, visibility: 4, texture: { sampleType: 'depth', viewDimension: '2d' } },
    { binding: 1, visibility: 4, texture: { sampleType: 'float', viewDimension: '2d' } },
    { binding: 2, visibility: 4, sampler: { type: 'filtering' } },
    { binding: 3, visibility: 4, buffer: { type: 'uniform' } },
    { binding: 4, visibility: 4, storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '2d' } },
    { binding: 5, visibility: 4, texture: { sampleType: 'float', viewDimension: '2d' } },
  ],
  iblPrefilter: [
    { binding: 0, visibility: 4, buffer: { type: 'uniform' } },
    { binding: 1, visibility: 4, storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '2d-array' } },
  ],
  taaResolve: [
    { binding: 0, visibility: 2, texture: { sampleType: 'float', viewDimension: '2d' } },
    { binding: 1, visibility: 2, texture: { sampleType: 'float', viewDimension: '2d' } },
    { binding: 2, visibility: 2, sampler: { type: 'filtering' } },
    { binding: 3, visibility: 2, texture: { sampleType: 'depth', viewDimension: '2d' } },
    { binding: 4, visibility: 2, buffer: { type: 'uniform' } },
  ],
  depthResolve: [
    { binding: 0, visibility: 2, texture: { sampleType: 'depth', viewDimension: '2d', multisampled: true } },
  ],
  fdtdCompute: [
    { binding: 0, visibility: 4, buffer: { type: 'uniform' } },
    { binding: 1, visibility: 4, buffer: { type: 'storage' } },
    { binding: 2, visibility: 4, buffer: { type: 'storage' } },
    { binding: 3, visibility: 4, buffer: { type: 'storage' } },
    { binding: 4, visibility: 4, buffer: { type: 'read-only-storage' } },
  ],
  fdtdSlice: [
    { binding: 0, visibility: 1, buffer: { type: 'uniform' } },
    { binding: 1, visibility: 3, buffer: { type: 'uniform' } },
    { binding: 2, visibility: 2, buffer: { type: 'uniform' } },
    { binding: 3, visibility: 2, buffer: { type: 'read-only-storage' } },
    { binding: 4, visibility: 2, buffer: { type: 'read-only-storage' } },
    { binding: 5, visibility: 2, buffer: { type: 'read-only-storage' } },
    { binding: 6, visibility: 2, buffer: { type: 'read-only-storage' } },
  ],
};
