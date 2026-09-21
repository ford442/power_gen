import type { LayoutRegistrar } from '../types.js';
import { uniform, storage, VS, FS, CS } from '../helpers.js';

/**
 * 2D TM_z FDTD wave slice (ADR-0010) — compute update + scene-pass panel.
 * Binding 4 / 6 is the ADR-0012 material map: `array<vec2f>` of
 * (1/μ_r, electric half-step loss). It is always bound — `params.materialFlags`
 * decides whether it is read — so a vacuum slice needs no second pipeline.
 */
export function registerFdtdLayouts(r: LayoutRegistrar): void {
  // passes/fdtd-tmz-compute.wgsl — `updateH` and `updateE` share this layout.
  r.bgl('fdtdCompute', [
    uniform(0, CS),
    storage(1, CS, false),
    storage(2, CS, false),
    storage(3, CS, false),
    storage(4, CS, true)
  ]);
  r.pl('fdtdCompute', ['fdtdCompute']);

  // passes/fdtd-slice.wgsl — reads the fields the compute pass wrote.
  r.bgl('fdtdSlice', [
    uniform(0, VS),
    uniform(1, VS | FS),
    uniform(2, FS),
    storage(3, FS, true),
    storage(4, FS, true),
    storage(5, FS, true),
    storage(6, FS, true)
  ]);
  r.pl('fdtdSlice', ['fdtdSlice']);
}
