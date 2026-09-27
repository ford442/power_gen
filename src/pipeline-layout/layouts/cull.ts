import type { LayoutRegistrar } from '../types.js';
import { BGL } from '../generated/bind-group-layouts.js';

/** Overview frustum cull → draw-indirect. */
export function registerCullLayouts(r: LayoutRegistrar): void {
  r.bgl('overviewCull', BGL.overviewCull);
  r.pl('overviewCull', ['overviewCull']);
}
