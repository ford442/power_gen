// =============================================================
// |B| = k isosurfaces (ADR-0017, #255 §3): ray-march the field volume inside
// the bench AABB in the scene pass. Up to four shells (levels in mT),
// composited front to back; the nearest hit writes frag_depth so opaque
// meshes drawn earlier occlude the shells correctly. The proxy is the AABB's
// back faces (front faces return nothing), so the march still works with the camera inside the box.
// Computed shells of the modelled sources — on SEG they replace the
// hand-modelled Roschin–Godin wall shells, and the UI labels them a model.
//
// Bindings: docs/BINDINGS.md → `fieldIso`.
// =============================================================
#include "common/frame-uniforms.wgsl"
#include "common/field-volume-sample.wgsl"

struct IsoParams {
  boundsMin: vec4f, // device-local; w = level count (1..4)
  boundsMax: vec4f, // w = opacity per shell
  devicePos: vec4f, // world offset; w = march steps
  levels: vec4f,    // |B| (mT), ascending
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(1) @binding(1) var<uniform> iso: IsoParams;
@group(1) @binding(2) var volume: texture_3d<f32>;
@group(1) @binding(3) var volumeSampler: sampler;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) world: vec3f,
}

struct FragmentOutput {
  @location(0) color: vec4f,
  @builtin(frag_depth) depth: f32,
}

@vertex
fn vsMain(@builtin(vertex_index) vi: u32) -> VertexOutput {
  // 12 triangles of the unit cube. Winding is irrelevant: the fragment
  // stage keeps back faces only (front_facing), so culling stays 'none'.
  var corners = array<vec3f, 8>(
    vec3f(0.0, 0.0, 0.0), vec3f(1.0, 0.0, 0.0), vec3f(1.0, 1.0, 0.0), vec3f(0.0, 1.0, 0.0),
    vec3f(0.0, 0.0, 1.0), vec3f(1.0, 0.0, 1.0), vec3f(1.0, 1.0, 1.0), vec3f(0.0, 1.0, 1.0)
  );
  var idx = array<u32, 36>(
    0u, 2u, 1u, 0u, 3u, 2u, 4u, 5u, 6u, 4u, 6u, 7u,
    0u, 1u, 5u, 0u, 5u, 4u, 3u, 7u, 6u, 3u, 6u, 2u,
    0u, 4u, 7u, 0u, 7u, 3u, 1u, 2u, 6u, 1u, 6u, 5u
  );
  let corner = corners[idx[vi]];
  let local = mix(iso.boundsMin.xyz, iso.boundsMax.xyz, corner);
  let world = local + iso.devicePos.xyz;
  var out: VertexOutput;
  out.position = uniforms.viewProj * vec4f(world, 1.0);
  out.world = world;
  return out;
}

fn magAt(p: vec3f) -> f32 {
  return textureSampleLevel(volume, volumeSampler, fieldVolumeUvw(p, iso.boundsMin.xyz, iso.boundsMax.xyz), 0.0).w;
}

fn levelColor(i: u32) -> vec3f {
  if (i == 0u) { return vec3f(0.20, 0.55, 1.00); }
  if (i == 1u) { return vec3f(0.25, 0.95, 0.70); }
  if (i == 2u) { return vec3f(1.00, 0.80, 0.25); }
  return vec3f(1.00, 0.40, 0.35);
}

@fragment
fn fsMain(input: VertexOutput, @builtin(front_facing) front: bool) -> FragmentOutput {
  var out: FragmentOutput;
  out.color = vec4f(0.0);
  out.depth = 1.0;
  if (front) {
    return out;
  }
  let bmin = iso.boundsMin.xyz;
  let bmax = iso.boundsMax.xyz;
  let ro = uniforms.cameraPos - iso.devicePos.xyz;
  let rd = (input.world - iso.devicePos.xyz) - ro;
  let inv = 1.0 / select(rd, vec3f(1e-9), abs(rd) < vec3f(1e-9));
  let t0s = (bmin - ro) * inv;
  let t1s = (bmax - ro) * inv;
  let tEnter = max(max(max(min(t0s.x, t1s.x), min(t0s.y, t1s.y)), min(t0s.z, t1s.z)), 0.0);
  let tExit = min(min(max(t0s.x, t1s.x), max(t0s.y, t1s.y)), max(t0s.z, t1s.z));
  let steps = max(u32(iso.devicePos.w), 16u);
  let nLevels = min(u32(iso.boundsMin.w), 4u);
  let dt = (tExit - tEnter) / f32(steps);
  let eps = length(bmax - bmin) / 128.0;
  let view = normalize(-rd);

  var col = vec3f(0.0);
  var alpha = 0.0;
  var firstT = -1.0;
  var prev = magAt(ro + rd * tEnter);
  for (var s = 1u; s <= steps; s++) {
    if (alpha > 0.97 || tExit <= tEnter) {
      break;
    }
    let t = tEnter + dt * f32(s);
    let p = ro + rd * t;
    let cur = magAt(p);
    for (var i = 0u; i < nLevels; i++) {
      let k = iso.levels[i];
      if ((prev - k) * (cur - k) < 0.0) {
        let f = (k - prev) / (cur - prev);
        let th = t - dt * (1.0 - f);
        let ph = ro + rd * th;
        let g = vec3f(
          magAt(ph + vec3f(eps, 0.0, 0.0)) - magAt(ph - vec3f(eps, 0.0, 0.0)),
          magAt(ph + vec3f(0.0, eps, 0.0)) - magAt(ph - vec3f(0.0, eps, 0.0)),
          magAt(ph + vec3f(0.0, 0.0, eps)) - magAt(ph - vec3f(0.0, 0.0, eps))
        );
        let n = normalize(select(g, vec3f(0.0, 1.0, 0.0), length(g) < 1e-12));
        let ndv = abs(dot(n, view));
        let shade = 0.35 + 0.65 * ndv;
        let rim = pow(1.0 - ndv, 3.0);
        let a = iso.boundsMax.w * (0.45 + 0.55 * rim);
        let c = levelColor(i) * shade + vec3f(rim * 0.6);
        col += (1.0 - alpha) * a * c;
        alpha += (1.0 - alpha) * a;
        if (firstT < 0.0) {
          firstT = th;
        }
      }
    }
    prev = cur;
  }
  if (firstT < 0.0) {
    return out;
  }
  let clip = uniforms.viewProj * vec4f(ro + rd * firstT + iso.devicePos.xyz, 1.0);
  out.depth = clamp(clip.z / clip.w, 0.0, 1.0);
  out.color = vec4f(col / max(alpha, 1e-4) * 1.25, alpha);
  return out;
}
