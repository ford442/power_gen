/**
 * URL / runtime flags for hybrid glTF housing (WebGPU path only).
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

export const SEG_HOUSING_GLB_URL = './assets/seg/housing-shell.glb';
