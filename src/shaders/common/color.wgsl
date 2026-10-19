// sRGB transfer functions (IEC 61966-2-1) — the linear colour pipeline (#223).
//
// The SDR composite does not need these for its final write: it renders
// through the canvas's `-srgb` view and the hardware encodes. They exist for
// the few places that must work in display-referred space (grain / vignette
// grading) and for the HDR canvas, which is float and has no `-srgb` view but
// still expects encoded values (`srgb`-tagged canvas, WebGPU §3.11).

fn srgbEncodeChannel(x: f32) -> f32 {
  if (x <= 0.0031308) { return 12.92 * x; }
  return 1.055 * pow(x, 1.0 / 2.4) - 0.055;
}

fn srgbDecodeChannel(x: f32) -> f32 {
  if (x <= 0.04045) { return x / 12.92; }
  return pow((x + 0.055) / 1.055, 2.4);
}

/** Linear → sRGB-encoded. Extended: mirrors negatives and keeps the curve above 1.0. */
fn linearToSrgb(c: vec3f) -> vec3f {
  let s = sign(c);
  let a = abs(c);
  return s * vec3f(srgbEncodeChannel(a.r), srgbEncodeChannel(a.g), srgbEncodeChannel(a.b));
}

/** sRGB-encoded → linear (extended, as above). */
fn srgbToLinear(c: vec3f) -> vec3f {
  let s = sign(c);
  let a = abs(c);
  return s * vec3f(srgbDecodeChannel(a.r), srgbDecodeChannel(a.g), srgbDecodeChannel(a.b));
}

fn luma709(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}
