import { createDetailedRollerBuffers } from '../seg-roller-model.js';

// ----------------------------------------------------------------------------
// 2. POLE-BANDED ROLLER (replaces smooth cylinder)
// ----------------------------------------------------------------------------
// Prototype-accurate SEG roller geometry.
//
// Reference grounding (rexresearch.com/searl4, Roschin-Godin reports):
//   - Real rollers are 8 stacked segments held together magnetically
//     (~34 g each, machined to ±0.05 g), separated by fine seam grooves.
//   - The visible barrel is the outer copper/aluminum sleeve; axial seams are
//     darkened/oxidized grooves.
//   - The radial layer composition (visible on the flat end faces) is:
//       1. Neodymium core          — electron reservoir, silver-gray
//       2. Nylon 66 / Teflon       — electron flow regulator, off-white/ivory
//       3. Iron or Nickel          — magnetized accelerator, bright nickel
//       4. Copper or Aluminum      — outer paramagnetic sleeve
//
// This generator builds:
//   - A single top and bottom end-cap disk (shader draws concentric rings).
//   - 8 axial barrel segments of the outer sleeve.
//   - 7 recessed groove rings between segments.
//
// Shader UV convention:
//   - End caps:   uv.x = angle/2π,  uv.y = radial fraction (0 center -> 1 edge)
//   - Barrel:     uv.x = angle/2π,  uv.y = height fraction (0 bottom -> 1 top)
//   - Grooves:    uv.x = angle/2π,  uv.y = height fraction at groove center
// ----------------------------------------------------------------------------
export function generatePoleBandedRoller(device, options = {}) {
  return createDetailedRollerBuffers(device, options);
}
