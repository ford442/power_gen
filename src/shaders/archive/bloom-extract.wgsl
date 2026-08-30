// Bloom pass 1: extract bright areas above a soft-knee threshold, then apply
// a 9-tap Gaussian blur.  The result is written to the bloom accumulation texture.
//
// NOTE: BloomParams layout is shared with bloom-composite.wgsl so both passes
// can use the same 16-byte uniform buffer.  Fields unused here must not be
// removed — they are written by the host and consumed by the composite pass.

struct BloomParams {
  texelSizeX : f32,   // 1.0 / canvas width
  texelSizeY : f32,   // 1.0 / canvas height
  threshold  : f32,   // luminance threshold for bloom (0.55–0.75 typical)
  strength   : f32,   // unused here (consumed by composite pass); layout padding
}

@group(0) @binding(0) var sceneTex    : texture_2d<f32>;
@group(0) @binding(1) var bloomSampler: sampler;
@group(0) @binding(2) var<uniform>    bloomParams: BloomParams;

fn luminance(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

fn extractBright(c: vec3f, threshold: f32) -> vec3f {
  let knee = threshold * 0.18;
  let lum  = luminance(c);
  let w    = clamp((lum - threshold + knee) / max(knee, 0.001), 0.0, 1.0);
  return c * w;
}

struct FragInput {
  @location(0) uv: vec2f,
}

@fragment
fn bloomExtractFrag(input: FragInput) -> @location(0) vec4f {
  let tx = bloomParams.texelSizeX;
  let ty = bloomParams.texelSizeY;
  let t  = bloomParams.threshold;

  // 3×3 Gaussian: centre 0.25, edges 0.125, corners 0.0625
  // var (not let) so loop indices are valid — const arrays reject dynamic indexing.
  var offsets: array<vec2f, 9> = array<vec2f, 9>(
    vec2f(-tx, -ty), vec2f(0.0, -ty), vec2f(tx, -ty),
    vec2f(-tx,  0.0), vec2f(0.0, 0.0), vec2f(tx,  0.0),
    vec2f(-tx,  ty),  vec2f(0.0, ty),  vec2f(tx,  ty)
  );
  var weights: array<f32, 9> = array<f32, 9>(
    0.0625, 0.125, 0.0625,
    0.125,  0.25,  0.125,
    0.0625, 0.125, 0.0625
  );

  var bloom = vec3f(0.0);
  for (var i = 0; i < 9; i++) {
    let s = textureSample(sceneTex, bloomSampler, input.uv + offsets[i]).rgb;
    bloom += extractBright(s, t) * weights[i];
  }

  return vec4f(bloom, 1.0);
}
