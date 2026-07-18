// =============================================================
// Particle compute — multi-device mode paths (SEG / Heron / …)
// Canonical .wgsl form; also loaded by generators/compute-shaders.js.
// =============================================================

#include "common/particle.wgsl"
#include "common/compute-uniforms.wgsl"

@binding(0) @group(0) var<storage, read_write> particles: array<GpuParticle>;
@binding(1) @group(0) var<uniform> uniforms: ComputeUniforms;

const PI: f32 = 3.14159265359;

fn posSEG(phase: f32, t: f32, idx: u32) -> vec3f {
  let cycleT  = fract(t * 0.12 + phase);
  let radius  = 8.5 - cycleT * 8.0;
  let angle   = phase * 6.28318 + cycleT * 18.84956;
  let height  = sin(cycleT * 6.28318 * 2.0 + phase * 6.28318) * 2.8;

  // Harmonic turbulence: high-frequency jitter gives electrified, organic motion
  let jitter1    = sin(t * 7.3  + phase * 31.4) * 0.12;
  let jitter2    = cos(t * 11.7 + phase * 17.8) * 0.08;
  let jitter3    = sin(t * 5.1  + phase * 43.2) * 0.06;
  let turbAngle  = angle  + jitter2;
  let turbRadius = radius + sin(t * 3.7 + phase * 23.5) * (radius * 0.04);
  let turbHeight = height + jitter1 + jitter3;

  return vec3f(cos(turbAngle) * turbRadius, turbHeight, sin(turbAngle) * turbRadius);
}

fn posHeron(phase: f32, t: f32, idx: u32) -> vec3f {
  let headN = uniforms.physics0;
  let vExit = uniforms.physics1;
  let cycleT  = fract(t * (0.18 + vExit * 0.08) + phase);
  let spread  = phase * 6.28318;
  let spreadR = fract(f32(idx) * 0.618034) * 0.55;
  let apexY = 5.2 + headN * 2.2;
  var pos: vec3f;
  if (cycleT < 0.35) {
    let k = cycleT / 0.35;
    pos = vec3f(sin(spread) * spreadR * k * 1.4,
                apexY - 0.8 + k * 0.4 - k * k * 0.3,
                cos(spread) * spreadR * k * 1.4);
  } else if (cycleT < 0.72) {
    let k = (cycleT - 0.35) / 0.37;
    pos = vec3f(sin(spread) * spreadR * (1.4 - k * 0.9),
                apexY - k * (2.8 + headN * 1.2),
                cos(spread) * spreadR * (1.4 - k * 0.9));
  } else {
    let k = (cycleT - 0.72) / 0.28;
    let bunch = sin(spread * 3.0 + t * 4.0) * 0.15 * headN;
    pos = vec3f(sin(spread) * spreadR * (0.5 - k * 0.5) + bunch,
                4.5 - k * 6.5,
                cos(spread) * spreadR * (0.5 - k * 0.5) + bunch);
  }
  return pos;
}

fn posKelvin(phase: f32, t: f32, idx: u32) -> vec3f {
  let voltN = uniforms.physics0;
  let spark = uniforms.physics1;
  let qE = uniforms.physics2;
  let cycleT = fract(t * (0.28 + voltN * 0.12) + phase);
  let side   = select(-1.0, 1.0, (idx & 1u) == 1u);
  let wobble = sin(t * 4.0 + phase * 20.0) * (0.06 + voltN * 0.12);
  let levitate = select(0.0, sin(t * 9.0 + phase * 24.0) * voltN * 0.45, voltN > 0.72);
  var pos: vec3f;
  if (cycleT < 0.82) {
    let k = cycleT / 0.82;
    pos = vec3f(side * 2.5 + wobble, 5.5 - k * 8.8 + levitate + qE * 0.02, wobble * 0.4);
  } else {
    let k = (cycleT - 0.82) / 0.18;
    let scatter = spark * sin(phase * 62.83 + t * 22.0) * 0.9;
    pos = vec3f(side * 2.5 * (1.0 - k * 1.9) + scatter, -3.2 + k * 1.4, scatter * 0.5);
  }
  return pos;
}

fn ledHexPos(ledIdx: u32) -> vec3f {
  let angle = (f32(ledIdx) / 6.0) * 6.28318;
  let r = 3.0;
  return vec3f(cos(angle) * r, 3.5, sin(angle) * r);
}

