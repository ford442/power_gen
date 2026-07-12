// Energy pipe particle advection along a cubic Bézier (overview mode).
#include "common/pipe-particle.wgsl"
#include "common/energy-pipe-bezier.wgsl"

@binding(0) @group(0) var<storage, read_write> particles: array<PipeParticle>;
@binding(1) @group(0) var<uniform> curve: PipeCurve;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  let n = u32(curve.particleCount);
  if (i >= n || n == 0u) {
    return;
  }

  let p0 = curve.p0;
  let p1 = curve.p1;
  let p2 = curve.p2;
  let p3 = curve.p3;
  let flow = curve.flow;
  let time = curve.time;
  let speed = curve.speed;

  let phase = f32(i) / f32(n);
  let t = fract(time * speed * 0.12 * (0.4 + flow) + phase);
  let pos = bezier3(p0, p1, p2, p3, t);
  let tan = bezierTangent(p0, p1, p2, p3, t);
  let tanLen = max(length(tan), 1e-5);
  let vel = tan / tanLen * speed;

  let lifeWave = 0.45 + 0.55 * sin(time * 3.5 + phase * 12.566);
  let strength = flow * (0.35 + 0.65 * (1.0 - abs(t - 0.5) * 1.4));

  var p: PipeParticle;
  p.posX = pos.x;
  p.posY = pos.y;
  p.posZ = pos.z;
  p.velX = vel.x;
  p.velY = vel.y;
  p.velZ = vel.z;
  p.life = lifeWave;
  p.strength = strength;
  particles[i] = p;
}
