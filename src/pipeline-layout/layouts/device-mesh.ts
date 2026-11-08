import type { LayoutRegistrar } from '../types.js';
import { BGL } from '../generated/bind-group-layouts.js';

/** Flux segments, field particles, energy pipes, coils. */
export function registerDeviceMeshLayouts(r: LayoutRegistrar): void {
  r.bgl('fluxSegment', BGL.fluxSegment);
  r.pl('fluxSegment', ['frame', 'fluxSegment']);

  r.bgl('fieldParticles', BGL.fieldParticles);
  r.pl('fieldParticles', ['frame', 'fieldParticles']);

  r.bgl('energyPipe', BGL.energyPipe);
  r.pl('energyPipe', ['frame', 'energyPipe']);

  r.bgl('energyPipeCompute', BGL.energyPipeCompute);
  r.pl('energyPipeCompute', ['energyPipeCompute']);

  r.bgl('coil', BGL.coil);
  r.pl('coil', ['frame', 'coil']);
}
