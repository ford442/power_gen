// MLS-MPM liquid, pass 3 of 3 — grid to particle (ADR-0022).
//
// Each live particle gathers its 27 nodes: velocity, and the affine matrix
// C = (4/h)·Σ w·v⊗δ (APIC). Its volume ratio follows the divergence it sees,
// dJ/dt = J·tr(C), integrated as J·exp(dt·tr C). Then it moves, and is kept
// inside the wall planes (node 1 and node n−2), where its stencil stays on
// the grid. The dither counter steps once.
//
// The velocity grid is bound read-write because the layout is shared with
// mpm-grid.wgsl; this pass only reads it.
//
// CPU twin: MpmCpu.g2p (src/fluids/mpm-cpu.ts).

#include "common/mpm.wgsl"

@group(0) @binding(0) var<uniform> params: MpmParams;
@group(0) @binding(1) var<storage, read_write> particles: array<MpmParticle>;
@group(0) @binding(3) var<storage, read_write> gridVel: array<vec4f>;

@compute @workgroup_size(64)
fn g2p(@builtin(global_invocation_id) gid: vec3u) {
  let index = gid.x;
  if (index >= params.particleCount) { return; }
  var p = particles[index];
  if (p.state == 0.0) { return; }

  let h = params.cellM;
  let s = mpmStencil(p.pos, h, params.gridN);
  var v = vec3f(0.0);
  var b0 = vec3f(0.0);
  var b1 = vec3f(0.0);
  var b2 = vec3f(0.0);
  for (var k = 0; k < 3; k++) {
    for (var jj = 0; jj < 3; jj++) {
      for (var i = 0; i < 3; i++) {
        let w = s.w[i].x * s.w[jj].y * s.w[k].z;
        let d = vec3f(f32(i), f32(jj), f32(k)) - s.f;
        let gv = gridVel[mpmNodeIndex(s.base + vec3i(i, jj, k), params.gridN)].xyz * w;
        v += gv;
        b0 += gv * d.x;
        b1 += gv * d.y;
        b2 += gv * d.z;
      }
    }
  }
  let k4 = 4.0 / h;
  p.c0 = b0 * k4;
  p.c1 = b1 * k4;
  p.c2 = b2 * k4;
  let divergence = (b0.x + b1.y + b2.z) * k4;
  p.j = clamp(p.j * exp(params.dt * divergence), params.minJ, params.maxJ);
  p.seed = mpmSeedNext(p.seed);
  p.vel = v;
  p.pos = clamp(p.pos + v * params.dt, vec3f(h), vec3f(params.gridN - vec3u(2u)) * h);
  particles[index] = p;
}
