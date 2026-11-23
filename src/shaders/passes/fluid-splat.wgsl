// Screen-space liquid surface, step 1 — splat (ADR-0022, docs/FLUIDS.md).
//
// Each bulk particle of the liquid solver's export is drawn as a sphere
// impostor: a camera-facing quad whose fragments are cut to a disc and given
// the depth of the sphere's near side.
//
//   fsDepth      depth-only, nearest wins: the liquid's front surface.
//   fsThickness  additive: the length of each sphere's chord along the view
//                ray, scaled so that the sum is the liquid's own thickness
//                (a particle's volume, not its splat sphere's).
//
// Spray particles and empty slots are skipped here; the particle pipeline
// draws the spray.

#include "common/particle.wgsl"
#include "common/fluid-surface.wgsl"

@group(0) @binding(0) var<uniform> surface: FluidSurfaceParams;
@group(0) @binding(1) var<storage, read> liquid: array<GpuParticle>;

struct SplatOutput {
  @builtin(position) position: vec4f,
  @location(0) quad: vec2f,
  @location(1) centreDistance: f32,
  // The radius drawn, and what a chord through it is worth in liquid.
  @location(2) radius: f32,
  @location(3) chordScale: f32,
}

@vertex
fn vsSplat(@builtin(vertex_index) vertexIndex: u32, @builtin(instance_index) instance: u32) -> SplatOutput {
  let p = liquid[instance];
  let corner = vec2f(f32(vertexIndex & 1u), f32((vertexIndex >> 1u) & 1u)) * 2.0 - 1.0;
  var out: SplatOutput;
  out.quad = corner;
  out.radius = surface.radius;
  out.chordScale = surface.thicknessScale;
  if (floor(p.phase) != FLUID_EFFECT_SURFACE) {
    // Behind the far plane: clipped.
    out.position = vec4f(0.0, 0.0, 2.0, 1.0);
    out.centreDistance = 0.0;
    return out;
  }
  let centre = surface.origin + p.pos;
  // clip.w of a perspective projection is the distance along the view axis.
  let distance = (surface.viewProj * vec4f(centre, 1.0)).w;
  // Far away a sphere is smaller than a pixel and would fall between pixel
  // centres. Draw it at `minPixels` instead, and thin it by the cube of the
  // ratio so that it still stands for the same volume of liquid.
  let unitsPerPixel = max(distance, 1.0e-4) / (0.5 * surface.targetSize.y * surface.projScale.y);
  let radius = max(surface.radius, surface.minPixels * unitsPerPixel);
  let shrink = surface.radius / radius;
  out.radius = radius;
  out.chordScale = surface.thicknessScale * shrink * shrink * shrink;
  let world = centre + (surface.camRight * corner.x + surface.camUp * corner.y) * radius;
  out.position = surface.viewProj * vec4f(world, 1.0);
  out.centreDistance = distance;
  return out;
}

struct DepthOutput {
  @builtin(frag_depth) depth: f32,
}

@fragment
fn fsDepth(in: SplatOutput) -> DepthOutput {
  let r2 = dot(in.quad, in.quad);
  if (r2 > 1.0) { discard; }
  let distance = in.centreDistance - in.radius * sqrt(1.0 - r2);
  return DepthOutput(clamp(distance / surface.zFar, 0.0, FLUID_EMPTY - 1.0e-6));
}

@fragment
fn fsThickness(in: SplatOutput) -> @location(0) vec4f {
  let r2 = dot(in.quad, in.quad);
  if (r2 > 1.0) { discard; }
  let chord = 2.0 * in.radius * sqrt(1.0 - r2);
  return vec4f(chord * in.chordScale, 0.0, 0.0, 1.0);
}
