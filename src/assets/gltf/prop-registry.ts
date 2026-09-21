/**
 * glTF prop registry — lazy, **per-device** CAD (ADR-0005 WS1).
 *
 * Each entry names the bench it belongs to via `deviceId`, so focusing the
 * transformer loads the transformer's core and nothing else. That is what keeps
 * the cost of a bench's CAD paid only by that bench's focus view, and what stops
 * the GPU holding two benches' meshes at once.
 *
 * Load policies:
 *   - `resident` — load on first focus, keep GPU buffers when leaving.
 *     **SEG only:** any other bench holding resident CAD would defeat the point.
 *   - `focus`    — load only while its device is focused; dispose on leave.
 *
 * WebGPU only. WebGL2 skips heavy glTF (docs/WEBGL2.md, docs/GLTF_ASSETS.md).
 */

export type PropLoadPolicy = 'resident' | 'focus';

/** Bench a prop belongs to when an entry does not say. */
export const DEFAULT_PROP_DEVICE_ID = 'seg';

export interface PropMaterialOverride {
  ringIndex?: number;
  color?: [number, number, number];
  metallic?: number;
  roughness?: number;
  emissiveScale?: number;
}

export interface SegGltfPropDef {
  id: string;
  /** Catalog device id whose focus view owns this prop. */
  deviceId: string;
  url: string;
  role: string;
  loadPolicy: PropLoadPolicy;
  enabled: (params?: URLSearchParams) => boolean;
  materialOverride?: PropMaterialOverride;
  /** Soft byte budget for placeholder GLBs (PR template). */
  softBudgetBytes?: number;
  /** Future / not yet authored — registry placeholder. */
  placeholder?: boolean;
  /**
   * Bake vertices through the SEG layout's `worldScale` / frame base offset.
   *
   * True for SEG, whose assembly size is layout-preset-driven. False elsewhere:
   * a bench's GLB is authored in its own metres, and the device uniform already
   * supplies world position and rotation — exactly as it does for that bench's
   * procedural cylinder instances.
   */
  layoutScaled?: boolean;
}

export function parseGltfHousingEnabled(params: URLSearchParams = new URLSearchParams(typeof location !== 'undefined' ? location.search : '')): boolean {
  const raw = params.get('gltfHousing');
  if (raw === '0' || raw === 'false' || raw === 'off') return false;
  if (raw === '1' || raw === 'true' || raw === 'on') return true;
  if (typeof window !== 'undefined' && window.GLTF_HOUSING === false) return false;
  return true;
}

/**
 * Coil former prop — default on with housing; disable via ?gltfCoilFormer=0.
 */
export function parseGltfCoilFormerEnabled(params: URLSearchParams = new URLSearchParams(typeof location !== 'undefined' ? location.search : '')): boolean {
  const raw = params.get('gltfCoilFormer');
  if (raw === '0' || raw === 'false' || raw === 'off') return false;
  if (raw === '1' || raw === 'true' || raw === 'on') return true;
  return parseGltfHousingEnabled(params);
}

function parseFocusPropEnabled(
  key: string,
  params: URLSearchParams = new URLSearchParams(typeof location !== 'undefined' ? location.search : '')
): boolean {
  const raw = params.get(key);
  if (raw === '0' || raw === 'false' || raw === 'off') return false;
  if (raw === '1' || raw === 'true' || raw === 'on') return true;
  return parseGltfHousingEnabled(params);
}

/** Stand prop — default on with housing; disable via ?gltfStand=0. */
export function parseGltfStandEnabled(params?: URLSearchParams): boolean {
  return parseFocusPropEnabled('gltfStand', params);
}

/** Base plate prop — default on with housing; disable via ?gltfBasePlate=0. */
export function parseGltfBasePlateEnabled(params?: URLSearchParams): boolean {
  return parseFocusPropEnabled('gltfBasePlate', params);
}

/**
 * Transformer C-core — default on; disable via `?gltfTransformerCore=0`.
 * `?gltfHousing=0` remains the master switch for all CAD props.
 */
export function parseGltfTransformerCoreEnabled(params?: URLSearchParams): boolean {
  return parseFocusPropEnabled('gltfTransformerCore', params);
}

/** Van de Graaff terminal — default on; disable via `?gltfVdgTerminal=0`. */
export function parseGltfVdgTerminalEnabled(params?: URLSearchParams): boolean {
  return parseFocusPropEnabled('gltfVdgTerminal', params);
}

export const SEG_HOUSING_GLB_URL = './assets/seg/housing-shell.glb';
export const SEG_COIL_FORMER_GLB_URL = './assets/seg/coil-former.glb';
export const SEG_STAND_GLB_URL = './assets/seg/stand.glb';
export const SEG_BASE_PLATE_GLB_URL = './assets/seg/base-plate.glb';
export const TRANSFORMER_CORE_GLB_URL = './assets/quanta/transformer-core.glb';
export const VDG_TERMINAL_GLB_URL = './assets/quanta/vdg-terminal.glb';

