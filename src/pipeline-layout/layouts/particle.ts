import type { LayoutRegistrar } from '../types.js';
import { BGL } from '../generated/bind-group-layouts.js';

/** Interactive particle billboards + particle compute. */
export function registerParticleLayouts(r: LayoutRegistrar): void {
  r.bgl('particle', BGL.particle);
  r.pl('particle', ['particle']);

  r.bgl('particleCompute', BGL.particleCompute);
  r.pl('particleCompute', ['particleCompute']);
}
