// =============================================================
// MHD duct slice — one lattice-Boltzmann step (docs/FLUIDS.md → MHD duct →
// The slice). CPU twin: MhdSliceCpu.lbm (src/fluids/mhd-slice-cpu.ts).
//
// Pull, collide, write: a cell reads the distributions that arrive from its
// neighbours (its own, reflected, where the neighbour is the top or bottom
// wall), takes the moments with half the force, relaxes the symmetric and
// antisymmetric halves at their own rates with the Guo source, and writes
// the other buffer. Nothing else writes that buffer, so the pass is free of
// races. The moments go to `moments` for the potential sweeps and the picture.
//
// Bindings: docs/BINDINGS.md → `mhdSlice`.
// =============================================================

#include "common/mhd-slice.wgsl"

@group(0) @binding(0) var<uniform> params: MhdSliceParams;
/// Per column: field shape 0..1, wall drag per step, electrode segment (-1 none), cells in that segment.
@group(0) @binding(1) var<storage, read> columns: array<vec4f>;
@group(0) @binding(2) var<storage, read> fIn: array<f32>;
@group(0) @binding(3) var<storage, read_write> fOut: array<f32>;
/// Per cell: ux, uy, rho, and (written by mhd-slice-phi.wgsl once a frame) the current's stream function.
@group(0) @binding(4) var<storage, read_write> moments: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> phi: array<f32>;
/// Column mean forces, then a voltage and a current per electrode pair.
@group(0) @binding(6) var<storage, read_write> state: array<f32>;

/// phi one row beyond (i, j): the neighbour, or the wall's ghost — an electrode at +-V/2 or an insulator.
fn phiAcross(i: u32, j: u32, dir: i32) -> f32 {
  let jn = i32(j) + dir;
  let here = phi[j * params.nx + i];
  if (jn >= 0 && jn < i32(params.ny)) { return phi[u32(jn) * params.nx + i]; }
  let seg = columns[i].z;
  if (seg >= 0.0) { return f32(dir) * state[params.nx + u32(seg)] - here; }
  return here;
}

@compute @workgroup_size(8, 8)
fn step(@builtin(global_invocation_id) gid: vec3u) {
  let nx = params.nx;
  let ny = params.ny;
  if (gid.x >= nx || gid.y >= ny) { return; }
  let i = gid.x;
  let j = gid.y;
  let cell = j * nx + i;
  let periodic = (params.flags & MHD_FLAG_PERIODIC) != 0u;

  var fin: array<f32, 9>;
  for (var q = 0u; q < 9u; q++) {
    var si = i32(i) - D2Q9_CX[q];
    let sj = i32(j) - D2Q9_CY[q];
    if (sj < 0 || sj >= i32(ny)) {
      fin[q] = fIn[cell * 9u + D2Q9_OPP[q]];
      continue;
    }
    if (si < 0 || si >= i32(nx)) {
      if (!periodic) {
        fin[q] = fIn[cell * 9u + q];
        continue;
      }
      si = (si + i32(nx)) % i32(nx);
    }
    fin[q] = fIn[(u32(sj) * nx + u32(si)) * 9u + q];
  }

  if (!periodic && (i == 0u || i == nx - 1u)) {
    // Inlet: the plant's speed, the density the interior asks for. Outlet: rest density, the speed that arrives.
    var rho = 1.0;
    var u = params.inletU;
    if (i == 0u) {
      rho = (fin[0] + fin[2] + fin[4] + 2.0 * (fin[3] + fin[6] + fin[7])) / (1.0 - u);
    } else {
      u = fin[0] + fin[2] + fin[4] + 2.0 * (fin[1] + fin[5] + fin[8]) - 1.0;
    }
    for (var q = 0u; q < 9u; q++) { fOut[cell * 9u + q] = mhdEquilibrium(q, rho, vec2f(u, 0.0)); }
    moments[cell] = vec4f(u, 0.0, rho, 0.0);
    return;
  }

  var rho = 0.0;
  var m = vec2f(0.0);
  for (var q = 0u; q < 9u; q++) {
    rho += fin[q];
    m += fin[q] * vec2f(f32(D2Q9_CX[q]), f32(D2Q9_CY[q]));
  }

  // Force per unit mass = g - drag * u. The drag is linear in u, so the half-force velocity is solved, not lagged.
  let col = columns[i];
  let nl = params.lorentz * col.x;
  let drag = params.dragUniform + col.y + nl * col.x;
  var g = vec2f(params.gUniform, 0.0);
  if ((params.flags & MHD_FLAG_POTENTIAL) != 0u) {
    let iw = u32(max(i32(i) - 1, 0));
    let ie = min(i + 1u, nx - 1u);
    let dpx = (phi[j * nx + ie] - phi[j * nx + iw]) / f32(ie - iw);
    let dpy = (phiAcross(i, j, 1) - phiAcross(i, j, -1)) * 0.5;
    g += vec2f(nl * dpy - state[i], -nl * dpx);
  }
  let u = (m / rho + 0.5 * g) / (1.0 + 0.5 * drag);
  let force = rho * (g - drag * u);
  let usq = dot(u, u);
  let uf = dot(u, force);

  for (var q = 0u; q < 9u; q++) {
    let o = D2Q9_OPP[q];
    if (q > o) { continue; }
    let c = vec2f(f32(D2Q9_CX[q]), f32(D2Q9_CY[q]));
    let cu = dot(c, u);
    let cf = dot(c, force);
    // Symmetric and antisymmetric halves relax at their own rates (TRT); so do the halves of the Guo source.
    let eqP = D2Q9_W[q] * rho * (1.0 + 4.5 * cu * cu - 1.5 * usq);
    let eqM = D2Q9_W[q] * rho * 3.0 * cu;
    let fp = 0.5 * (fin[q] + fin[o]);
    let fm = 0.5 * (fin[q] - fin[o]);
    let sp = D2Q9_W[q] * (9.0 * cu * cf - 3.0 * uf);
    let sm = D2Q9_W[q] * 3.0 * cf;
    let outP = fp - params.omegaPlus * (fp - eqP) + (1.0 - 0.5 * params.omegaPlus) * sp;
    let outM = fm - params.omegaMinus * (fm - eqM) + (1.0 - 0.5 * params.omegaMinus) * sm;
    if (q == 0u) {
      fOut[cell * 9u] = outP;
    } else {
      fOut[cell * 9u + q] = outP + outM;
      fOut[cell * 9u + o] = outP - outM;
    }
  }
  moments[cell] = vec4f(u, rho, 0.0);
}
