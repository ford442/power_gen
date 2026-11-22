// @ts-check
/**
 * Helpers for the WebGPU e2e specs (`e2e/*.webgpu.js`, playwright.webgpu.config.js).
 *
 * The page gives the specs three things to assert on instead of the console:
 *   window.__gpuErrors          every GPU error, counted (webgpu-init/gpu-errors.ts)
 *   window.getRendererInfo()    frames submitted, frame-graph passes, lazy targets, tiers
 *   window.__gpuDraws           installed here: which pipelines actually drew
 */
import { waitForEval } from './helpers.js';

export { waitForEval };

/**
 * Record, per pipeline label, how many draws / dispatches used it. A pipeline
 * that silently became `null` raises no GPU error — its draw is just skipped —
 * so "the transformer drew its flux ribbons" has to be observed, not inferred
 * from the absence of errors (#252).
 * @param {import('@playwright/test').Page} page
 */
export async function installDrawProbe(page) {
  await page.addInitScript(() => {
    /** @type {Record<string, number>} */
    const draws = {};
    // @ts-ignore test-only global
    window.__gpuDraws = draws;
    // @ts-ignore
    window.__resetGpuDraws = () => { for (const k of Object.keys(draws)) delete draws[k]; };
    if (typeof GPURenderPassEncoder === 'undefined') return;
    const bump = (/** @type {string} */ label) => { draws[label] = (draws[label] ?? 0) + 1; };
    const current = new WeakMap();
    for (const Encoder of [GPURenderPassEncoder, GPURenderBundleEncoder]) {
      const proto = Encoder.prototype;
      const setPipeline = proto.setPipeline;
      proto.setPipeline = function (pipeline) {
        current.set(this, pipeline?.label || '(unlabelled)');
        return setPipeline.call(this, pipeline);
      };
      for (const name of /** @type {const} */ (['draw', 'drawIndexed', 'drawIndirect', 'drawIndexedIndirect'])) {
        const original = proto[name];
        // @ts-ignore same signature, forwarded untouched
        proto[name] = function (...args) {
          const label = current.get(this) ?? '(no pipeline)';
          // @ts-ignore test-only: see suppressDraws()
          if (window.__gpuSkipDraws?.test(label)) return undefined;
          bump(label);
          // @ts-ignore
          return original.apply(this, args);
        };
      }
    }
    const cproto = GPUComputePassEncoder.prototype;
    const csetPipeline = cproto.setPipeline;
    cproto.setPipeline = function (pipeline) {
      current.set(this, pipeline?.label || '(unlabelled)');
      return csetPipeline.call(this, pipeline);
    };
    const dispatch = cproto.dispatchWorkgroups;
    cproto.dispatchWorkgroups = function (...args) {
      bump(`compute:${current.get(this) ?? '(no pipeline)'}`);
      return dispatch.apply(this, args);
    };
  });
}

/**
 * Drop every draw whose pipeline label matches `pattern` (needs
 * installDrawProbe). The image baselines use it to leave the additive
 * particle billboards out: on a software rasteriser they cover the frame and
 * hide the meshes and lighting the baseline is about.
 * @param {import('@playwright/test').Page} page
 * @param {RegExp} pattern
 */
export async function suppressDraws(page, pattern) {
  await page.evaluate(({ source, flags }) => {
    // @ts-ignore
    window.__gpuSkipDraws = new RegExp(source, flags);
  }, { source: pattern.source, flags: pattern.flags });
}

/**
 * Console errors and uncaught exceptions, minus the one a headed browser
 * always produces on a static preview server (it asks for /favicon.ico).
 * @param {import('@playwright/test').Page} page
 */
export function trackErrors(page) {
  /** @type {string[]} */
  const errors = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (/favicon\.ico/.test(msg.location()?.url ?? '') || /favicon\.ico/.test(text)) return;
    errors.push(text);
  });
  return errors;
}

/**
 * Open the app on the WebGPU renderer and wait for the first submitted frame.
 * @param {import('@playwright/test').Page} page
 * @param {string} [query] e.g. `mode=seg&look=drama`
 */
export async function bootWebgpu(page, query = '') {
  await page.goto(`/?${query}`, { waitUntil: 'domcontentloaded' });
  await waitForEval(page, () => {
    const info = window.getRendererInfo?.();
    return info?.renderer === 'webgpu' && (info.frames ?? 0) > 0;
  }, { timeout: 180_000 });
}

