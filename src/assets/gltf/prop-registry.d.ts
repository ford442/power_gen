/** Ambient types for the glTF prop registry (implementation stays JS). */

export type PropLoadPolicy = 'resident' | 'focus';

export interface PropMaterialOverride {
  ringIndex?: number;
  color?: [number, number, number];
  metallic?: number;
  roughness?: number;
  emissiveScale?: number;
}

export interface SegGltfPropDef {
  id: string;
  url: string;
  role: string;
  loadPolicy: PropLoadPolicy;
  enabled: (params?: URLSearchParams) => boolean;
  materialOverride?: PropMaterialOverride;
  softBudgetBytes?: number;
  placeholder?: boolean;
}

export const SEG_HOUSING_GLB_URL: string;
export const SEG_COIL_FORMER_GLB_URL: string;
export const SEG_GLTF_PROPS: SegGltfPropDef[];

export function parseGltfHousingEnabled(params?: URLSearchParams): boolean;
export function parseGltfCoilFormerEnabled(params?: URLSearchParams): boolean;
export function resolvePropMaterial(
  prop: SegGltfPropDef,
  nodeOrDrawable?: {
    materialRingIndex?: number;
    material?: Record<string, unknown>;
    [key: string]: unknown;
  }
): Required<Pick<PropMaterialOverride, 'ringIndex' | 'color'>> & PropMaterialOverride;
