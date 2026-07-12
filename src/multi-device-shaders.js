/**
 * MultiDeviceShaders - Thin delegator for all WGSL shaders.
 * Imports implementations from ./shaders/generators/* and raw files.
 * Contains getters for: roller, particle, core, field line, energy arc, coil,
 * seg-enhanced, compute, environment, bloom, and anomaly walls.
 */
import fluxLinesWgsl from './shaders/flux-lines.wgsl?raw';
import segAnomalyWallsWgsl from './shaders/seg-anomaly-walls.wgsl?raw';

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
  getSegFieldAdvectShader
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

  get anomalyWallsShader() {
    return segAnomalyWallsWgsl;
  }

  // Legacy / compatibility alias sometimes referenced in older code
  get fluxLinesWgsl() {
    return fluxLinesWgsl;
  }
}
