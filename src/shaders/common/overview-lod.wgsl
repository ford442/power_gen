// =============================================================
// Overview particle LOD ladder (ADR-0005 WS4).
//
// One ladder shared by the frustum-cull pass (which sizes the
// draw-indirect instance count) and the particle compute pass
// (which discards high-index particles above the threshold), so a
// device never draws instances the compute pass did not integrate.
//
// JS mirror: `overviewLodParticleCount` in renderers/shared/view-lod.js.
// =============================================================

/// Highest (coarsest) LOD level. Level L keeps baseCount >> L particles.
const OVERVIEW_LOD_MAX: u32 = 3u;

/// Particles kept for `baseCount` at `lodLevel` (0 = full, 3 = 1/8).
fn overviewLodCount(baseCount: u32, lodLevel: u32) -> u32 {
  return baseCount >> min(lodLevel, OVERVIEW_LOD_MAX);
}
