/**
 * Renderer selection for WebGPU vs WebGL2 fallback.
 *
 * Priority (first match wins):
 *   1. URL param  ?renderer=webgpu|webgl2
 *   2. global     DEBUG_RENDERER = 'webgpu' | 'webgl2'
 *   3. localStorage seg-renderer
 *   4. default    webgpu (when navigator.gpu is available)
 *
 * WebGL2 → WebGPU mapping notes:
 *   - GPU compute shaders  → CPU particle-physics.js (or transform feedback later)
 *   - Storage buffers      → Float32Array + gl.bufferData / bufferSubData
 *   - Instanced draw       → gl.drawElementsInstanced + per-instance attributes
 *   - Bind groups          → uniform blocks (UBO) + texture units
 */

export const RENDERER_WEBGPU = 'webgpu';
export const RENDERER_WEBGL2 = 'webgl2';
export const STORAGE_KEY = 'seg-renderer';

/**
 * @returns {'webgpu' | 'webgl2'}
 */
export function resolveRenderer() {
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
    if (stored === RENDERER_WEBGL2 || stored === RENDERER_WEBGPU) return stored;
  } catch (_) { /* private browsing */ }

  if (!navigator.gpu) return RENDERER_WEBGL2;
  return RENDERER_WEBGPU;
}

/**
 * Persist renderer choice (optional hot-switch without full reload).
 * @param {'webgpu' | 'webgl2'} renderer
 */
export function setRendererPreference(renderer) {
  try {
    localStorage.setItem(STORAGE_KEY, renderer);
  } catch (_) { /* ignore */ }
  window.DEBUG_RENDERER = renderer;
}

/**
 * Apply canvas data attributes and window.currentRenderer for Playwright / agents.
 * @param {HTMLCanvasElement} canvas
 * @param {'webgpu' | 'webgl2'} renderer
 */
export function exposeRenderer(canvas, renderer) {
  window.currentRenderer = renderer;
  if (canvas) {
    canvas.dataset.renderer = renderer;
    canvas.dataset.webglVersion = renderer === RENDERER_WEBGL2 ? '2' : '';
  }
}
