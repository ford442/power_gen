// Screen-space liquid surface, step 2 — depth filter (ADR-0022, docs/FLUIDS.md).
//
// One direction of a separable narrow-range filter (Truong & Yuksel 2018)
// over the splatted depth: a Gaussian whose support is a fixed size in the
// scene, so it shrinks with distance, and which treats depth as follows —
//
//   a neighbour more than δ in front   is another surface: left out
//   a neighbour more than δ behind     counts as δ behind (so does "no liquid")
//
// The first keeps a jet in front of a pool from being smeared into it; the
// second rounds a silhouette off instead of dragging it to the far plane.
// Run once along x and once along y. Reads one depth target, writes the other.
//
// CPU twin: `fluidFilterPixel` in src/fluids/fluid-surface.ts.

#include "common/fluid-surface.wgsl"

@group(0) @binding(0) var<uniform> surface: FluidSurfaceParams;
@group(0) @binding(1) var depthIn: texture_depth_2d;

/// Taps to each side at most (`FLUID_FILTER_MAX_TAPS`).
const FLUID_FILTER_MAX_TAPS = 24;

struct FilterVertex {
  @builtin(position) position: vec4f,
}

@vertex
fn vsFilter(@builtin(vertex_index) vertexIndex: u32) -> FilterVertex {
  return FilterVertex(fluidFullscreen(vertexIndex));
}

@fragment
fn fsFilter(@builtin(position) frag: vec4f) -> @builtin(frag_depth) f32 {
  let pixel = vec2i(frag.xy);
  let d0 = textureLoad(depthIn, pixel, 0);
  if (d0 >= FLUID_EMPTY) { return 1.0; }
  let z0 = d0 * surface.zFar;
  // The support in pixels at this distance.
  let pxPerUnit = 0.5 * surface.targetSize.y * surface.projScale.y / max(z0, 1.0e-4);
  let support = clamp(surface.filterRadius * pxPerUnit, 1.0, min(surface.filterMaxPx, f32(FLUID_FILTER_MAX_TAPS)));
  let sigma = 0.5 * support;
  let taps = i32(ceil(support));
  let size = vec2i(surface.targetSize);
  let dir = vec2i(surface.filterDir);
  let range = surface.filterRange;
  var sum = z0;
  var weight = 1.0;
  for (var i = 1; i <= FLUID_FILTER_MAX_TAPS; i++) {
    if (i > taps) { break; }
    let x = f32(i) / sigma;
    let w = exp(-0.5 * x * x);
    for (var side = -1; side <= 1; side += 2) {
      let q = pixel + dir * (i * side);
      var z = z0 + range;
      if (all(q >= vec2i(0)) && all(q < size)) {
        let d = textureLoad(depthIn, q, 0);
        if (d < FLUID_EMPTY) { z = d * surface.zFar; }
      }
      if (z < z0 - range) { continue; }
      sum += w * min(z, z0 + range);
      weight += w;
    }
  }
  return clamp(sum / weight / surface.zFar, 0.0, FLUID_EMPTY - 1.0e-6);
}
