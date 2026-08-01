/**
 * Ambient types for the WGSL shader delegator (implementation stays JS —
 * it is a thin pass-through to the generators in src/shaders/generators).
 */

/** Every accessor returns generated WGSL source. */
export declare class MultiDeviceShaders {
  readonly rollerVertShader: string;
  readonly rollerFragShader: string;
  readonly particleVertShader: string;
  readonly particleFragShader: string;
  readonly coreVertShader: string;
  readonly coreFragShader: string;
  readonly fieldLineVertShader: string;
  readonly fieldLineFragShader: string;
  readonly fluxLineTracerShader: string;
  readonly fluxSegmentVertShader: string;
  readonly fluxSegmentFragShader: string;
  readonly energyArcVertShader: string;
  readonly energyArcFragShader: string;
  readonly energyPipeVertShader: string;
  readonly energyPipeFragShader: string;
  readonly energyPipeComputeShader: string;
  readonly coilVertShader: string;
  readonly coilFragShader: string;
  readonly segEnhancedVertShader: string;
  readonly segEnhancedFragShader: string;
  readonly computeShader: string;
  readonly segRollerComputeShader: string;
  readonly segFieldAdvectShader: string;
  readonly skyVertShader: string;
  readonly skyFragShader: string;
  readonly gridVertShader: string;
  readonly gridFragShader: string;
  readonly bloomVertShader: string;
  readonly bloomExtractShader: string;
  readonly bloomBlurShader: string;
  readonly bloomCompositeShader: string;
  readonly anomalyWallsShader: string;
}
