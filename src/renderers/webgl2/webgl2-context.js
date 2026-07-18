/**
 * WebGL2 context initialization with extension checks.
 * Maps to WebGPU device/context acquisition in webgpu-manager.js.
 */

export class WebGL2Context {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = null;
    this.extensions = {};
  }

  init() {
    const gl = this.canvas.getContext('webgl2', {
      alpha: false,
      antialias: true,
      depth: true,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: true // Playwright screenshots
    });

    if (!gl) {
      throw new Error('WebGL2 not supported in this browser');
    }

    this.gl = gl;
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0.02, 0.02, 0.05, 1.0);

    this.extensions = {
      instancedArrays: true, // core in WebGL2
      vao: true,
      floatTextures: gl.getExtension('EXT_color_buffer_float'),
      depthTexture: gl.getExtension('WEBGL_depth_texture')
    };

    this.resize();
    return gl;
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
