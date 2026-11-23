// =============================================================
// Screen-space liquid surface — shared by passes/fluid-*.wgsl
// (ADR-0022, docs/FLUIDS.md → The surface).
//
// One uniform block for the splat, the depth filter and the composite.
// Host layout: `packFluidSurfaceParams` (src/fluids/fluid-surface.ts), which
// scripts/tests/fluid-surface.test.mjs checks against this struct.
//
// Depth convention of the liquid's own depth targets (depth32float): the
// distance from the camera plane along the view axis, in scene units, over
// `zFar`. Linear on purpose — the filter averages it and the composite takes
// its differences. 1.0 is "no liquid here".
// =============================================================

// 224 bytes.
struct FluidSurfaceParams {
  viewProj: mat4x4f,
  camRight: vec3f,        // camera basis in world space
  radius: f32,            // splat sphere radius, scene units
  camUp: vec3f,
  zFar: f32,              // the depth targets store distance / zFar
  camBack: vec3f,         // from the scene towards the camera
  thicknessScale: f32,    // particle volume over splat-sphere volume
  origin: vec3f,          // bench position: particle records are bench-local
  metresPerUnit: f32,
  projScale: vec2f,       // proj[0][0], proj[1][1]
  depthAB: vec2f,         // proj[2][2], proj[3][2] — scene depth to distance
  targetSize: vec2f,      // pixels of the full-resolution targets
  filterDir: vec2f,       // (1, 0) or (0, 1)
  filterRadius: f32,      // filter support, scene units
  filterRange: f32,       // narrow-range threshold δ, scene units
  filterMaxPx: f32,       // cap on the support in pixels
  roughness: f32,
  absorption: vec3f,      // Beer–Lambert, per metre
  refraction: f32,        // how far a metre of liquid bends the background, in uv at 1 unit away
  scatter: vec3f,         // colour the liquid adds where it absorbs
  edgeThickness: f32,     // scene units of liquid over which an edge fades in
  minPixels: f32,         // a splat is never drawn smaller than this radius on screen
  pad0: f32,
  pad1: f32,
  pad2: f32,
}

/// Effect types the liquid export writes into `GpuParticle.phase` (floor).
const FLUID_EFFECT_PLAIN = 9.0;     // drawn by the particle pipeline (no surface pass)
const FLUID_EFFECT_SPRAY = 10.0;    // thin liquid: always drawn by the particle pipeline
const FLUID_EFFECT_SURFACE = 11.0;  // bulk liquid under the surface pass: splatted, not drawn as a particle

/// Depth value of a pixel with no liquid.
const FLUID_EMPTY = 0.9999995;

/// Oversized triangle covering the target.
fn fluidFullscreen(vertexIndex: u32) -> vec4f {
  var pos = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(pos[vertexIndex], 0.0, 1.0);
}

/// View-space position of a pixel centre at `distance` scene units along the
/// view axis. x right, y up, z towards the camera (so z = −distance).
fn fluidViewPos(pixel: vec2f, distance: f32, p: FluidSurfaceParams) -> vec3f {
  let ndc = vec2f(pixel.x / p.targetSize.x * 2.0 - 1.0, 1.0 - pixel.y / p.targetSize.y * 2.0);
  return vec3f(ndc / p.projScale * distance, -distance);
}
