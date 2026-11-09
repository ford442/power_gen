/** Named bind group layouts — keep in sync with docs/BINDINGS.md. */
export type BindGroupLayoutName =
  | 'frame'
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
  | 'anomalyWall'
  | 'bloomExtract'
  | 'bloomBlur'
  | 'bloomMip'
  | 'bloomComposite'
  | 'ssr'
  | 'iblPrefilter'
  | 'taaResolve'
  | 'depthResolve'
  | 'fdtdCompute'
  | 'fdtdSlice';

/**
 * Pipeline layouts share their bind group layout's name. Scene pipelines are
 * `[frame, <own>]`; `grid` has no group of its own, so it is `[frame]` alone.
 */
export type PipelineLayoutName = Exclude<BindGroupLayoutName, 'frame'> | 'grid';

export interface LayoutRegistrar {
  readonly device: GPUDevice;
  bgl(name: BindGroupLayoutName, entries: readonly GPUBindGroupLayoutEntry[]): void;
  pl(name: PipelineLayoutName, bglNames: BindGroupLayoutName[]): void;
}
