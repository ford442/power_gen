# SEG Lighting & Post-Processing

Studio-quality lighting and a full-screen post pipeline for the WebGPU path, with a simplified 3-point + IBL fallback in WebGL2.

## Lighting looks

Presets live in `src/seg-lighting-presets.js`:

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
- Hemispherical studio IBL (`approximateIBL` + analytic `envRadiance` mips) — softbox ceiling + floor bounce; roughness selects sharp / mid / irradiance lobes (no Three.js PMREM)
- Rim term from view-dependent Fresnel
- `shadowStrength` modulates crevice ambient and IBL occlusion

## Post-processing pipeline (WebGPU)

Scene renders to an HDR-ish offscreen target (`bloomSceneTexture`). Passes:

1. **Extract** — luminance threshold with **corona boost** (green/cyan plasma weighted higher than bare metal specular)
2. **Blur H / V** — 5-tap Gaussian
3. **Composite** — scene + wide bloom + **filmic tonemap** + vignette + film grain

Composite also applies:

- **SSAO** — 6-tap depth comparison (cheap screen-space AO)
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
`src/post-processing-config.js` (`POST_QUALITY_GATES` → `getPostQualityGates`):

| Tier | Bloom extract/blur | SSAO | Contact shadow | Motion blur |
|------|--------------------|------|----------------|-------------|
| `high` | on | 100% | 100% | 100% |
| `medium` | on | 70% | 85% | 70% |
| `low` | on | 30% | 55% | **off** |
| `critical` | **skipped** | **off** | 35% | **off** |

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

### BloomParams (64 bytes)

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

Packed by `packPostUniforms()` in `seg-lighting-presets.js`.

## WebGL2 fallback

No full bloom chain (performance / complexity). Instead:

- 3-point PBR in `MESH_FRAG` / `ROLLER_FRAG` (key + fill + rim + IBL)
- Studio / lab / drama sky via `u_skyMode`
- Mild vignette + Reinhard tonemap in fragment shader
- Stronger emissive multiplier so corona reads under simpler lighting

## Modifying looks

1. Edit presets in `src/seg-lighting-presets.js`
2. If changing struct layouts, update WGSL in `bloom-shaders.js` and CPU packers together
3. Run `npm run build:site`
