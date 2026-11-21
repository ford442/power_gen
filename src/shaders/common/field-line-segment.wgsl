// One drawn segment of a field line or particle trail (ADR-0017). 32 B of
// scalars, the same stride as FluxSegment (flux-line-tracer.wgsl), so the
// billboard shading is shared. `age` < 0 marks an unused slot: the vertex
// shader moves it outside the clip volume instead of drawing a dot.
struct FieldLineSegment {
  startX: f32,
  startY: f32,
  startZ: f32,
  endX: f32,
  endY: f32,
  endZ: f32,
  strength: f32, // |B| (mT) for lines; speed fraction for particle trails
  age: f32,      // position along the line 0..1 (or trail age); < 0 = unused
}
