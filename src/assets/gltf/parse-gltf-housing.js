/**
 * SEG glTF prop registry re-exports (compat).
 * Canonical registry: `./prop-registry.js` (ADR-0005).
 */
export {
  parseGltfHousingEnabled,
  parseGltfCoilFormerEnabled,
  SEG_HOUSING_GLB_URL,
  SEG_COIL_FORMER_GLB_URL,
  SEG_GLTF_PROPS,
  getPropDef,
  resolvePropMaterial
} from './prop-registry.js';
