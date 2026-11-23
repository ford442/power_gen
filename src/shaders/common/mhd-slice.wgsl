// =============================================================
// MHD duct slice — shared declarations of passes/mhd-slice-*.wgsl
// (docs/FLUIDS.md → MHD duct → The slice). Host: src/fluids/mhd-slice.ts
// (`packMhdSliceParams`); CPU twin: src/fluids/mhd-slice-cpu.ts.
//
// D2Q9, two-relaxation-time collision, Guo forcing, half-way bounce-back at
// the top and bottom rows. Lattice units throughout: cell = 1, step = 1.
// =============================================================

/// 80 B.
struct MhdSliceParams {
  nx: u32,
  ny: u32,
  /// MHD_FLAG_*.
  flags: u32,
  /// Electrode pairs in use.
  segments: u32,
  omegaPlus: f32,
  omegaMinus: f32,
  /// Inlet speed along x.
  inletU: f32,
  /// Uniform body acceleration along x.
  gUniform: f32,
  /// sigma * B^2 * dt / rho at the peak field.
  lorentz: f32,
  /// Drag applied everywhere, per step.
  dragUniform: f32,
  sorOmega: f32,
  circuitGain: f32,
  /// Each pair's load, R * sigma * 2a.
  segLoad: array<vec4f, 2>,
}

const MHD_FLAG_PERIODIC: u32 = 1u;
const MHD_FLAG_POTENTIAL: u32 = 2u;
const MHD_MAX_SEGMENTS: u32 = 8u;

const D2Q9_CX = array<i32, 9>(0, 1, 0, -1, 0, 1, -1, -1, 1);
const D2Q9_CY = array<i32, 9>(0, 0, 1, 0, -1, 1, 1, -1, -1);
const D2Q9_OPP = array<u32, 9>(0u, 3u, 4u, 1u, 2u, 7u, 8u, 5u, 6u);
const D2Q9_W = array<f32, 9>(
  0.44444445, 0.11111111, 0.11111111, 0.11111111, 0.11111111,
  0.027777778, 0.027777778, 0.027777778, 0.027777778
);

/// D2Q9 equilibrium to second order in the velocity.
fn mhdEquilibrium(q: u32, rho: f32, u: vec2f) -> f32 {
  let cu = f32(D2Q9_CX[q]) * u.x + f32(D2Q9_CY[q]) * u.y;
  return D2Q9_W[q] * rho * (1.0 + 3.0 * cu + 4.5 * cu * cu - 1.5 * dot(u, u));
}