/** @param {import('@playwright/test').Page} page */
export function rendererInfo(page) {
  return page.evaluate(() => window.getRendererInfo?.());
}

/** @param {import('@playwright/test').Page} page */
export function gpuErrors(page) {
  return page.evaluate(() => {
    const e = window.__gpuErrors;
    return e ? { uncaptured: e.uncaptured, scoped: e.scoped, lost: e.lost, messages: [...e.messages] } : null;
  });
}

/**
 * Wait until `n` more frames were submitted. Clears the draw probe first, so
 * `drawnPipelines()` afterwards describes exactly those frames.
 * @param {import('@playwright/test').Page} page
 * @param {number} n
 */
export async function renderFrames(page, n, timeout = 240_000) {
  await page.evaluate((count) => {
    // @ts-ignore
    window.__resetGpuDraws?.();
    // @ts-ignore
    window.__frameTarget = (window.getRendererInfo?.()?.frames ?? 0) + count;
  }, n);
  // @ts-ignore
  await waitForEval(page, () => (window.getRendererInfo?.()?.frames ?? 0) >= window.__frameTarget, { timeout });
}

/** @param {import('@playwright/test').Page} page @returns {Promise<string[]>} */
export function drawnPipelines(page) {
  // @ts-ignore
  return page.evaluate(() => Object.keys(window.__gpuDraws ?? {}).sort());
}

/**
 * Pin the quality tier. SwiftShader boots at `low` (auto-quality reads its
 * frame time); `high` is where MSAA, the shadow map, TAA and the field volume
 * live, so the specs ask for it explicitly rather than depend on timing.
 * @param {import('@playwright/test').Page} page
 * @param {'low' | 'medium' | 'high'} tier
 */
export async function pinQualityTier(page, tier) {
  await page.evaluate((t) => {
    const p = /** @type {any} */ (window.multiVisualizer)?.profiler;
    p.autoQualityEnabled = false;
    p.qualityLevel = t === 'high' ? 1 : t === 'medium' ? 0.6 : 0.5;
    p.qualityTier = t;
  }, tier);
}

/**
 * Focus a bench (or `overview`) and wait until its view is current and no
 * pipeline tier is still compiling.
 * @param {import('@playwright/test').Page} page
 * @param {string} id
 */
export async function focusView(page, id, timeout = 300_000) {
  await page.evaluate((view) => window.setMode?.(view), id);
  await page.evaluate((view) => { /** @type {any} */ (window).__wantView = view; }, id);
  await waitForEval(page, () => {
    const info = window.getRendererInfo?.();
    if (!info || info.view !== /** @type {any} */ (window).__wantView) return false;
    return !Object.values(info.pipelineTiers?.states ?? {}).includes('compiling');
  }, { timeout });
}

/**
 * `window.captureCanvasFrame()` as PNG bytes (both renderers). Encoded in the
 * page through a 2D canvas: megabytes of pixels do not cross the protocol as
 * a JSON number array.
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<{ png: Buffer, width: number, height: number, renderer: string, view: string }>}
 */
export async function captureFramePng(page) {
  const shot = await page.evaluate(async () => {
    // WebGL2 reads the back buffer, which is only intact between the app's
    // render and the browser's composite — so read inside a rAF callback
    // (queued after the app's own). WebGPU's hook renders on demand.
    if (window.currentRenderer === 'webgl2') await new Promise((resolve) => requestAnimationFrame(resolve));
    const frame = window.captureCanvasFrame?.({ flipY: true });
    if (!frame) throw new Error('window.captureCanvasFrame is not installed');
    const canvas = document.createElement('canvas');
    canvas.width = frame.width;
    canvas.height = frame.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2D context');
    const rgba = new Uint8ClampedArray(frame.pixels.buffer, frame.pixels.byteOffset, frame.pixels.byteLength);
    // Opaque: the page composites the canvas over an opaque background.
    for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
    ctx.putImageData(new ImageData(rgba, frame.width, frame.height), 0, 0);
    return { url: canvas.toDataURL('image/png'), width: frame.width, height: frame.height, renderer: frame.renderer, view: frame.view };
  });
  return { ...shot, png: Buffer.from(shot.url.slice(shot.url.indexOf(',') + 1), 'base64') };
}
