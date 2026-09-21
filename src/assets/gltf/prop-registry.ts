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

import { parseHeronLayoutPreset, HERON_LAYOUT_PRESETS } from '../../heron-layout';

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

/**
 * Per-prop switch with `gltfHousing` as the **default**, not an override.
 *
 * Precedence is deliberate and predates the per-device registry: an explicit
 * per-prop value wins, so `?gltfHousing=0&gltfStand=1` shows the stand alone —
 * which is how you look at one prop without the rest of the assembly in the way.
 * `?gltfHousing=0` on its own therefore disables every prop that has no explicit
 * value of its own, which is every prop unless you say otherwise.
 *
 * Both halves are pinned by `npm run test:props`, including the conflicting
 * query, so the precedence cannot drift unnoticed in either direction.
 */
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
 * Follows `gltfHousing` unless given an explicit value — see
 * {@link parseFocusPropEnabled} for the precedence.
 */
export function parseGltfTransformerCoreEnabled(params?: URLSearchParams): boolean {
  return parseFocusPropEnabled('gltfTransformerCore', params);
}

/** Van de Graaff terminal — default on; disable via `?gltfVdgTerminal=0`. */
export function parseGltfVdgTerminalEnabled(params?: URLSearchParams): boolean {
  return parseFocusPropEnabled('gltfVdgTerminal', params);
}

/** Kelvin header tank / insulated jars — default on; disable via `?gltfKelvinJars=0`. */
export function parseGltfKelvinJarsEnabled(params?: URLSearchParams): boolean {
  return parseFocusPropEnabled('gltfKelvinJars', params);
}

/** Thomson ring stand — default on; disable via `?gltfThomsonStand=0`. */
export function parseGltfThomsonStandEnabled(params?: URLSearchParams): boolean {
  return parseFocusPropEnabled('gltfThomsonStand', params);
}

/**
 * The Heron layout the lab is actually on.
 *
 * `LabSession` publishes its resolved preset to `window.HERON_LAYOUT_PRESET`
 * and that is the authority here, because the query string alone is not: a
 * preset stored in `localStorage` overrides `?heronLayout=` at boot, and
 * `persistHeronLayoutPreset()` rewrites the query afterwards. Reading the
 * session's answer means the prop cannot disagree with the geometry on screen
 * in either direction.
 *
 * Off the browser — `npm run test:props` — there is no session to ask, so the
 * passed params are the whole truth and `parseHeronLayoutPreset` resolves them.
 */
function activeHeronPreset(params: URLSearchParams): string {
  const published = typeof window !== 'undefined' ? window.HERON_LAYOUT_PRESET : undefined;
  if (published && published in HERON_LAYOUT_PRESETS) return published;
  return parseHeronLayoutPreset(params);
}

/**
 * Heron vessels — default on **for the `classic` layout preset only**.
 *
 * Heron's five presets are not five scales of one shape the way the SEG's are:
 * `tower` and `wide` move the vessels to different heights and re-route the
 * plumbing, so a single baked GLB cannot follow them and `layoutScaled` cannot
 * save it. Rather than ship five GLBs or hang a classic-shaped prop in a tower
 * layout, the other four presets keep the procedural vessels they already had.
 *
 * `setHeronLayoutPreset()` re-runs `ensureGltfPropsForView()` after applying a
 * preset, and `_disposeFocusOnlyGltfProps()` keeps only what `propsForDevice()`
 * still reports as enabled — so switching away from `classic` disposes this
 * prop's GPU buffers, and switching back reloads it.
 */
export function parseGltfHeronVesselsEnabled(params?: URLSearchParams): boolean {
  const resolved = params
    ?? new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
  if (!parseFocusPropEnabled('gltfHeronVessels', resolved)) return false;
  return activeHeronPreset(resolved) === HERON_LAYOUT_PRESETS.classic;
}

export const SEG_HOUSING_GLB_URL = './assets/seg/housing-shell.glb';
export const SEG_COIL_FORMER_GLB_URL = './assets/seg/coil-former.glb';
export const SEG_STAND_GLB_URL = './assets/seg/stand.glb';
export const SEG_BASE_PLATE_GLB_URL = './assets/seg/base-plate.glb';
export const TRANSFORMER_CORE_GLB_URL = './assets/quanta/transformer-core.glb';
export const VDG_TERMINAL_GLB_URL = './assets/quanta/vdg-terminal.glb';
export const THOMSON_STAND_GLB_URL = './assets/quanta/thomson-stand.glb';
export const HERON_VESSELS_GLB_URL = './assets/lab/heron-vessels.glb';
export const KELVIN_JARS_GLB_URL = './assets/lab/kelvin-jars.glb';

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
  },
  {
    // Flanged lids on the two sealed vessels, an open rim on the catch basin:
    // which volume is closed to the air is the fountain's whole argument, and
    // four identical shared cylinders cannot show it. Ends rather than walls,
    // because `segEnhanced` culls back faces and a wall would hide the water
    // inside. Classic preset only — see {@link parseGltfHeronVesselsEnabled}.
    id: 'heronVessels',
    deviceId: 'heron',
    url: HERON_VESSELS_GLB_URL,
    role: 'heron_vessels',
    loadPolicy: 'focus',
    enabled: parseGltfHeronVesselsEnabled,
    materialOverride: {
      ringIndex: 12.0,
      color: [0.58, 0.72, 0.82],
      metallic: 0.08,
      roughness: 0.16,
      // Glass reads as glass mostly through specular, so keep the trim low.
      emissiveScale: 0.35
    },
    softBudgetBytes: 50 * 1024
  },
  {
    // A shared header tank the water comes from, and jars on insulating
    // pillars — the supply and the isolation the procedural buckets imply but
    // never draw. The induction rings stay procedural: they glow with charge.
    id: 'kelvinJars',
    deviceId: 'kelvin',
    url: KELVIN_JARS_GLB_URL,
    role: 'kelvin_jars',
    loadPolicy: 'focus',
    enabled: parseGltfKelvinJarsEnabled,
    materialOverride: {
      ringIndex: 11.0,
      color: [0.68, 0.70, 0.74],
      metallic: 0.55,
      roughness: 0.34,
      emissiveScale: 0.45
    },
    softBudgetBytes: 50 * 1024
  },
  {
    // The parts of the jumping-ring bench that do NOT move: laminated core,
    // bobbin, the shoulder at h = 0 and the stop at poleHeightM. The ring and
    // the winding stay procedural because their height and glow are the plant.
    id: 'thomsonStand',
    deviceId: 'jumping-ring',
    url: THOMSON_STAND_GLB_URL,
    role: 'thomson_stand',
    loadPolicy: 'focus',
    enabled: parseGltfThomsonStandEnabled,
    materialOverride: {
      ringIndex: 12.0,
      color: [0.44, 0.45, 0.49],
      metallic: 0.64,
      roughness: 0.40,
      emissiveScale: 0.5
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
 * The `enabled` predicates apply `?gltfHousing=0` as the default for any prop
 * without an explicit switch of its own — see {@link parseFocusPropEnabled}.
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
