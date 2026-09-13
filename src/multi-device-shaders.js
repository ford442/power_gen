/**
 * MultiDeviceShaders - Thin delegator for all WGSL shaders.
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
  getBloomCompositeShader
} from './shaders/generators/bloom-shaders.js';

export class MultiDeviceShaders {
  constructor() {}

  get rollerVertShader() {
    return getRollerVertShader();
  }

  get rollerFragShader() {
    return getRollerFragShader();
  }

  get particleVertShader() {
    return getParticleVertShader();
  }

  get particleFragShader() {
    return getParticleFragShader();
  }

  get coreVertShader() {
    return getCoreVertShader();
  }

  get coreFragShader() {
    return getCoreFragShader();
  }

  get fieldLineVertShader() {
    return getFieldLineVertShader();
  }

  get fieldLineFragShader() {
    return getFieldLineFragShader();
  }

  get fluxLineTracerShader() {
    return getFluxLineTracerShader();
  }

  get fluxSegmentVertShader() {
    return getFluxSegmentVertShader();
  }

  get fluxSegmentFragShader() {
    return getFluxSegmentFragShader();
  }

  get energyArcVertShader() {
    return getEnergyArcVertShader();
  }

  get energyArcFragShader() {
    return getEnergyArcFragShader();
  }

  get energyPipeVertShader() {
    return getEnergyPipeVertShader();
  }

  get energyPipeFragShader() {
    return getEnergyPipeFragShader();
  }

  get energyPipeComputeShader() {
    return getEnergyPipeComputeShader();
  }

  get coilVertShader() {
    return getCoilVertShader();
  }

  get coilFragShader() {
    return getCoilFragShader();
  }

  get segEnhancedVertShader() {
    return getSegEnhancedVertShader();
  }

  get segEnhancedFragShader() {
    return getSegEnhancedFragShader();
  }

  get computeShader() {
    return getComputeShader();
  }

  get segRollerComputeShader() {
    return getSegRollerComputeShader();
  }

  get segFieldAdvectShader() {
    return getSegFieldAdvectShader();
  }

  get overviewCullComputeShader() {
    return getOverviewCullComputeShader();
  }

  get transformerFluxShader() {
    return getTransformerFluxShader();
  }

  get choresReduceShader() {
    return getChoresReduceShader();
  }

  get skyVertShader() {
    return getSkyVertShader();
  }

  get skyFragShader() {
    return getSkyFragShader();
  }

  get gridVertShader() {
    return getGridVertShader();
  }

  get gridFragShader() {
    return getGridFragShader();
  }

  get bloomVertShader() {
    return getBloomVertShader();
  }

  get bloomExtractShader() {
    return getBloomExtractShader();
  }

  get bloomBlurShader() {
    return getBloomBlurShader();
  }

  get bloomCompositeShader() {
    return getBloomCompositeShader();
  }

  /** Screen-space reflections compute pass (ADR-0005 WS2). */
  get taaResolveShader() {
    return taaResolveWgsl;
  }

  get iblPrefilterComputeShader() {
    return iblPrefilterComputeWgsl;
  }

  get ssrComputeShader() {
    return ssrComputeWgsl;
  }

  get anomalyWallsShader() {
    return segAnomalyWallsWgsl;
  }

  /** Manual MSAA depth resolve, vsMain/fsMain (ADR-0005 WS2 — see passes/depth-resolve.wgsl). */
  get depthResolveShader() {
    return depthResolveWgsl;
  }

  /** 2D TM_z Yee update, updateH/updateE (ADR-0010 — see passes/fdtd-tmz-compute.wgsl). */
  get fdtdTmzComputeShader() {
    return fdtdTmzComputeWgsl;
  }

  /** FDTD slice panel, vsMain/fsMain (ADR-0010 — see passes/fdtd-slice.wgsl). */
  get fdtdSliceShader() {
    return fdtdSliceWgsl;
  }

  // Legacy / compatibility alias sometimes referenced in older code
  get fluxLinesWgsl() {
    return getFluxLineTracerShader();
  }
}
