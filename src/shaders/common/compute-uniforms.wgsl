// =============================================================
// Particle compute uniforms (32 B)
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
}
