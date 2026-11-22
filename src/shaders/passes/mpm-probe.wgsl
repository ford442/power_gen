// MLS-MPM liquid — read-back profile (ADR-0022).
//
// One invocation per horizontal layer of grid nodes sums the mass on it
// (from the velocity grid's w, in particle masses) and stores it as fixed
// point, MPM_PROBE_MASS_SCALE counts per particle mass. Two words after the
// last layer carry the emitted and sunk totals. The host copies this small
// buffer out now and then: the liquid's height profile gives the top of a
// jet, the level of a pool and the mass in the box in one read.
//
// CPU twin: mpmLayerProfile (src/fluids/mpm-cpu.ts).

#include "common/mpm.wgsl"

@group(0) @binding(0) var<uniform> params: MpmParams;
@group(0) @binding(3) var<storage, read_write> counters: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read> gridVel: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> profile: array<u32>;

const MPM_PROBE_MASS_SCALE = 256.0;

@compute @workgroup_size(1)
fn probe(@builtin(global_invocation_id) gid: vec3u) {
  let y = gid.x;
  if (y == params.gridN.y) {
    profile[y] = atomicLoad(&counters[MPM_COUNTER_EMITTED]);
    profile[y + 1u] = atomicLoad(&counters[MPM_COUNTER_SUNK]);
    return;
  }
  if (y > params.gridN.y) { return; }
  var mass = 0.0;
  for (var z = 0u; z < params.gridN.z; z++) {
    let row = (z * params.gridN.y + y) * params.gridN.x;
    for (var x = 0u; x < params.gridN.x; x++) {
      mass += gridVel[row + x].w;
    }
  }
  profile[y] = u32(round(mass * MPM_PROBE_MASS_SCALE));
}
