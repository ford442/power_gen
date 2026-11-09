import type { LayoutRegistrar } from '../types.js';
import { BGL } from '../generated/bind-group-layouts.js';

/**
 * The scene pass's shared `@group(0)`: camera / time, SEG layout, lighting
 * rig, material table, prefiltered IBL and the key-light shadow map. Bound
 * once per scene (or shadow) pass by src/visualizer/frame-bindings.ts; every
 * scene pipeline layout is `[frame, <its own @group(1)>]`.
 */
export function registerFrameLayout(r: LayoutRegistrar): void {
  r.bgl('frame', BGL.frame);
}
