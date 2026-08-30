import type { LayoutRegistrar } from '../types.js';
import { uniform, storage, CS } from '../helpers.js';

/** Overview frustum cull → draw-indirect. */
export function registerCullLayouts(r: LayoutRegistrar): void {
  r.bgl('overviewCull', [
    storage(0, CS, true),
    uniform(1, CS),
    storage(2, CS, false),
    storage(3, CS, false)
  ]);
  r.pl('overviewCull', ['overviewCull']);
}
