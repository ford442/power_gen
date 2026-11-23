// MLS-MPM liquid, pass 3 of 3 — grid to particle (ADR-0022).
//
// Each live particle gathers its 27 nodes: velocity, and the affine matrix
// C = (4/h)·Σ w·v⊗δ (APIC). Its volume ratio follows the divergence it sees,
// dJ/dt = J·tr(C), integrated as J·exp(dt·tr C). Then it moves, and is kept
// inside the wall planes (node 1 and node n−2), where its stencil stays on
// the grid. With MPM_FLAG_BOUNDARY set, a particle that ends the step inside
// a solid of the signed-distance field (binding 4, read trilinearly) is put
// back on its surface. The dither counter steps once.
//
// A charged particle (charge ≠ 0) also feels the field of the conductors in
// `params` — rings of charge at the potentials the bench's plant gives them:
// q·E/m is added to its velocity before it moves. Neutral liquid skips it.
//
// The velocity grid is bound read-write because the layout is shared with
// mpm-grid.wgsl; this pass only reads it.
//
// CPU twin: MpmCpu.g2p (src/fluids/mpm-cpu.ts).

#include "common/mpm.wgsl"

@group(0) @binding(0) var<uniform> params: MpmParams;
@group(0) @binding(1) var<storage, read_write> particles: array<MpmParticle>;
@group(0) @binding(3) var<storage, read_write> gridVel: array<vec4f>;
@group(0) @binding(4) var<storage, read> boundary: array<vec4f>;

// Normal (not normalised) and signed distance at a point, trilinear over the
// eight nodes around it — `sampleMpmBoundary`.
fn boundaryAt(pos: vec3f) -> vec4f {
  let g = pos / params.cellM;
  let i0 = clamp(vec3i(floor(g)), vec3i(0), vec3i(params.gridN) - 2);
  let t = g - vec3f(i0);
  var out = vec4f(0.0);
  for (var c = 0; c < 8; c++) {
    let o = vec3i(c & 1, (c >> 1) & 1, (c >> 2) & 1);
    let w3 = select(1.0 - t, t, o == vec3i(1));
    out += boundary[mpmNodeIndex(i0 + o, params.gridN)] * (w3.x * w3.y * w3.z);
  }
  return out;
}

// Field (V/m) of the conductors at a point — `mpmFieldAt`. A ring is summed
// as MPM_RING_POINTS point charges, softened by the wire's radius.
fn fieldAt(pos: vec3f) -> vec3f {
  var e = vec3f(0.0);
  for (var c = 0u; c < min(params.conductorCount, u32(MPM_MAX_CONDUCTORS)); c++) {
    let k = params.conductors[c];
    let soft2 = k.soft * k.soft;
    if (k.radius <= 0.0) {
      let r = pos - k.centre;
      let d2 = dot(r, r) + soft2;
      e += r * (k.kq / (d2 * sqrt(d2)));
      continue;
    }
    let share = k.kq / f32(MPM_RING_POINTS);
    for (var i = 0; i < MPM_RING_POINTS; i++) {
      let a = 6.283185307179586 * f32(i) / f32(MPM_RING_POINTS);
      let r = pos - (k.centre + vec3f(cos(a), 0.0, sin(a)) * k.radius);
      let d2 = dot(r, r) + soft2;
      e += r * (share / (d2 * sqrt(d2)));
    }
  }
  return e;
}

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
  if (p.charge != 0.0 && params.conductorCount > 0u) {
    v += fieldAt(p.pos) * (p.charge / params.particleMass * params.dt);
    v = clamp(v, vec3f(-params.maxSpeed), vec3f(params.maxSpeed));
  }
  p.vel = v;
  var pos = p.pos + v * params.dt;
  if ((params.flags & MPM_FLAG_BOUNDARY) != 0u) {
    let b = boundaryAt(pos);
    let len = length(b.xyz);
    if (b.w < 0.0 && len > 1e-6) {
      pos -= b.xyz * (b.w / len);
    }
  }
  p.pos = clamp(pos, vec3f(h), vec3f(params.gridN - vec3u(2u)) * h);
  particles[index] = p;
}
