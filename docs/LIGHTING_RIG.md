# SEG Lighting & Post-Processing

Studio-quality lighting and a full-screen post pipeline for the WebGPU path, with a simplified 3-point + IBL fallback in WebGL2.

## Lighting looks

Presets live in `src/seg-lighting-presets.ts`:

| Look | Use case | Sky | Key character |
|------|----------|-----|---------------|
| `studio` (default) | Product shots, documentation | Neutral grey sweep | Warm key, soft fill, moderate bloom |
| `lab` | Bright technical demo | Even white-grey | High key, low vignette |
| `drama` | Cinematic / overdrive | Deep space | Strong rim, high bloom, heavy vignette |

Toggle via URL: `?look=studio`, `?look=lab`, `?look=drama`

Runtime: `setLightingLook('lab')` or debug panel **Lighting look** dropdown.

Exposure and bloom strength sliders in the debug panel adjust `postExposure` and `postBloomStrength` without changing the preset.

## 3-point + IBL rig

Each preset defines key / fill / rim / ground lights uploaded to `lightingUniformBuffer` (192 bytes) every frame. PBR evaluation is in `src/shaders/generators/pbr-wgsl-chunks.js`:

- Cook-Torrance GGX specular (anisotropic on rollers)
- **Prefiltered GGX split-sum IBL** (`evaluateIBL`) — see below
- Rim term from view-dependent Fresnel
- `shadowStrength` modulates crevice ambient and IBL occlusion

### Prefiltered environment (ADR-0005 WS2)

`src/ibl-prefilter.ts` bakes the active preset into an octahedral `rgba16float`
**2D array texture** at startup (segEnhanced bindings 7–8):

| Layer | Contents |
|-------|----------|
| `0 … IBL_SPEC_LEVELS-1` | GGX-prefiltered radiance, roughness `i/(n-1)` |
| `IBL_SPEC_LEVELS` | Cosine-convolved irradiance (`E/π`) |

- Defaults: `IBL_TEX_SIZE = 64`, `IBL_SPEC_LEVELS = 6` → 7 layers, **224 KB**.
  Small enough to be **always-on**; it is not quality-gated.
- The split-sum's DFG term is Lazarov's analytic fit (`envBRDFApprox`), so there
  is no BRDF LUT texture.
- Bake cost is ~270 ms on the main thread, **memoised per look** — switching
  studio → lab → drama pays it once each, and `setLightingLook()` re-uploads
  into the same texture so no bind group is rebuilt.
- Constants are duplicated in `pbr-eval.wgsl`; `assertIblShaderContract()` (and
  `npm run check:post`) fail on drift.
- `LightingConfig.iblLevels` is `0` until the bake is uploaded — `pbr-eval.wgsl`
  then falls back to the previous analytic `approximateIBL` polynomial, which is
  retained for exactly that purpose.
- `IBL_DIFFUSE_SCALE` (0.45) holds the previous exposure calibration: the old
  polynomial folded no albedo into its irradiance term, so the honest
  `E · albedo` result is scaled to keep the looks matching their references.

## Post-processing pipeline (WebGPU)

Scene renders to an HDR-ish offscreen target (`bloomSceneTexture`). Passes:

0. **SSR** (compute, high/ultra tier only) — `passes/ssr-compute.wgsl`
1. **Extract** — luminance threshold with **corona boost** (green/cyan plasma weighted higher than bare metal specular)
2. **Blur H / V** — 5-tap Gaussian
3. **Composite** — scene + SSR + wide bloom + **filmic tonemap** + vignette + film grain

Composite also applies:

- **SSAO** — 6-tap depth comparison (cheap screen-space AO)
- **SSR** — screen-space reflections, added *after* the AO term (see below)
- **Contact shadows** — depth-gradient creases + ground-plane darkening
- **Motion blur** — mix with previous frame at high overdrive speed
- **Chromatic aberration** — scales with energy level

Mesh shaders output **linear HDR** (no per-object tonemap); tonemapping happens once in composite.

### Filmic tonemap + exposure

- Curve: ACES fitted (Narkowicz) with a soft shoulder (`filmicTonemap` in `generators/bloom-shaders.js`) to reduce hard clip on SEG metals / corona.
- **Exposure** comes from the active lighting preset (`studio` / `lab` / `drama` → `post.exposure`) via `packPostUniforms()`, overridable by the debug **Exposure** slider (`postExposure`).
- Applied **before** the filmic curve: `combined *= exposure`.

### Quality gates (auto-quality ↔ post cost)

`qualityTier` from `PerformanceProfiler` maps to multipliers in
`src/post-processing-config.ts` (`POST_QUALITY_GATES` → `getPostQualityGates`):

