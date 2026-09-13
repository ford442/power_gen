// =============================================================
// 2D TM_z Yee FDTD update (ADR-0010) — classroom wave slice
//
// Normalized units (ε = μ = c = Δx = 1). Two entry points, dispatched
// alternately `FDTD_STEPS_PER_FRAME` times inside one compute pass:
//   updateH — Hx, Hy from the curl of Ez
//   updateE — Ez from the curl of H minus the soft J_z source
// A cubic graded-loss sponge (matched electric/magnetic loss) absorbs at the
// edges; the outermost Ez ring stays zero (PEC) behind it.
//
// Mirrors FdtdTmzGrid.step in src/physics/fdtd-tmz.ts, which is the CPU
// reference — change both together.
//
// Bindings: docs/BINDINGS.md → `fdtdCompute`.
// =============================================================

#include "common/fdtd-params.wgsl"

@group(0) @binding(0) var<uniform> params: FdtdParams;
@group(0) @binding(1) var<storage, read_write> ez: array<f32>;
@group(0) @binding(2) var<storage, read_write> hx: array<f32>;
@group(0) @binding(3) var<storage, read_write> hy: array<f32>;

/// Half-step loss at a (half-)integer grid position — fdtdLossAt on the CPU.
fn lossAt(px: f32, py: f32) -> f32 {
  let edge = f32(params.n - 1u);
  let p = f32(params.pmlCells);
  let d = max(max(p - px, px - (edge - p)), max(max(p - py, py - (edge - p)), 0.0));
  let t = min(d / p, 1.0);
  return params.lossMax * t * t * t;
}

/// Soft current density at a cell: sum of Gaussian blobs, cut at 3 radii.
fn sourceJ(x: f32, y: f32) -> f32 {
  let r = params.sourceRadius;
  let inv2r2 = 1.0 / (2.0 * r * r);
  let count = min(params.sourceCount, FDTD_MAX_SOURCES);
  var j = 0.0;
  for (var k = 0u; k < count; k++) {
    let s = params.sources[k];
    let dx = x - s.x;
    let dy = y - s.y;
    let r2 = dx * dx + dy * dy;
    if (r2 < 9.0 * r * r) {
      j += s.z * exp(-r2 * inv2r2);
    }
  }
  return j;
}

@compute @workgroup_size(8, 8)
fn updateH(@builtin(global_invocation_id) id: vec3u) {
  let n = params.n;
  if (id.x >= n - 1u || id.y >= n - 1u) { return; }
  let i = id.x + id.y * n;
  let x = f32(id.x);
  let y = f32(id.y);
  let S = params.courant;
  let sx = lossAt(x, y + 0.5);
  let sy = lossAt(x + 0.5, y);
  hx[i] = ((1.0 - sx) * hx[i] - S * (ez[i + n] - ez[i])) / (1.0 + sx);
  hy[i] = ((1.0 - sy) * hy[i] + S * (ez[i + 1u] - ez[i])) / (1.0 + sy);
}

@compute @workgroup_size(8, 8)
fn updateE(@builtin(global_invocation_id) id: vec3u) {
  let n = params.n;
  if (id.x == 0u || id.y == 0u || id.x >= n - 1u || id.y >= n - 1u) { return; }
  let i = id.x + id.y * n;
  let x = f32(id.x);
  let y = f32(id.y);
  let s = lossAt(x, y);
  let curl = (hy[i] - hy[i - 1u]) - (hx[i] - hx[i - n]);
  ez[i] = ((1.0 - s) * ez[i] + params.courant * (curl - sourceJ(x, y))) / (1.0 + s);
}
