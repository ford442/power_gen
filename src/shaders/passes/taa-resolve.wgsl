// ============================================================================
// Temporal anti-aliasing resolve — ADR-0005 Workstream 2
// ============================================================================
// Runs between the scene pass (and its manual MSAA depth resolve) and the
// SSR / bloom chain. Reprojects last frame's *resolved* colour into this
// frame using the camera's own view-projection — no separate TAA camera, no
// velocity buffer: the scene is a static rig orbited by the camera, so
// reconstructing world position from depth and reprojecting with the previous
// frame's matrix recovers the motion exactly for everything that is not
// itself moving.
//
// The rollers and pipes *do* move, and the neighbourhood clamp below is what
// keeps them from smearing: history that falls outside the 3x3 colour box of
// the current frame is pulled back to the box, which is the standard
// (Karis) rejection and costs eight extra taps.
//
// Quality-gated to high/ultra in SEG focus — see post-processing-config.ts
// (`taa` gate) and render-loop.ts. Not implemented on WebGL2 (docs/WEBGL2.md).
//
// Bindings — see docs/BINDINGS.md ("taaResolve" group):
//   0 scene colour (this frame)   1 history (last resolved frame)
//   2 filtering sampler           3 depth (resolved on MSAA frames)
//   4 TaaParams

struct TaaParams {
  invViewProj  : mat4x4f,  // clip → world, this frame
  prevViewProj : mat4x4f,  // world → clip, previous frame
  texelSize    : vec2f,    // 1 / scene texture size
  alpha        : f32,      // history weight (0 = no TAA, 0.9 = strong)
  historyValid : f32,      // 0 on the first frame after a reset
}

@group(0) @binding(0) var taaSceneTex   : texture_2d<f32>;
@group(0) @binding(1) var taaHistoryTex : texture_2d<f32>;
@group(0) @binding(2) var taaSampler    : sampler;
@group(0) @binding(3) var taaDepthTex   : texture_depth_2d;
@group(0) @binding(4) var<uniform> taa  : TaaParams;

struct FragInput {
  @location(0) uv: vec2f,
}

/** Raw depth (NDC z, as written by the camera's GL-style projection). */
fn loadDepth(uv: vec2f) -> f32 {
  let dim = textureDimensions(taaDepthTex, 0);
  let coord = vec2i(clamp(uv * vec2f(dim), vec2f(0.0), vec2f(dim) - vec2f(1.0)));
  return textureLoad(taaDepthTex, coord, 0);
}

/**
 * Where this pixel was last frame, in UV space.
 *
 * Same NDC convention as ssr-compute.wgsl: the depth sample is NDC z directly,
 * and y is flipped between UV and NDC.
 */
fn reprojectUv(uv: vec2f, depth: f32) -> vec2f {
  let ndc = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, depth, 1.0);
  let world = taa.invViewProj * ndc;
  // A w at or below zero means the point is behind the previous eye; the
  // caller rejects it via the bounds test on the result.
  if (abs(world.w) < 1e-6) { return vec2f(-1.0); }
  let prevClip = taa.prevViewProj * vec4f(world.xyz / world.w, 1.0);
  if (prevClip.w <= 1e-6) { return vec2f(-1.0); }
  let prevNdc = prevClip.xy / prevClip.w;
  return vec2f(prevNdc.x * 0.5 + 0.5, 0.5 - prevNdc.y * 0.5);
}

@fragment
fn main(input: FragInput) -> @location(0) vec4f {
  let current = textureSample(taaSceneTex, taaSampler, input.uv);

  // Reset frame (mode switch, layout preset, lighting look, resize) — the
  // history is from a different scene, so show the current frame untouched.
  if (taa.historyValid < 0.5 || taa.alpha < 0.001) {
    return current;
  }

  let depth = loadDepth(input.uv);
  let prevUv = reprojectUv(input.uv, depth);

  // Off-screen last frame: nothing to blend against, so no history term
  // rather than a clamped-edge smear.
  if (prevUv.x < 0.0 || prevUv.x > 1.0 || prevUv.y < 0.0 || prevUv.y > 1.0) {
    return current;
  }

  // 3x3 neighbourhood of the current frame — the box history must lie in.
  var boxMin = current.rgb;
  var boxMax = current.rgb;
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      if (dx == 0 && dy == 0) { continue; }
      let offset = vec2f(f32(dx), f32(dy)) * taa.texelSize;
      let c = textureSample(taaSceneTex, taaSampler, input.uv + offset).rgb;
      boxMin = min(boxMin, c);
      boxMax = max(boxMax, c);
    }
  }

  let history = textureSample(taaHistoryTex, taaSampler, prevUv).rgb;
  let clamped = clamp(history, boxMin, boxMax);

  // How far the clamp had to move the sample is a good disocclusion signal:
  // a rejected history is usually a silhouette that was not there last frame,
  // so lean on the current frame instead of ghosting.
  let rejection = length(clamped - history) / max(length(boxMax - boxMin), 1e-4);
  let alpha = taa.alpha * (1.0 - clamp(rejection, 0.0, 1.0));

  return vec4f(mix(current.rgb, clamped, alpha), current.a);
}
