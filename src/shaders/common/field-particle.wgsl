// =============================================================
// SEG field-line / energy-arc particle layout (32 B)
// Used by field-advect compute and field particle draw paths.
// =============================================================

struct FieldParticle {
  posX: f32,
  posY: f32,
  posZ: f32,
  velX: f32,
  velY: f32,
  velZ: f32,
  life: f32,
  strength: f32,
}

struct FieldUniforms {
  time: f32,
  speedMult: f32,
  particleCount: u32,
  pad: f32,
}
