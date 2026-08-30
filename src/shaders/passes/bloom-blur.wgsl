#include "common/bloom-params.wgsl"

@group(0) @binding(0) var bloomInput : texture_2d<f32>;
@group(0) @binding(1) var bloomSampler: sampler;
@group(0) @binding(2) var<uniform> params: BloomParams;
@group(0) @binding(3) var<uniform> direction: vec2f;

struct FragInput {
  @location(0) uv: vec2f,
}

@fragment
fn main(input: FragInput) -> @location(0) vec4f {
  let radius = max(params.radius, 0.25);
  let axis = direction * vec2f(params.texelSizeX, params.texelSizeY) * radius;

  var weights: array<f32, 5> = array<f32, 5>(0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216);
  var blur = textureSample(bloomInput, bloomSampler, input.uv).rgb * weights[0];
  for (var i = 1; i < 5; i++) {
    let o = axis * f32(i);
    blur += textureSample(bloomInput, bloomSampler, input.uv + o).rgb * weights[i];
    blur += textureSample(bloomInput, bloomSampler, input.uv - o).rgb * weights[i];
  }
  return vec4f(blur, 1.0);
}
