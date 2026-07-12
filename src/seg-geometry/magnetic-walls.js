import { makeGeomBuffers } from './helpers.js';

// ----------------------------------------------------------------------------
// 6c. MAGNETIC WALL SHELLS (Roschin–Godin anomalous environmental effect)
// ----------------------------------------------------------------------------
// Generates N open-ended concentric cylindrical shells used as extremely faint
// refractive/shimmer markers for zones of increased magnetic flux. The shells
// are drawn double-sided with depth-write disabled so they act as a pure
// atmospheric overlay around the SEG device.
// ----------------------------------------------------------------------------

export function generateMagneticWallShells(device, options = {}) {
  const {
    innerRadius = 1.6,
    spacing = 0.55,
    shellThickness = 0.06,
    height = 8.0,
    maxShells = 5,
    segments = 96
  } = options;

  const vertices = [];
  const indices = [];
  let baseVertex = 0;

  for (let s = 0; s < maxShells; s++) {
    const radius = innerRadius + s * spacing;
    const halfH = height / 2;

    // Each shell has two rings of vertices: inner surface and outer surface.
    // We build side quads only (no caps) so the shell is open-ended.
    for (let i = 0; i <= segments; i++) {
      const theta = (i / segments) * Math.PI * 2;
      const c = Math.cos(theta);
      const sn = Math.sin(theta);

      // Outer surface vertex
      vertices.push(
        c * (radius + shellThickness * 0.5), -halfH, sn * (radius + shellThickness * 0.5),
        c, 0.0, sn,
        i / segments, 0.0
      );
      vertices.push(
        c * (radius + shellThickness * 0.5),  halfH, sn * (radius + shellThickness * 0.5),
        c, 0.0, sn,
        i / segments, 1.0
      );

      // Inner surface vertex (normal inverted)
      vertices.push(
        c * (radius - shellThickness * 0.5), -halfH, sn * (radius - shellThickness * 0.5),
        -c, 0.0, -sn,
        i / segments, 0.0
      );
      vertices.push(
        c * (radius - shellThickness * 0.5),  halfH, sn * (radius - shellThickness * 0.5),
        -c, 0.0, -sn,
        i / segments, 1.0
      );
    }

    // Indices for outer and inner side strips.
    for (let i = 0; i < segments; i++) {
      const outerBase = baseVertex + i * 4;
      const nextOuter = baseVertex + (i + 1) * 4;
      // Outer side: two triangles
      indices.push(outerBase, nextOuter, outerBase + 1);
      indices.push(outerBase + 1, nextOuter, nextOuter + 1);
      // Inner side: two triangles (winding reversed for inward normal)
      indices.push(outerBase + 2, outerBase + 3, nextOuter + 2);
      indices.push(outerBase + 3, nextOuter + 3, nextOuter + 2);
    }

    baseVertex += (segments + 1) * 4;
  }

  const vertexData = new Float32Array(vertices.length);
  vertexData.set(vertices);
  const indexData = new Uint16Array(indices);

  return makeGeomBuffers(device, { vertices: vertexData, indices: indexData });
}
