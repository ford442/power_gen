# ADR-0014: Linear-HDR colour pipeline (WebGPU)

- **Status:** Accepted
- **Date:** 2026-10

## Context

The WebGPU scene, MSAA, TAA resolve and history targets were all created in
`getPreferredCanvasFormat()` — `bgra8unorm` / `rgba8unorm`. Two consequences
followed:

- **No headroom.** Lit shaders write linear radiance, but anything above 1.0
  clipped at the scene target, so bloom thresholded display-referred 8-bit
  values and TAA blended clipped highlights.
- **No encode.** The composite tonemapped linear light and wrote it straight
  into a UNORM canvas, which the compositor reads as sRGB. The presets were
  tuned by eye against that uncorrected output, with a low (studio: 0.58)
  display-referred bloom threshold that let large bright surfaces bloom and
  haze the frame.

Authored colours (sky, light tints, material table, device base colours) were
sRGB-looking values used as linear, which fit that uncorrected output.

## Decision

`src/webgpu-init/color-pipeline.ts` resolves every colour format once per boot.

- **Scene-referred float targets.** The scene, its MSAA twin, the TAA resolve
  and the history use `rg11b10ufloat` when `rg11b10ufloat-renderable` is
  present (4 bytes/px, renderable, blendable, multisampled), else
  `rgba16float`.
- **Bloom is a mip chain** in the same format: a 13-tap Karis prefilter with a
  scene-referred soft-knee threshold, about 6 downsample levels, and a 3×3 tent
  upsample blended additively back up (`src/visualizer/bloom-chain.ts`).
- **The SDR composite writes through the canvas's `-srgb` view**, requested via
  `viewFormats`, so the hardware applies the sRGB OETF. `?hdr=1` on an HDR
  display configures an `rgba16float` canvas with `toneMapping: 'extended'`.
  There the shader applies an extended sRGB OETF, because WebGPU textures are
  not colour-managed and an `srgb`-tagged float canvas still expects encoded
  values.
- **Authored colours are decoded** sRGB → linear on this path (`authoredColor()`
  in `seg-lighting-presets.ts`, and the sky shader).
- **Presets are retuned** (`LINEAR_RETUNE`): exposure around 1 and bloom
  threshold around 1.0, which in scene-referred units is a white surface under
  the key light.
- **`?color=legacy`** keeps the 8-bit no-encode path for one release as a
  reference, with the original presets. After that it is removed.
- **WebGL2 does not change** (ADR-0001: the fallback stays simple).

The shared full-screen vertex shader now emits texture-space UVs (v down).
It used to flip the image once per post pass, which the float TAA history and
the before/after comparisons made impossible to ignore.

## Consequences

- Highlights, plasma and corona survive into bloom and TAA. TAA blends
  luminance-weighted (Karis) so a single HDR texel cannot ghost.
- Memory: `rg11b10ufloat` costs the same 4 bytes/px as the old targets. The
  `rgba16float` fallback doubles scene, MSAA, TAA and history. The bloom chain
  (half resolution plus mips, about 1/3 of a full-res target) replaces two
  full-res blur targets. `getRendererInfo().gpuMemory` reports the tracked
  bytes, and `.colorPipeline` reports the formats.
- `maxColorAttachmentBytesPerSample` is priced against the scene format at
  device request (`checkColorAttachmentBudget`).
- Colour literals inside WGSL (some particle and energy-pipe tints) are not yet
  decoded and read slightly brighter.
- Captures and goldens taken before this change are not comparable pixel for
  pixel. Use `?color=legacy` for an A/B.
