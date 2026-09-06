/**
 * SEG glTF prop registry re-exports (compat).
 * Canonical registry: `./prop-registry.ts` (ADR-0005).
 */
export {
  parseGltfHousingEnabled,
  parseGltfCoilFormerEnabled,
  parseGltfStandEnabled,
  parseGltfBasePlateEnabled,
  SEG_HOUSING_GLB_URL,
  SEG_COIL_FORMER_GLB_URL,
  SEG_STAND_GLB_URL,
  SEG_BASE_PLATE_GLB_URL,
  SEG_GLTF_PROPS,
  getPropDef,
  resolvePropMaterial
} from './prop-registry';
