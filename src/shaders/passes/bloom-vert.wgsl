struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f
}

@vertex
fn main(@builtin(vertex_index) vi: u32) -> VertexOutput {
  var pos = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f( 3.0, -1.0),
    vec2f(-1.0,  3.0)
  );
  var o: VertexOutput;
  o.position = vec4f(pos[vi], 0.0, 1.0);
  o.uv = pos[vi] * 0.5 + 0.5;
  return o;
}
