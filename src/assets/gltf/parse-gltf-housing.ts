/**
 * glTF prop registry re-exports (compat).
 * Canonical registry: `./prop-registry.ts` (ADR-0005).
 */
export {
  parseGltfHousingEnabled,
  parseGltfCoilFormerEnabled,
  parseGltfStandEnabled,
  parseGltfBasePlateEnabled,
  parseGltfTransformerCoreEnabled,
  parseGltfVdgTerminalEnabled,
  SEG_HOUSING_GLB_URL,
  SEG_COIL_FORMER_GLB_URL,
  SEG_STAND_GLB_URL,
  SEG_BASE_PLATE_GLB_URL,
  TRANSFORMER_CORE_GLB_URL,
  VDG_TERMINAL_GLB_URL,
  SEG_GLTF_PROPS,
  DEFAULT_PROP_DEVICE_ID,
  getPropDef,
  propsForDevice,
  listPropDeviceIds,
  listResidentPropIds,
  listFocusPropIds,
  allFocusPropIds,
  resolvePropMaterial
} from './prop-registry';
