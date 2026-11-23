// MLS-MPM liquid — emitters and sinks, once per frame before the substeps
// (ADR-0022).
//
// Every slot of the particle budget is visited. A live particle inside a
// sink box becomes an empty slot. An empty slot takes a ticket from an
// atomic counter (cleared by the host each frame); tickets below the frame's
// emission count become new particles. Which slot gets which ticket depends
// on the order the GPU runs them in — but the particle a ticket makes is a
// function of the ticket alone (its place in the nozzle, its velocity, its
// dither counter), and nothing downstream depends on slot order, so the
// liquid is the same on every run.
//
// A new particle sits in the cylinder the jet sweeps this frame — disc
// radius × speed·seconds — at rest density, so successive frames stack into
// a continuous stream.
//
// CPU twin: MpmCpu.emit (src/fluids/mpm-cpu.ts), `mpmEmitParticle`.

#include "common/mpm.wgsl"

@group(0) @binding(0) var<uniform> params: MpmParams;
@group(0) @binding(1) var<storage, read_write> particles: array<MpmParticle>;
@group(0) @binding(2) var<uniform> io: MpmIoParams;
@group(0) @binding(3) var<storage, read_write> counters: array<atomic<u32>>;

fn spawn(e: MpmEmitter, ticket: u32, charge: f32) -> MpmParticle {
  let id = e.baseId + ticket;
  // Any unit vector not parallel to dir, then an orthonormal pair across the disc.
  let a = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), abs(e.dir.y) < 0.9);
  let t = normalize(cross(a, e.dir));
  let b = cross(e.dir, t);
  let rho = sqrt(mpmHash01(id * 3u + 1u));
  let theta = 6.283185307179586 * mpmHash01(id * 3u + 2u);
  let along = (f32(ticket) + mpmHash01(id * 3u)) / f32(max(e.count, 1u)) * e.length;
  let radial = t * (cos(theta) * rho) + b * (sin(theta) * rho);
  var p: MpmParticle;
  p.pos = e.centre + e.dir * along + radial * e.radius;
  p.j = 1.0;
  p.vel = normalize(e.dir + radial * e.spread) * e.speed;
  p.state = 1.0;
  p.c0 = vec3f(0.0);
  p.pressure = 0.0;
  p.c1 = vec3f(0.0);
  p.seed = mpmHash32(id);
  p.c2 = vec3f(0.0);
  p.charge = charge;
  return p;
}

@compute @workgroup_size(64)
fn emit(@builtin(global_invocation_id) gid: vec3u) {
  let index = gid.x;
  if (index >= io.capacity) { return; }
  let p = particles[index];
  if (p.state != 0.0) {
    for (var s = 0; s < MPM_MAX_SINKS; s++) {
      let k = io.sinks[s];
      if (k.on != 0.0 && all(p.pos >= k.lo) && all(p.pos <= k.hi)) {
        particles[index].state = 0.0;
        atomicAdd(&counters[MPM_COUNTER_SUNK], 1u);
        // The first sink that holds it takes it: a bench can tell what went where.
        atomicAdd(&counters[MPM_COUNTER_SINK0 + u32(s)], 1u);
        return;
      }
    }
    return;
  }
  let total = io.emitters[0].count + io.emitters[1].count;
  if (total == 0u) { return; }
  let ticket = atomicAdd(&counters[MPM_COUNTER_TICKETS], 1u);
  if (ticket >= total) { return; }
  if (ticket < io.emitters[0].count) {
    particles[index] = spawn(io.emitters[0], ticket, io.emitterCharge.x);
  } else {
    particles[index] = spawn(io.emitters[1], ticket - io.emitters[0].count, io.emitterCharge.y);
  }
  atomicAdd(&counters[MPM_COUNTER_EMITTED], 1u);
}
