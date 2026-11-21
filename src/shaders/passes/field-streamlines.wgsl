// =============================================================
// Generic field-line tracer (ADR-0017, #255 §3): one invocation per seed,
// RK4 along the unit field direction sampled trilinearly from the volume,
// half the segments forward and half backward from the seed. Replaces the
// SEG-only RK4 tracer (which re-evaluated every roller per step and re-traced
// from the seed for every segment) and the transformer's analytic torus
// metaphor whenever the volume is live; both stay as overview / low-tier
// fallbacks.
//
// A line stops when it leaves the bench AABB or |B| drops below `minMt`;
// its remaining slots are marked unused (age < 0).
//
// Bindings: docs/BINDINGS.md → `fieldStreamlines`.
// =============================================================
#include "common/field-line-segment.wgsl"
#include "common/field-volume-sample.wgsl"

struct StreamParams {
  boundsMin: vec4f, // xyz scene units; w = step (scene units)
  boundsMax: vec4f, // xyz; w = minimum |B| (mT) to keep tracing
  shape: vec4f,     // seed count, segments per line, time (s), unused
}

@group(0) @binding(0) var<uniform> params: StreamParams;
@group(0) @binding(1) var volume: texture_3d<f32>;
@group(0) @binding(2) var volumeSampler: sampler;
@group(0) @binding(3) var<storage, read> seeds: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> segments: array<FieldLineSegment>;

fn sampleB(p: vec3f) -> vec4f {
  return textureSampleLevel(volume, volumeSampler, fieldVolumeUvw(p, params.boundsMin.xyz, params.boundsMax.xyz), 0.0);
}

fn fieldDir(p: vec3f) -> vec3f {
  let b = sampleB(p).xyz;
  let l = length(b);
  if (l < 1e-12) {
    return vec3f(0.0);
  }
  return b / l;
}

fn rk4(p: vec3f, h: f32) -> vec3f {
  let k1 = fieldDir(p);
  let k2 = fieldDir(p + k1 * (h * 0.5));
  let k3 = fieldDir(p + k2 * (h * 0.5));
  let k4 = fieldDir(p + k3 * h);
  return p + (k1 + 2.0 * k2 + 2.0 * k3 + k4) * (h / 6.0);
}

fn unused() -> FieldLineSegment {
  return FieldLineSegment(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, -1.0);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let line = gid.x;
  if (line >= u32(params.shape.x)) {
    return;
  }
  let segs = u32(params.shape.y);
  let half = segs / 2u;
  let base = line * segs;
  let bmin = params.boundsMin.xyz;
  let bmax = params.boundsMax.xyz;
  let h = params.boundsMin.w;
  let minMt = params.boundsMax.w;
  let seed = seeds[line].xyz;

  for (var dirIdx = 0u; dirIdx < 2u; dirIdx++) {
    let sgn = select(-1.0, 1.0, dirIdx == 0u);
    let count = select(half, segs - half, dirIdx == 0u);
    var p = seed;
    var alive = fieldInside(p, bmin, bmax);
    for (var i = 0u; i < count; i++) {
      // Forward fills [half, segs), backward fills [half − 1 … 0].
      let slot = select(base + half - 1u - i, base + half + i, dirIdx == 0u);
      var seg = unused();
      if (alive) {
        let b = sampleB(p);
        if (b.w < minMt) {
          alive = false;
        } else {
          let q = rk4(p, h * sgn);
          if (!fieldInside(q, bmin, bmax) || distance(q, p) < h * 1e-3) {
            alive = false;
          } else {
            let t = f32(i) / f32(max(count, 1u));
            seg = FieldLineSegment(p.x, p.y, p.z, q.x, q.y, q.z, b.w, select(0.5 - 0.5 * t, 0.5 + 0.5 * t, dirIdx == 0u));
            p = q;
          }
        }
      }
      segments[slot] = seg;
    }
  }
}
