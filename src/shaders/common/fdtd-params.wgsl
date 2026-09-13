// =============================================================
// 2D TM_z FDTD slice uniforms (ADR-0010).
// Packed by packFdtdParams in src/physics/fdtd-tmz.ts — keep both in sync
// (scripts/test-fdtd-slice.mjs checks the byte size).
// =============================================================

const FDTD_MAX_SOURCES: u32 = 16u;

/// 288 B. Grid is n×n cells indexed x + y·n; y points up the slice.
struct FdtdParams {
  n: u32,
  /// Sponge depth in cells on every edge.
  pmlCells: u32,
  /// Courant number S = c·Δt/Δx (normalized units, 2D limit 1/√2).
  courant: f32,
  /// Peak half-step loss s = σ·S/2 at the outer sponge edge.
  lossMax: f32,
  sourceCount: u32,
  /// Gaussian J_z blob radius, cells.
  sourceRadius: f32,
  _pad0: f32,
  _pad1: f32,
  /// (x cell, y cell, signed J_z, polarity marker ±1)
  sources: array<vec4f, 16>,
}
