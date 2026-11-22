/**
 * WGSL of the MLS-MPM liquid passes (ADR-0022): the substep, emitters and
 * sinks, the profile read-back, the draw export.
 *
 * Its own module so the strings travel with the solver in the lazily loaded
 * liquid chunk (visualizer/heron-liquid-runtime.ts) instead of in the WebGPU
 * chunk every visit downloads.
 */
import mpmP2gWgsl from '../shaders/passes/mpm-p2g.wgsl?raw';
import mpmGridWgsl from '../shaders/passes/mpm-grid.wgsl?raw';
import mpmG2pWgsl from '../shaders/passes/mpm-g2p.wgsl?raw';
import mpmEmitWgsl from '../shaders/passes/mpm-emit.wgsl?raw';
import mpmProbeWgsl from '../shaders/passes/mpm-probe.wgsl?raw';
import mpmExportWgsl from '../shaders/passes/mpm-export.wgsl?raw';
import type { MpmShaderSources } from '../pipeline-layout/factories/mpm-pipelines.js';

export const MPM_SHADERS: MpmShaderSources = Object.freeze({
  p2g: mpmP2gWgsl,
  grid: mpmGridWgsl,
  g2p: mpmG2pWgsl,
  emit: mpmEmitWgsl,
  probe: mpmProbeWgsl,
  exportDraw: mpmExportWgsl
});
