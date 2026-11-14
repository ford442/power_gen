#include "common/bloom-params.wgsl"
#include "common/bloom-level.wgsl"
#include "common/color.wgsl"

// Mip-chain bloom, down half (linear colour pipeline, #223). The 13-tap
// filter from Jimenez, "Next Generation Post Processing in Call of Duty:
// Advanced Warfare" (SIGGRAPH 2014): four overlapping 2x2 box groups plus a
// centre group, which avoids the pulsing a plain 2x2 box shows on thin
// highlights as they cross texels.
//
// `prefilter` reads the scene (full res) into mip 0 (half res) and applies the
// threshold; `downsample` reads mip N-1 into mip N.
//
// UVs come from @builtin(position), not the shared full-screen triangle's
// interpolant: each level is its own render target, and texel-space UVs keep
// the chain in the scene texture's orientation whatever bloom-vert emits.

@group(0) @binding(0) var srcTex      : texture_2d<f32>;
@group(0) @binding(1) var srcSampler  : sampler;
@group(0) @binding(2) var<uniform> params: BloomParams;
@group(0) @binding(3) var<uniform> level : BloomLevel;

// rg11b10ufloat tops out at 65000; keep a stray NaN / huge specular sample
// from turning into a full-screen flash two levels down.
const BLOOM_MAX = 256.0;

fn tap(uv: vec2f, dx: f32, dy: f32) -> vec3f {
  let c = textureSampleLevel(srcTex, srcSampler, uv + vec2f(dx, dy) * level.srcTexel, 0.0).rgb;
  return clamp(c, vec3f(0.0), vec3f(BLOOM_MAX));
}

/** Corona-weighted brightness, same weighting as the legacy bloom-extract.wgsl. */
fn coronaLuminance(c: vec3f) -> f32 {
  let base = luma709(c);
  let plasma = max(c.g, c.b) * 0.72 + c.g * 0.28;
  return max(base, plasma * 0.88) * params.coronaBoost;
}

/** Soft-knee threshold in scene-referred linear units (before exposure). */
fn thresholdBright(c: vec3f) -> vec3f {
  let knee = max(params.knee, 0.001);
  let lum = coronaLuminance(c);
  let soft = clamp(lum - params.threshold + knee, 0.0, 2.0 * knee);
  let curve = soft * soft / (4.0 * knee);
  let w = max(curve, lum - params.threshold) / max(lum, 1e-4);
  return c * clamp(w, 0.0, 1.0);
}

/** Karis average weight: tames single-pixel highlights before they spread. */
fn karis(c: vec3f) -> f32 {
  return 1.0 / (1.0 + luma709(c));
}

struct FragInput {
  @builtin(position) fragCoord: vec4f,
}

fn outUv(fragCoord: vec4f) -> vec2f {
  return fragCoord.xy * level.dstTexel;
}

@fragment
fn prefilter(input: FragInput) -> @location(0) vec4f {
  let uv = outUv(input.fragCoord);
  let a = tap(uv, -2.0, -2.0); let b = tap(uv, 0.0, -2.0); let c = tap(uv, 2.0, -2.0);
  let d = tap(uv, -2.0,  0.0); let e = tap(uv, 0.0,  0.0); let f = tap(uv, 2.0,  0.0);
  let g = tap(uv, -2.0,  2.0); let h = tap(uv, 0.0,  2.0); let i = tap(uv, 2.0,  2.0);
  let j = tap(uv, -1.0, -1.0); let k = tap(uv, 1.0, -1.0);
  let l = tap(uv, -1.0,  1.0); let m = tap(uv, 1.0,  1.0);

  // Five groups, Karis-weighted (the box weights 0.5 / 4 × 0.125 still sum to 1).
  let g0 = (j + k + l + m) * 0.25;
  let g1 = (a + b + d + e) * 0.25;
  let g2 = (b + c + e + f) * 0.25;
  let g3 = (d + e + g + h) * 0.25;
  let g4 = (e + f + h + i) * 0.25;
  let w0 = 0.5 * karis(g0);
  let w1 = 0.125 * karis(g1);
  let w2 = 0.125 * karis(g2);
  let w3 = 0.125 * karis(g3);
  let w4 = 0.125 * karis(g4);
  let avg = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / max(w0 + w1 + w2 + w3 + w4, 1e-4);
  return vec4f(thresholdBright(avg), 1.0);
}

@fragment
fn downsample(input: FragInput) -> @location(0) vec4f {
  let uv = outUv(input.fragCoord);
  let a = tap(uv, -2.0, -2.0); let b = tap(uv, 0.0, -2.0); let c = tap(uv, 2.0, -2.0);
  let d = tap(uv, -2.0,  0.0); let e = tap(uv, 0.0,  0.0); let f = tap(uv, 2.0,  0.0);
  let g = tap(uv, -2.0,  2.0); let h = tap(uv, 0.0,  2.0); let i = tap(uv, 2.0,  2.0);
  let j = tap(uv, -1.0, -1.0); let k = tap(uv, 1.0, -1.0);
  let l = tap(uv, -1.0,  1.0); let m = tap(uv, 1.0,  1.0);
  var o = e * 0.125;
  o += (a + c + g + i) * 0.03125;
  o += (b + d + f + h) * 0.0625;
  o += (j + k + l + m) * 0.125;
  return vec4f(o, 1.0);
}
