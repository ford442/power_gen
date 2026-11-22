/**
 * MultiDeviceShaders - Thin delegator for all WGSL shaders (typed TS; the
 * generators it forwards to in ./shaders/generators/* stay JS `?raw` re-exports).
 * Imports implementations from ./shaders/generators/* and raw files.
 * Contains getters for: roller, particle, core, field line, energy arc, coil,
 * seg-enhanced, compute, environment, bloom, and anomaly walls.
 */
import segAnomalyWallsWgsl from './shaders/passes/seg-anomaly-walls.wgsl?raw';
import ssrComputeWgsl from './shaders/passes/ssr-compute.wgsl?raw';
import iblPrefilterComputeWgsl from './shaders/passes/ibl-prefilter-compute.wgsl?raw';
import taaResolveWgsl from './shaders/passes/taa-resolve.wgsl?raw';
import depthResolveWgsl from './shaders/passes/depth-resolve.wgsl?raw';
import fdtdTmzComputeWgsl from './shaders/passes/fdtd-tmz-compute.wgsl?raw';
import fdtdSliceWgsl from './shaders/passes/fdtd-slice.wgsl?raw';
import fieldVolumeWgsl from './shaders/passes/field-volume.wgsl?raw';
import fieldProbeWgsl from './shaders/passes/field-probe.wgsl?raw';
import fieldStreamlinesWgsl from './shaders/passes/field-streamlines.wgsl?raw';
import fieldParticlesWgsl from './shaders/passes/field-particles.wgsl?raw';
import fieldLinesVertWgsl from './shaders/passes/field-lines-vert.wgsl?raw';
import fieldSliceWgsl from './shaders/passes/field-slice.wgsl?raw';
import fieldIsoWgsl from './shaders/passes/field-iso.wgsl?raw';
import mpmP2gWgsl from './shaders/passes/mpm-p2g.wgsl?raw';
import mpmGridWgsl from './shaders/passes/mpm-grid.wgsl?raw';
import mpmG2pWgsl from './shaders/passes/mpm-g2p.wgsl?raw';
import mpmEmitWgsl from './shaders/passes/mpm-emit.wgsl?raw';
import mpmProbeWgsl from './shaders/passes/mpm-probe.wgsl?raw';
import mpmExportWgsl from './shaders/passes/mpm-export.wgsl?raw';

import { getRollerVertShader, getRollerFragShader } from './shaders/generators/roller-shaders.js';
import { getParticleVertShader, getParticleFragShader } from './shaders/generators/particle-shaders.js';
import { getCoreVertShader, getCoreFragShader } from './shaders/generators/core-shaders.js';
import {
  getFieldLineVertShader,
  getFieldLineFragShader,
  getFluxLineTracerShader,
  getFluxSegmentVertShader,
  getFluxSegmentFragShader
} from './shaders/generators/field-line-shaders.js';
import { getEnergyArcVertShader, getEnergyArcFragShader } from './shaders/generators/energy-arc-shaders.js';
import { getEnergyPipeVertShader, getEnergyPipeFragShader, getEnergyPipeComputeShader } from './shaders/generators/energy-pipe-shaders.js';
import { getCoilVertShader, getCoilFragShader } from './shaders/generators/coil-shaders.js';
import { getSegEnhancedVertShader, getSegEnhancedFragShader } from './shaders/generators/seg-enhanced-shaders.js';
import {
  getComputeShader,
  getSegRollerComputeShader,
  getSegFieldAdvectShader,
  getOverviewCullComputeShader,
  getTransformerFluxShader,
  getChoresReduceShader
} from './shaders/generators/compute-shaders.js';
import {
  getSkyVertShader,
  getSkyFragShader,
  getGridVertShader,
  getGridFragShader
} from './shaders/generators/environment-shaders.js';
import {
  getBloomVertShader,
  getBloomExtractShader,
  getBloomBlurShader,
  getBloomCompositeShader,
  getBloomDownsampleShader,
  getBloomUpsampleShader
} from './shaders/generators/bloom-shaders.js';
import type { FieldShaderSources } from './pipeline-layout/factories/field-pipelines.js';
import type { MpmShaderSources } from './pipeline-layout/factories/mpm-pipelines.js';

/** Every accessor returns generated WGSL source. */
export class MultiDeviceShaders {
  get rollerVertShader(): string {
    return getRollerVertShader();
  }

  get rollerFragShader(): string {
    return getRollerFragShader();
  }

  get particleVertShader(): string {
    return getParticleVertShader();
  }

  get particleFragShader(): string {
    return getParticleFragShader();
  }

  get coreVertShader(): string {
    return getCoreVertShader();
  }

  get coreFragShader(): string {
    return getCoreFragShader();
  }

