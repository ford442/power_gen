/**
 * SEG glTF prop registry — lazy multi-prop CAD (ADR-0005).
 *
 * Housing + coil former are the first entries; stand / base plate slots are
 * reserved for later artist CAD. Load policies:
 *   - `resident` — load on first SEG focus, keep GPU buffers when leaving
 *   - `focus`    — load only in SEG focus; dispose buffers on mode leave
 *
 * WebGPU only. WebGL2 skips heavy glTF (docs/WEBGL2.md, docs/GLTF_ASSETS.md).
 */

/**
 * @param {URLSearchParams} [params]
 * @returns {boolean}
 */
export function parseGltfHousingEnabled(params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '')) {
  const raw = params.get('gltfHousing');
  if (raw === '0' || raw === 'false' || raw === 'off') return false;
  if (raw === '1' || raw === 'true' || raw === 'on') return true;
  if (typeof window !== 'undefined' && window.GLTF_HOUSING === false) return false;
  return true;
}

/**
 * Coil former prop — default on with housing; disable via ?gltfCoilFormer=0.
 * @param {URLSearchParams} [params]
 * @returns {boolean}
 */
export function parseGltfCoilFormerEnabled(params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '')) {
  const raw = params.get('gltfCoilFormer');
  if (raw === '0' || raw === 'false' || raw === 'off') return false;
  if (raw === '1' || raw === 'true' || raw === 'on') return true;
  return parseGltfHousingEnabled(params);
}

export const SEG_HOUSING_GLB_URL = './assets/seg/housing-shell.glb';
export const SEG_COIL_FORMER_GLB_URL = './assets/seg/coil-former.glb';

/** @typedef {'resident'|'focus'} PropLoadPolicy */

/**
 * @typedef {{
 *   ringIndex?: number,
 *   color?: [number, number, number],
 *   metallic?: number,
 *   roughness?: number,
 *   emissiveScale?: number
 * }} PropMaterialOverride
 */

/**
 * @typedef {object} SegGltfPropDef
 * @property {string} id
 * @property {string} url
 * @property {string} role
 * @property {PropLoadPolicy} loadPolicy
 * @property {(p?: URLSearchParams) => boolean} enabled
 * @property {PropMaterialOverride} materialOverride
 * @property {number} [softBudgetBytes] Soft byte budget for placeholder GLBs (PR template).
 * @property {boolean} [placeholder] Future / not yet authored — registry placeholder.
 */

/** @type {SegGltfPropDef[]} */
export const SEG_GLTF_PROPS = [
  {
    id: 'housing',
    url: SEG_HOUSING_GLB_URL,
    role: 'housing',
    loadPolicy: 'resident',
    enabled: parseGltfHousingEnabled,
    materialOverride: {
      ringIndex: 11.0,
      color: [0.78, 0.80, 0.84],
      metallic: 0.72,
      roughness: 0.32,
      emissiveScale: 1.0
    },
    softBudgetBytes: 50 * 1024
  },
  {
    id: 'coilFormer',
    url: SEG_COIL_FORMER_GLB_URL,
    role: 'coil_former',
    loadPolicy: 'focus',
    enabled: parseGltfCoilFormerEnabled,
    materialOverride: {
      ringIndex: 12.0,
      color: [0.55, 0.42, 0.28],
      metallic: 0.15,
      roughness: 0.55,
      emissiveScale: 0.65
    },
    softBudgetBytes: 50 * 1024
  },
  // Reserved for later showroom CAD — not loaded until url + generator exist.
  {
    id: 'stand',
    url: './assets/seg/stand.glb',
    role: 'stand',
    loadPolicy: 'focus',
    enabled: () => false,
    materialOverride: {
      ringIndex: 13.0,
      color: [0.35, 0.36, 0.38],
      metallic: 0.55,
      roughness: 0.45,
      emissiveScale: 0.4
    },
    softBudgetBytes: 50 * 1024,
    placeholder: true
  },
  {
    id: 'basePlate',
    url: './assets/seg/base-plate.glb',
    role: 'base_plate',
    loadPolicy: 'focus',
    enabled: () => false,
    materialOverride: {
      ringIndex: 13.0,
      color: [0.28, 0.28, 0.30],
      metallic: 0.6,
      roughness: 0.4,
      emissiveScale: 0.35
    },
    softBudgetBytes: 50 * 1024,
    placeholder: true
  }
];

/** @param {string} id */
export function getPropDef(id) {
  return SEG_GLTF_PROPS.find((p) => p.id === id) ?? null;
}

/** Props that should be resident after first SEG focus. */
export function listResidentPropIds(params) {
  return SEG_GLTF_PROPS
    .filter((p) => !p.placeholder && p.loadPolicy === 'resident' && p.enabled(params))
    .map((p) => p.id);
}

/** Props loaded only while SEG is focused (disposed on leave). */
export function listFocusPropIds(params) {
  return SEG_GLTF_PROPS
    .filter((p) => !p.placeholder && p.loadPolicy === 'focus' && p.enabled(params))
    .map((p) => p.id);
}

/**
 * Resolve material for a drawable: registry override wins over glTF extras.
 * @param {SegGltfPropDef} prop
 * @param {{ materialRingIndex?: number, material?: object }} drawable
 */
export function resolvePropMaterial(prop, drawable = {}) {
  const ov = prop.materialOverride || {};
  const ring =
    ov.ringIndex ??
    drawable.materialRingIndex ??
    drawable.material?.ringIndex ??
    11.0;
  const color = ov.color ?? drawable.material?.color ?? [0.74, 0.76, 0.8];
  return {
    ringIndex: ring,
    color,
    metallic: ov.metallic,
    roughness: ov.roughness,
    emissiveScale: ov.emissiveScale ?? 1.0
  };
}
