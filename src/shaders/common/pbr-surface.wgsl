// Auto-sourced from pbr-wgsl-chunks; edit either, keep in sync via pbr-wgsl-chunks loaders.
fn hash3(p: vec3f) -> vec3f {
    let q = vec3f(
      dot(p, vec3f(127.1, 311.7, 74.7)),
      dot(p, vec3f(269.5, 183.3, 246.1)),
      dot(p, vec3f(113.5, 271.9, 124.6))
    );
    return fract(sin(q) * 43758.5453);
  }

  fn fbm(p: vec3f) -> f32 {
    var value = 0.0;
    var amplitude = 0.5;
    var pos = p;
    for (var i = 0; i < 4; i++) {
      let h = hash3(floor(pos * 3.0));
      value += (h.x * 2.0 - 1.0) * amplitude;
      pos = pos * 2.1 + vec3f(1.7, 2.3, 0.9);
      amplitude *= 0.5;
    }
    return clamp(value * 0.5 + 0.5, 0.0, 1.0);
  }

  fn detailNormal(n: vec3f, p: vec3f, detailScale: f32) -> vec3f {
    let upRef = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(n.y) > 0.94);
    let t = normalize(cross(upRef, n));
    let b = cross(n, t);
    let dn1 = fbm(p * detailScale + vec3f(0.3, 4.2, 1.1)) - 0.5;
    let dn2 = fbm(p * detailScale + vec3f(3.7, 0.8, 2.4)) - 0.5;
    return normalize(n + t * dn1 * 0.22 + b * dn2 * 0.22);
  }

  /** Axial brushing for cylindrical rollers / rings (tangent along Y). */
  fn brushedMetalNormal(n: vec3f, p: vec3f, brushScale: f32, strength: f32) -> vec3f {
    let upRef = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(n.y) > 0.94);
    let tangent = normalize(cross(upRef, n));
    let bitangent = cross(n, tangent);
    let brush = fbm(vec3f(p.y * brushScale, atan2(p.z, p.x) * 2.0, 0.0)) - 0.5;
    let micro = fbm(p * brushScale * 2.5) - 0.5;
    return normalize(n + tangent * brush * strength + bitangent * micro * strength * 0.35);
  }

  /** Circular knurling for plate edges and ring faces. */
  fn knurlNormal(n: vec3f, p: vec3f, freq: f32, strength: f32) -> vec3f {
    let theta = atan2(p.z, p.x);
    let knurl = sin(theta * freq + p.y * freq * 0.4) * 0.5;
    let upRef = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(n.y) > 0.94);
    let t = normalize(cross(upRef, n));
    return normalize(n + t * knurl * strength);
  }
