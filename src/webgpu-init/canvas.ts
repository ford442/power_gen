/**
 * Canvas sizing, URL-driven canvas options, and `context.configure()` — the
 * canvas half of WebGPU init. Split out of webgpu-manager.ts; `WebGPUManager`
 * keeps its static entry points as thin delegates.
 */

/** Depth-only format — stencil is unused; saves memory vs depth24plus-stencil8. */
export const DEPTH_FORMAT: GPUTextureFormat = 'depth24plus';

/** Preferred canvas alpha for full-viewport apps (HTML overlays do not need canvas alpha). */
export const CANVAS_ALPHA_MODE: GPUCanvasAlphaMode = 'opaque';

export interface CanvasPixelSize {
  width: number;
  height: number;
  layoutReady: boolean;
}

export interface DepthStencilAttachmentOpts {
  depthClearValue?: number;
  depthLoadOp?: GPULoadOp;
  depthStoreOp?: GPUStoreOp;
  format?: GPUTextureFormat;
}

export type CanvasToneMappingMode = 'standard' | 'extended';

/**
 * Exact device-pixel size per canvas, from a `device-pixel-content-box`
 * ResizeObserver ({@link observeDevicePixelSize}). `clientWidth × dpr` rounds:
 * at a fractional DPR (1.25, 1.5 on Windows laptops) it can land a pixel off,
 * and the compositor then resamples the whole frame — a soft blur on every
 * line and label.
 */
const devicePixelSizes = new WeakMap<HTMLCanvasElement, { width: number; height: number }>();

/** `device.limits.maxTextureDimension2D` — every post target is canvas-sized. */
let maxCanvasDimension = 8192;

export function setMaxCanvasDimension(max: number): void {
  if (Number.isFinite(max) && max >= 1) maxCanvasDimension = Math.floor(max);
}

/**
 * `?renderScale=0.5..1`: render at a fraction of device pixels and let the
 * browser upscale — classroom projectors and integrated GPUs. Clamped;
 * anything unparsable is 1.
 */
export function renderScale(search = typeof location !== 'undefined' ? location.search : ''): number {
  const raw = Number(searchParams(search).get('renderScale'));
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  return Math.min(1, Math.max(0.5, raw));
}

/**
 * Observe `canvas`'s exact device-pixel content box. Falls back to `null`
 * (and canvasPixelSize keeps using `clientWidth × dpr`) where the browser does
 * not support the `device-pixel-content-box` option (Safari).
 */
export function observeDevicePixelSize(
  canvas: HTMLCanvasElement,
  onChange: () => void
): ResizeObserver | null {
  if (typeof ResizeObserver === 'undefined') return null;
  const ro = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const box = entry.devicePixelContentBoxSize?.[0];
      if (!box) continue;
      devicePixelSizes.set(canvas, {
        width: Math.round(box.inlineSize),
        height: Math.round(box.blockSize)
      });
    }
    onChange();
  });
  try {
    ro.observe(canvas, { box: 'device-pixel-content-box' });
  } catch {
    ro.disconnect();
    return null;
  }
  return ro;
}

export function canvasPixelSize(
  canvas: HTMLCanvasElement,
  scale = renderScale()
): CanvasPixelSize {
  const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
  const clientWidth = canvas.clientWidth;
  const clientHeight = canvas.clientHeight;
  const layoutReady = clientWidth >= 1 && clientHeight >= 1;
  let width: number;
  let height: number;
  const exact = layoutReady ? devicePixelSizes.get(canvas) : undefined;
  if (exact && exact.width >= 1 && exact.height >= 1) {
    width = exact.width;
    height = exact.height;
  } else {
    const cssWidth = layoutReady ? clientWidth : Math.max(canvas.width / dpr, 1);
    const cssHeight = layoutReady ? clientHeight : Math.max(canvas.height / dpr, 1);
    width = cssWidth * dpr;
    height = cssHeight * dpr;
  }
  // Render scale, then the device's texture limit — one factor for both axes
  // so the aspect ratio (and the projection built from it) is unchanged.
  const fit = Math.min(scale, maxCanvasDimension / Math.max(width, height, 1));
  return {
    width: Math.max(1, Math.floor(width * fit)),
    height: Math.max(1, Math.floor(height * fit)),
    layoutReady
  };
}

export function searchParams(search = typeof location !== 'undefined' ? location.search : ''): URLSearchParams {
  try {
    return new URLSearchParams(search);
  } catch {
    return new URLSearchParams();
  }
}

