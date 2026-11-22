/**
 * Fully developed Hartmann flow — the exact laminar solution for a conducting
 * fluid driven along x between insulating walls at y = ±a, with a uniform
 * field B along y (Hartmann 1937).
 *
 *   u(η) / Ū = (cosh Ha − cosh(Ha·η)) / (cosh Ha − sinh(Ha)/Ha),   η = y/a
 *   Ha = B · a · √(σ / ρν)
 *
 * Ha → 0 is plane Poiseuille flow, u/Ū = 1.5·(1 − η²). Large Ha is a flat
 * core with Hartmann layers of thickness a/Ha at the two walls.
 *
 * Everything here is normalised: η in [−1, 1], velocity in units of the mean
 * Ū (the plant's `mhdFlowU` is the mean — V = B·Ū·w). The same expressions are
 * written out in passes/particle-compute.wgsl (`hartmannShape`) and
 * cpp/src/plant/mhd_plant.h; scripts/tests/hartmann.test.mjs and the Dawn
 * golden hold the three together.
 *
 * Evaluated with decaying exponentials only, so Ha in the thousands neither
 * overflows nor loses the layer. Below {@link HARTMANN_SERIES_BELOW} the
 * closed form cancels (1 − tanh(Ha)/Ha ≈ Ha²/3), so a two-term series in Ha²
 * takes over. The hand-over sits where the two errors cross in single
 * precision — the shader and the C++ plant evaluate this in f32 — at about
 * 1e-5 relative: the series' Ha⁴ truncation below, the float cancellation
 * above.
 *
 * What this is not: it assumes a duct much wider than its gap (no side
 * layers), insulating walls, a uniform field (no entry length, no fringing)
 * and laminar flow. docs/DEVICE_GALLERY.md → mhd lists the limits.
 */

/** Below this Ha the series replaces the closed form. Mirrored in WGSL and C++. */
export const HARTMANN_SERIES_BELOW = 0.25;

/** cosh(h·e) / cosh(h) for e in [0, 1], h ≥ 0 — never overflows. */
function coshRatio(h: number, e: number): number {
  return Math.exp(h * (e - 1)) * (1 + Math.exp(-2 * h * e)) / (1 + Math.exp(-2 * h));
}

/** 1 / cosh(h). */
function sech(h: number): number {
  return 2 * Math.exp(-h) / (1 + Math.exp(-2 * h));
}

function clampEta(eta: number): number {
  const e = Math.abs(eta);
  return e < 1 ? e : 1;
}

/**
 * u(η) / u(0): the profile's shape, 1 on the centre line and 0 at the walls.
 * This is what a material line released across the duct turns into.
 */
export function hartmannShape(eta: number, ha: number): number {
  const e = clampEta(eta);
  const h = Math.abs(ha);
  if (!(h >= HARTMANN_SERIES_BELOW)) return (1 - e * e) * (1 + h * h * e * e / 12);
  return (1 - coshRatio(h, e)) / (1 - sech(h));
}

/** u(η) / Ū: local speed over the mean. Integrates to 1 across the gap. */
export function hartmannProfile(eta: number, ha: number): number {
  const e = clampEta(eta);
  const h = Math.abs(ha);
  if (!(h >= HARTMANN_SERIES_BELOW)) return 1.5 * (1 - e * e) * (1 + h * h * (e * e / 12 - 1 / 60));
  return (1 - coshRatio(h, e)) / (1 - Math.tanh(h) / h);
}

/** u(0) / Ū: 1.5 for Poiseuille, → 1 as the core flattens. */
export function hartmannCentre(ha: number): number {
  const h = Math.abs(ha);
  if (!(h >= HARTMANN_SERIES_BELOW)) return 1.5 * (1 - h * h / 60);
  return (1 - sech(h)) / (1 - Math.tanh(h) / h);
}

/**
 * Wall shear, −(a/Ū)·du/dy at y = a: 3 for Poiseuille, → Ha for thin Hartmann
 * layers. Wall friction per unit mass is (ν/a²)·this·Ū.
 */
export function hartmannWallShear(ha: number): number {
  const h = Math.abs(ha);
  if (!(h >= HARTMANN_SERIES_BELOW)) return 3 * (1 + h * h / 15);
  const th = Math.tanh(h);
  return h * th / (1 - th / h);
}

/** Hartmann-layer thickness over the half-gap, a/Ha capped at the whole half-gap. */
export function hartmannLayerFraction(ha: number): number {
  const h = Math.abs(ha);
  return h > 1 ? 1 / h : 1;
}

/**
 * `n` samples of u/Ū across the gap, η from −1 to 1 inclusive — what the
 * profile overlay draws.
 */
export function sampleHartmannProfile(ha: number, n: number, out: Float64Array = new Float64Array(n)): Float64Array {
  for (let i = 0; i < n; i++) {
    const eta = n > 1 ? -1 + (2 * i) / (n - 1) : 0;
    out[i] = hartmannProfile(eta, ha);
  }
  return out;
}
