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
- Hemispherical studio IBL (`approximateIBL`) — softbox ceiling + floor bounce
- Rim term from view-dependent Fresnel
- `shadowStrength` modulates crevice ambient and IBL occlusion

## Post-processing pipeline (WebGPU)

Scene renders to an HDR-ish offscreen target (`bloomSceneTexture`). Passes:

1. **Extract** — luminance threshold with **corona boost** (green/cyan plasma weighted higher than bare metal specular)
2. **Blur H / V** — 5-tap Gaussian
3. **Composite** — scene + wide bloom + ACES tonemap + vignette + film grain

Composite also applies:

- **SSAO** — 6-tap depth comparison (cheap screen-space AO)
- **Contact shadows** — depth-gradient creases + ground-plane darkening
- **Motion blur** — mix with previous frame at high overdrive speed
- **Chromatic aberration** — scales with energy level

Mesh shaders output **linear HDR** (no per-object tonemap); tonemapping happens once in composite.

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
