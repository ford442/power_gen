/**
 * SEG glTF prop registry — housing shell + coil former (and future CAD).
 * WebGPU focus only; WebGL2 keeps procedural frame (docs/GLTF_ASSETS.md).
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
  // Follow housing master switch when unset
  return parseGltfHousingEnabled(params);
}

export const SEG_HOUSING_GLB_URL = './assets/seg/housing-shell.glb';
export const SEG_COIL_FORMER_GLB_URL = './assets/seg/coil-former.glb';

/**
 * @typedef {{ id: string, url: string, role: string, enabled: (p?: URLSearchParams) => boolean, defaultColor: [number, number, number] }} SegGltfPropDef
 */

/** @type {SegGltfPropDef[]} */
export const SEG_GLTF_PROPS = [
  {
    id: 'housing',
    url: SEG_HOUSING_GLB_URL,
    role: 'housing',
    enabled: parseGltfHousingEnabled,
    defaultColor: [0.78, 0.80, 0.84]
  },
  {
    id: 'coilFormer',
    url: SEG_COIL_FORMER_GLB_URL,
    role: 'coil_former',
    enabled: parseGltfCoilFormerEnabled,
    defaultColor: [0.55, 0.42, 0.28]
  }
];
