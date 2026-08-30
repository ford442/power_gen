#include "common/bloom-params.wgsl"

@group(0) @binding(0) var sceneTex    : texture_2d<f32>;
@group(0) @binding(1) var bloomSampler: sampler;
@group(0) @binding(2) var<uniform> params: BloomParams;

struct FragInput {
  @location(0) uv: vec2f,
}

fn luminance(c: vec3f) -> vec3f {
  return vec3f(dot(c, vec3f(0.2126, 0.7152, 0.0722)));
}

/** Weight green/cyan plasma higher so corona blooms before metal specular blows out. */
fn coronaLuminance(c: vec3f) -> f32 {
  let base = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  let plasma = max(c.g, c.b) * 0.72 + c.g * 0.28;
  return max(base, plasma * 0.88) * params.coronaBoost;
}

fn extractBright(c: vec3f, threshold: f32, knee: f32) -> vec3f {
  let lum  = coronaLuminance(c);
  let w    = clamp((lum - threshold + knee) / max(knee, 0.001), 0.0, 1.0);
  let w2   = w * w * (3.0 - 2.0 * w);
  return c * w2;
}

@fragment
fn main(input: FragInput) -> @location(0) vec4f {
  let ts = vec2f(params.texelSizeX, params.texelSizeY);
  var bloom = vec3f(0.0);
  var weights: array<f32, 5> = array<f32, 5>(0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216);
  for (var i = 0; i < 5; i++) {
    let o = ts * f32(i);
    bloom += extractBright(textureSample(sceneTex, bloomSampler, input.uv + vec2f(o.x, 0.0)).rgb, params.threshold, params.knee) * weights[i];
    bloom += extractBright(textureSample(sceneTex, bloomSampler, input.uv - vec2f(o.x, 0.0)).rgb, params.threshold, params.knee) * weights[i];
    bloom += extractBright(textureSample(sceneTex, bloomSampler, input.uv + vec2f(0.0, o.y)).rgb, params.threshold, params.knee) * weights[i];
    bloom += extractBright(textureSample(sceneTex, bloomSampler, input.uv - vec2f(0.0, o.y)).rgb, params.threshold, params.knee) * weights[i];
  }
  bloom *= 0.25;
  bloom += extractBright(textureSample(sceneTex, bloomSampler, input.uv).rgb, params.threshold, params.knee) * 0.35;
  return vec4f(bloom, 1.0);
}
