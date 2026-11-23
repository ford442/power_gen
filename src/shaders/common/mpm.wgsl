// MLS-MPM liquid solver — the structs and stencil shared by passes/mpm-p2g.wgsl,
// mpm-grid.wgsl and mpm-g2p.wgsl (ADR-0022). SI units: m, s, kg, Pa.
// CPU side and the reasoning: src/fluids/mpm-params.ts; CPU twin: mpm-cpu.ts.

// A horizontal ring of charge (or, with radius 0, a point charge): a conductor
// held at a potential by the bench's plant, as the liquid's charged particles
// feel it. 32 bytes.
struct MpmConductor {
  centre: vec3f,          // m, domain-local
  radius: f32,            // m; 0 = a point
  kq: f32,                // Coulomb constant × charge, V·m
  soft: f32,              // softening length (the wire's radius), m
  pad0: f32,
  pad1: f32,
}

const MPM_MAX_CONDUCTORS = 4;
// A ring is summed as this many point charges — exact on its axis.
const MPM_RING_POINTS = 12;

// 224 bytes — `packMpmParams`.
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
  flags: u32,             // bit 0: the boundary buffer holds a signed-distance field
  conductorCount: u32,    // conductors in use: charged particles feel their field
  pad1: u32,
  pad2: u32,
  conductors: array<MpmConductor, 4>,
}

const MPM_FLAG_BOUNDARY = 1u;

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
  charge: f32,            // C carried by the parcel; 0 = neutral
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

// lowbias32 (`mpmHash32`) and its [0, 1) form with 24 bits (`mpmHash01`).
fn mpmHash32(n: u32) -> u32 {
  var x = n;
  x = (x ^ (x >> 16u)) * 0x7feb352du;
  x = (x ^ (x >> 15u)) * 0x846ca68bu;
  return x ^ (x >> 16u);
}

fn mpmHash01(n: u32) -> f32 {
  return f32(mpmHash32(n) >> 8u) / 16777216.0;
}

// ---- emitters, sinks, read-back (layout `mpmIo`) ---------------------------

// 48 bytes.
struct MpmEmitter {
  centre: vec3f,          // m, domain-local: centre of the nozzle disc
  radius: f32,
  dir: vec3f,             // unit
  speed: f32,             // m/s
  count: u32,             // particles to release this frame
  baseId: u32,            // id of this emitter's first new particle
  length: f32,            // speed · simulated seconds this frame
  spread: f32,            // tan of the half-angle at the rim
}

// 32 bytes. `on` is 0 for an unused slot.
struct MpmSink {
  lo: vec3f,
  on: f32,
  hi: vec3f,
  pad: f32,
}

// 272 bytes — `packMpmIoParams`.
struct MpmIoParams {
  emitters: array<MpmEmitter, 2>,
  sinks: array<MpmSink, 4>,
  exportOrigin: vec3f,    // scene position = exportOrigin + metres · exportScale
  exportScale: f32,
  capacity: u32,
  surface: u32,           // 1: a surface pass draws the bulk liquid (export it as type 11)
  sprayBelow: f32,        // density over rest density under which a particle is spray; 0 = never
  pad2: u32,
  emitterCharge: vec4f,   // C each new particle of emitter 0 / 1 carries (z, w spare)
}

const MPM_COUNTER_TICKETS = 0u;
const MPM_COUNTER_EMITTED = 1u;
const MPM_COUNTER_SUNK = 2u;
// Then one word per sink: what each has removed.
const MPM_COUNTER_SINK0 = 3u;
const MPM_MAX_SINKS = 4;
