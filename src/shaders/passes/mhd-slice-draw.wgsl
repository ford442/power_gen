// =============================================================
// MHD duct slice — the picture (docs/FLUIDS.md → MHD duct → The slice).
// A world-space panel in the scene pass, in front of the bench: the duct's
// mid-plane seen from above, flow left to right, electrodes top and bottom.
//
//   speed            → heat map, 0 … speedFull (dark blue → yellow)
//   current          → lines: contours of its stream function (computed by
//                      mhd-slice-phi.wgsl), so they are the current's own
//                      paths and their spacing its density
//   electrode pairs  → bars on the two side walls, lit by their voltage
//   pole faces       → brackets where the field is half its peak
//   bottom strip     → the speed ramp, as a legend
//
// Reads the solver's buffers directly; nothing is copied. Colours are linear
// HDR like every other scene draw.
//
// Bindings: docs/BINDINGS.md → `mhdSliceDraw`.
// =============================================================

#include "common/frame-uniforms.wgsl"
#include "common/mhd-slice.wgsl"

/// 64 B — packed by MhdSlicePass (src/fluids/mhd-slice.ts → packMhdSliceDraw).
struct MhdSliceDraw {
  /// Panel centre, world.
  center: vec3f,
  /// Lattice speed drawn as the top of the ramp.
  speedFull: f32,
  /// Half-extents along the flow and across it, world vectors.
  right: vec3f,
  /// Stream-function step between two current lines.
  lineStep: f32,
  up: vec3f,
  opacity: f32,
  /// Electrode voltage drawn at full brightness (lattice units).
  voltFull: f32,
  /// Share of the panel's height below the duct given to the legend strip.
  legend: f32,
  _pad: vec2f,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(1) @binding(1) var<uniform> draw: MhdSliceDraw;
@group(1) @binding(2) var<uniform> params: MhdSliceParams;
@group(1) @binding(3) var<storage, read> columns: array<vec4f>;
@group(1) @binding(4) var<storage, read> moments: array<vec4f>;
@group(1) @binding(6) var<storage, read> state: array<f32>;

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
  let world = draw.center + c.x * draw.right + c.y * draw.up;
  var out: VertexOutput;
  out.position = uniforms.viewProj * vec4f(world, 1.0);
  out.uv = c * 0.5 + 0.5;
  return out;
}

fn velocityAt(i: i32, j: i32) -> vec2f {
  let ci = u32(clamp(i, 0, i32(params.nx) - 1));
  let cj = u32(clamp(j, 0, i32(params.ny) - 1));
  return moments[cj * params.nx + ci].xy;
}

fn speedAt(gp: vec2f) -> f32 {
  let base = floor(gp - 0.5);
  let f = gp - 0.5 - base;
  let x = i32(base.x);
  let y = i32(base.y);
  let a = mix(length(velocityAt(x, y)), length(velocityAt(x + 1, y)), f.x);
  let b = mix(length(velocityAt(x, y + 1)), length(velocityAt(x + 1, y + 1)), f.x);
  return mix(a, b, f.y);
}

/// The current's stream function (mhd-slice-phi.wgsl → streamFunction), bilinear between cell centres.
fn streamAt(gp: vec2f) -> f32 {
  let p = clamp(gp - 0.5, vec2f(0.0), vec2f(f32(params.nx) - 1.0, f32(params.ny) - 1.0));
  let base = floor(p);
  let f = p - base;
  let x0 = u32(base.x);
  let y0 = u32(base.y);
  let x1 = min(x0 + 1u, params.nx - 1u);
  let y1 = min(y0 + 1u, params.ny - 1u);
  let a = mix(moments[y0 * params.nx + x0].w, moments[y0 * params.nx + x1].w, f.x);
  let b = mix(moments[y1 * params.nx + x0].w, moments[y1 * params.nx + x1].w, f.x);
  return mix(a, b, f.y);
}

