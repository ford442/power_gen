// Stateful kinematic particle integrator.
//
// Each particle is a persistent body carried across frames:
//   pos.xyz  – world position
//   phase    – per-particle random seed (0–1), kept for spawn/colour variety
//   vel.xyz  – velocity (the stateful quantity; parametric modes had none)
//   aux      – per-mode scalar (Kelvin: signed charge, Solar: reflected flag)
//
// Integration is semi-implicit (symplectic) Euler: v += a·dt ; p += v·dt.
// It is stable for the restoring/drag forces used here and, unlike position
// Verlet, keeps velocity available for the velocity-dependent drag terms
// (Stokes, eddy, aerodynamic) that the four devices rely on.
//
// IMPORTANT: the Uniforms struct mirrors the JS uniform buffer layout exactly
// and is shared (as a prefix) with roller.wgsl and particles.wgsl.

struct Particle {
  pos:   vec3f,
  phase: f32,
  vel:   vec3f,
  aux:   f32,
}

@binding(0) @group(0) var<storage, read_write> particles: array<Particle>;

struct Uniforms {
  viewProj:       mat4x4f,  // 0   – ignored by compute
  time:           f32,      // 64  – ω-scaled roller clock
  mode:           f32,      // 68  (0=SEG 1=Heron 2=Kelvin 3=Solar)
  particleCount:  f32,      // 72
  battery:        f32,      // 76
  dt:             f32,      // 80  – clamped physics step (s)
  segOmega:       f32,      // 84  – normalised SEG angular velocity
  fieldStrength:  f32,      // 88
  heronVExit:     f32,      // 92  – nozzle exit speed (scene units/s)
  heronHead:      f32,      // 96  – normalised reservoir head 0–1
  kelvinE:        f32,      // 100 – upward qE accel coefficient
  kelvinVoltageN: f32,      // 104 – normalised bucket voltage 0–1
  kelvinSpark:    f32,      // 108 – 1 during discharge
  solarN2:        f32,      // 112 – substrata refractive index
  corona:         f32,      // 116 – SEG plasma intensity 0–1
  simClock:       f32,      // 120 – steady wall clock (s) for hashing
  spare:          f32,      // 124
}
@binding(1) @group(0) var<uniform> u: Uniforms;

const PI:   f32 = 3.14159265359;
const TAU:  f32 = 6.28318530718;
const GRAV: f32 = 9.81;

// ─── Hashing ────────────────────────────────────────────────────────────────
fn hash1(n: f32) -> f32 {
  return fract(sin(n * 78.233 + 12.9898) * 43758.5453);
}
fn rnd(idx: u32, salt: f32) -> f32 {
  return hash1(f32(idx) * 0.1031 + salt * 1.7 + u.simClock * 0.37);
}

// ─── Fresnel (unpolarised) reflectance for an air→substrata interface ─────────
// Snell's law sets the transmission angle; the s- and p-polarised reflection
// coefficients are averaged. n1 = 1 (air), n2 = u.solarN2.
fn fresnelReflectance(cosI: f32, n2: f32) -> f32 {
  let n1 = 1.0;
  let ci = clamp(cosI, 0.0, 1.0);
  let sinI = sqrt(max(0.0, 1.0 - ci * ci));
  let sinT = (n1 / n2) * sinI;          // n1 sinI = n2 sinT
  if (sinT >= 1.0) { return 1.0; }       // (cannot occur for n1<n2, kept for safety)
  let ct = sqrt(max(0.0, 1.0 - sinT * sinT));
  let rs = (n1 * ci - n2 * ct) / (n1 * ci + n2 * ct);
  let rp = (n1 * ct - n2 * ci) / (n1 * ct + n2 * ci);
  return clamp(0.5 * (rs * rs + rp * rp), 0.0, 1.0);
}

// ─── SEG: ring radius for a particle ──────────────────────────────────────────
fn segRingRadius(idx: u32) -> f32 {
  let z = idx % 3u;
  if (z == 0u)      { return 3.5; }
  else if (z == 1u) { return 5.5; }
  else              { return 7.5; }
}

// ─── Spawn helpers (set pos + vel + aux for a recycled particle) ──────────────
fn spawnSEG(idx: u32) -> Particle {
  let R = segRingRadius(idx);
  let a = rnd(idx, 1.0) * TAU;
  let y = (rnd(idx, 2.0) - 0.5) * 1.6;
  var p: Particle;
  p.pos = vec3f(cos(a) * R, y, sin(a) * R);
  p.phase = rnd(idx, 3.0);
  // tangential seed velocity (CCW)
  let vT = u.segOmega * R * 1.2;
  p.vel = vec3f(-sin(a) * vT, 0.0, cos(a) * vT);
  p.aux = 0.0;
  return p;
}

