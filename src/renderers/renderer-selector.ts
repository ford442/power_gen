/**
 * Renderer selection — WebGPU is the default required path.
 *
 * Priority (first match wins):
 *   1. URL param  ?renderer=webgpu|webgl2  (webgl2 is explicit opt-in only)
 *   2. global     DEBUG_RENDERER = 'webgpu' | 'webgl2'
 *   3. localStorage seg-renderer (webgpu only)
 *
 * The URL and storage layers come from LabConfig (src/config/lab-config.ts).
 *   4. default    webgpu (always — missing GPU → probe hard-fail, not WebGL2)
 *
 * Automatic WebGL2 fallback on WebGPU failure is **disabled**.
 * WebGL2 code stays in-tree for agents via ?renderer=webgl2 only.
 */

import { labConfigResolved, persistLabConfig } from '../config/lab-config';

export type RendererName = 'webgpu' | 'webgl2';

export const RENDERER_WEBGPU: RendererName = 'webgpu';
export const RENDERER_WEBGL2: RendererName = 'webgl2';
export const STORAGE_KEY = 'seg-renderer';

export function resolveRenderer(): RendererName {
  const { config, sources, rejectedStorage } = labConfigResolved();
  if (sources.renderer === 'url') return config.renderer;

  if (typeof window.DEBUG_RENDERER === 'string') {
    const g = window.DEBUG_RENDERER.toLowerCase();
    if (g === RENDERER_WEBGL2 || g === RENDERER_WEBGPU) return g;
  }

  // Do not auto-prefer stored webgl2 as a silent fallback for missing GPU —
  // only an explicit webgpu preference is honoured from storage (the LabConfig
  // spec limits `seg-renderer` to it); default is webgpu.
  if (rejectedStorage.renderer === RENDERER_WEBGL2) {
    console.warn(
      '[renderer-selector] Ignoring localStorage webgl2 preference for default boot; ' +
      'use ?renderer=webgl2 to opt in. Default is WebGPU-required.'
    );
  }
  return RENDERER_WEBGPU;
}

/**
 * Persist renderer choice (optional hot-switch without full reload).
 */
export function setRendererPreference(renderer: RendererName): void {
  persistLabConfig('renderer', renderer);
  window.DEBUG_RENDERER = renderer;
}

/**
 * Apply canvas data attributes and window.currentRenderer for Playwright / agents.
 */
export function exposeRenderer(canvas: HTMLCanvasElement | null, renderer: RendererName): void {
  window.currentRenderer = renderer;
  if (canvas) {
    canvas.dataset.renderer = renderer;
    canvas.dataset.webglVersion = renderer === RENDERER_WEBGL2 ? '2' : '';
  }
}
