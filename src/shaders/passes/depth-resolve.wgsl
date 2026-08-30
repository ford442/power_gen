// ============================================================================
// Manual MSAA depth resolve — ADR-0005 Workstream 2 (showroom G-buffer/MSAA)
// ============================================================================
// WebGPU resolves multisampled COLOR attachments automatically via
// `resolveTarget`, but has no equivalent for depth. When 4x MSAA is active
// (see render-loop.ts `msaaActive`), this fullscreen-triangle pass runs right
// after the main scene pass: it reads sample 0 of the multisampled depth
// buffer and writes it via @builtin(frag_depth) into a regular single-sample
// depth texture. SSR (`ssr-compute.wgsl`) and bloom-composite then bind that
// resolved texture exactly as they bind the non-MSAA depth buffer — neither
// pass needs to know MSAA happened.
//
// Bindings — see docs/BINDINGS.md ("depthResolve" group):
//   0 multisampled depth (texture_depth_multisampled_2d, FRAGMENT)

@group(0) @binding(0) var msaaDepthTex: texture_depth_multisampled_2d;

struct VertexOutput {
  @builtin(position) position: vec4f,
}

@vertex
fn vsMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  // Oversized triangle that covers the entire clip-space screen.
  var pos = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f( 3.0, -1.0),
    vec2f(-1.0,  3.0)
  );
  var output: VertexOutput;
  output.position = vec4f(pos[vertexIndex], 0.0, 1.0);
  return output;
}

@fragment
fn fsMain(@builtin(position) fragCoord: vec4f) -> @builtin(frag_depth) f32 {
  let coord = vec2i(fragCoord.xy);
  return textureLoad(msaaDepthTex, coord, 0);
}
