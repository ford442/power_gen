/**
 * Renderer selection — WebGPU is the default required path.
 *
 * Priority (first match wins):
 *   1. URL param  ?renderer=webgpu|webgl2  (webgl2 is explicit opt-in only)
 *   2. global     DEBUG_RENDERER = 'webgpu' | 'webgl2'
 *   3. localStorage seg-renderer
 *   4. default    webgpu (always — missing GPU → probe hard-fail, not WebGL2)
 *
 * Automatic WebGL2 fallback on WebGPU failure is **disabled**.
 * WebGL2 code stays in-tree for agents via ?renderer=webgl2 only.
 */

export type RendererName = 'webgpu' | 'webgl2';

export const RENDERER_WEBGPU: RendererName = 'webgpu';
export const RENDERER_WEBGL2: RendererName = 'webgl2';
export const STORAGE_KEY = 'seg-renderer';

export function resolveRenderer(): RendererName {
  const params = new URLSearchParams(window.location.search);
  const urlRenderer = params.get('renderer');
  if (urlRenderer === RENDERER_WEBGL2 || urlRenderer === RENDERER_WEBGPU) {
    return urlRenderer;
  }

  if (typeof window.DEBUG_RENDERER === 'string') {
    const g = window.DEBUG_RENDERER.toLowerCase();
    if (g === RENDERER_WEBGL2 || g === RENDERER_WEBGPU) return g;
  }

  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    // Do not auto-prefer stored webgl2 as a silent fallback for missing GPU —
    // only honor explicit webgpu preference from storage; default is webgpu.
    if (stored === RENDERER_WEBGPU) return RENDERER_WEBGPU;
    if (stored === RENDERER_WEBGL2) {
      console.warn(
        '[renderer-selector] Ignoring localStorage webgl2 preference for default boot; ' +
        'use ?renderer=webgl2 to opt in. Default is WebGPU-required.'
      );
    }
  } catch (_) { /* private browsing */ }

  return RENDERER_WEBGPU;
}

/**
 * Persist renderer choice (optional hot-switch without full reload).
 */
export function setRendererPreference(renderer: RendererName): void {
  try {
    localStorage.setItem(STORAGE_KEY, renderer);
  } catch (_) { /* ignore */ }
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
