/**
 * Colour pipeline: which texture formats the scene, post stack and canvas use,
 * and how the composite gets from scene-referred linear light to the screen.
 *
 * Two modes (`?color=`), picked once at boot because every scene pipeline is
 * built against the scene format:
 *
 *   linear (default)  Scene, MSAA, TAA resolve and history are a float format
 *                     (`rg11b10ufloat` when renderable, else `rgba16float`), so
 *                     highlights survive past 1.0 into bloom and TAA. The SDR
 *                     composite writes through the canvas's `-srgb` view, which
 *                     applies the sRGB OETF in hardware. `?hdr=1` on an HDR
 *                     display configures an `rgba16float` canvas with
 *                     `toneMapping: 'extended'` instead.
 *   legacy            The pre-#223 path, kept for one release as a reference:
 *                     everything in the canvas format (8-bit UNORM), tonemapped
 *                     linear values written to the canvas with no encode.
 *
 * Kept free of imports so scripts/check-post-contracts.mjs can load it directly.
 * See docs/WEBGPU.md → Colour pipeline.
 */

export type ColorPipelineMode = 'linear' | 'legacy';

/** Device feature that makes `rg11b10ufloat` renderable (and blendable / multisampled). */
export const RG11B10_RENDERABLE_FEATURE = 'rg11b10ufloat-renderable';

/** Canvas format for `?hdr=1` — the only format extended tone mapping takes effect on. */
export const HDR_CANVAS_FORMAT: GPUTextureFormat = 'rgba16float';

export interface ColorTargets {
  mode: ColorPipelineMode;
  /** Format the canvas is configured with (`context.configure({ format })`). */
  canvasFormat: GPUTextureFormat;
  /** Extra view formats requested at configure time. */
  canvasViewFormats: GPUTextureFormat[];
  /** View format the composite renders through — `-srgb` on the linear SDR path. */
  outputFormat: GPUTextureFormat;
  /** Scene colour, its MSAA twin, TAA resolve and history. */
  sceneFormat: GPUTextureFormat;
  /** Bloom extract / blur / mip-chain intermediates. */
  bloomFormat: GPUTextureFormat;
  /** `rgba16float` canvas + `toneMapping: 'extended'`; composite skips the filmic curve. */
  hdrOutput: boolean;
  /**
   * Composite applies the (extended) sRGB OETF itself. Only the HDR path needs
   * this: a float canvas has no `-srgb` view, but an `srgb`-tagged canvas still
   * expects encoded values (WebGPU §3.11 — textures are not colour-managed).
   */
  shaderEncodesOutput: boolean;
}

export function parseColorPipelineMode(
  search = typeof location !== 'undefined' ? location.search : ''
): ColorPipelineMode {
  try {
    return new URLSearchParams(search).get('color') === 'legacy' ? 'legacy' : 'linear';
  } catch {
    return 'linear';
  }
}

/** The `-srgb` twin of an 8-bit canvas format, or null when there is none. */
export function srgbViewFormat(format: GPUTextureFormat): GPUTextureFormat | null {
  if (format === 'bgra8unorm') return 'bgra8unorm-srgb';
  if (format === 'rgba8unorm') return 'rgba8unorm-srgb';
  return null;
}

/**
 * Resolve every colour format for one session. Pure: callers pass the adapter's
 * feature set and whether `?hdr=1` survived the HDR-display media query.
 */
export function resolveColorTargets(opts: {
  mode: ColorPipelineMode;
  preferredCanvasFormat: GPUTextureFormat;
  features: { has(name: string): boolean };
  /** `?hdr=1` and `(dynamic-range: high)` — see canvasToneMappingMode(). */
  hdrRequested: boolean;
}): ColorTargets {
  const { mode, preferredCanvasFormat, features } = opts;
  const rg11b10 = features.has(RG11B10_RENDERABLE_FEATURE);

  if (mode === 'legacy') {
    const srgb = srgbViewFormat(preferredCanvasFormat);
    return {
      mode,
      canvasFormat: preferredCanvasFormat,
      canvasViewFormats: srgb ? [preferredCanvasFormat, srgb] : [preferredCanvasFormat],
      outputFormat: preferredCanvasFormat,
      sceneFormat: preferredCanvasFormat,
      bloomFormat: rg11b10 ? 'rg11b10ufloat' : preferredCanvasFormat,
      hdrOutput: false,
      shaderEncodesOutput: false
    };
  }

  const sceneFormat: GPUTextureFormat = rg11b10 ? 'rg11b10ufloat' : 'rgba16float';
  if (opts.hdrRequested) {
    return {
      mode,
      canvasFormat: HDR_CANVAS_FORMAT,
      canvasViewFormats: [HDR_CANVAS_FORMAT],
      outputFormat: HDR_CANVAS_FORMAT,
      sceneFormat,
      bloomFormat: sceneFormat,
      hdrOutput: true,
      shaderEncodesOutput: true
    };
  }

  const srgb = srgbViewFormat(preferredCanvasFormat);
  return {
    mode,
    canvasFormat: preferredCanvasFormat,
    canvasViewFormats: srgb ? [preferredCanvasFormat, srgb] : [preferredCanvasFormat],
    // getPreferredCanvasFormat() only ever returns bgra8unorm / rgba8unorm,
    // both of which have an -srgb view; the shader-encode fallback covers a
    // future preferred format that does not.
    outputFormat: srgb ?? preferredCanvasFormat,
    sceneFormat,
    bloomFormat: sceneFormat,
    hdrOutput: false,
    shaderEncodesOutput: !srgb
  };
}

/** `BloomParams.outputTransfer`: how the composite's result reaches the canvas. */
export function postOutputTransfer(targets: ColorTargets): 0 | 1 | 2 {
  if (targets.mode === 'legacy') return 0;
  return targets.shaderEncodesOutput ? 2 : 1;
}
