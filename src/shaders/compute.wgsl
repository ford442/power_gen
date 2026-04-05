// Particle physics compute shader
// Particles stored as vec4f: xyz = world position, w = phase (0–1, per-particle seed)
//
// IMPORTANT: ComputeUniforms must mirror the JS uniform buffer layout exactly.
// JS writes: viewProj(16f) | time(f) mode(f) particleCount(f) batteryCharge(f)

@binding(0) @group(0) var<storage, read_write> particles: array<vec4f>;

struct ComputeUniforms {
  viewProj:      mat4x4f,   // 64 bytes – ignored by compute
  time:          f32,       // offset 64
  mode:          f32,       // offset 68  (0=SEG 1=Heron 2=Kelvin 3=Solar)
  particleCount: f32,       // offset 72
  speedMult:     f32,       // offset 76  (batteryCharge 0–1, used as speed hint)
}
@binding(1) @group(0) var<uniform> uniforms: ComputeUniforms;

const PI: f32 = 3.14159265359;

// ─── SEG Mode ──────────────────────────────────────────────────────────────────
// Particles spiral inward toward the centre, sweeping through the magnetic field
// topology. Each particle traces a unique helical path keyed by its phase seed.
fn posSEG(phase: f32, t: f32, idx: u32) -> vec3f {
  // Cycle period driven by time; each particle offset by its phase
  let cycleT  = fract(t * 0.12 + phase);
  // Start at outer ring, spiral in
  let radius  = 8.5 - cycleT * 8.0;
  // Angle wraps around multiple times per cycle for a tight helix
  let angle   = phase * 6.28318 + cycleT * 18.84956;  // 3 full turns
  let height  = sin(cycleT * 6.28318 * 2.0 + phase * 6.28318) * 2.8;
  return vec3f(cos(angle) * radius, height, sin(angle) * radius);
}

// ─── Heron's Fountain Mode ─────────────────────────────────────────────────────
// Parametric water-jet arc: rises from nozzle (0,5.6,0), peaks ~y=8.4,
// falls into display basin (y≈4.5), drains back through the system.
fn posHeron(phase: f32, t: f32, idx: u32) -> vec3f {
  let cycleT  = fract(t * 0.22 + phase);   // one full cycle
  // Per-particle angular spread and radial offset for natural dispersion
  let spread  = phase * 6.28318;
  let spreadR = fract(f32(idx) * 0.618034) * 0.55;

  var pos: vec3f;
  if (cycleT < 0.35) {
    // Rising: upward jet from nozzle with radial spread
    let k  = cycleT / 0.35;
    pos = vec3f(sin(spread) * spreadR * k * 1.4,
                5.6 + k * 3.1 - k * k * 1.2,
                cos(spread) * spreadR * k * 1.4);
  } else if (cycleT < 0.72) {
    // Falling into basin: gravity arc
    let k  = (cycleT - 0.35) / 0.37;
    pos = vec3f(sin(spread) * spreadR * (1.4 - k * 0.9),
                8.5 - k * 4.2,
                cos(spread) * spreadR * (1.4 - k * 0.9));
  } else {
    // Draining back through centre tube to reservoir
    let k  = (cycleT - 0.72) / 0.28;
    pos = vec3f(sin(spread) * spreadR * (0.5 - k * 0.5),
                4.5 - k * 6.5,
                cos(spread) * spreadR * (0.5 - k * 0.5));
  }
  return pos;
}

// ─── Kelvin's Thunderstorm Mode ────────────────────────────────────────────────
// Water droplets fall from upper drip cans into lower collectors.
// Odd-indexed particles come from the right side; even from the left.
// Near the end of each drop's cycle, it briefly "sparks" toward centre.
fn posKelvin(phase: f32, t: f32, idx: u32) -> vec3f {
  let cycleT = fract(t * 0.32 + phase);
  let side   = select(-1.0, 1.0, (idx & 1u) == 1u);
  let wobble = sin(t * 4.0 + phase * 20.0) * 0.09;

  var pos: vec3f;
  if (cycleT < 0.82) {
    // Falling phase: straight drop with slight lateral wobble
    let k  = cycleT / 0.82;
    pos = vec3f(side * 2.5 + wobble,
                5.5 - k * 8.8,
                wobble * 0.4);
  } else {
    // Spark / discharge: particle jumps toward centre between collectors
    let k  = (cycleT - 0.82) / 0.18;
    pos = vec3f(side * 2.5 * (1.0 - k * 1.9),
                -3.2 + k * 1.4,
                0.0);
  }
  return pos;
}

// ─── Solar / LED Mode ──────────────────────────────────────────────────────────
// Photons travel in straight lines from each LED down to the solar panel surface.
fn posSolar(phase: f32, t: f32, idx: u32, speedMult: f32) -> vec3f {
  let ledIdx  = idx % 6u;
  let ledX    = (f32(ledIdx) - 2.5) * 1.6;
  let ledPos  = vec3f(ledX, 3.5, 1.5);

  // Each photon aims at a slightly randomised point on the panel
  let panelX  = (fract(f32(idx) * 0.61803) - 0.5) * 9.0;
  let panelZ  = (fract(f32(idx) * 0.38490) - 0.5) * 9.0;
  let panelPos = vec3f(panelX, 0.05, panelZ);

  let speed  = 1.0 + speedMult * 1.5;
  let life   = fract(t * speed * 0.18 + phase);
  return mix(ledPos, panelPos, min(life * 1.05, 1.0));
}

// ─── Main entry point ──────────────────────────────────────────────────────────
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let idx   = id.x;
  let count = u32(uniforms.particleCount);
  if (idx >= count) { return; }

  let p     = particles[idx];
  let phase = p.w;
  let t     = uniforms.time;
  let mode  = uniforms.mode;

  var newPos: vec3f;
  if (mode < 0.5) {
    newPos = posSEG(phase, t, idx);
  } else if (mode < 1.5) {
    newPos = posHeron(phase, t, idx);
  } else if (mode < 2.5) {
    newPos = posKelvin(phase, t, idx);
  } else {
    newPos = posSolar(phase, t, idx, uniforms.speedMult);
  }

  particles[idx] = vec4f(newPos, phase);
}
