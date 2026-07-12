// Field-line particle advection (SEG).
// Avoid `array<f32,N>(...)[i]` — naga rejects dynamic index of value arrays.
#include "common/field-particle.wgsl"

@group(0) @binding(0) var<storage, read_write> particles: array<FieldParticle>;
@group(0) @binding(1) var<uniform>             uniforms: FieldUniforms;

const PI: f32 = 3.14159265359;

fn ringRadius(ringIdx: u32) -> f32 {
  if (ringIdx == 0u) { return 2.5; }
  if (ringIdx == 1u) { return 4.0; }
  return 5.5;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= uniforms.particleCount) { return; }

  let t = uniforms.time;
  let sm = uniforms.speedMult;
  let ringIdx = i % 3u;
  let r = ringRadius(ringIdx);

  let angle = (f32(i) / f32(uniforms.particleCount)) * PI * 20.0
            + t * (0.5 + f32(ringIdx) * 0.3);
  let heightOffset = sin(t * 0.5 + f32(i) * 0.1) * 0.8;

  let px = cos(angle) * r;
  let pz = sin(angle) * r;
  let py = heightOffset;

  let speed = 1.0 + f32(ringIdx) * 0.5;
  let vx = -sin(angle) * speed;
  let vy = cos(t * 2.0 + f32(i) * 0.05) * 0.1;
  let vz = cos(angle) * speed;

  let lifePulse = sin(t * 2.0 + f32(i) * 0.5) * 0.5 + 0.5;
  let life = clamp(lifePulse * min(sm * 0.4 + 0.6, 1.0), 0.0, 1.0);
  let strength = clamp(0.3 + 0.7 * sin(angle * 3.0 + t), 0.0, 1.0)
               * min(1.0, 0.5 + sm * 0.15);

  var p: FieldParticle;
  p.posX = px;
  p.posY = py;
  p.posZ = pz;
  p.velX = vx;
  p.velY = vy;
  p.velZ = vz;
  p.life = life;
  p.strength = strength;

  particles[i] = p;
}
