// Magnetostatic field sources (ADR-0017). WGSL twin of src/physics/field-eval.ts:
// same packed layout (src/physics/field-sources.ts), same kernels, same order of
// operations, so test:field-volume can hold them to the CPU reference.
//
// Units: metres, tesla. FieldSource is 64 B (4 × vec4f):
//   dipole    p0 = pos | kind, p1 = moment (A·m²) | core radius (m)
//   segment   p0 = start | kind, p1 = end | current (A), p2.x = wire radius (m)
//   box       p0 = centre | kind, p1 = half-size, p2 = quat (local → world), p3 = M (A/m, local)
//   cylinder  p0 = centre | kind, p1 = axis | radius, p2.x = half-length, p2.y = K (A/m)
#include "generated/field-sources.wgsl"

struct FieldSource {
  p0: vec4f,
  p1: vec4f,
  p2: vec4f,
  p3: vec4f,
}

const FIELD_MU0: f32 = 1.25663706212e-6;
const FIELD_MU0_4PI: f32 = 1.0e-7;
const FIELD_PI: f32 = 3.14159265358979;
const FIELD_HALF_PI: f32 = 1.5707963267949;
const FIELD_INV_4PI: f32 = 0.0795774715459;

fn fieldQuatRotate(q: vec4f, v: vec3f) -> vec3f {
  let t = 2.0 * cross(q.xyz, v);
  return v + q.w * t + cross(q.xyz, t);
}

fn fieldDipole(p: vec3f, s: FieldSource) -> vec3f {
  let r = p - s.p0.xyz;
  let m = s.p1.xyz;
  let rc = s.p1.w;
  let r2 = dot(r, r);
  if (r2 < rc * rc) {
    return (2.0 * FIELD_MU0_4PI / (rc * rc * rc)) * m;
  }
  let rl = sqrt(r2);
  let u = r / rl;
  let k = FIELD_MU0_4PI / (r2 * rl);
  return k * (3.0 * dot(m, u) * u - m);
}

fn fieldSegment(p: vec3f, s: FieldSource) -> vec3f {
  let a = s.p0.xyz - p;
  let b = s.p1.xyz - p;
  let current = s.p1.w;
  let rw = s.p2.x;
  let la = length(a);
  let lb = length(b);
  let lalb = la * lb;
  let den = lalb * (lalb + dot(a, b) + 2.0 * rw * rw);
  if (!(den > 1e-30)) {
    return vec3f(0.0);
  }
  let k = FIELD_MU0_4PI * current * (la + lb) / den;
  return k * cross(a, b);
}

// ln(v + r), stable when v is large and negative.
fn fieldLnVR(v: f32, r: f32, uw2: f32) -> f32 {
  if (v >= 0.0) {
    return log(v + r + 1e-30);
  }
  return log(uw2 / (r - v) + 1e-30);
}

// H/σ of the charged faces z = ±h.z (σ = +1 top, −1 bottom) at local point p.
fn fieldFacePairZ(p: vec3f, h: vec3f) -> vec3f {
  var f = vec3f(0.0);
  for (var face = 0u; face < 2u; face++) {
    let sigma = select(-1.0, 1.0, face == 0u);
    var w = p.z - select(-h.z, h.z, face == 0u);
    if (abs(w) < 1e-9) {
      w = select(1e-9, -1e-9, w < 0.0);
    }
    for (var i = 0u; i < 2u; i++) {
      let u = p.x - select(h.x, -h.x, i == 0u);
      let si = select(-1.0, 1.0, i == 0u);
      for (var j = 0u; j < 2u; j++) {
        let v = p.y - select(h.y, -h.y, j == 0u);
        let sj = select(-1.0, 1.0, j == 0u);
        let sgn = sigma * si * sj;
        let r = sqrt(u * u + v * v + w * w);
        f.x -= sgn * fieldLnVR(v, r, u * u + w * w);
        f.y -= sgn * fieldLnVR(u, r, v * v + w * w);
        f.z += sgn * atan2(u * v * sign(w), abs(w) * r);
      }
    }
  }
  return f * FIELD_INV_4PI;
}