fn posSolar(phase: f32, t: f32, idx: u32, speedMult: f32) -> vec3f {
  let ledIdx = idx % 6u;
  let ledPos = ledHexPos(ledIdx);
  let panelX = (fract(f32(idx) * 0.61803) - 0.5) * 9.0;
  let panelZ = (fract(f32(idx) * 0.38490) - 0.5) * 9.0;
  let panelPos = vec3f(panelX, 0.05, panelZ);
  let charge = uniforms.physics0;
  let speed = 1.0 + speedMult * 1.5 + charge * 0.8;
  let life  = fract(t * speed * 0.18 + phase);
  var pos = mix(ledPos, panelPos, min(life * 1.05, 1.0));
  if (life > 0.92) {
    let refract = sin(phase * 40.0 + t * 6.0) * 0.15;
    pos = vec3f(pos.x + refract, pos.y, pos.z + refract * 0.5);
  }
  return pos;
}

fn posPeltier(phase: f32, t: f32, idx: u32) -> vec3f {
  let isSetupA = (idx % 2u) == 0u;
  let xOffset = select(3.5, -3.5, isSetupA);
  let cycleT = fract(t * 0.4 + phase);
  var pos: vec3f;
  if (phase < 0.4) {
    let isBottom = isSetupA;
    let yStart = select(4.0, -4.0, isBottom);
    let currentY = mix(yStart, 0.0, cycleT);
    let px = xOffset + sin(phase * 123.45) * 1.5;
    let pz = cos(f32(idx) * 0.123) * 1.5;
    pos = vec3f(px, currentY, pz);
  } else if (phase < 0.8) {
    let isTop = isSetupA;
    let yStart = select(-4.0, 4.0, isTop);
    let currentY = mix(yStart, 0.0, cycleT);
    let px = xOffset + sin(phase * 123.45) * 1.5;
    let pz = cos(f32(idx) * 0.123) * 1.5;
    pos = vec3f(px, currentY, pz);
  } else {
    let angle = phase * 62.83 + f32(idx) * 0.1;
    let radius = 1.0 + cycleT * 3.0;
    let px = xOffset + cos(angle) * radius;
    let pz = sin(angle) * radius;
    let py = sin(t * 5.0 + phase * 20.0) * 0.15;
    pos = vec3f(px, py, pz);
  }
  return pos;
}

fn posMagLev(phase: f32, t: f32, idx: u32) -> vec3f {
  let gap = uniforms.physics0;
  let field = uniforms.physics1;
  let angle = phase * 6.28318 + t * (0.7 + field * 0.5) + f32(idx) * 0.017;
  let r = 0.9 + fract(f32(idx) * 0.131) * 2.0;
  let y = 0.55 + gap + sin(t * 3.2 + phase * 11.0) * 0.07 * (0.4 + field);
  return vec3f(cos(angle) * r, y, sin(angle) * r);
}

fn posHomopolar(phase: f32, t: f32, idx: u32) -> vec3f {
  let rpmN = uniforms.physics0;
  let emfN = uniforms.physics1;
  let discAngle = uniforms.physics2;
  let rFrac = fract(f32(idx) * 0.618034 + phase * 0.37);
  let drift = fract(phase + t * (0.12 + emfN * 0.35));
  let r = mix(0.18, 1.15, drift * (0.35 + rFrac * 0.65));
  let theta = discAngle + phase * 6.28318 + t * (0.4 + rpmN * 3.5) + f32(idx) * 0.011;
  let y = 0.16 + sin(t * 4.0 + phase * 18.0) * 0.04 * (0.3 + emfN);
  return vec3f(cos(theta) * r, y, sin(theta) * r);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let idx = id.x;
  if (idx >= u32(uniforms.particleCount)) { return; }

  let p = particles[idx];
  let phase = p.phase;
  let t = uniforms.time;
  let mode = uniforms.mode;

  var newPos: vec3f;
  if (mode < 0.5) {
    newPos = posSEG(phase, t, idx);
  } else if (mode < 1.5) {
    newPos = posHeron(phase, t, idx);
  } else if (mode < 2.5) {
    newPos = posKelvin(phase, t, idx);
  } else if (mode < 3.5) {
    newPos = posSolar(phase, t, idx, uniforms.speedMult);
  } else if (mode < 4.5) {
    newPos = posPeltier(phase, t, idx);
  } else if (mode < 5.5) {
    newPos = posPeltier(phase, t, idx);
  } else if (mode < 7.0) {
    newPos = posMagLev(phase, t, idx);
  } else if (mode < 8.5) {
    newPos = posHomopolar(phase, t, idx);
  } else {
    newPos = posMagLev(phase, t, idx);
  }

  var outP: GpuParticle;
  outP.pos = newPos;
  outP.phase = phase;
  particles[idx] = outP;
}