/// Dark blue → teal → green → yellow.
fn ramp(t: f32) -> vec3f {
  let x = clamp(t, 0.0, 1.0);
  let a = vec3f(0.03, 0.05, 0.22);
  let b = vec3f(0.02, 0.36, 0.55);
  let c = vec3f(0.18, 0.72, 0.38);
  let d = vec3f(1.15, 0.95, 0.18);
  if (x < 0.33) { return mix(a, b, x / 0.33); }
  if (x < 0.66) { return mix(b, c, (x - 0.33) / 0.33); }
  return mix(c, d, (x - 0.66) / 0.34);
}

fn lineMask(d: f32, halfWidth: f32, w: f32) -> f32 {
  return 1.0 - smoothstep(halfWidth - w, halfWidth + w, abs(d));
}

@fragment
fn fsMain(input: VertexOutput) -> @location(0) vec4f {
  let nx = f32(params.nx);
  let ny = f32(params.ny);
  // The duct fills the panel above the legend strip.
  let ductV = (input.uv.y - draw.legend) / (1.0 - draw.legend);
  let gp = vec2f(input.uv.x * nx, ductV * ny);
  let uvPx = max(length(fwidth(input.uv)), 1e-6);

  // Derivatives are taken here, before any branch: WGSL only allows them in uniform control flow.
  // Current lines: contours of the stream function.
  let lines = streamAt(gp) / max(draw.lineStep, 1e-9);
  let wLine = max(fwidth(lines), 1e-4);

  var rgb = vec3f(0.015, 0.02, 0.035);
  let alpha = 0.92;

  if (ductV < 0.0) {
    // Legend: the ramp along the strip, with a gap under the duct.
    let band = input.uv.y / draw.legend;
    if (band > 0.2 && band < 0.7 && input.uv.x > 0.02 && input.uv.x < 0.98) {
      rgb = ramp((input.uv.x - 0.02) / 0.96);
    }
  } else {
    let i = u32(clamp(gp.x, 0.0, nx - 1.0));
    let speed = speedAt(gp);
    rgb = ramp(speed / max(draw.speedFull, 1e-6));

    // A line where the stream function crosses a multiple of the step; faded out where they would merge.
    let dLine = abs(fract(lines - 0.5) - 0.5);
    let current = (1.0 - smoothstep(0.6 * wLine, 1.6 * wLine, dLine)) * (1.0 - smoothstep(0.25, 0.5, wLine));
    rgb = mix(rgb, vec3f(1.6, 1.5, 1.3), current * 0.75);

    // Pole faces: where the field passes half its peak.
    let shape = columns[i].x;
    let shapeNext = columns[min(i + 1u, params.nx - 1u)].x;
    if ((shape - 0.5) * (shapeNext - 0.5) <= 0.0 && shape != shapeNext) {
      let dash = step(0.5, fract(gp.y * 0.25));
      rgb = mix(rgb, vec3f(1.4, 0.45, 0.4), 0.8 * dash);
    }

    // Electrode pairs on the two side walls, lit by their voltage: + on top, - below.
    let seg = columns[i].z;
    let wallBand = 2.0;
    if (seg >= 0.0 && (gp.y < wallBand || gp.y > ny - wallBand)) {
      let v = clamp(abs(state[params.nx + u32(seg)]) / max(draw.voltFull, 1e-9), 0.0, 1.0);
      let plus = vec3f(1.5, 0.75, 0.25);
      let minus = vec3f(0.3, 0.75, 1.5);
      let col = select(minus, plus, gp.y > ny * 0.5);
      rgb = mix(vec3f(0.35, 0.37, 0.4), col, 0.25 + 0.75 * v);
    } else if (gp.y < 0.35 || gp.y > ny - 0.35) {
      // Insulating wall.
      rgb = vec3f(0.12, 0.13, 0.15);
    }
  }

  // Panel border.
  let border = lineMask(max(abs(input.uv.x - 0.5), abs(input.uv.y - 0.5)) - 0.5, 0.004, uvPx) * 0.7;
  rgb = mix(rgb, vec3f(0.5, 0.62, 0.75), border);
  return vec4f(rgb, clamp(alpha * draw.opacity, 0.0, 1.0));
}