| Tier | Bloom extract/blur | SSAO | Contact shadow | Motion blur | SSR |
|------|--------------------|------|----------------|-------------|-----|
| `ultra` | on | 100% | 100% | 100% | on |
| `high` | on | 100% | 100% | 100% | on |
| `medium` | on | 70% | 85% | 70% | **off** |
| `low` | on | 30% | 55% | **off** | **off** |
| `critical` | **skipped** | **off** | 35% | **off** | **off** |

The prefiltered IBL chain is **not** in this table — it is always on.

`packPostUniforms({ qualityGates })` scales strengths. When `bloom: 0`, the render
loop skips extract + blur passes (composite still runs for exposure / filmic).
Debug panel shows **Post Quality** summary next to the quality tier.

| Gate | Rule |
|------|------|
| Feature negotiate | HDR bloom intermediates only when `rg11b10ufloat-renderable` (or equivalent) is present — else canvas format |
| Auto-quality | Particles / mesh LOD first; **post cost follows** via the table above (ADR-0005) |
| WebGL2 | No bloom chain — mild Reinhard + vignette in mesh shaders only (`docs/WEBGL2.md`) |
| Offline | `npm run check:wgsl` must pass on extracted bloom generators |
| Look presets | Changing `BloomParams` layout requires updating `packPostUniforms`, WGSL struct, and this doc together |

See also **Post stack** notes in [`SHADERS.md`](./SHADERS.md).

## Uniform layouts

### LightingConfig (binding 5, lit passes)

See prior sections in this doc — 48 floats CPU / WGSL `LightData` × 4 + ambient + envMapStrength + shadowStrength.

### BloomParams (80 bytes)

| Index | Field |
|-------|-------|
| 0–1 | texelSize |
| 2–3 | threshold, knee |
| 4–5 | strength, radius |
| 6 | power (energy) |
| 7–9 | grain, aberration, vignette |
| 10 | motionBlur |
| 11 | exposure |
| 12 | coronaBoost |
| 13 | ssaoStrength |
| 14 | contactShadow |
| 15 | skyMode |
| 16 | ssrStrength |
| 17–19 | padding (16-byte alignment) |

Packed by `packPostUniforms()` in `seg-lighting-presets.ts`. The struct is
duplicated in three generator templates plus `bloom-composite.wgsl`;
`npm run check:post` asserts all four match the packer's float count.

## Screen-space reflections (WebGPU, high/ultra only)

`src/shaders/passes/ssr-compute.wgsl` runs between the scene pass and bloom:

- Reconstructs view-space position and normal from the existing depth buffer,
  then marches the reflected ray with a geometrically growing step and a
  5-step binary refine on hit.
- Writes premultiplied reflection colour + confidence into a **half-resolution**
  `rgba16float` storage texture, which the composite adds after its AO term.
- `SsrParams` uploads the camera's own projection and its inverse
  (`MultiDeviceCamera.getProjMatrix` / `invertMatrix`) so depth is unprojected
  exactly the way the scene pass projected it.
- **Metalness/roughness G-buffer (ADR-0005 WS2):** the scene render pass has a
  second color attachment — `rg8unorm`, full canvas resolution, r=metallic
  g=roughness — written only by `seg-enhanced-frag.wgsl` and `roller-frag.wgsl`
  (chrome/nickel rollers, and the CAD housing/frame, which is drawn with the
  same segEnhanced pipeline). Every other pass in the scene declares a `null`
  second target, so its pixels keep the pass's clear value (metallic=0,
  roughness=1 — "non-metal") by default. `ssr-compute.wgsl` samples this at
  binding 5, at the *reflecting* pixel's own UV, and weights each reflection by
  `hitConfidence * fresnel * metallic * (1 - roughness)^2` — a painted/plastic
  surface (near-zero metalness) now contributes ~0 regardless of viewing
  angle, replacing the previous Fresnel-only approximation. Memory: `rg8unorm`
  at 2 bytes/px is **≈3.96 MB at 1080p** (1920×1080) and **≈15.82 MB at 4K**
  (3840×2160), on top of the existing scene-color/depth/SSR textures.

### 4x MSAA (ADR-0005 WS2 showroom pass)

Gated on `qualityTier === 'high'` **and** focus mode (a single device selected,
not overview) — `'ultra'` is defined in this doc's quality table and in
`post-processing-config.ts`, but the auto-quality system in
`performance-profiler.ts` never actually assigns it (`_updateQualityTier()`
only ever picks critical/low/medium/high), so `'high'` is the practical
ceiling gate today rather than a deliberate downgrade from `'ultra'`.

