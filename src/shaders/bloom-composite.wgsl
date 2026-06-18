// Bloom pass 2: composite the original scene with the bloom layer, apply
// ACES tone-mapping, and add a smooth screen-space vignette.
//
// NOTE: BloomParams layout is shared with bloom-extract.wgsl so both passes
// can use the same 16-byte uniform buffer.  Fields unused here must not be
// removed — they are written by the host and consumed by the extract pass.

struct BloomParams {
  texelSizeX : f32,   // unused here (consumed by extract pass); layout padding
  texelSizeY : f32,   // unused here (consumed by extract pass); layout padding
  threshold  : f32,   // unused here (consumed by extract pass); layout padding
  strength   : f32,   // bloom additive strength multiplier (1.0–2.0 typical)
}

@group(0) @binding(0) var sceneTexC   : texture_2d<f32>;
@group(0) @binding(1) var bloomTexC   : texture_2d<f32>;
@group(0) @binding(2) var compSampler : sampler;
@group(0) @binding(3) var<uniform>    compParams: BloomParams;
@group(0) @binding(4) var depthTex    : texture_2d<f32>;

fn acesTonemap(x: vec3f) -> vec3f {
  // ACES fitted approximation (Hill / Narkowicz)
  let a = 2.51; let b = 0.03; let c = 2.43; let d = 0.59; let e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3f(0.0), vec3f(1.0));
}

// Low-cost screen-space cavity darkener. Samples the depth buffer in a small
// cross and darkens pixels that sit next to large depth discontinuities.
fn cheapSSAO(uv: vec2f) -> f32 {
  let center = textureSample(depthTex, compSampler, uv).r;
  if (center > 0.999) { return 0.0; }

  let texel = vec2f(compParams.texelSizeX, compParams.texelSizeY) * 2.5;
  let d1 = textureSample(depthTex, compSampler, uv + vec2f(texel.x, 0.0)).r;
  let d2 = textureSample(depthTex, compSampler, uv - vec2f(texel.x, 0.0)).r;
  let d3 = textureSample(depthTex, compSampler, uv + vec2f(0.0, texel.y)).r;
  let d4 = textureSample(depthTex, compSampler, uv - vec2f(0.0, texel.y)).r;

  let diff = abs(d1 - center) + abs(d2 - center) + abs(d3 - center) + abs(d4 - center);
  let ao = clamp(diff * 3.5 - 0.04, 0.0, 0.30);
  return ao * (1.0 - center * 0.5);
}

struct FragInput {
  @location(0) uv: vec2f,
}

@fragment
fn bloomCompositeFrag(input: FragInput) -> @location(0) vec4f {
  let scene = textureSample(sceneTexC, compSampler, input.uv).rgb;
  let bloom = textureSample(bloomTexC, compSampler, input.uv).rgb;

  // Low-cost SSAO cavity darkening (kept subtle so the floor grid survives).
  let ao = cheapSSAO(input.uv);
  let groundedScene = scene * (1.0 - ao * 0.35);

  // Additive bloom blended into scene
  let combined = groundedScene + bloom * compParams.strength;

  // ACES tone-mapping
  let tm = acesTonemap(combined);

  // Smooth radial vignette (screen-space, distance from centre)
  let vCoord  = input.uv * 2.0 - 1.0;
  let vigDist = dot(vCoord * vec2f(0.45, 0.55), vCoord * vec2f(0.45, 0.55));
  let vignette = 1.0 - smoothstep(0.55, 1.1, vigDist);

  return vec4f(tm * mix(0.25, 1.0, vignette), 1.0);
}
