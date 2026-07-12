// =============================================================
// Packed SEG layout uniforms — must match packSEGLayoutUniforms (seg-layout.js)
// =============================================================

struct SEGLayoutRing {
  count: f32,
  fullCount: f32,
  orbitRadius: f32,
  rollerRadius: f32,
  rollerHeight: f32,
  speed: f32,
  statorInner: f32,
  statorOuter: f32,
  rollerOffset: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
}

struct SEGLayoutUniforms {
  worldScale: f32,
  ringCount: f32,
  totalRollers: f32,
  maxRollers: f32,
  refRollerRadius: f32,
  refRollerHeight: f32,
  statorHeight: f32,
  fluxLinesPerRing: f32,
  ring0: SEGLayoutRing,
  ring1: SEGLayoutRing,
  ring2: SEGLayoutRing,
}
