/**
 * Debug / e2e hooks of the WebGPU path that need the visualizer (#258 §4–5).
 * `window.__gpuErrors` lives in webgpu-init/gpu-errors.ts (it must exist
 * before there is a visualizer); `window.simulateDeviceLost` and
 * `window.getRendererInfo` are installed next to this in init-methods.ts.
 *
 *   window.captureCanvasFrame({ flipY? })
 *       Render one frame now and read the canvas back as RGBA8, the same
 *       shape the WebGL2 hook returns — so one spec can capture both
 *       renderers. A WebGPU canvas only holds its frame until the browser
 *       presents it; reading it later returns transparent black. So this
 *       renders on demand and copies in the same task, through a 2D canvas
 *       (what the page would show: after the canvas's colour encode).
 *   multiVisualizer.frozenTime = seconds | null
 *       Hold scene time (render-loop.ts). With a fixed `?seed=` this makes a
 *       capture repeatable.
 */
import type { MultiDeviceVisualizer } from '../multi-device-visualizer.js';
import type { CanvasFrameCapture, CaptureCanvasFrameOptions } from '../window-globals';

let scratch: HTMLCanvasElement | null = null;

export function captureWebgpuFrame(
  host: MultiDeviceVisualizer,
  opts: CaptureCanvasFrameOptions = {}
): CanvasFrameCapture {
  const { width, height } = host.canvas;
  scratch ??= document.createElement('canvas');
  scratch.width = width;
  scratch.height = height;
  const ctx = scratch.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('captureCanvasFrame: no 2D context for the readback');

  const submitted = host.framesSubmitted ?? 0;
  host._frameOnDemand = true;
  try {
    host.render(performance.now());
  } finally {
    host._frameOnDemand = false;
  }
  // render() returns without submitting while the device is recovering or
  // before the targets exist; the canvas then holds nothing of this view.
  if ((host.framesSubmitted ?? 0) === submitted) {
    throw new Error('captureCanvasFrame: no frame was rendered (device recovering, or the renderer is not ready)');
  }
  ctx.drawImage(host.canvas, 0, 0);
  const rgba = ctx.getImageData(0, 0, width, height).data;

  // The 2D canvas is top-left origin; the WebGL2 hook is bottom-left unless
  // `flipY` — keep the same contract.
  const pixels = new Uint8Array(rgba.length);
  if (opts.flipY) {
    pixels.set(rgba);
  } else {
    const row = width * 4;
    for (let y = 0; y < height; y++) pixels.set(rgba.subarray(y * row, (y + 1) * row), (height - 1 - y) * row);
  }
  return {
    width,
    height,
    pixels,
    format: 'RGBA8',
    origin: opts.flipY ? 'top-left' : 'bottom-left',
    view: host.currentView,
    renderer: 'webgpu'
  };
}

/** Install the visualizer-side hooks. Called once from `init()`. */
export function installWebgpuTestHooks(host: MultiDeviceVisualizer): void {
  window.captureCanvasFrame = (opts) => captureWebgpuFrame(host, opts);
}