fn spawnHeron(idx: u32) -> Particle {
  let ang = rnd(idx, 1.0) * TAU;
  let rad = rnd(idx, 2.0) * 0.18;
  var p: Particle;
  // nozzle mouth at (0, 5.6, 0)
  p.pos = vec3f(cos(ang) * rad, 5.6, sin(ang) * rad);
  p.phase = rnd(idx, 3.0);
  let spread = 0.9;
  p.vel = vec3f(cos(ang) * rad * spread,
                u.heronVExit,
                sin(ang) * rad * spread);
  p.aux = 0.0;
  return p;
}

fn spawnKelvin(idx: u32) -> Particle {
  let side = select(-1.0, 1.0, (idx & 1u) == 1u);
  var p: Particle;
  let jitterX = (rnd(idx, 1.0) - 0.5) * 0.18;
  let jitterZ = (rnd(idx, 2.0) - 0.5) * 0.18;
  p.pos = vec3f(side * 2.5 + jitterX, 5.0 + rnd(idx, 4.0) * 0.4, jitterZ);
  p.phase = rnd(idx, 3.0);
  p.vel = vec3f(0.0, -0.25, 0.0);
  // Charge captured at pinch-off grows with the induction-ring voltage
  // (positive feedback). Sign alternates between the two cross-wired streams.
  p.aux = side * (0.25 + 0.75 * u.kelvinVoltageN);
  return p;
}

