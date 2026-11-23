// =============================================================
// IR view (`?thermal=1`, docs/FLUIDS.md → IR view): false colour by
// temperature. Host: src/thermal/ir-view.ts — `IR_RAMP` is mirrored there
// and in renderers/webgl2/shaders.js (scripts/tests/ir-view.test.mjs).
//
// A mesh shader reads the bench's code from its material block:
//   0       the view is off
//   1 + t   the whole bench at t (0..1) on the ramp
//   3       each instance's own colour is already its ramp colour
// =============================================================

const IR_RAMP = array<vec3f, 6>(
  vec3f(0.0, 0.0, 0.1),
  vec3f(0.35, 0.02, 0.5),
  vec3f(0.78, 0.12, 0.36),
  vec3f(0.98, 0.48, 0.08),
  vec3f(1.0, 0.85, 0.25),
  vec3f(1.0, 1.0, 0.95)
);

fn irRamp(t: f32) -> vec3f {
  let x = clamp(t, 0.0, 1.0) * 5.0;
  let i = u32(min(floor(x), 4.0));
  return mix(IR_RAMP[i], IR_RAMP[i + 1u], x - f32(i));
}

/// True when the bench is drawn in the IR view.
fn irOn(code: f32) -> bool {
  return code > 0.5;
}

/// Scene level the ramp is written at. The scene is HDR and goes through the
/// tone curve like everything else; at full level the curve's shoulder would
/// bleach the ramp's hot half towards white and it would stop matching its
/// legend. Tuned by eye against the legend on the three looks, not derived.
const IR_SCENE_LEVEL: f32 = 0.5;

/// The fragment's colour in the IR view: the ramp, with just enough of the
/// view angle left in it to keep the shape. Unlit — the colour is the reading.
fn irShade(code: f32, instanceColor: vec3f, nDotV: f32) -> vec3f {
  var c = instanceColor;
  if (code < 2.5) { c = irRamp(code - 1.0); }
  return c * IR_SCENE_LEVEL * (0.72 + 0.28 * clamp(nDotV, 0.0, 1.0));
}
