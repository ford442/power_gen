// =============================================================
// FDTD slice panel (ADR-0010) — draws the TM_z grid as a world-space quad
// in the scene pass, in front of the owning device.
//
//   Ez (signed)  → warm (+) / cool (−) diverging ramp, tanh-compressed
//   |H|          → green glow (the coil's own magnetic field)
//   materials    → μ_r cells tinted violet, σ cells tinted slate, both outlined
//                  (ADR-0012) so the armature and copper turns are visibly
//                  *there* rather than an unexplained bend in the wave
//   windings     → ring with a dot (current out of the plane) or a cross (in)
//   sponge edge  → thin frame, so the absorbing band reads as "not vacuum"
//
// Alpha follows field strength, so a quiet grid leaves the device visible
// behind a faint panel tint. Colours are linear HDR like every other scene
// draw; bloom / TAA / tonemap see the panel as ordinary geometry.
//
// Bindings: docs/BINDINGS.md → `fdtdSlice`.
// =============================================================

#include "common/frame-uniforms.wgsl"
#include "common/fdtd-params.wgsl"

/// 32 B — packed by FdtdSlicePass._writeSliceParams.
struct FdtdSliceParams {
  center: vec3f,
  halfExtent: f32,
  ezGain: f32,
  hGain: f32,
  opacity: f32,
  _pad0: f32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<uniform> slice: FdtdSliceParams;
@group(0) @binding(2) var<uniform> params: FdtdParams;
@group(0) @binding(3) var<storage, read> ez: array<f32>;
@group(0) @binding(4) var<storage, read> hx: array<f32>;
@group(0) @binding(5) var<storage, read> hy: array<f32>;
/// (1/mu_r, electric half-step loss) per cell — ADR-0012.
@group(0) @binding(6) var<storage, read> materials: array<vec2f>;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vsMain(@builtin(vertex_index) vi: u32) -> VertexOutput {
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
    vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0)
  );
  let c = corners[vi];
  let world = slice.center + vec3f(c * slice.halfExtent, 0.0);
  var out: VertexOutput;
  out.position = uniforms.viewProj * vec4f(world, 1.0);
  out.uv = c * 0.5 + 0.5;
  return out;
}

/// which: 0 = Ez, 1 = Hx, 2 = Hy. Clamped to the grid.
fn cell(which: u32, x: i32, y: i32) -> f32 {
  let n = i32(params.n);
  let cx = clamp(x, 0, n - 1);
  let cy = clamp(y, 0, n - 1);
  let i = u32(cx + cy * n);
  if (which == 0u) { return ez[i]; }
  if (which == 1u) { return hx[i]; }
  return hy[i];
}

/// Material at a (clamped) cell: (1/mu_r, electric loss), vacuum when off.
fn materialCell(x: i32, y: i32) -> vec2f {
  if ((params.materialFlags & FDTD_FLAG_MATERIALS) == 0u) {
    return vec2f(1.0, 0.0);
  }
  let n = i32(params.n);
  let cx = clamp(x, 0, n - 1);
  let cy = clamp(y, 0, n - 1);
  return materials[u32(cx + cy * n)];
}

/// Occupancy of a material at a grid point, 0..1:
///   .x = permeable fraction (1 − 1/mu_r), .y = conductive fraction (loss)
fn materialAmount(gp: vec2f) -> vec2f {
  let m = materialCell(i32(round(gp.x)), i32(round(gp.y)));
  return vec2f(clamp(1.0 - m.x, 0.0, 1.0), clamp(m.y * 4.0, 0.0, 1.0));
}

fn bilinear(which: u32, gp: vec2f) -> f32 {
  let base = floor(gp);
  let f = gp - base;
  let x = i32(base.x);
  let y = i32(base.y);
  let a = mix(cell(which, x, y), cell(which, x + 1, y), f.x);
  let b = mix(cell(which, x, y + 1), cell(which, x + 1, y + 1), f.x);
  return mix(a, b, f.y);
}

/// Anti-aliased 1 → 0 edge; `w` is one screen pixel in the units of `d`.
/// Derivatives are taken once at the top of fsMain: WGSL only allows
/// fwidth in uniform control flow, and the winding loop below is not.
fn lineMask(d: f32, halfWidth: f32, w: f32) -> f32 {
  return 1.0 - smoothstep(halfWidth - w, halfWidth + w, abs(d));
}

