// =============================================================
// Energy pipe particle + uniform layouts (32 B particle stride)
// Used by passes/energy-pipe-compute.wgsl and energy-pipe render.
// =============================================================

struct PipeUniforms {
  color: vec3f,
  flow: f32,
  pulse: f32,
  _pad: vec2f,
}

/// GPU curve control upload (96 B uniform block).
struct PipeCurve {
  p0: vec3f,
  _pad0: f32,
  p1: vec3f,
  _pad1: f32,
  p2: vec3f,
  _pad2: f32,
  p3: vec3f,
  flow: f32,
  time: f32,
  speed: f32,
  particleCount: f32,
  pulse: f32,
}

struct PipeParticle {
  posX: f32,
  posY: f32,
  posZ: f32,
  velX: f32,
  velY: f32,
  velZ: f32,
  life: f32,
  strength: f32,
}
