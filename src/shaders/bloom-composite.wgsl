// Bloom pass 2: composite the original scene with the bloom layer, apply
// ACES tone-mapping, and add a smooth screen-space vignette.

struct BloomParams {
  texelSizeX : f32,   // unused in this pass; reserved for alignment
  texelSizeY : f32,   // unused in this pass; reserved for alignment
  threshold  : f32,   // unused in this pass; reserved for alignment
  strength   : f32,   // bloom additive strength multiplier (1.0–2.0 typical)
}

@group(0) @binding(0) var sceneTexC   : texture_2d<f32>;
@group(0) @binding(1) var bloomTexC   : texture_2d<f32>;
@group(0) @binding(2) var compSampler : sampler;
@group(0) @binding(3) var<uniform>    compParams: BloomParams;

fn acesTonemap(x: vec3f) -> vec3f {
  // ACES fitted approximation (Hill / Narkowicz)
  let a = 2.51; let b = 0.03; let c = 2.43; let d = 0.59; let e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3f(0.0), vec3f(1.0));
}

struct FragInput {
  @location(0) uv: vec2f,
}

@fragment
fn bloomCompositeFrag(input: FragInput) -> @location(0) vec4f {
  let scene = textureSample(sceneTexC, compSampler, input.uv).rgb;
  let bloom = textureSample(bloomTexC, compSampler, input.uv).rgb;

  // Additive bloom blended into scene
  let combined = scene + bloom * compParams.strength;

  // ACES tone-mapping
  let tm = acesTonemap(combined);

  // Smooth radial vignette (screen-space, distance from centre)
  let vCoord  = input.uv * 2.0 - 1.0;
  let vigDist = dot(vCoord * vec2f(0.45, 0.55), vCoord * vec2f(0.45, 0.55));
  let vignette = 1.0 - smoothstep(0.55, 1.1, vigDist);

  return vec4f(tm * mix(0.25, 1.0, vignette), 1.0);
}
