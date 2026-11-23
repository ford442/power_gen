/**
 * WGSL of the MHD duct slice's compute passes and of its panel. Its own module so the strings
 * travel with the solver in the lazily loaded chunk, not in the WebGPU chunk
 * every visit downloads.
 */
import lbmWgsl from '../shaders/passes/mhd-slice-lbm.wgsl?raw';
import phiWgsl from '../shaders/passes/mhd-slice-phi.wgsl?raw';
import drawWgsl from '../shaders/passes/mhd-slice-draw.wgsl?raw';
import type { MhdSliceShaderSources } from '../pipeline-layout/factories/mhd-slice-pipelines.js';

export const MHD_SLICE_SHADERS: MhdSliceShaderSources = Object.freeze({
  lbm: lbmWgsl,
  phi: phiWgsl,
  draw: drawWgsl
});
