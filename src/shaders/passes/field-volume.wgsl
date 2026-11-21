// =============================================================
// Field volume (ADR-0017, #255 §2): B from every packed source at each texel
// centre of an n³ grid over the bench AABB → rgba16float 3-D texture,
// (B.xyz, |B|) in millitesla.
//
// One 4³ workgroup per brick. Sources stream through workgroup memory in
// tiles of 64 (each invocation loads one), so every source is read from the
// storage buffer once per brick instead of once per texel. A dispatch covers
// the z-bricks [grid.y, grid.y + grid.z): the host spreads a sweep over
// frames at 128³ (field-volume-pass.ts). CPU reference: src/physics/field-volume.ts.
//
// Bindings: docs/BINDINGS.md → `fieldVolume`.
// =============================================================
#include "common/field-sources.wgsl"

struct FieldVolumeParams {
  boundsMin: vec4f, // device-local scene units; w = metres per unit
  boundsMax: vec4f, // w = source count
  grid: vec4f,      // n, first z brick, z bricks this dispatch, unused
  scale: vec4f,     // x = stored units per tesla (1000 → mT)
}

@group(0) @binding(0) var<uniform> params: FieldVolumeParams;
@group(0) @binding(1) var<storage, read> sources: array<FieldSource>;
@group(0) @binding(2) var volume: texture_storage_3d<rgba16float, write>;

const FIELD_TILE: u32 = 64u;
var<workgroup> tile: array<FieldSource, 64>;

@compute @workgroup_size(4, 4, 4)
fn main(
  @builtin(workgroup_id) wg: vec3u,
  @builtin(local_invocation_id) lid: vec3u,
  @builtin(local_invocation_index) li: u32
) {
  let n = u32(params.grid.x);
  let texel = vec3u(wg.x, wg.y, wg.z + u32(params.grid.y)) * 4u + lid;
  let ext = params.boundsMax.xyz - params.boundsMin.xyz;
  let pUnits = params.boundsMin.xyz + (vec3f(texel) + vec3f(0.5)) / f32(n) * ext;
  let p = pUnits * params.boundsMin.w;
  let count = u32(params.boundsMax.w);
  var B = vec3f(0.0);
  for (var base = 0u; base < count; base += FIELD_TILE) {
    let idx = base + li;
    if (idx < count) {
      tile[li] = sources[idx];
    }
    workgroupBarrier();
    let m = min(FIELD_TILE, count - base);
    for (var i = 0u; i < m; i++) {
      B += fieldSourceB(p, tile[i]);
    }
    workgroupBarrier();
  }
  if (all(texel < vec3u(n))) {
    let s = params.scale.x;
    textureStore(volume, vec3i(texel), vec4f(B * s, length(B) * s));
  }
}
