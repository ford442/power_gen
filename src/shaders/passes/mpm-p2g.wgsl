// MLS-MPM liquid, pass 1 of 3 — particle to grid (ADR-0022).
//
// Each live particle scatters to its 27 nodes: mass, and one momentum
// transfer t that carries its velocity, the APIC affine term and the stress
// impulse of this substep together:
//
//   t = v/maxSpeed + A·δ        A = C·h/maxSpeed + stressK·σ
//   σ = −p·I + μ·(C + Cᵀ)       p = B·(J^−γ − 1), never negative
//   stressK = −4·dt·J / (ρ₀·h·maxSpeed)        δ = node − particle, in cells
//
// WGSL has no float atomics, so the grid is fixed-point i32. The 27
// contributions are rounded in sequence with the remainder carried to the
// next node; the momentum remainders start from a hash of the particle's
// counter. That keeps every contribution exact in expectation (no dead zone
// for slow particles) and a particle's total within one count. The scales
// are sized so the sums cannot wrap (`mpmFixedScales`). The host clears the
// grid before this pass.
//
// CPU twin: MpmCpu.p2g (src/fluids/mpm-cpu.ts) — same loop order, k outermost.

#include "common/mpm.wgsl"

@group(0) @binding(0) var<uniform> params: MpmParams;
@group(0) @binding(1) var<storage, read_write> particles: array<MpmParticle>;
@group(0) @binding(2) var<storage, read_write> gridFixed: array<atomic<i32>>;

@compute @workgroup_size(64)
fn p2g(@builtin(global_invocation_id) gid: vec3u) {
  let index = gid.x;
  if (index >= params.particleCount) { return; }
  let p = particles[index];
  if (p.state == 0.0) { return; }

  let h = params.cellM;
  let s = mpmStencil(p.pos, h, params.gridN);

  let j = clamp(p.j, params.minJ, params.maxJ);
  let pressure = max(0.0, params.eosStiffness * (pow(j, -params.eosGamma) - 1.0));
  particles[index].pressure = pressure;

  let c = mat3x3f(p.c0, p.c1, p.c2);
  var sigma = params.viscosity * (c + transpose(c));
  sigma[0][0] -= pressure;
  sigma[1][1] -= pressure;
  sigma[2][2] -= pressure;
  let stressK = -4.0 * params.dt * j / (params.restDensity * h * params.maxSpeed);
  let a = c * (h / params.maxSpeed) + sigma * stressK;
  let u = p.vel / params.maxSpeed;

  let bits = mpmSeedBits(p.seed);
  var rm = 0.0;
  var r = (vec3f(f32(bits & 1023u), f32((bits >> 10u) & 1023u), f32((bits >> 20u) & 1023u)) + 0.5) / 1024.0 - 0.5;
  let tMax = vec3f(params.tMax);

  for (var k = 0; k < 3; k++) {
    for (var jj = 0; jj < 3; jj++) {
      for (var i = 0; i < 3; i++) {
        let w = s.w[i].x * s.w[jj].y * s.w[k].z;
        let d = vec3f(f32(i), f32(jj), f32(k)) - s.f;
        let t = clamp(u + a * d, -tMax, tMax);

        let xm = w * params.massScale + rm;
        let qm = round(xm);
        rm = xm - qm;
        let x = w * t * params.momentumScale + r;
        let q = round(x);
        r = x - q;

        let n = mpmNodeIndex(s.base + vec3i(i, jj, k), params.gridN) * 4u;
        atomicAdd(&gridFixed[n], i32(qm));
        atomicAdd(&gridFixed[n + 1u], i32(q.x));
        atomicAdd(&gridFixed[n + 2u], i32(q.y));
        atomicAdd(&gridFixed[n + 3u], i32(q.z));
      }
    }
  }
}
