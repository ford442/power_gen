// =============================================================
// MHD duct slice — the electric potential and the circuit (docs/FLUIDS.md →
// MHD duct → The slice). CPU twin: MhdSliceCpu.sor / .reduce.
//
// Current is sigma * (-grad phi + u x B) and has no divergence, so
//   laplace(phi) = d/dx(-uy * b) + d/dy(ux * b)        b = B(x) / B_peak
// with insulating walls except on the electrode segments, which are
// equipotentials at +-V/2.
//
//   sorRed / sorBlack — the two colours of a red-black sweep, in place: a
//                       cell reads only the other colour.
//   reduceColumns     — per column, the mean force along x (next step's
//                       balance).
//   reduceElectrodes  — per electrode pair, the current through it and its
//                       voltage moved towards load * current.
//
// Bindings: docs/BINDINGS.md → `mhdSlice`.
// =============================================================

#include "common/mhd-slice.wgsl"

@group(0) @binding(0) var<uniform> params: MhdSliceParams;
/// Per column: field shape 0..1, wall drag per step, electrode segment (-1 none), cells in that segment.
@group(0) @binding(1) var<storage, read> columns: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> moments: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> phi: array<f32>;
@group(0) @binding(6) var<storage, read_write> state: array<f32>;

fn mhdSegLoad(k: u32) -> f32 {
  return params.segLoad[k / 4u][k % 4u];
}

fn phiAcross(i: u32, j: u32, dir: i32) -> f32 {
  let jn = i32(j) + dir;
  let here = phi[j * params.nx + i];
  if (jn >= 0 && jn < i32(params.ny)) { return phi[u32(jn) * params.nx + i]; }
  let seg = columns[i].z;
  if (seg >= 0.0) { return f32(dir) * state[params.nx + u32(seg)] - here; }
  return here;
}

fn sweep(gid: vec3u, colour: u32) {
  let nx = params.nx;
  let ny = params.ny;
  // One invocation per cell of this colour: x counts every other column.
  let j = gid.y;
  let i = gid.x * 2u + ((j + colour) & 1u);
  if (i >= nx || j >= ny) { return; }
  let cell = j * nx + i;
  let iw = u32(max(i32(i) - 1, 0));
  let ie = min(i + 1u, nx - 1u);
  let ddx = (moments[j * nx + iw].y * columns[iw].x - moments[j * nx + ie].y * columns[ie].x) / f32(ie - iw);
  // No-slip walls: the ghost velocity is -u.
  let here = moments[cell].x;
  var un = -here;
  var us = -here;
  if (j + 1u < ny) { un = moments[cell + nx].x; }
  if (j > 0u) { us = moments[cell - nx].x; }
  let rhs = ddx + columns[i].x * (un - us) * 0.5;
  let next = (phi[j * nx + iw] + phi[j * nx + ie] + phiAcross(i, j, 1) + phiAcross(i, j, -1) - rhs) * 0.25;
  phi[cell] += params.sorOmega * (next - phi[cell]);
}

@compute @workgroup_size(8, 8)
fn sorRed(@builtin(global_invocation_id) gid: vec3u) {
  sweep(gid, 0u);
}

@compute @workgroup_size(8, 8)
fn sorBlack(@builtin(global_invocation_id) gid: vec3u) {
  sweep(gid, 1u);
}

/// Per column: the mean force along x in that cross-section. The inlet and outlet columns carry none.
@compute @workgroup_size(64)
fn reduceColumns(@builtin(global_invocation_id) gid: vec3u) {
  let nx = params.nx;
  let ny = params.ny;
  let id = gid.x;
  if (id >= nx) { return; }
  var mean = 0.0;
  if (id > 0u && id + 1u < nx) {
    let col = columns[id];
    let nl = params.lorentz * col.x;
    let drag = params.dragUniform + col.y + nl * col.x;
    var sum = 0.0;
    for (var j = 0u; j < ny; j++) {
      let dpy = (phiAcross(id, j, 1) - phiAcross(id, j, -1)) * 0.5;
      sum += nl * dpy - drag * moments[j * nx + id].x;
    }
    mean = sum / f32(ny);
  }
  state[id] = mean;
}

/// Per electrode pair: its current, and its voltage moved towards load * current.
/// A pass of its own: the column means above read the voltages this writes.
@compute @workgroup_size(8)
fn reduceElectrodes(@builtin(global_invocation_id) gid: vec3u) {
  let nx = params.nx;
  let ny = params.ny;
  let k = gid.x;
  if (k >= params.segments) { return; }
  let v = state[nx + k];
  var current = 0.0;
  var cells = 0.0;
  for (var i = 0u; i < nx; i++) {
    if (columns[i].z != f32(k)) { continue; }
    cells += 1.0;
    // Into the top electrode and out of the bottom one: -d(phi)/dz over the half cell to each wall.
    current += (phi[(ny - 1u) * nx + i] - 0.5 * v) + (-0.5 * v - phi[i]);
  }
  let r = mhdSegLoad(k);
  state[nx + k] = v + params.circuitGain * (r * current - v) / (1.0 + r * cells);
  state[nx + MHD_MAX_SEGMENTS + k] = current;
}
