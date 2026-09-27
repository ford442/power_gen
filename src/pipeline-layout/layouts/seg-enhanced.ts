import type { LayoutRegistrar } from '../types.js';
import { BGL } from '../generated/bind-group-layouts.js';

/** SEG PBR mesh + SEG compute passes (roller, field advect, flux tracer). */
export function registerSegEnhancedLayouts(r: LayoutRegistrar): void {
  r.bgl('roller', BGL.roller);
  r.pl('roller', ['roller']);

  r.bgl('segEnhanced', BGL.segEnhanced);
  r.pl('segEnhanced', ['segEnhanced']);

  r.bgl('rollerCompute', BGL.rollerCompute);
  r.pl('rollerCompute', ['rollerCompute']);

  r.bgl('fieldAdvect', BGL.fieldAdvect);
  r.pl('fieldAdvect', ['fieldAdvect']);

  r.bgl('transformerFlux', BGL.transformerFlux);
  r.pl('transformerFlux', ['transformerFlux']);

  r.bgl('choresReduce', BGL.choresReduce);
  r.pl('choresReduce', ['choresReduce']);

  r.bgl('fluxTracer', BGL.fluxTracer);
  r.pl('fluxTracer', ['fluxTracer']);
}