// ─── MHD Generator Mode (Molten Bismuth) ───────────────────────────────────────
// Fluid flows along the Z axis. A transverse magnetic field (Y axis) generates
// the Lorentz force F = q(v × B), separating positive ions (+X) from electrons (-X).
fn posMHD(phase: f32, t: f32, idx: u32) -> vec3f {
  let speed = 0.7;
  let cycleT = fract(t * speed + fract(phase * 123.45));

  // Molten bismuth flows down a pipe from z = 8.0 to z = -8.0
  let zPos = mix(8.0, -8.0, cycleT);

  // phase < 0.5 → positive ion, >= 0.5 → electron
  let isPositive = phase < 0.5;
  let chargeMultiplier = select(-1.0, 1.0, isPositive);

  // Base spread inside the circular pipe cross-section
  let px = sin(f32(idx) * 123.45) * 0.8;
  let py = cos(f32(idx) * 0.123) * 0.8;

  // Lorentz deflection begins at the magnetic field region (z < 2.0)
  var xDeflection = 0.0;
  if (zPos < 2.0) {
    let exposure = clamp((2.0 - zPos) / 4.0, 0.0, 1.0);
    xDeflection = chargeMultiplier * exposure * 4.0;
  }

  return vec3f(px + xDeflection, py, zPos);
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
fn spawnSolar(idx: u32) -> Particle {
  let ledIdx = idx % 6u;
  let ledX = (f32(ledIdx) - 2.5) * 1.6;
  let led = vec3f(ledX, 3.5, 1.5);
  let panel = vec3f((rnd(idx, 1.0) - 0.5) * 9.0, 0.05, (rnd(idx, 2.0) - 0.5) * 9.0);
  var p: Particle;
  p.pos = led;
  p.phase = rnd(idx, 3.0);
  p.vel = normalize(panel - led) * 6.0;
  p.aux = 0.0;   // 0 = travelling, 1 = reflected
  return p;
}

// ─── Main entry ───────────────────────────────────────────────────────────────
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let idx = id.x;
  if (idx >= u32(u.particleCount)) { return; }

  var p  = particles[idx];
  let dt = u.dt;
  let mode = u.mode;

  // ── SEG ──────────────────────────────────────────────────────────────────
  if (mode < 0.5) {
    let R = segRingRadius(idx);
    let rXZ = vec2f(p.pos.x, p.pos.z);
    let r = max(length(rXZ), 1e-4);
    let radial  = rXZ / r;
    let tangent = vec2f(-radial.y, radial.x);     // CCW unit tangent
    let vXZ = vec2f(p.vel.x, p.vel.z);
    let vTan = dot(vXZ, tangent);
    let vRad = dot(vXZ, radial);

    // Lorentz/Poynting macroscopic thrust drives tangential speed toward
    // ω·R; the gap closes with a time constant, so particles inherit the
    // device's momentum lag instead of snapping to the target.
    let vTarget = u.segOmega * R * 1.2;
    let aTan = (vTarget - vTan) * 3.0;
    let aRad = -(r - R) * 26.0 - vRad * 4.0;       // confine to the ring radius
    let aY   = -p.pos.y * 9.0 - p.vel.y * 3.0;     // confine near the equator
    let aXZ  = tangent * aTan + radial * aRad;
    let accel = vec3f(aXZ.x, aY, aXZ.y);

    // Harmonic turbulence: high-frequency jitter gives an electrified, organic feel
    let turb1 = sin(u.simClock * 7.3  + p.phase * 31.4) * 0.045;
    let turb2 = cos(u.simClock * 11.7 + p.phase * 17.8) * 0.032;
    let turb3 = sin(u.simClock * 5.1  + p.phase * 43.2) * 0.028;
    let turbAccel = vec3f(turb1 + turb2 * radial.x,
                          turb3,
                          turb1 * radial.y - turb2);

    p.vel = p.vel + (accel + turbAccel * u.corona) * dt;
    p.pos = p.pos + p.vel * dt;

    if (r < 1.0 || r > 11.0 || abs(p.pos.y) > 5.0) { p = spawnSEG(idx); }

  // ── Heron's Fountain ──────────────────────────────────────────────────────
  } else if (mode < 1.5) {
    let speed = length(p.vel);
    // gravity + aerodynamic drag (linear + quadratic)
    let accel = vec3f(0.0, -GRAV, 0.0) - p.vel * (0.18 + 0.05 * speed);
    p.vel = p.vel + accel * dt;
    p.pos = p.pos + p.vel * dt;

    // Recycle once the droplet has fallen back into the display basin.
    if (p.pos.y < 3.4 || abs(p.pos.x) > 6.0 || abs(p.pos.z) > 6.0) {
      p = spawnHeron(idx);
    }

  // ── Kelvin's Thunderstorm ─────────────────────────────────────────────────
  } else if (mode < 2.5) {
    newPos = posKelvin(phase, t, idx);
  } else if (mode < 4.5) {
    // Solar (3.0) and Peltier (4.0) both use photon-stream particles
    newPos = posSolar(phase, t, idx, uniforms.speedMult);
  } else {
    // Mode 5: MHD Generator – molten bismuth Lorentz deflection
    newPos = posMHD(phase, t, idx);
    let q = p.aux;
    let stokes = 2.0;                              // 6πηr / m, lumped
    // Net vertical: gravity − Stokes drag + Coulomb repulsion (qE, upward).
    let aE = u.kelvinE * abs(q);                   // upward when same-charge bucket below
    var accel = vec3f(-p.vel.x * stokes,
                      -GRAV + aE - p.vel.y * stokes,
                      -p.vel.z * stokes);
    // Near/above force balance the drops scatter sideways before levitating.
    if (aE > GRAV * 0.85) {
      let s = (aE - GRAV * 0.85);
      accel.x = accel.x + (rnd(idx, 5.0) - 0.5) * s * 2.2;
      accel.z = accel.z + (rnd(idx, 6.0) - 0.5) * s * 2.2;
    }
    p.vel = p.vel + accel * dt;
    p.pos = p.pos + p.vel * dt;

    // Reached a collector, drifted away, or the spark collapsed the field.
    if (p.pos.y < -2.4 || abs(p.pos.x) > 8.0 || p.pos.y > 9.0) {
      p = spawnKelvin(idx);
    }

  // ── Solar / LED photons ───────────────────────────────────────────────────
  } else {
    // Photons travel ballistically (straight) until they meet the panel.
    p.pos = p.pos + p.vel * dt;

    if (p.aux < 0.5 && p.pos.y <= 0.06 && p.vel.y < 0.0) {
      // Strike: Snell + Fresnel decide reflection vs absorption.
      let vh = normalize(p.vel);
      let cosI = clamp(-vh.y, 0.0, 1.0);
      let Rf = fresnelReflectance(cosI, u.solarN2);
      if (rnd(idx, 7.0) < Rf) {
        p.pos.y = 0.07;
        p.vel.y = -p.vel.y;                        // specular bounce (glare)
        p.aux = 1.0;
      } else {
        p = spawnSolar(idx);                       // absorbed → re-emit at LED
      }
    } else if (p.aux > 0.5 && p.pos.y > 3.6) {
      p = spawnSolar(idx);                          // reflected ray left the scene
    }
  }

  particles[idx] = p;
}
