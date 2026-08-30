import type { LayoutRegistrar } from '../types.js';
import {
  uniform, storage, texture, depthTexture, textureArray, sampler, storageTexture,
  VF, VS, FS, CS, SSR_FORMAT
} from '../helpers.js';

/** SEG PBR mesh + SEG compute passes (roller, field advect, flux tracer). */
export function registerSegEnhancedLayouts(r: LayoutRegistrar): void {
  r.bgl('roller', [
    uniform(0, VF),
    uniform(1, VF),
    storage(2, VS, true),
    uniform(3, FS),
    storage(5, FS, true)
  ]);
  r.pl('roller', ['roller']);

  r.bgl('segEnhanced', [
    uniform(0, VF),
    uniform(1, VF),
    storage(2, VS, true),
    uniform(3, FS),
    uniform(4, VS),
    uniform(5, FS),
    storage(6, FS, true),
    textureArray(7, FS),
    sampler(8, FS)
  ]);
  r.pl('segEnhanced', ['segEnhanced']);

  r.bgl('rollerCompute', [
    storage(0, CS, false),
    uniform(1, CS),
    uniform(2, CS)
  ]);
  r.pl('rollerCompute', ['rollerCompute']);

  r.bgl('fieldAdvect', [
    storage(0, CS, false),
    uniform(1, CS)
  ]);
  r.pl('fieldAdvect', ['fieldAdvect']);

  r.bgl('transformerFlux', [
    storage(0, CS, false),
    uniform(1, CS)
  ]);
  r.pl('transformerFlux', ['transformerFlux']);

  r.bgl('choresReduce', [
    storage(0, CS, true),
    storage(1, CS, false),
    uniform(2, CS)
  ]);
  r.pl('choresReduce', ['choresReduce']);

  r.bgl('fluxTracer', [
    storage(0, CS, false),
    uniform(1, CS),
    storage(2, CS, true),
    uniform(3, CS)
  ]);
  r.pl('fluxTracer', ['fluxTracer']);
}
