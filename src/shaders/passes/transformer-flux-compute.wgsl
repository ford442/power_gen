// Classroom transformer flux lines — toroidal-core metaphor (not FEM).
// Binding layout matches field-advect (storage + uniform). Output is FluxSegment
// (32 B packed scalars) so the existing fluxSegment billboard pipeline can draw.
//
// Each thread owns one field line and writes SEGMENTS_PER_LINE start/end pairs.

struct FluxSegment {
  startX: f32,
  startY: f32,
  startZ: f32,
  endX: f32,
  endY: f32,
  endZ: f32,
  strength: f32,
  age: f32,
}

struct TransformerFluxUniforms {
  time: f32,
  fluxN: f32,
  k: f32,
  segmentCount: f32,
}

@group(0) @binding(0) var<storage, read_write> segments: array<FluxSegment>;
@group(0) @binding(1) var<uniform> uniforms: TransformerFluxUniforms;

const PI: f32 = 3.14159265359;
const LINE_COUNT: u32 = 24u;
const SEGS_PER_LINE: u32 = 48u;
const TORUS_R: f32 = 0.55;
const TORUS_R_MINOR: f32 = 0.16;
const TORUS_CY: f32 = 0.25;

fn torusPoint(phi: f32, theta: f32) -> vec3f {
  let cr = TORUS_R + TORUS_R_MINOR * cos(theta);
  return vec3f(cr * cos(phi), TORUS_CY + cr * sin(phi), TORUS_R_MINOR * sin(theta));
}

// B along the core (e_phi) plus leakage that peels off the torus.
fn coreField(p: vec3f, fluxN: f32, k: f32) -> vec3f {
  let q = p - vec3f(0.0, TORUS_CY, 0.0);
  let rho = length(q.xy);
  let phi = atan2(q.y, q.x);
  let ePhi = vec3f(-sin(phi), cos(phi), 0.0);
  let radial = vec3f(cos(phi), sin(phi), 0.0);
  let eTheta = normalize(q - radial * TORUS_R);
  let tube = rho - TORUS_R;
  let inside = exp(-((tube * tube + q.z * q.z) / (TORUS_R_MINOR * TORUS_R_MINOR * 1.6)));
  let Bphi = fluxN * (0.35 + 0.65 * k) * inside;
  let Bleak = fluxN * (1.0 - k) * 0.22 * inside;
  return ePhi * Bphi + eTheta * Bleak + vec3f(0.0, 0.0, Bleak * 0.35 * sin(phi * 2.0));
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let lineIdx = gid.x;
  if (lineIdx >= LINE_COUNT) { return; }

  let fluxN = clamp(uniforms.fluxN, 0.0, 1.0);
  let k = clamp(uniforms.k, 0.0, 1.0);
  let t = uniforms.time;
  let theta0 = (f32(lineIdx) / f32(LINE_COUNT)) * PI * 2.0;
  let phi0 = t * (0.35 + fluxN * 0.8);

  var pos = torusPoint(phi0, theta0);
  let ds = 0.085;

  for (var s: u32 = 0u; s < SEGS_PER_LINE; s = s + 1u) {
    let B0 = coreField(pos, fluxN, k);
    let len0 = max(length(B0), 1e-6);
    let mid = pos + B0 / len0 * (ds * 0.5);
    let B1 = coreField(mid, fluxN, k);
    let len1 = max(length(B1), 1e-6);
    let nxt = pos + B1 / len1 * ds;

    let mag = 0.5 * (len0 + len1);
    let strength = (0.25 + fluxN) * 2.0e-6 * (0.4 + mag);
    let age = t + f32(s) * 0.08 + f32(lineIdx) * 0.17;

    let idx = lineIdx * SEGS_PER_LINE + s;
    var seg: FluxSegment;
    seg.startX = pos.x;
    seg.startY = pos.y;
    seg.startZ = pos.z;
    seg.endX = nxt.x;
    seg.endY = nxt.y;
    seg.endZ = nxt.z;
    seg.strength = strength;
    seg.age = age;
    segments[idx] = seg;

    pos = nxt;
  }
}
