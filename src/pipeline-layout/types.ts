/** Named bind group layouts — keep in sync with docs/BINDINGS.md. */
export type BindGroupLayoutName =
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
  | 'depthResolve';

export type PipelineLayoutName = BindGroupLayoutName | 'emptyGroups';

export interface LayoutRegistrar {
  readonly device: GPUDevice;
  bgl(name: BindGroupLayoutName, entries: GPUBindGroupLayoutEntry[]): void;
  pl(name: PipelineLayoutName, bglNames: BindGroupLayoutName[]): void;
  setEmptyGroupsPipeline(layout: GPUPipelineLayout): void;
}
