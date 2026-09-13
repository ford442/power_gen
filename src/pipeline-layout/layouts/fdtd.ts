import type { LayoutRegistrar } from '../types.js';
import { uniform, storage, VS, FS, CS } from '../helpers.js';

/** 2D TM_z FDTD wave slice (ADR-0010) — compute update + scene-pass panel. */
export function registerFdtdLayouts(r: LayoutRegistrar): void {
  // passes/fdtd-tmz-compute.wgsl — `updateH` and `updateE` share this layout.
  r.bgl('fdtdCompute', [
    uniform(0, CS),
    storage(1, CS, false),
    storage(2, CS, false),
    storage(3, CS, false)
  ]);
  r.pl('fdtdCompute', ['fdtdCompute']);

  // passes/fdtd-slice.wgsl — reads the fields the compute pass wrote.
  r.bgl('fdtdSlice', [
    uniform(0, VS),
    uniform(1, VS | FS),
    uniform(2, FS),
    storage(3, FS, true),
    storage(4, FS, true),
    storage(5, FS, true)
  ]);
  r.pl('fdtdSlice', ['fdtdSlice']);
}
