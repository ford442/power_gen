// =============================================================
// Overview frustum-cull structs (ADR-0005 WS4).
// Matches the packing in src/devices/overview-cull.ts — keep both in sync.
// =============================================================

#include "common/overview-lod.wgsl"

/// One device slot: bounding sphere + the particle budget for its draw. 32 B.
struct DeviceBounds {
  center: vec3f,
  radius: f32,
  /// Particle count before LOD (already clamped to the tier budget on the CPU).
  baseCount: u32,
  /// 0..3 — see common/overview-lod.wgsl. CPU-authored so the compute pass
  /// (which reads it from ComputeUniforms) and this pass cannot disagree.
  lodLevel: u32,
  /// bit 0 = device enabled/simulated this frame.
  flags: u32,
  _pad0: u32,
}

/// 96 B — viewProj (GL-style, z ∈ [-1,1]; see MultiDeviceCamera.perspectiveMatrix).
struct CullUniforms {
  viewProj: mat4x4f,
  cameraPos: vec3f,
  deviceCount: u32,
  /// Bounding-sphere inflation; matches the CPU cull margin in view-lod.js.
  margin: f32,
  /// Vertices per particle billboard (triangle-strip quad → 4).
  vertexCount: u32,
  _pad0: u32,
  _pad1: u32,
}

/// `drawIndirect` argument block — 16 B, one per device slot (stable index).
struct DrawArgs {
  vertexCount: u32,
  instanceCount: u32,
  firstVertex: u32,
  firstInstance: u32,
}

/// Compacted visibility list + counters read back for profiling/diagnostics.
struct CullOutput {
  visibleCount: atomic<u32>,
  drawnInstances: atomic<u32>,
  _pad0: u32,
  _pad1: u32,
  /// Device slot indices of the visible devices, packed [0, visibleCount).
  indices: array<u32>,
}

const CULL_FLAG_ENABLED: u32 = 1u;

/// Signed distance of a sphere centre to a (possibly unnormalized) plane.
fn planeDistance(plane: vec4f, center: vec3f) -> f32 {
  let len = max(1e-6, length(plane.xyz));
  return (dot(plane.xyz, center) + plane.w) / len;
}

/// Gribb–Hartmann frustum test. `m` is column-major, so row i is m[c][i].
fn sphereInFrustum(m: mat4x4f, center: vec3f, radius: f32) -> bool {
  let r0 = vec4f(m[0][0], m[1][0], m[2][0], m[3][0]);
  let r1 = vec4f(m[0][1], m[1][1], m[2][1], m[3][1]);
  let r2 = vec4f(m[0][2], m[1][2], m[2][2], m[3][2]);
  let r3 = vec4f(m[0][3], m[1][3], m[2][3], m[3][3]);

  var planes = array<vec4f, 6>(
    r3 + r0,  // left
    r3 - r0,  // right
    r3 + r1,  // bottom
    r3 - r1,  // top
    r3 + r2,  // near (GL depth convention)
    r3 - r2   // far
  );

  for (var i = 0u; i < 6u; i = i + 1u) {
    if (planeDistance(planes[i], center) < -radius) {
      return false;
    }
  }
  return true;
}