fn fieldBox(p: vec3f, s: FieldSource) -> vec3f {
  let q = s.p2;
  let qi = vec4f(-q.xyz, q.w);
  let l = fieldQuatRotate(qi, p - s.p0.xyz);
  let h = s.p1.xyz;
  let m = s.p3.xyz;
  var H = vec3f(0.0);
  if (m.z != 0.0) {
    H += m.z * fieldFacePairZ(l, h);
  }
  if (m.x != 0.0) {
    let f = fieldFacePairZ(l.yzx, h.yzx);
    H += m.x * f.zxy;
  }
  if (m.y != 0.0) {
    let f = fieldFacePairZ(l.zxy, h.zxy);
    H += m.y * f.yzx;
  }
  if (abs(l.x) < h.x && abs(l.y) < h.y && abs(l.z) < h.z) {
    H += m;
  }
  return FIELD_MU0 * fieldQuatRotate(q, H);
}

// Bulirsch's generalised complete elliptic integral cel(kc, p, c, s).
fn fieldCel(kcIn: f32, p: f32, c: f32, s: f32) -> f32 {
  let errtol = 1e-7;
  var k = max(abs(kcIn), 1e-7);
  var pp = p;
  var cc = c;
  var ss = s;
  var em = 1.0;
  if (pp > 0.0) {
    pp = sqrt(pp);
    ss = ss / pp;
  } else {
    var f0 = k * k;
    var q = 1.0 - f0;
    let g0 = 1.0 - pp;
    f0 = f0 - pp;
    q = q * (ss - c * pp);
    pp = sqrt(f0 / g0);
    cc = (c - ss) / pp;
    ss = -q / (g0 * g0 * pp) + cc * pp;
  }
  var f = cc;
  cc = cc + ss / pp;
  var g = k / pp;
  ss = 2.0 * (ss + f * g);
  pp = g + pp;
  g = em;
  em = k + em;
  var kk = k;
  for (var it = 0u; it < 24u; it++) {
    if (!(abs(g - k) > g * errtol)) {
      break;
    }
    k = 2.0 * sqrt(kk);
    kk = k * em;
    f = cc;
    cc = cc + ss / pp;
    g = kk / pp;
    ss = 2.0 * (ss + f * g);
    pp = g + pp;
    g = em;
    em = k + em;
  }
  return FIELD_HALF_PI * (ss + cc * em) / (em * (em + pp));
}

fn fieldCylinder(p: vec3f, s: FieldSource) -> vec3f {
  let d = p - s.p0.xyz;
  let ax = s.p1.xyz;
  let a = s.p1.w;
  let b = s.p2.x;
  let K = s.p2.y;
  let z = dot(d, ax);
  let rv = d - z * ax;
  let rho = length(rv);
  let B0 = FIELD_MU0 * K / FIELD_PI;
  let zp = z + b;
  let zm = z - b;
  let apr = a + rho;
  let amr = a - rho;
  let dp = sqrt(zp * zp + apr * apr);
  let dm = sqrt(zm * zm + apr * apr);
  let alphaP = a / dp;
  let alphaM = a / dm;
  let betaP = zp / dp;
  let betaM = zm / dm;
  let gamma = amr / apr;
  let kp = sqrt((zp * zp + amr * amr) / (dp * dp));
  let km = sqrt((zm * zm + amr * amr) / (dm * dm));
  let Brho = B0 * (alphaP * fieldCel(kp, 1.0, 1.0, -1.0) - alphaM * fieldCel(km, 1.0, 1.0, -1.0));
  let g2 = gamma * gamma;
  let Bz = (B0 * a / apr) * (betaP * fieldCel(kp, g2, 1.0, gamma) - betaM * fieldCel(km, g2, 1.0, gamma));
  var B = Bz * ax;
  if (rho > 1e-9) {
    B += rv * (Brho / rho);
  }
  return B;
}

fn fieldSourceB(p: vec3f, s: FieldSource) -> vec3f {
  let kind = s.p0.w;
  if (kind == FIELD_KIND_DIPOLE) {
    return fieldDipole(p, s);
  }
  if (kind == FIELD_KIND_SEGMENT) {
    return fieldSegment(p, s);
  }
  if (kind == FIELD_KIND_BOX) {
    return fieldBox(p, s);
  }
  if (kind == FIELD_KIND_CYLINDER) {
    return fieldCylinder(p, s);
  }
  return vec3f(0.0);
}