WebGPU resolves multisampled **color** attachments automatically via
`resolveTarget`, but has no equivalent for depth. When MSAA is active:

- The scene color and metalness/roughness G-buffer render into 4x-sample
  textures and resolve automatically into the existing single-sample
  `bloomSceneTexture` / `materialGBufferTexture` — bloom and SSR never know
  MSAA happened for those two.
- Depth is manually resolved: `passes/depth-resolve.wgsl`, a fullscreen
  triangle, runs right after the scene pass and writes sample 0 of the 4x
  depth buffer into `depthResolvedTexture` via `@builtin(frag_depth)`. SSR
  and bloom-composite bind that (via `ssrBindGroupResolved` /
  `bloomCompositeBindGroupResolved`) instead of the regular depth texture on
  MSAA frames.
- Every render pipeline drawn in the scene pass (sky, grid, all device
  meshes, anomaly walls, energy pipes) has a second, otherwise-identical
  `GPURenderPipeline` compiled with `multisample.count: 4` — `multisample` is
  baked into a pipeline at creation, so this can't be a runtime toggle on one
  pipeline object. Both variants are created eagerly at init (not lazily on
  first use) specifically so the per-frame render loop never awaits pipeline
  creation mid-frame; `DevicePipelineManager.applyMsaaState()` swaps the
  active reference once per frame (cheap — no GPU work).
- Debug panel (`src/debug-panel.ts`) shows `MSAA: 4x` / `1x (off)` next to
  the FPS readout so a "measured FPS note" is visible when toggling into
  focus mode at `high` tier.

**Memory** — these four textures (plus the second, `multisample.count: 4`
copy of every scene-pass pipeline) are allocated **eagerly at init**, for
every session regardless of whether that user's tier/view ever reaches
`high` + focus — a deliberate simplicity/safety tradeoff over lazy
allocation, since this renderer's WebGPU-level pipeline/attachment
correctness (sample-count matching, `resolveTarget` semantics) isn't
exercised by anything runnable outside a browser, and a lazy path would add
an async pipeline-readiness state the per-frame render loop would have to
account for. A future pass could gate allocation on ever reaching `high`
tier if the unconditional ≈87 MB / ≈348 MB below proves worth avoiding for
users who never focus a device:

| Texture | Format | Bytes/px | 1080p | 4K |
|---|---|---|---|---|
| `sceneMsaaTexture` | canvas format, 4x | 16 | ≈31.6 MB | ≈126.6 MB |
| `materialGBufferMsaaTexture` | `rg8unorm`, 4x | 8 | ≈15.8 MB | ≈63.3 MB |
| `depthMsaaTexture` | depth format, 4x | 16 | ≈31.6 MB | ≈126.6 MB |
| `depthResolvedTexture` | depth format, 1x | 4 | ≈7.9 MB | ≈31.7 MB |
| **Total extra** | | | **≈87 MB** | **≈348 MB** |

Per the issue's auto-quality guidance, MSAA is the thing to drop first under
memory/perf pressure — it's gated on `qualityTier` already, so a downgrade
away from `'high'` drops it automatically; IBL (224 KB, always-on) is never
touched by that same downgrade path.

### Disabling SSR

| Control | Effect |
|---------|--------|
| `?ssr=0` (or `off` / `false` / `no`) | Off at **any** tier; parsed by `parseSsrEnabled` in `renderers/shared/url-params.ts` |
| `window.SEG_SSR_ENABLED = false` | Same, for agent / console use |
| Tier `medium` and below | Compute pass not dispatched, `ssrStrength` packs to 0 |

The reflection texture stays allocated in every case, because `bloomComposite`
always binds it; only the dispatch and the strength are gated.

## WebGL2 fallback

No SSR and no full bloom chain (performance / complexity); the WebGL2 path is
untouched by ADR-0005 WS2. Instead:

- 3-point PBR in `MESH_FRAG` / `ROLLER_FRAG` (key + fill + rim + IBL)
- Studio / lab / drama sky via `u_skyMode`
- Mild vignette + Reinhard tonemap in fragment shader
- Stronger emissive multiplier so corona reads under simpler lighting

## Modifying looks

1. Edit presets in `src/seg-lighting-presets.ts`
2. If changing struct layouts, update WGSL in `bloom-shaders.js` and CPU packers together
3. Run `npm run check:post` (struct/packer contracts) and `npm run check:wgsl`
4. Changing the lighting rig changes the IBL bake — clear the memo with
   `clearIblCache()` if you are editing presets live
5. Run `npm run build:site`
