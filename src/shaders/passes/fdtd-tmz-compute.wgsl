// =============================================================
// 2D TM_z Yee FDTD update (ADR-0010) — classroom wave slice
// Material cells (mu_r / sigma) added by ADR-0012.
//
// Normalized units (ε = μ₀ = c = Δx = 1). Two entry points, dispatched
// alternately `FDTD_STEPS_PER_FRAME` times inside one compute pass:
//   updateH — Hx, Hy from the curl of Ez, scaled by 1/mu_r
//   updateE — Ez from the curl of H minus the soft J_z source, damped by sigma
// A cubic graded-loss sponge (matched electric/magnetic loss) absorbs at the
// edges; the outermost Ez ring stays zero (PEC) behind it.
//
// The material map is a per-cell vec2f (1/mu_r, electric half-step loss),
// built on the CPU by buildFdtdMaterialMap. mu_r >= 1 only ever *reduces* the
// effective Courant number, and sigma only damps, so materials cannot
// destabilise a grid that was stable in vacuum. With
// `params.materialFlags & FDTD_FLAG_MATERIALS` clear the map is not read at all
// and this is bit-for-bit the ADR-0010 kernel.
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
/// (1/mu_r, electric half-step loss) per cell — same x + y·n indexing.
@group(0) @binding(4) var<storage, read> materials: array<vec2f>;

/// Material at a cell, or vacuum when the map is switched off.
fn materialAt(i: u32) -> vec2f {
  if ((params.materialFlags & FDTD_FLAG_MATERIALS) == 0u) {
    return vec2f(1.0, 0.0);
  }
  return materials[i];
}

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
  // 1/mu_r averaged across the two Ez nodes each H component sits between, so a
  // material boundary does not bias the front by half a cell.
  let invMuHere = materialAt(i).x;
  let nuX = 0.5 * (invMuHere + materialAt(i + n).x);
  let nuY = 0.5 * (invMuHere + materialAt(i + 1u).x);
  hx[i] = ((1.0 - sx) * hx[i] - S * nuX * (ez[i + n] - ez[i])) / (1.0 + sx);
  hy[i] = ((1.0 - sy) * hy[i] + S * nuY * (ez[i + 1u] - ez[i])) / (1.0 + sy);
}

@compute @workgroup_size(8, 8)
fn updateE(@builtin(global_invocation_id) id: vec3u) {
  let n = params.n;
  if (id.x == 0u || id.y == 0u || id.x >= n - 1u || id.y >= n - 1u) { return; }
  let i = id.x + id.y * n;
  let x = f32(id.x);
  let y = f32(id.y);
  // Sponge loss and the cell's own sigma loss add: a conductor inside the
  // sponge absorbs for both reasons.
  let s = lossAt(x, y) + materialAt(i).y;
  let curl = (hy[i] - hy[i - 1u]) - (hx[i] - hx[i - n]);
  ez[i] = ((1.0 - s) * ez[i] + params.courant * (curl - sourceJ(x, y))) / (1.0 + s);
}
