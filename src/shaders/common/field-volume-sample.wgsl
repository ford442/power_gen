// Sample the field volume at a device-local scene-unit point (ADR-0017).
// Texel centres sit at min + (i + ½)/n · extent, which is exactly where a
// linear, clamp-to-edge `textureSampleLevel` puts them — sampleFieldVolume()
// in src/physics/field-volume.ts is the CPU twin.
fn fieldVolumeUvw(p: vec3f, bmin: vec3f, bmax: vec3f) -> vec3f {
  return (p - bmin) / (bmax - bmin);
}

fn fieldInside(p: vec3f, bmin: vec3f, bmax: vec3f) -> bool {
  return all(p >= bmin) && all(p <= bmax);
}
