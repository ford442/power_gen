// MLS-MPM liquid solver — the structs and stencil shared by passes/mpm-p2g.wgsl,
// mpm-grid.wgsl and mpm-g2p.wgsl (ADR-0022). SI units: m, s, kg, Pa.
// CPU side and the reasoning: src/fluids/mpm-params.ts; CPU twin: mpm-cpu.ts.

// 80 bytes — `packMpmParams`.
struct MpmParams {
  gridN: vec3u,           // nodes per axis
  particleCount: u32,     // records the passes visit
  cellM: f32,             // h
  dt: f32,                // substep
  restDensity: f32,
  particleMass: f32,
  eosStiffness: f32,      // Tait B, Pa
  eosGamma: f32,
  viscosity: f32,         // μ, Pa·s
  minJ: f32,              // 1 / maxDensityRatio
  gravity: vec3f,
  maxSpeed: f32,          // m/s: grid velocity clamp and the fixed-point momentum unit
  massScale: f32,         // counts per unit weight
  momentumScale: f32,     // counts per unit weight · maxSpeed
  maxJ: f32,
  tMax: f32,              // clamp on a momentum transfer, in maxSpeed
}

// 80 bytes — `MPM_P` gives the word offsets.
struct MpmParticle {
  pos: vec3f,             // m, domain-local
  j: f32,                 // V / V₀
  vel: vec3f,             // m/s
  state: f32,             // 0 = empty slot
  c0: vec3f,              // affine matrix C, column 0 (∂v/∂x), 1/s
  pressure: f32,          // Pa, as P2G last computed it (diagnostic)
  c1: vec3f,
  seed: u32,              // counter the fixed-point dither is hashed from
  c2: vec3f,
  pad: f32,
}

// The 3×3×3 quadratic B-spline stencil of a position.
struct MpmStencil {
  base: vec3i,            // lowest node
  f: vec3f,               // position relative to it, in cells: [0.5, 1.5)
  w: array<vec3f, 3>,     // w[k] = weights of node offset k, per axis
}

fn mpmStencil(pos: vec3f, cellM: f32, gridN: vec3u) -> MpmStencil {
  let g = pos / cellM;
  var s: MpmStencil;
  // The clamp only matters for a position outside the box (never written by
  // g2p); it keeps every index on the grid whatever the buffer holds.
  s.base = clamp(vec3i(floor(g - 0.5)), vec3i(0), vec3i(gridN) - 3);
  s.f = g - vec3f(s.base);
  let a = 1.5 - s.f;
  let b = s.f - 1.0;
  let d = s.f - 0.5;
  s.w[0] = 0.5 * a * a;
  s.w[1] = 0.75 - b * b;
  s.w[2] = 0.5 * d * d;
  return s;
}

fn mpmNodeIndex(node: vec3i, gridN: vec3u) -> u32 {
  return (u32(node.z) * gridN.y + u32(node.y)) * gridN.x + u32(node.x);
}

// PCG output permutation of the particle counter (`mpmSeedBits`).
fn mpmSeedBits(seed: u32) -> u32 {
  let word = ((seed >> ((seed >> 28u) + 4u)) ^ seed) * 277803737u;
  return (word >> 22u) ^ word;
}

// The counter's step (`mpmSeedNext`).
fn mpmSeedNext(seed: u32) -> u32 {
  return seed * 747796405u + 2891336453u;
}
