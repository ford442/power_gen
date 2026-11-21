// |B| colour ramp shared by the field slice (WebGPU) and its WebGL2 readout
// (fieldColormap() in src/physics/field-colormap.ts holds the same stops):
// deep blue → teal → green → amber → white, on log10 |B| between two bounds.
fn fieldColormap(t: f32) -> vec3f {
  let x = clamp(t, 0.0, 1.0);
  let c0 = vec3f(0.05, 0.07, 0.30);
  let c1 = vec3f(0.05, 0.45, 0.62);
  let c2 = vec3f(0.25, 0.78, 0.38);
  let c3 = vec3f(0.98, 0.70, 0.15);
  let c4 = vec3f(1.00, 0.97, 0.88);
  if (x < 0.25) {
    return mix(c0, c1, x * 4.0);
  }
  if (x < 0.5) {
    return mix(c1, c2, (x - 0.25) * 4.0);
  }
  if (x < 0.75) {
    return mix(c2, c3, (x - 0.5) * 4.0);
  }
  return mix(c3, c4, (x - 0.75) * 4.0);
}

// log10 |B| mapped to 0..1 between lo and hi (mT).
fn fieldColorT(mt: f32, lo: f32, hi: f32) -> f32 {
  return (log2(max(mt, 1e-9)) - log2(lo)) / max(log2(hi) - log2(lo), 1e-6);
}
