/**
 * WebGL2 context initialization with extension checks.
 * Maps to WebGPU device/context acquisition in webgpu-manager.js.
 */
import { showDeviceLostUI } from '../../webgpu-init/device-lost';

/** Anisotropy ceiling for procedural meshes on the fallback renderer. */
export const MAX_ANISOTROPY_CAP = 8;

export class WebGL2Context {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = null;
    this.extensions = {};
    /** True between webglcontextlost and a reload; GL calls are no-ops meanwhile. */
    this.contextLost = false;
  }

  init() {
    const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
    const capture = params?.get('capture') === '1';
    const gpuPower = params?.get('gpuPower');
    const gl = this.canvas.getContext('webgl2', {
      alpha: false,
      antialias: true,
      depth: true,
      stencil: false,
      premultipliedAlpha: true,
      // ?gpuPower=low mirrors the WebGPU adapter hint (docs/WEBGPU.md).
      powerPreference: gpuPower === 'low' || gpuPower === 'low-power' ? 'low-power' : 'high-performance',
      failIfMajorPerformanceCaveat: false,
      preserveDrawingBuffer: !!(typeof navigator !== 'undefined' && navigator.webdriver) || capture
    });

    if (!gl) {
      throw new Error('WebGL2 not supported in this browser');
    }

    this.gl = gl;
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0.02, 0.02, 0.05, 1.0);

    // Depth textures are core in WebGL2 — WEBGL_depth_texture is a WebGL1
    // extension and getExtension() always returned null for it here.
    this.extensions = {
      instancedArrays: true, // core in WebGL2
      vao: true,
      floatTextures: gl.getExtension('EXT_color_buffer_float'),
      anisotropic: gl.getExtension('EXT_texture_filter_anisotropic')
    };
    this._watchContextLoss();
    // 0 = extension missing → applyAnisotropy() is a no-op.
    this.maxAnisotropy = this.extensions.anisotropic
      ? Math.min(MAX_ANISOTROPY_CAP, gl.getParameter(this.extensions.anisotropic.MAX_TEXTURE_MAX_ANISOTROPY_EXT) || 1)
      : 0;

    this.resize();
    return gl;
  }

  /**
   * A lost context (GPU reset, driver update, too many contexts) takes every
   * buffer, texture and program with it, and this renderer has no rebuild
   * path — so say so and offer a reload instead of rendering black silently.
   * preventDefault() keeps restoration possible; on restore we still reload
   * because the resources are gone.
   */
  _watchContextLoss() {
    if (this._lossWatched) return;
    this._lossWatched = true;
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
      console.error('[WebGL2] context lost');
      showDeviceLostUI({
        title: 'WebGL2 context lost',
        reason: 'webglcontextlost',
        message: 'The browser dropped the WebGL2 context (GPU reset or too many contexts). Reload to rebuild the scene.'
      });
    }, false);
    this.canvas.addEventListener('webglcontextrestored', () => {
      console.warn('[WebGL2] context restored — GL resources are gone; reload required');
      showDeviceLostUI({
        title: 'WebGL2 context restored',
        reason: 'webglcontextrestored',
        message: 'The context came back, but the scene\'s GPU resources did not. Reload to rebuild it.'
      });
    }, false);
  }

  /**
   * Set TEXTURE_MAX_ANISOTROPY on the texture currently bound to `target`
   * (mipmapped procedural textures only — the fallback has no glTF). Capped at
   * {@link MAX_ANISOTROPY_CAP}; no-op when EXT_texture_filter_anisotropic is missing.
   */
  applyAnisotropy(target = this.gl?.TEXTURE_2D, level = this.maxAnisotropy) {
    const ext = this.extensions.anisotropic;
    if (!ext || !this.gl || this.maxAnisotropy <= 0) return;
    this.gl.texParameterf(target, ext.TEXTURE_MAX_ANISOTROPY_EXT, Math.max(1, Math.min(level, this.maxAnisotropy)));
  }

  resize() {
    const gl = this.gl;
    if (!gl) return;
    const dpr = window.devicePixelRatio || 1;
    const clientWidth = this.canvas.clientWidth;
    const clientHeight = this.canvas.clientHeight;
    const layoutReady = clientWidth >= 1 && clientHeight >= 1;
    const cssWidth = layoutReady ? clientWidth : Math.max(this.canvas.width / dpr, 1);
    const cssHeight = layoutReady ? clientHeight : Math.max(this.canvas.height / dpr, 1);
    const w = Math.max(1, Math.floor(cssWidth * dpr));
    const h = Math.max(1, Math.floor(cssHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
  }
}
