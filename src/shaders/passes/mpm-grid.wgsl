// MLS-MPM liquid, pass 2 of 3 — grid update (ADR-0022).
//
// Fixed-point momentum / mass → velocity, plus gravity, then the box: nodes
// 0, 1 and n−2, n−1 on each axis are wall nodes, where nothing flows into the
// wall and tangential motion is free. Velocities are clamped to maxSpeed.
// Writes velocity (m/s) and mass (in particle masses) for every node, so the
// float grid never needs clearing.
//
// The fixed-point grid is the buffer p2g scattered into; it is read here with
// plain loads, after that pass has finished.
//
// CPU twin: MpmCpu.gridUpdate (src/fluids/mpm-cpu.ts).

#include "common/mpm.wgsl"

@group(0) @binding(0) var<uniform> params: MpmParams;
@group(0) @binding(2) var<storage, read_write> gridFixed: array<i32>;
@group(0) @binding(3) var<storage, read_write> gridVel: array<vec4f>;

@compute @workgroup_size(4, 4, 4)
fn gridUpdate(@builtin(global_invocation_id) gid: vec3u) {
  if (any(gid >= params.gridN)) { return; }
  let n = mpmNodeIndex(vec3i(gid), params.gridN);
  let m = gridFixed[n * 4u];
  var v = vec3f(0.0);
  var mass = 0.0;
  if (m > 0) {
    mass = f32(m) / params.massScale;
    let k = params.maxSpeed * params.massScale / (params.momentumScale * f32(m));
    v = vec3f(f32(gridFixed[n * 4u + 1u]), f32(gridFixed[n * 4u + 2u]), f32(gridFixed[n * 4u + 3u])) * k
      + params.gravity * params.dt;
    v = select(v, max(v, vec3f(0.0)), gid <= vec3u(1u));
    v = select(v, min(v, vec3f(0.0)), gid + vec3u(2u) >= params.gridN);
    v = clamp(v, vec3f(-params.maxSpeed), vec3f(params.maxSpeed));
  }
  gridVel[n] = vec4f(v, mass);
}