  get fieldLineVertShader(): string {
    return getFieldLineVertShader();
  }

  get fieldLineFragShader(): string {
    return getFieldLineFragShader();
  }

  get fluxLineTracerShader(): string {
    return getFluxLineTracerShader();
  }

  get fluxSegmentVertShader(): string {
    return getFluxSegmentVertShader();
  }

  get fluxSegmentFragShader(): string {
    return getFluxSegmentFragShader();
  }

  get energyArcVertShader(): string {
    return getEnergyArcVertShader();
  }

  get energyArcFragShader(): string {
    return getEnergyArcFragShader();
  }

  get energyPipeVertShader(): string {
    return getEnergyPipeVertShader();
  }

  get energyPipeFragShader(): string {
    return getEnergyPipeFragShader();
  }

  get energyPipeComputeShader(): string {
    return getEnergyPipeComputeShader();
  }

  get coilVertShader(): string {
    return getCoilVertShader();
  }

  get coilFragShader(): string {
    return getCoilFragShader();
  }

  get segEnhancedVertShader(): string {
    return getSegEnhancedVertShader();
  }

  get segEnhancedFragShader(): string {
    return getSegEnhancedFragShader();
  }

  get computeShader(): string {
    return getComputeShader();
  }

  get segRollerComputeShader(): string {
    return getSegRollerComputeShader();
  }

  get segFieldAdvectShader(): string {
    return getSegFieldAdvectShader();
  }

  get overviewCullComputeShader(): string {
    return getOverviewCullComputeShader();
  }

  get transformerFluxShader(): string {
    return getTransformerFluxShader();
  }

  get choresReduceShader(): string {
    return getChoresReduceShader();
  }

  get skyVertShader(): string {
    return getSkyVertShader();
  }

  get skyFragShader(): string {
    return getSkyFragShader();
  }

  get gridVertShader(): string {
    return getGridVertShader();
  }

  get gridFragShader(): string {
    return getGridFragShader();
  }

  get bloomVertShader(): string {
    return getBloomVertShader();
  }

  get bloomExtractShader(): string {
    return getBloomExtractShader();
  }

  get bloomBlurShader(): string {
    return getBloomBlurShader();
  }

  get bloomCompositeShader(): string {
    return getBloomCompositeShader();
  }

  get bloomDownsampleShader(): string {
    return getBloomDownsampleShader();
  }

  get bloomUpsampleShader(): string {
    return getBloomUpsampleShader();
  }

  /** Screen-space reflections compute pass (ADR-0005 WS2). */
  get taaResolveShader(): string {
    return taaResolveWgsl;
  }

  get iblPrefilterComputeShader(): string {
    return iblPrefilterComputeWgsl;
  }

  get ssrComputeShader(): string {
    return ssrComputeWgsl;
  }

  get anomalyWallsShader(): string {
    return segAnomalyWallsWgsl;
  }

  /** Manual MSAA depth resolve, vsMain/fsMain (ADR-0005 WS2 — see passes/depth-resolve.wgsl). */
  get depthResolveShader(): string {
    return depthResolveWgsl;
  }

  /** 2D TM_z Yee update, updateH/updateE (ADR-0010 — see passes/fdtd-tmz-compute.wgsl). */
  get fdtdTmzComputeShader(): string {
    return fdtdTmzComputeWgsl;
  }

  /** FDTD slice panel, vsMain/fsMain (ADR-0010 — see passes/fdtd-slice.wgsl). */
  get fdtdSliceShader(): string {
    return fdtdSliceWgsl;
  }

  /** Every field-volume pass (ADR-0017 — see passes/field-*.wgsl). */
  get fieldShaders(): FieldShaderSources {
    return {
      volume: fieldVolumeWgsl,
      probe: fieldProbeWgsl,
      streamlines: fieldStreamlinesWgsl,
      particles: fieldParticlesWgsl,
      linesVert: fieldLinesVertWgsl,
      linesFrag: getFluxSegmentFragShader(),
      slice: fieldSliceWgsl,
      iso: fieldIsoWgsl
    };
  }

  /** The MLS-MPM liquid passes: the substep, emitters / sinks, read-back, draw export (ADR-0022 — see passes/mpm-*.wgsl). */
  get mpmShaders(): MpmShaderSources {
    return { p2g: mpmP2gWgsl, grid: mpmGridWgsl, g2p: mpmG2pWgsl, emit: mpmEmitWgsl, probe: mpmProbeWgsl, exportDraw: mpmExportWgsl };
  }

  // Legacy / compatibility alias sometimes referenced in older code
  get fluxLinesWgsl(): string {
    return getFluxLineTracerShader();
  }
}
