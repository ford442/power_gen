// =============================================================
// Shared particle layouts — single source for GPU + C++ docs
//
// Interactive WebGPU path (DeviceGeometry / compute / billboards):
//   16 bytes — PARTICLE_BYTES_PER_INSTANCE in device-geometry.js
//
// High-precision C++ / WASM path (cpp/src/sim_core.h SimParticle):
//   32 bytes — 8 floats (pos + phase + velocity + aux)
//
// Keep field order and sizes in sync with C++ and JS constants.
// =============================================================

/// Interactive GPU particle (16 B). Storage: `array<GpuParticle>`.
/// `phase` may encode effect-type in the integer part (floor) with
/// fractional particle phase — see particle vertex shader.
struct GpuParticle {
  pos: vec3f,
  phase: f32,
}

/// High-precision particle matching C++ `SimParticle` (32 B).
/// Used by WASM export and any future full-state GPU path.
struct SimParticle {
  x: f32,
  y: f32,
  z: f32,
  phase: f32,
  vx: f32,
  vy: f32,
  vz: f32,
  aux: f32,
}
