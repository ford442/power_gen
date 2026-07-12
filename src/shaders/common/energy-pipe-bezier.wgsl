// Cubic Bézier helpers for overview energy pipes.

fn bezier3(p0: vec3f, p1: vec3f, p2: vec3f, p3: vec3f, t: f32) -> vec3f {
  let u = 1.0 - t;
  let uu = u * u;
  let tt = t * t;
  let uuu = uu * u;
  let ttt = tt * t;
  return uuu * p0 + 3.0 * uu * t * p1 + 3.0 * u * tt * p2 + ttt * p3;
}

fn bezierTangent(p0: vec3f, p1: vec3f, p2: vec3f, p3: vec3f, t: f32) -> vec3f {
  let u = 1.0 - t;
  return 3.0 * u * u * (p1 - p0) + 6.0 * u * t * (p2 - p1) + 3.0 * t * t * (p3 - p2);
}