@fragment
fn fsMain(input: VertexOutput) -> @location(0) vec4f {
  let n = f32(params.n);
  let gp = input.uv * (n - 1.0);
  let cellPx = max(length(fwidth(gp)), 1e-4);
  let uvPx = cellPx / (n - 1.0);

  // Field layers. Hx/Hy live half a cell off the Ez nodes; at 256² that
  // offset is invisible, so all three are sampled at the same point.
  let e = tanh(bilinear(0u, gp) * slice.ezGain);
  let hMag = length(vec2f(bilinear(1u, gp), bilinear(2u, gp)));
  let h = tanh(hMag * slice.hGain);

  let warm = vec3f(1.0, 0.42, 0.12);
  let cool = vec3f(0.15, 0.5, 1.0);
  let eCol = select(cool, warm, e > 0.0) * 1.35;
  let hCol = vec3f(0.3, 0.95, 0.55);

  var rgb = vec3f(0.02, 0.035, 0.06);
  var a = 0.1;

  // Materials sit *under* the field layers: the point is that the wave bends
  // around something the viewer can see, not that the shape hides the wave.
  let mat = materialAmount(gp);
  let ironCol = vec3f(0.42, 0.30, 0.62);
  let copperCol = vec3f(0.30, 0.34, 0.40);
  let matA = max(mat.x, mat.y) * 0.5;
  rgb = mix(rgb, mix(copperCol, ironCol, select(0.0, 1.0, mat.x > mat.y)), matA);
  a = max(a, matA);
  // Outline where *either* material starts, so both the armature and the copper
  // turns read as objects rather than as unexplained changes in the field.
  let mR = materialAmount(gp + vec2f(1.0, 0.0));
  let mL = materialAmount(gp - vec2f(1.0, 0.0));
  let mU = materialAmount(gp + vec2f(0.0, 1.0));
  let mD = materialAmount(gp - vec2f(0.0, 1.0));
  let matEdge = length(vec2f(
    max(mR.x, mR.y) - max(mL.x, mL.y),
    max(mU.x, mU.y) - max(mD.x, mD.y)
  ));
  rgb = mix(rgb, vec3f(0.72, 0.62, 0.95), matEdge * 0.6);
  a = max(a, matEdge * 0.6);

  let hA = h * 0.55;
  rgb = mix(rgb, hCol, hA);
  a = max(a, hA);
  let eA = abs(e);
  rgb = mix(rgb, eCol, eA);
  a = max(a, eA);

  // Sponge: dim the absorbing band and outline where it starts.
  let p = f32(params.pmlCells);
  let edge = n - 1.0;
  let inner = max(max(p - gp.x, gp.x - (edge - p)), max(p - gp.y, gp.y - (edge - p)));
  if (inner > 0.0) { a *= 0.6; }
  let frame = lineMask(inner, 0.35, cellPx) * 0.45;
  rgb = mix(rgb, vec3f(0.45, 0.55, 0.65), frame);
  a = max(a, frame);

  // Panel border.
  let border = lineMask(max(abs(input.uv.x - 0.5), abs(input.uv.y - 0.5)) - 0.5, 0.004, uvPx) * 0.7;
  rgb = mix(rgb, vec3f(0.5, 0.62, 0.75), border);
  a = max(a, border);

  // Winding cross-sections: ring + dot (out of plane) or cross (into plane).
  let count = min(params.sourceCount, FDTD_MAX_SOURCES);
  let ringR = params.sourceRadius * 1.9;
  for (var k = 0u; k < count; k++) {
    let s = params.sources[k];
    let d = gp - s.xy;
    let r = length(d);
    if (r > ringR * 1.6) { continue; }
    var mark = lineMask(r - ringR, 0.3, cellPx);
    if (s.w >= 0.0) {
      mark = max(mark, 1.0 - smoothstep(0.5, 0.9, r));
    } else if (r < ringR * 0.75) {
      mark = max(mark, max(lineMask(d.x - d.y, 0.3, cellPx), lineMask(d.x + d.y, 0.3, cellPx)));
    }
    let markCol = mix(vec3f(0.85, 0.6, 0.35), vec3f(1.2, 0.85, 0.5), clamp(abs(s.z), 0.0, 1.0));
    rgb = mix(rgb, markCol, mark * 0.9);
    a = max(a, mark * 0.9);
  }

  return vec4f(rgb, clamp(a * slice.opacity, 0.0, 1.0));
}
