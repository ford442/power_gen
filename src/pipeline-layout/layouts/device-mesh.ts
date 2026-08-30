import type { LayoutRegistrar } from '../types.js';
import { uniform, storage, VF, VS, FS, CS } from '../helpers.js';

/** Flux segments, field particles, energy pipes, coils. */
export function registerDeviceMeshLayouts(r: LayoutRegistrar): void {
  r.bgl('fluxSegment', [
    uniform(0, VF),
    uniform(1, VF),
    storage(2, VS, true)
  ]);
  r.pl('fluxSegment', ['fluxSegment']);

  r.bgl('fieldParticles', [
    uniform(0, VF),
    uniform(1, VF),
    storage(4, VS, true)
  ]);
  r.pl('fieldParticles', ['fieldParticles']);

  r.bgl('energyPipe', [
    uniform(0, VF),
    uniform(1, VF),
    storage(2, VS, true)
  ]);
  r.pl('energyPipe', ['energyPipe']);

  r.bgl('energyPipeCompute', [
    storage(0, CS, false),
    uniform(1, CS)
  ]);
  r.pl('energyPipeCompute', ['energyPipeCompute']);

  r.bgl('coil', [
    uniform(0, VF),
    uniform(1, VF),
    storage(2, VS, true),
    uniform(3, FS)
  ]);
  r.pl('coil', ['coil']);
}
