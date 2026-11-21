// =============================================================
// Charged particles in the field volume (ADR-0017, #255 §3): Boris pusher in
// SI units, B trilinear from the volume, E = 0 or the bench's uniform field
// (catalog `efield`). Non-relativistic. Each frame runs `substeps` pushes of
// `dt` seconds of simulated time; the host picks dt so a gyration at the
// bench's reference |B| takes ~24 substeps, i.e. time is slowed by many
// orders of magnitude and the UI says by how much.
//
// Particles respawn (hash RNG) inside the spawn sphere when they leave the
// AABB or outlive `lifetime` frames. Each keeps a TRAIL-long ring of segments
// drawn by field-line-vert.wgsl in trail mode.
//
// Bindings: docs/BINDINGS.md → `fieldCharges` (not `fieldParticles`, the SEG field-line particles).
// =============================================================
#include "common/field-line-segment.wgsl"
#include "common/field-volume-sample.wgsl"

struct Particle {
  pos: vec4f, // xyz scene units, w = age (frames)
  vel: vec4f, // xyz m/s, w = 1 alive / 0 needs spawn
}

struct ParticleParams {
  boundsMin: vec4f, // w = metres per scene unit
  boundsMax: vec4f, // w = q/m (C/kg)
  efield: vec4f,    // V/m; w = dt per push (s)
  spawn: vec4f,     // xyz centre (scene units), w = radius (scene units)
  motion: vec4f,    // x = launch speed (m/s), y = lifetime (frames), z = pushes per frame, w = frame counter
  shape: vec4f,     // x = particle count, y = trail length, z = volume units per tesla, w = unused
}

@group(0) @binding(0) var<uniform> params: ParticleParams;
@group(0) @binding(1) var volume: texture_3d<f32>;
@group(0) @binding(2) var volumeSampler: sampler;
@group(0) @binding(3) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(4) var<storage, read_write> trails: array<FieldLineSegment>;

fn pcgHash(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}

fn rand01(seed: ptr<function, u32>) -> f32 {
  *seed = pcgHash(*seed);
  return f32(*seed) / 4294967295.0;
}

fn randUnit(seed: ptr<function, u32>) -> vec3f {
  let z = rand01(seed) * 2.0 - 1.0;
  let a = rand01(seed) * 6.2831853;
  let r = sqrt(max(0.0, 1.0 - z * z));
  return vec3f(r * cos(a), r * sin(a), z);
}

fn bTesla(p: vec3f) -> vec3f {
  let uvw = fieldVolumeUvw(p, params.boundsMin.xyz, params.boundsMax.xyz);
  return textureSampleLevel(volume, volumeSampler, uvw, 0.0).xyz / params.shape.z;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= u32(params.shape.x)) {
    return;
  }
  let trail = u32(params.shape.y);
  let frame = u32(params.motion.w);
  let bmin = params.boundsMin.xyz;
  let bmax = params.boundsMax.xyz;
  let unitM = params.boundsMin.w;
  let qm = params.boundsMax.w;
  let dt = params.efield.w;
  var part = particles[i];
  var seed = pcgHash(i * 9781u + frame * 6271u + 1u);

  if (part.vel.w < 0.5 || part.pos.w > params.motion.y || !fieldInside(part.pos.xyz, bmin, bmax)) {
    let r = params.spawn.w * pow(rand01(&seed), 0.3333);
    part.pos = vec4f(params.spawn.xyz + randUnit(&seed) * r, rand01(&seed) * params.motion.y * 0.25);
    part.vel = vec4f(randUnit(&seed) * params.motion.x, 1.0);
    for (var k = 0u; k < trail; k++) {
      trails[i * trail + k].age = -1.0;
    }
  }

  let start = part.pos.xyz;
  var x = part.pos.xyz;
  var v = part.vel.xyz;
  let E = params.efield.xyz;
  let pushes = u32(params.motion.z);
  for (var s = 0u; s < pushes; s++) {
    // Boris: half electric kick, magnetic rotation, half electric kick.
    let vm = v + E * (qm * dt * 0.5);
    let t = bTesla(x) * (qm * dt * 0.5);
    let sv = 2.0 * t / (1.0 + dot(t, t));
    let vp = vm + cross(vm, t);
    let vplus = vm + cross(vp, sv);
    v = vplus + E * (qm * dt * 0.5);
    x = x + v * (dt / unitM);
  }
  part.pos = vec4f(x, part.pos.w + 1.0);
  part.vel = vec4f(v, 1.0);
  particles[i] = part;

  // Trail ring: the newest slot gets this frame's step, the rest age by one.
  let slot = frame % max(trail, 1u);
  let speedFrac = clamp(length(v) / max(params.motion.x, 1e-6), 0.0, 1.5) / 1.5;
  for (var k = 0u; k < trail; k++) {
    let idx = i * trail + k;
    if (k == slot) {
      trails[idx] = FieldLineSegment(start.x, start.y, start.z, x.x, x.y, x.z, speedFrac, 0.0);
    } else if (trails[idx].age >= 0.0) {
      let age = f32((frame + trail - k) % trail) / f32(trail);
      trails[idx].age = age;
    }
  }
}
