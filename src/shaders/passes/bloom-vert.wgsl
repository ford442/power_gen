struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f
}

// Full-screen triangle for every post pass (bloom, TAA, composite). `uv` is in
// texture space — (0,0) top-left, v down — so a pass that samples its input at
// `uv` writes it back in the same orientation. NDC y is up, so v = 0.5 - y/2;
// a plain `pos * 0.5 + 0.5` flipped the image once per pass (upside-down
// composite without TAA, TAA history misregistered, legacy bloom mirrored).
@vertex
fn main(@builtin(vertex_index) vi: u32) -> VertexOutput {
  var pos = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f( 3.0, -1.0),
    vec2f(-1.0,  3.0)
  );
  var o: VertexOutput;
  o.position = vec4f(pos[vi], 0.0, 1.0);
  o.uv = vec2f(pos[vi].x * 0.5 + 0.5, 0.5 - pos[vi].y * 0.5);
  return o;
}
