// =============================================================
// SEG enhanced roller instance + roller compute uniforms
// =============================================================

struct RollerInstance {
  position: vec3f,
  ringIndex: f32,
  rotation: vec4f,
  copperColor: vec3f,
  greenEmissive: f32,
}

struct RollerUniforms {
  time: f32,
  speedMult: f32,
  prototypePreset: f32,
  segOmega: f32,
}
