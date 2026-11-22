// MLS-MPM liquid — export for drawing (ADR-0022).
//
// Writes one 16-byte `GpuParticle` per slot, the record the particle
// pipeline already draws: position in the bench's scene units
// (exportOrigin + metres · exportScale) and a phase word. The integer part
// of phase is the effect type — 9, "solver liquid": drawn round and facing
// the camera, with no closed-form velocity behind it. The fraction is the
// particle's speed over maxSpeed. An empty slot is parked far below the
// scene, where its quad is clipped.

#include "common/mpm.wgsl"
#include "common/particle.wgsl"

@group(0) @binding(0) var<uniform> params: MpmParams;
@group(0) @binding(1) var<storage, read_write> particles: array<MpmParticle>;
@group(0) @binding(2) var<uniform> io: MpmIoParams;
@group(0) @binding(6) var<storage, read_write> drawn: array<GpuParticle>;

const MPM_EFFECT_LIQUID = 9.0;

@compute @workgroup_size(64)
fn exportParticles(@builtin(global_invocation_id) gid: vec3u) {
  let index = gid.x;
  if (index >= io.capacity) { return; }
  let p = particles[index];
  var out: GpuParticle;
  if (p.state == 0.0) {
    out.pos = vec3f(0.0, -1.0e6, 0.0);
    out.phase = MPM_EFFECT_LIQUID;
  } else {
    out.pos = io.exportOrigin + p.pos * io.exportScale;
    out.phase = MPM_EFFECT_LIQUID + clamp(length(p.vel) / params.maxSpeed, 0.0, 0.999);
  }
  drawn[index] = out;
}
