# SEG Lighting Rig

This document describes the centralized 3-point + environment lighting rig used by all lit SEG device passes in the WebGPU renderer.

## Goal

All SEG geometry (rollers, base plate, stator rings, wiring, stand, core, pickup coils, electromagnets, wire harnesses) and the solar battery gauge now read lighting from a single `LightingConfig` uniform buffer. This eliminates the previous mismatch where:

- The enhanced SEG shader read a `LightingConfig` at `@binding(5)` but its struct layout was out of sync with the CPU upload.
- The legacy roller shader used hard-coded `L1 = normalize(vec3f(1,1,1))`, `L2 = normalize(vec3f(-0.5,0.3,-0.5))`, etc.
- Some passes bound a `materialTable` at `@binding(5)` instead of lighting.

## Light definitions

The rig is authored on the CPU in `src/multi-device-visualizer.js`:

```js
this.lightingConfig = {
  key:    { position: [ 5.0,  8.0,  5.0], color: [1.0, 0.98, 0.95], intensity: 1.2 },
  fill:   { position: [-4.0,  3.0, -3.0], color: [0.75, 0.85, 1.0], intensity: 0.4 },
  rim:    { position: [ 0.0,  2.0, -8.0], color: [0.4,  0.8,  1.0], intensity: 0.8 },
  ground: { position: [ 0.0, -5.0,  0.0], color: [0.3,  0.25, 0.2 ], intensity: 0.15 },
  ambient: 0.3,
  envMapStrength: 0.5
};
```

| Light  | Role | Direction (surface → light) | Color | Intensity |
|--------|------|----------------------------|-------|-----------|
| Key    | Main directional highlight | Upper-right-front | Warm white (1.0, 0.98, 0.95) | 1.2 |
| Fill   | Soft opposite-side fill | Upper-left-back | Cool blue (0.75, 0.85, 1.0) | 0.4 |
| Rim    | View-dependent edge/rim | Back | Cyan (0.4, 0.8, 1.0) | 0.8 |
| Ground | Bounce light from below | Upward from ground | Warm brown (0.3, 0.25, 0.2) | 0.15 |
| Ambient | Flat environment term | — | Cool grey (0.15, 0.18, 0.22) × `ambient` | 0.3 |
| EnvMap | Fresnel reflection approximation | View-dependent | `f0` × `envMapStrength` × 0.3 | 0.5 |

The `position` fields are normalized in the shader to produce directional light vectors. `ground.position = [0, -5, 0]` points upward after normalization, simulating light reflected off the floor and illuminating the undersides of objects.

## Uniform buffer layout

The lighting uniform buffer is created as a 192-byte `GPUBufferUsage.UNIFORM` buffer in `src/multi-device-visualizer.js` and uploaded every frame.

### CPU layout (`Float32Array(48)`)

| Floats | Bytes | Field |
|--------|-------|-------|
| 0–2    | 0–11  | `key.dir` (vec3f) |
| 3      | 12–15 | padding |
| 4–6    | 16–27 | `key.color` (vec3f) |
| 7      | 28–31 | `key.intensity` |
| 8–10   | 32–43 | `fill.dir` |
| 11     | 44–47 | padding |
| 12–14  | 48–59 | `fill.color` |
| 15     | 60–63 | `fill.intensity` |
| 16–18  | 64–75 | `rim.dir` |
| 19     | 76–79 | padding |
| 20–22  | 80–91 | `rim.color` |
| 23     | 92–95 | `rim.intensity` |
| 24–26  | 96–107| `ground.dir` |
| 27     | 108–111| padding |
| 28–30  | 112–123| `ground.color` |
| 31     | 124–127| `ground.intensity` |
| 32     | 128–131| `ambient` |
| 33     | 132–135| `envMapStrength` |
| 34–47  | 136–191| unused padding |

### WGSL layout

```wgsl
struct Light {
  dir: vec3f,      // offset 0  (align 16, size 12)
  color: vec3f,    // offset 16 (align 16, size 12)
  intensity: f32,  // offset 28 (align 4,  size 4)
}                  // Light size = 32 bytes

struct LightingConfig {
  key: Light,           // offset 0
  fill: Light,          // offset 32
  rim: Light,           // offset 64
  ground: Light,        // offset 96
  ambient: f32,         // offset 128
  envMapStrength: f32,  // offset 132
}                       // total size = 144 bytes (padded to 144)

@binding(5) @group(0) var<uniform> lighting: LightingConfig;
```

Each `Light` is 32 bytes, so the WGSL struct and the CPU upload are byte-identical.

## Consumers

| Pipeline | Shader | Binds `lighting` @ 5? | Notes |
|----------|--------|----------------------|-------|
| `segEnhancedPipeline` | `segEnhancedFragShader` | Yes | All SEG mesh geometry |
| `rollerPipeline` | `rollerFragShader` | Yes | Solar battery gauge |
| `fluxSegmentPipeline` | `fluxSegmentFragShader` | No | Self-illuminated flux ribbons |
| `energyArcPipeline` | `energyArcFragShader` | No | Self-illuminated arcs |
| `particlePipeline` | `particleFragShader` | No | Additive particles |
| `skyPipeline` / `gridPipeline` | sky/grid shaders | No | Background passes |

The lighting buffer is always uploaded before rendering, so any future lit pass only needs to bind `@binding(5)` to receive the rig.

## Bind group convention

For lit passes the bind group layout is:

```
@binding(0) global uniforms (viewProj, time, resolution, cameraPos)
@binding(1) device uniforms
@binding(2) instance storage buffer
@binding(3) material uniforms
@binding(5) LightingConfig
@binding(6) material table storage buffer
```

`@binding(4)` is intentionally left free; it is used by arc and particle passes for their dynamic buffers.

## Modifying the rig

1. Edit `src/multi-device-visualizer.js` → `this.lightingConfig`.
2. If you change the number of lights or the struct layout, update both the CPU upload and the `Light` / `LightingConfig` structs in `src/multi-device-shaders.js`.
3. Re-validate shaders with `node validate-shaders.mjs` (or any WGSL → SPIR-V tool such as `naga`).
4. Run `npm run build:site` to confirm bundling still succeeds.

## History / previous issues fixed

- The enhanced shader previously declared `keyDir`, `keyColor`, `keyIntensity` as flat fields and read `ambient` / `envMapStrength` at offsets that aliased into the ground-light position/color data.
- The enhanced shader also negated light directions (`normalize(-lighting.keyDir)`), which inverted the key light relative to the legacy roller shader. Both shaders now use `normalize(light.dir)` so highlights come from the same directions.
- The legacy roller shader bound `materialTable` at `@binding(5)`, blocking lighting. It has been moved to `@binding(6)` and the solar gauge bind group was updated to match.
