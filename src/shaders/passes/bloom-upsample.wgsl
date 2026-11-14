#include "common/bloom-params.wgsl"
#include "common/bloom-level.wgsl"

// Mip-chain bloom, up half (linear colour pipeline, #223): a 3x3 tent over
// mip N+1, additively blended (pipeline blend one + one) onto mip N, which
// still holds its own downsample. Walking from the smallest level back to mip
// 0 leaves mip 0 holding the sum of every level — a wide, smooth glow for a
// fraction of the old full-resolution separable blur. The composite scales
// the sum by `bloomChainScale` (1 / levels).

@group(0) @binding(0) var srcTex      : texture_2d<f32>;
@group(0) @binding(1) var srcSampler  : sampler;
@group(0) @binding(2) var<uniform> params: BloomParams;
@group(0) @binding(3) var<uniform> level : BloomLevel;

struct FragInput {
  @builtin(position) fragCoord: vec4f,
}

@fragment
fn main(input: FragInput) -> @location(0) vec4f {
  let uv = input.fragCoord.xy * level.dstTexel;
  // The preset / energy-driven radius widens the tent a little; the chain's
  // depth already sets most of the glow's reach.
  let r = level.srcTexel * level.upRadius * clamp(params.radius * 0.6, 0.6, 2.0);
  var s = textureSampleLevel(srcTex, srcSampler, uv, 0.0).rgb * 4.0;
  s += textureSampleLevel(srcTex, srcSampler, uv + vec2f(-r.x, 0.0), 0.0).rgb * 2.0;
  s += textureSampleLevel(srcTex, srcSampler, uv + vec2f( r.x, 0.0), 0.0).rgb * 2.0;
  s += textureSampleLevel(srcTex, srcSampler, uv + vec2f(0.0, -r.y), 0.0).rgb * 2.0;
  s += textureSampleLevel(srcTex, srcSampler, uv + vec2f(0.0,  r.y), 0.0).rgb * 2.0;
  s += textureSampleLevel(srcTex, srcSampler, uv + vec2f(-r.x, -r.y), 0.0).rgb;
  s += textureSampleLevel(srcTex, srcSampler, uv + vec2f( r.x, -r.y), 0.0).rgb;
  s += textureSampleLevel(srcTex, srcSampler, uv + vec2f(-r.x,  r.y), 0.0).rgb;
  s += textureSampleLevel(srcTex, srcSampler, uv + vec2f( r.x,  r.y), 0.0).rgb;
  return vec4f(s / 16.0, 1.0);
}
