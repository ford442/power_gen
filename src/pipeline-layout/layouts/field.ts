import type { LayoutRegistrar } from '../types.js';
import { BGL } from '../generated/bind-group-layouts.js';

/**
 * 3-D magnetostatic field volume (ADR-0017): the volume compute, the exact
 * point probe, the streamline tracer and the Boris pusher (compute, one group
 * each), plus the scene-pass consumers — line billboards, slice plane and
 * isosurface march — on `[frame, <own>]`.
 */
export function registerFieldLayouts(r: LayoutRegistrar): void {
  r.bgl('fieldVolume', BGL.fieldVolume);
  r.pl('fieldVolume', ['fieldVolume']);
  r.bgl('fieldProbe', BGL.fieldProbe);
  r.pl('fieldProbe', ['fieldProbe']);
  r.bgl('fieldStreamlines', BGL.fieldStreamlines);
  r.pl('fieldStreamlines', ['fieldStreamlines']);
  r.bgl('fieldCharges', BGL.fieldCharges);
  r.pl('fieldCharges', ['fieldCharges']);

  r.bgl('fieldLines', BGL.fieldLines);
  r.pl('fieldLines', ['frame', 'fieldLines']);
  r.bgl('fieldSlice', BGL.fieldSlice);
  r.pl('fieldSlice', ['frame', 'fieldSlice']);
  r.bgl('fieldIso', BGL.fieldIso);
  r.pl('fieldIso', ['frame', 'fieldIso']);
}
