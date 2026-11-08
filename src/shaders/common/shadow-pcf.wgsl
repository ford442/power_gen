// =============================================================
// Key-light shadow map (#225 §4): 3×3 PCF against the frame group's
// `shadowMap` (@group(0) @binding(9), depth32float), `shadowSampler`
// (@binding(10), comparison `less-equal`) and `shadow` (@binding(11)).
//
// The including pass declares those three globals; this chunk only declares
// the struct and the lookup, so it stays usable from any lit fragment shader.
// When the shadow pass did not run this frame (overview, below `high`, WebGL2
// has no equivalent) the host writes `params.x = 0` and binds a 1×1
// placeholder, so the lookup returns 1 without sampling.
//
// Host layout: src/visualizer/shadow-map.ts SHADOW_UNIFORM_FLOATS.
// =============================================================

struct ShadowUniforms {
  /** World → key-light clip space (orthographic; the key light is directional). */
  lightViewProj: mat4x4f,
  /** x: enabled (0/1), y: 1 / map size, z: depth bias (NDC), w: strength 0..1. */
  params: vec4f,
  /** x: normal offset (world units, scaled by 1 - N·L), yzw: unused. */
  params2: vec4f,
}

/**
 * Fraction of the key light reaching `worldPos` (1 = lit). `N` is the
 * geometric normal; `L` the direction towards the key light.
 */
fn keyLightVisibility(worldPos: vec3f, N: vec3f, L: vec3f) -> f32 {
  if (shadow.params.x < 0.5) {
    return 1.0;
  }
  // Normal offset grows towards grazing angles, where acne starts.
  let slope = 1.0 - clamp(dot(N, L), 0.0, 1.0);
  let p = shadow.lightViewProj * vec4f(worldPos + N * (shadow.params2.x * (0.25 + slope)), 1.0);
  let ndc = p.xyz / p.w;
  let uv = ndc.xy * vec2f(0.5, -0.5) + vec2f(0.5);
  if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0)) || ndc.z > 1.0) {
    return 1.0;
  }
  let refDepth = ndc.z - shadow.params.z;
  let texel = shadow.params.y;
  var lit = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      // *Level: no derivatives, so the early returns above are legal.
      lit += textureSampleCompareLevel(shadowMap, shadowSampler, uv + vec2f(f32(x), f32(y)) * texel, refDepth);
    }
  }
  return mix(1.0, lit / 9.0, shadow.params.w);
}
