// =============================================================
// Particle compute uniforms (48 B)
// Matches DeviceComputeManager.updateComputeUniforms write order.
// =============================================================

struct ComputeUniforms {
  time: f32,
  mode: f32,
  particleCount: f32,
  speedMult: f32,
  physics0: f32,
  physics1: f32,
  physics2: f32,
  physics3: f32,
  /// Overview particle LOD 0..3 — see common/overview-lod.wgsl.
  lodLevel: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
}
