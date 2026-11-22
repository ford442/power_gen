import type { LayoutRegistrar } from '../types.js';
import { BGL } from '../generated/bind-group-layouts.js';

/**
 * MLS-MPM liquid solver (ADR-0022). One layout for the three passes of a
 * substep, so a solver holds one bind group: params, particles, the
 * fixed-point grid p2g scatters into, and the velocity grid.
 *
 * Each pass declares only the bindings it uses. Binding 2 is
 * `array<atomic<i32>>` in mpm-p2g.wgsl and a plain `array<i32>` in
 * mpm-grid.wgsl — the same buffer, read after the scatter has finished.
 */
export function registerMpmLayouts(r: LayoutRegistrar): void {
  // passes/mpm-p2g.wgsl, mpm-grid.wgsl, mpm-g2p.wgsl.
  r.bgl('mpm', BGL.mpm);
  r.pl('mpm', ['mpm']);
}
