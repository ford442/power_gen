// =============================================================
// Field slice plane (ADR-0017, #255 §3): an axis-aligned plane through the
// bench volume, drawn in the scene pass. |B| as a log colour map, plus
//   mode 1 — direction arrows (in-plane B per cell, anti-aliased SDF glyphs)
//   mode 2 — line-integral convolution of hash noise along in-plane B
// The plane's normal axis and offset come from the field panel (draggable
// slider) or `?fieldSlice=x|y|z`.
//
// Bindings: docs/BINDINGS.md → `fieldSlice`.
// =============================================================
#include "common/frame-uniforms.wgsl"
#include "common/field-colormap.wgsl"
#include "common/field-volume-sample.wgsl"

struct SliceParams {
  boundsMin: vec4f, // device-local; w = normal axis (0 x, 1 y, 2 z)
  boundsMax: vec4f, // w = offset along the normal, 0..1
  devicePos: vec4f, // world offset; w = mode (0 heat, 1 arrows, 2 LIC)
  scale: vec4f,     // x = |B| at the bottom of the ramp (mT), y = top (mT), z = opacity, w = time
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(1) @binding(1) var<uniform> slice: SliceParams;
@group(1) @binding(2) var volume: texture_3d<f32>;
@group(1) @binding(3) var volumeSampler: sampler;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

// In-plane axes (u, v) and the normal, per normal axis.
fn planePoint(uv: vec2f) -> vec3f {
  let lo = slice.boundsMin.xyz;
  let hi = slice.boundsMax.xyz;
  let axis = u32(slice.boundsMin.w);
  let o = slice.boundsMax.w;
  let f = mix(lo, hi, vec3f(o));
  let a = mix(lo, hi, vec3f(uv.x, uv.y, uv.x));
  if (axis == 0u) {
    return vec3f(f.x, mix(lo.y, hi.y, uv.y), mix(lo.z, hi.z, uv.x));
  }
  if (axis == 1u) {
    return vec3f(a.x, f.y, mix(lo.z, hi.z, uv.y));
  }
  return vec3f(a.x, mix(lo.y, hi.y, uv.y), f.z);
}

// In-plane components of B (along u, along v).
fn planeB(b: vec3f) -> vec2f {
  let axis = u32(slice.boundsMin.w);
  if (axis == 0u) {
    return vec2f(b.z, b.y);
  }
  if (axis == 1u) {
    return vec2f(b.x, b.z);
  }
  return vec2f(b.x, b.y);
}

fn sampleAt(uv: vec2f) -> vec4f {
  let p = planePoint(uv);
  return textureSampleLevel(volume, volumeSampler, fieldVolumeUvw(p, slice.boundsMin.xyz, slice.boundsMax.xyz), 0.0);
}

@vertex
fn vsMain(@builtin(vertex_index) vi: u32) -> VertexOutput {
  var corners = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0),
    vec2f(0.0, 0.0), vec2f(1.0, 1.0), vec2f(0.0, 1.0)
  );
  let uv = corners[vi];
  var out: VertexOutput;
  out.position = uniforms.viewProj * vec4f(planePoint(uv) + slice.devicePos.xyz, 1.0);
  out.uv = uv;
  return out;
}

fn hash2(p: vec2f) -> f32 {
  let q = fract(p * vec2f(0.1031, 0.1030));
  let r = q + dot(q, q.yx + 33.33);
  return fract((r.x + r.y) * r.x);
}

fn lic(uv: vec2f) -> f32 {
  let res = 220.0;
  var acc = hash2(floor(uv * res));
  var w = 1.0;
  for (var dirIdx = 0u; dirIdx < 2u; dirIdx++) {
    let sgn = select(-1.0, 1.0, dirIdx == 0u);
    var q = uv;
    for (var i = 0u; i < 14u; i++) {
      let d = planeB(sampleAt(q).xyz);
      let l = length(d);
      if (l < 1e-9) {
        break;
      }
      q = q + sgn * d / l * (1.0 / res);
      let k = 1.0 - f32(i) / 14.0;
      acc += hash2(floor(q * res)) * k;
      w += k;
    }
  }
  return acc / w;
}

fn arrowMask(uv: vec2f, px: f32) -> f32 {
  let cells = 18.0;
  let cell = floor(uv * cells);
  let c = (cell + 0.5) / cells;
  let d = planeB(sampleAt(c).xyz);
  let l = length(d);
  if (l < 1e-9) {
    return 0.0;
  }
  let dir = d / l;
  let local = (uv - c) * cells; // −0.5 … 0.5 per cell
  let along = dot(local, dir);
  let across = dot(local, vec2f(-dir.y, dir.x));
  let w = px * cells;
  let shaft = (1.0 - smoothstep(0.035 - w, 0.035 + w, abs(across))) * (1.0 - smoothstep(0.30 - w, 0.30 + w, abs(along + 0.05)));
  let headT = clamp((along - 0.08) / 0.3, 0.0, 1.0);
  let head = select(0.0, 1.0 - smoothstep(0.16 * (1.0 - headT) - w, 0.16 * (1.0 - headT) + w, abs(across)), along > 0.08 && along < 0.38);
  return max(shaft, head);
}

@fragment
fn fsMain(input: VertexOutput) -> @location(0) vec4f {
  let px = max(length(fwidth(input.uv)), 1e-5);
  let b = sampleAt(input.uv);
  let t = fieldColorT(b.w, slice.scale.x, slice.scale.y);
  var rgb = fieldColormap(t);
  var a = slice.scale.z * (0.35 + 0.55 * clamp(t, 0.0, 1.0));
  let mode = u32(slice.devicePos.w);
  if (mode == 1u) {
    let m = arrowMask(input.uv, px);
    rgb = mix(rgb * 0.75, vec3f(1.0, 1.0, 1.0), m);
    a = max(a, m * 0.95);
  } else if (mode == 2u) {
    let l = lic(input.uv);
    rgb = rgb * (0.35 + 1.1 * l);
  }
  // Thin outline so the plane reads as a probe surface, not a wall.
  let edge = min(min(input.uv.x, 1.0 - input.uv.x), min(input.uv.y, 1.0 - input.uv.y));
  let rim = 1.0 - smoothstep(px, px * 2.5, edge);
  rgb = mix(rgb, vec3f(0.85, 0.95, 1.0), rim);
  a = max(a, rim * 0.9);
  return vec4f(rgb * 1.2, a);
}
