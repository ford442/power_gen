/**
 * Named instance-buffer material tags (per-mesh `ringIndex` in packInstance).
 * Distinct from shader mode index (`getDeviceModeIndex`) written to device uniforms.
 *
 * @see docs/GLTF_ASSETS.md
 */

/** Steel central shaft (SEG core). */
export const MATERIAL_SHAFT = -1;

/** Default copper / generic cylinders. */
export const MATERIAL_COPPER = 0;

/** Steel base plate (Quanta apparatus). */
export const MATERIAL_STEEL_BASE = 1;

/** Solar battery cylinder. */
export const MATERIAL_SOLAR_BATTERY = 6;

/** Structural brass / aluminum plate (SEG plates, solar mount, glTF default). */
export const MATERIAL_STRUCTURAL = 11;

/** Coil former / tube mesh default. */
export const MATERIAL_COIL_FORMER = 12;

/** Dark lab bench base. */
export const MATERIAL_LAB_BASE = 13;

/** Quanta: Halbach ring segment / coil body. */
export const MATERIAL_QUANTA_COIL = 14;

/** Quanta: levitating disc / floater. */
export const MATERIAL_QUANTA_FLOATER = 15;

/** Quanta: secondary floater post. */
export const MATERIAL_QUANTA_FLOATER_POST = 16;

/** Quanta: magnet / cap segment. */
export const MATERIAL_QUANTA_MAGNET = 17;

/** Quanta: brush contact. */
export const MATERIAL_QUANTA_BRUSH = 18;

/** Quanta: Halbach slice visualizer segment. */
export const MATERIAL_QUANTA_HALBACH_SLICE = 20;

/** Kelvin induction torus (ring geometry in fragment shader). */
export const MATERIAL_KELVIN_RING = 100;

/** Solar panel disc (legacy shader convention). */
export const MATERIAL_SOLAR_PANEL = 200;
