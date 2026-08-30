import type { LayoutRegistrar } from '../types.js';
import { uniform, storage, VF, VS, FS, CS } from '../helpers.js';

/** Interactive particle billboards + particle compute. */
export function registerParticleLayouts(r: LayoutRegistrar): void {
  r.bgl('particle', [
    uniform(0, VF),
    uniform(1, VF),
    uniform(3, FS),
    storage(4, VS, true)
  ]);
  r.pl('particle', ['particle']);

  r.bgl('particleCompute', [
    storage(0, CS, false),
    uniform(1, CS)
  ]);
  r.pl('particleCompute', ['particleCompute']);
}
