import type { LayoutRegistrar } from '../types.js';
import { BGL } from '../generated/bind-group-layouts.js';

/**
 * 2D TM_z FDTD wave slice (ADR-0010) — compute update + scene-pass panel.
 * Binding 4 / 6 is the ADR-0012 material map: `array<vec2f>` of
 * (1/μ_r, electric half-step loss). It is always bound — `params.materialFlags`
 * decides whether it is read — so a vacuum slice needs no second pipeline.
 */
export function registerFdtdLayouts(r: LayoutRegistrar): void {
  // passes/fdtd-tmz-compute.wgsl — `updateH` and `updateE` share this layout.
  r.bgl('fdtdCompute', BGL.fdtdCompute);
  r.pl('fdtdCompute', ['fdtdCompute']);

  // passes/fdtd-slice.wgsl — reads the fields the compute pass wrote.
  r.bgl('fdtdSlice', BGL.fdtdSlice);
  r.pl('fdtdSlice', ['fdtdSlice']);
}
