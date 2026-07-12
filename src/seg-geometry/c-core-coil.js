import { _buildBoxPart, _buildWindingPart } from './helpers.js';

// ----------------------------------------------------------------------------
// 6b. C-SHAPED PICKUP COIL (replaces floating torus/cylinder coils)
// ----------------------------------------------------------------------------
// Documented SEG prototypes show laminated C-core electromagnets straddling the
// outer roller ring. This generator produces three separate mesh parts that
// share one instance buffer: the laminated iron C-core, the enameled copper
// winding bundle on the core back, and a small mounting foot.
// ----------------------------------------------------------------------------
export function generateCCorePickupCoil(device, options = {}) {
  const {
    coilRadius = 7.2,
    jawReach = 1.7,
    coreWidth = 1.8,
    coreHeight = 0.70,
    coreThickness = 0.45,
    armWidth = 0.45,
    windingWidth = 1.4,
    windingHeight = 0.9,
    windingThickness = 0.85
  } = options;

  // Local-space C-core: opening faces -Z, back at +Z.
  const backZ = jawReach * 0.35; // back bar sits slightly outward
  const jawZ = -jawReach;
  const sideX = coreWidth / 2;
  const halfH = coreHeight / 2;

  // Core = back bar + two side arms.
  const coreBoxes = [
    {
      center: [0, 0, backZ],
      size: [coreWidth, coreHeight, coreThickness],
      uvScale: [1 / coreWidth, 1 / coreHeight]
    },
    {
      center: [sideX, 0, (backZ + jawZ) / 2],
      size: [armWidth, coreHeight, backZ - jawZ + coreThickness],
      uvScale: [1 / armWidth, 1 / coreHeight]
    },
    {
      center: [-sideX, 0, (backZ + jawZ) / 2],
      size: [armWidth, coreHeight, backZ - jawZ + coreThickness],
      uvScale: [1 / armWidth, 1 / coreHeight]
    }
  ];

  // Mounting foot: small tab extending from core back down to base plate.
  const footBoxes = [
    {
      center: [0, -halfH - 0.25, backZ + 0.05],
      size: [0.6, 0.5, 0.3],
      uvScale: [2, 2]
    },
    {
      center: [0, -halfH - 0.45, backZ + 0.25],
      size: [0.9, 0.15, 0.7],
      uvScale: [2, 2]
    }
  ];

  return {
    core: _buildBoxPart(device, coreBoxes),
    winding: _buildWindingPart(device, {
      backZ: backZ + coreThickness * 0.5 + windingThickness * 0.1,
      width: windingWidth,
      height: windingHeight,
      thickness: windingThickness
    }),
    foot: _buildBoxPart(device, footBoxes)
  };
}