/**
 * Whether GPU timestamp queries should be requested as a device feature.
 * Opt-in only: writing timestamps into the main render encoder blanks the canvas
 * on some D3D12/ANGLE stacks (60 FPS, no validation errors).
 */
export function wantsGpuTiming(search = typeof location !== 'undefined' ? location.search : ''): boolean {
  try {
    return new URLSearchParams(search).get('gpuTiming') === '1';
  } catch {
    return false;
  }
}

export function wantsDisplayP3(search = typeof location !== 'undefined' ? location.search : ''): boolean {
  return searchParams(search).get('p3') === '1';
}

/**
 * Canvas toneMapping. Default `standard` because bloom composite ACES-maps to [0,1]
 * for SDR. `extended` only with `?hdr=1` and an HDR display; the canvas is then
 * configured `rgba16float` (extended range has no effect on an 8-bit canvas) and
 * the composite skips the filmic curve (`outputLinearHdr`) so the compositor is
 * not double-tonemapped. See color-pipeline.ts.
 */
export function canvasToneMappingMode(
  search = typeof location !== 'undefined' ? location.search : ''
): CanvasToneMappingMode {
  if (searchParams(search).get('hdr') !== '1') return 'standard';
  try {
    if (typeof matchMedia === 'function' && matchMedia('(dynamic-range: high)').matches) {
      return 'extended';
    }
  } catch { /* ignore */ }
  return 'standard';
}

export function resolveDepthFormat(ssrEnabled: boolean): GPUTextureFormat {
  return ssrEnabled ? 'depth32float' : DEPTH_FORMAT;
}

/**
 * Offscreen scene-color descriptor. MSAA belongs here (not on canvas.configure).
 * Base scene/G-buffer textures stay sampleCount 1 — the ADR-0005 WS2
 * showroom MSAA path (`high` tier + focus mode) allocates separate
 * sampleCount-4 textures alongside these (see scene-setup.ts
 * `sceneMsaaTexture` / `materialGBufferMsaaTexture`) rather than passing
 * sampleCount here, since color resolves via `resolveTarget` into exactly
 * these single-sample textures.
 */
export function offscreenColorDescriptor(opts: {
  format: GPUTextureFormat;
  size: GPUExtent3D;
  sampleCount?: number;
  usage?: GPUTextureUsageFlags;
  label?: string;
}): GPUTextureDescriptor {
  return {
    label: opts.label,
    size: opts.size,
    format: opts.format,
    sampleCount: opts.sampleCount ?? 1,
    usage: opts.usage ?? (
      GPUTextureUsage.RENDER_ATTACHMENT
      | GPUTextureUsage.TEXTURE_BINDING
      | GPUTextureUsage.COPY_DST
      | GPUTextureUsage.COPY_SRC
    )
  };
}

export function depthStencilAttachment(
  view: GPUTextureView,
  opts: DepthStencilAttachmentOpts = {}
): GPURenderPassDepthStencilAttachment {
  const attachment: GPURenderPassDepthStencilAttachment = {
    view,
    depthClearValue: opts.depthClearValue ?? 1.0,
    depthLoadOp: opts.depthLoadOp ?? 'clear',
    depthStoreOp: opts.depthStoreOp ?? 'store'
  };
  const format = opts.format ?? DEPTH_FORMAT;
  if (format.includes('stencil')) {
    attachment.stencilClearValue = 0;
    attachment.stencilLoadOp = 'clear';
    attachment.stencilStoreOp = 'store';
  }
  return attachment;
}

/** Acquire the `webgpu` context for `canvas` and configure it for `device`. */
export function configureCanvasContext(
  canvas: HTMLCanvasElement,
  device: GPUDevice,
  cfg: {
    format: GPUTextureFormat;
    viewFormats: GPUTextureFormat[];
    alphaMode: GPUCanvasAlphaMode;
    colorSpace: PredefinedColorSpace;
    toneMappingMode: CanvasToneMappingMode;
  }
): GPUCanvasContext {
  const context = canvas.getContext('webgpu');
  if (!context) throw new Error('Failed to get webgpu canvas context');
  context.configure({
    device,
    format: cfg.format,
    alphaMode: cfg.alphaMode,
    colorSpace: cfg.colorSpace,
    toneMapping: { mode: cfg.toneMappingMode } as GPUCanvasToneMapping,
    viewFormats: cfg.viewFormats,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
  } as GPUCanvasConfiguration);
  return context;
}
