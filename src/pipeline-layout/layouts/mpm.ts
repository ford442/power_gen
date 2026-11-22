import type { LayoutRegistrar } from '../types.js';
import { BGL } from '../generated/bind-group-layouts.js';

/**
 * MLS-MPM liquid solver (ADR-0022).
 *
 * `mpm` — the three passes of a substep, so a solver holds one bind group for
 * them: params, particles, the fixed-point grid p2g scatters into, the
 * velocity grid, and the boundary's signed-distance field. Each pass declares
 * only the bindings it uses. Binding 2 is `array<atomic<i32>>` in
 * mpm-p2g.wgsl and a plain `array<i32>` in mpm-grid.wgsl — the same buffer,
 * read after the scatter has finished. Binding 4 is always bound;
 * `params.flags` says whether it holds a field (a solver without solids binds
 * a one-node dummy).
 *
 * `mpmIo` — the once-a-frame passes around the substeps: emitters and sinks,
 * the height profile read-back, and the export to the 16-byte records the
 * particle pipeline draws. The velocity grid is read-only here.
 */
export function registerMpmLayouts(r: LayoutRegistrar): void {
  // passes/mpm-p2g.wgsl, mpm-grid.wgsl, mpm-g2p.wgsl.
  r.bgl('mpm', BGL.mpm);
  r.pl('mpm', ['mpm']);

  // passes/mpm-emit.wgsl, mpm-probe.wgsl, mpm-export.wgsl.
  r.bgl('mpmIo', BGL.mpmIo);
  r.pl('mpmIo', ['mpmIo']);
}
