// Bloom post uniform block — shared by extract, blur, composite passes.
// Must stay in lockstep with packPostUniforms() (npm run check:post).

struct BloomParams {
  texelSizeX: f32,
  texelSizeY: f32,
  threshold:  f32,
  knee:       f32,
  strength:   f32,
  radius:     f32,
  power:      f32,
  grain:      f32,
  aberration: f32,
  vignette:   f32,
  motionBlur: f32,
  exposure:   f32,
  coronaBoost: f32,
  ssaoStrength: f32,
  contactShadow: f32,
  skyMode:    f32,
  // SSR reflection gain: preset ssrStrength x tier gate x ?ssr= override.
  ssrStrength: f32,
  // 1 = skip filmic curve (linear HDR for canvas toneMapping.extended).
  outputLinearHdr: f32,
  // 0 = legacy 3-pass bloom (composite widens it with 5 taps); > 0 = the
  // linear pipeline's mip chain, read once and scaled by this (1 / levels).
  bloomChainScale: f32,
  // How the composite's result reaches the canvas (see color-pipeline.ts):
  //   0 legacy   tonemapped linear written as-is to a UNORM view (no encode)
  //   1 srgbView canvas -srgb view encodes in hardware; grading runs encoded
  //   2 shader   composite applies the sRGB OETF (float HDR canvas)
  outputTransfer: f32,
}
