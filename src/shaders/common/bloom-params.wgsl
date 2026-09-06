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
  _pad1:      f32,
  _pad2:      f32,
}
