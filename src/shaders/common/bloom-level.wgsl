// Per-level uniform of the mip-chain bloom (linear colour pipeline, #223).
// Packed by packBloomLevel() in visualizer/bloom-chain.ts — one 256-byte slot
// per level in a single buffer, so each level's bind group is a static offset.

struct BloomLevel {
  // 1 / size of the texture this pass samples (scene for the prefilter, the
  // previous mip otherwise).
  srcTexel: vec2f,
  // 1 / size of the render target — fragCoord * dstTexel is the target UV.
  dstTexel: vec2f,
  // Upsample tent radius, in source texels.
  upRadius: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
}