export const SEG_GLTF_PROPS: SegGltfPropDef[] = [
  {
    id: 'housing',
    deviceId: 'seg',
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
    softBudgetBytes: 50 * 1024,
    layoutScaled: true
  },
  {
    id: 'coilFormer',
    deviceId: 'seg',
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
    softBudgetBytes: 50 * 1024,
    layoutScaled: true
  },
  {
    id: 'stand',
    deviceId: 'seg',
    url: SEG_STAND_GLB_URL,
    role: 'stand',
    loadPolicy: 'focus',
    enabled: parseGltfStandEnabled,
    materialOverride: {
      ringIndex: 13.0,
      color: [0.35, 0.36, 0.38],
      metallic: 0.55,
      roughness: 0.45,
      emissiveScale: 0.4
    },
    softBudgetBytes: 50 * 1024,
    layoutScaled: true
  },
  {
    id: 'basePlate',
    deviceId: 'seg',
    url: SEG_BASE_PLATE_GLB_URL,
    role: 'base_plate',
    loadPolicy: 'focus',
    enabled: parseGltfBasePlateEnabled,
    materialOverride: {
      ringIndex: 13.0,
      color: [0.28, 0.28, 0.30],
      metallic: 0.6,
      roughness: 0.4,
      emissiveScale: 0.35
    },
    softBudgetBytes: 50 * 1024,
    layoutScaled: true
  },
  {
    // The flux *path* the procedural coil pair lacks: two legs, two yokes, two
    // bobbins. Laminated-steel tint rather than the former's phenolic brown.
    id: 'transformerCore',
    deviceId: 'transformer',
    url: TRANSFORMER_CORE_GLB_URL,
    role: 'transformer_core',
    loadPolicy: 'focus',
    enabled: parseGltfTransformerCoreEnabled,
    materialOverride: {
      ringIndex: 12.0,
      color: [0.46, 0.47, 0.50],
      metallic: 0.62,
      roughness: 0.42,
      emissiveScale: 0.5
    },
    softBudgetBytes: 50 * 1024
  },
  {
    // Sphere terminal, insulating column, belt runs, discharge electrode — the
    // apparatus whose shape *is* the explanation.
    id: 'vdgTerminal',
    deviceId: 'vdg',
    url: VDG_TERMINAL_GLB_URL,
    role: 'vdg_terminal',
    loadPolicy: 'focus',
    enabled: parseGltfVdgTerminalEnabled,
    materialOverride: {
      ringIndex: 11.0,
      color: [0.74, 0.78, 0.84],
      metallic: 0.8,
      roughness: 0.22,
      // Terminal trim tracks charge, so keep headroom for the corona glow.
      emissiveScale: 0.8
    },
    softBudgetBytes: 50 * 1024
  }
];

export function getPropDef(id: string): SegGltfPropDef | null {
  return SEG_GLTF_PROPS.find((p) => p.id === id) ?? null;
}

/** Every bench that has at least one registry entry. */
export function listPropDeviceIds(): string[] {
  return [...new Set(SEG_GLTF_PROPS.map((p) => p.deviceId))];
}

/**
 * Authored, enabled props owned by one bench's focus view.
 * The `enabled` predicates already honour `?gltfHousing=0` as a master switch.
 */
export function propsForDevice(
  deviceId: string,
  params?: URLSearchParams
): SegGltfPropDef[] {
  return SEG_GLTF_PROPS.filter((p) =>
    !p.placeholder && p.deviceId === deviceId && p.enabled(params));
}

/** Props that stay resident after first focus (SEG only, by policy). */
export function listResidentPropIds(
  params?: URLSearchParams,
  deviceId: string = DEFAULT_PROP_DEVICE_ID
): string[] {
  return propsForDevice(deviceId, params)
    .filter((p) => p.loadPolicy === 'resident')
    .map((p) => p.id);
}

/** Props loaded only while their device is focused (disposed on leave). */
export function listFocusPropIds(
  params?: URLSearchParams,
  deviceId: string = DEFAULT_PROP_DEVICE_ID
): string[] {
  return propsForDevice(deviceId, params)
    .filter((p) => p.loadPolicy === 'focus')
    .map((p) => p.id);
}

/** Ids of every `focus`-policy prop, across all benches (for disposal). */
export function allFocusPropIds(): Set<string> {
  return new Set(SEG_GLTF_PROPS.filter((p) => p.loadPolicy === 'focus').map((p) => p.id));
}

export interface PropMaterialDrawable {
  materialRingIndex?: number;
  material?: { ringIndex?: number; color?: [number, number, number] };
  [key: string]: unknown;
}

/**
 * Resolve material for a drawable: registry override wins over glTF extras.
 */
export function resolvePropMaterial(
  prop: SegGltfPropDef,
  drawable: PropMaterialDrawable = {}
): Required<Pick<PropMaterialOverride, 'ringIndex' | 'color'>> & PropMaterialOverride {
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
