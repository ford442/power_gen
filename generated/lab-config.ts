/**
 * AUTO-GENERATED from config/lab-config.json — do not edit.
 * Regenerate: npm run codegen:lab-config
 *
 * Precedence for every field: URL > share hash (#lab2= / #lab=) > localStorage
 * > default. The reader is src/config/lab-config.ts; docs/AGENTS.md carries the
 * generated matrix (doc text stays out of this file to keep the entry chunk small).
 */

export type LabFieldType = 'bool' | 'enum' | 'number' | 'int' | 'string' | 'list' | 'setpoints';

export interface LabFieldStorage {
  key: string;
  /** `bool`: 'true'/'false' · `raw`: the value itself · `int`: decimal. */
  codec: 'bool' | 'raw' | 'int';
  /** Values honoured when read back from storage (others are ignored). */
  values?: readonly string[];
}

export interface LabFieldSpec {
  key: LabConfigKey;
  type: LabFieldType;
  default: unknown;
  values?: readonly string[];
  aliases?: Readonly<Record<string, string>>;
  min?: number;
  max?: number;
  /** A number at or below this is invalid (falls through), not clamped. */
  exclusiveMin?: number;
  pattern?: string;
  /** URL aliases; the first is canonical. */
  url: readonly string[];
  storage?: LabFieldStorage;
  /** Carried by #lab2= share links and `.lab.json`. */
  share: boolean;
  /** Applied to a running lab without a reload. */
  live: boolean;
}

export interface LabConfig {
  renderer: 'webgpu' | 'webgl2';
  wasmPhysics: boolean;
  plantWorker: boolean;
  seed: number | null;
  gpuPower: 'high-performance' | 'low-power';
  gpuTiming: boolean;
  p3: boolean;
  hdr: boolean;
  color: 'linear' | 'legacy';
  renderScale: number;
  capture: boolean;
  ssr: boolean;
  taa: boolean;
  gpuChores: 'auto' | 'js' | 'wasm' | 'webgpu';
  layout: 'searl' | 'roschin' | 'legacy' | null;
  heronLayout: 'classic' | 'compact' | 'tower' | 'wide' | 'spiral';
  prototype: 'showroom' | 'lab';
  frame: 'full' | 'minimal' | 'off';
  gltfHousing: boolean;
  gltfCoilFormer: boolean | null;
  gltfStand: boolean | null;
  gltfBasePlate: boolean | null;
  gltfTransformerCore: boolean | null;
  gltfVdgTerminal: boolean | null;
  gltfHeronVessels: boolean | null;
  gltfKelvinJars: boolean | null;
  gltfThomsonStand: boolean | null;
  look: 'studio' | 'lab' | 'drama';
  labMode: 'showroom' | 'lab' | 'twin' | null;
  classroom: boolean | null;
  mockHardware: boolean;
  energyCoupling: boolean;
  fieldCoupling: boolean;
  chargeCoupling: boolean;
  replay: boolean;
  fdtd: boolean;
  fdtdMaterials: boolean;
  fdtdDrive: 'coil' | 'transformer';
  halbachLinear: boolean;
  audio: boolean;
  embed: boolean;
  embedOrigins: readonly string[];
  experiment: string | null;
  mode: string | null;
  drive: number | null;
  field: number | null;
  bmult: number | null;
  highlight: string | null;
  tour: boolean | null;
  tourStep: number | null;
  setpoints: Readonly<Record<string, number>>;
}

export type LabConfigKey = keyof LabConfig;

type LabFieldRow = Omit<LabFieldSpec, 'url' | 'share' | 'live'> & { url?: readonly string[]; share?: true; live?: true };

const ROWS: readonly LabFieldRow[] = [
  { key: 'renderer', type: 'enum', default: "webgpu", values: ["webgpu","webgl2"], storage: { key: 'seg-renderer', codec: 'raw', values: ["webgpu"] } },
  { key: 'wasmPhysics', type: 'bool', default: false, url: ["wasmPhysics","wasm"], storage: { key: 'useWasmPhysics', codec: 'bool' }, share: true },
  { key: 'plantWorker', type: 'bool', default: true },
  { key: 'seed', type: 'int', default: null, min: 0, max: 4294967295, storage: { key: 'seg-sim-seed', codec: 'int' }, share: true, live: true },
  { key: 'gpuPower', type: 'enum', default: "high-performance", values: ["high-performance","low-power"], aliases: {"low":"low-power"} },
  { key: 'gpuTiming', type: 'bool', default: false },
  { key: 'p3', type: 'bool', default: false },
  { key: 'hdr', type: 'bool', default: false },
  { key: 'color', type: 'enum', default: "linear", values: ["linear","legacy"] },
  { key: 'renderScale', type: 'number', default: 1, min: 0.5, max: 1, exclusiveMin: 0 },
  { key: 'capture', type: 'bool', default: false },
  { key: 'ssr', type: 'bool', default: true },
  { key: 'taa', type: 'bool', default: true },
  { key: 'gpuChores', type: 'enum', default: "auto", values: ["auto","js","wasm","webgpu"], aliases: {"0":"js","off":"js"}, storage: { key: 'seg-gpu-chores', codec: 'raw', values: ["js"] } },
  { key: 'layout', type: 'enum', default: null, values: ["searl","roschin","legacy"], aliases: {"lab":"roschin","godin":"roschin","showroom":"searl"}, share: true, live: true },
  { key: 'heronLayout', type: 'enum', default: "classic", values: ["classic","compact","tower","wide","spiral"], storage: { key: 'heron-layout', codec: 'raw' }, share: true, live: true },
  { key: 'prototype', type: 'enum', default: "showroom", values: ["showroom","lab"], aliases: {"searl":"showroom","roschin":"lab","godin":"lab"}, share: true },
  { key: 'frame', type: 'enum', default: "full", values: ["full","minimal","off"], aliases: {"0":"off","1":"minimal","2":"full","min":"minimal","false":"off"}, share: true, live: true },
  { key: 'gltfHousing', type: 'bool', default: true },
  { key: 'gltfCoilFormer', type: 'bool', default: null },
  { key: 'gltfStand', type: 'bool', default: null },
  { key: 'gltfBasePlate', type: 'bool', default: null },
  { key: 'gltfTransformerCore', type: 'bool', default: null },
  { key: 'gltfVdgTerminal', type: 'bool', default: null },
  { key: 'gltfHeronVessels', type: 'bool', default: null },
  { key: 'gltfKelvinJars', type: 'bool', default: null },
  { key: 'gltfThomsonStand', type: 'bool', default: null },
  { key: 'look', type: 'enum', default: "studio", values: ["studio","lab","drama"], url: ["look","lighting"], share: true, live: true },
  { key: 'labMode', type: 'enum', default: null, values: ["showroom","lab","twin"], storage: { key: 'seg-lab-mode', codec: 'raw' }, share: true, live: true },
  { key: 'classroom', type: 'bool', default: null, url: ["class"], share: true, live: true },
  { key: 'mockHardware', type: 'bool', default: false },
  { key: 'energyCoupling', type: 'bool', default: false, storage: { key: 'seg-energy-coupling', codec: 'bool' }, share: true, live: true },
  { key: 'fieldCoupling', type: 'bool', default: false, storage: { key: 'seg-field-coupling', codec: 'bool' }, share: true, live: true },
  { key: 'chargeCoupling', type: 'bool', default: false, storage: { key: 'seg-charge-coupling', codec: 'bool' }, share: true, live: true },
  { key: 'replay', type: 'bool', default: false },
  { key: 'fdtd', type: 'bool', default: true },
  { key: 'fdtdMaterials', type: 'bool', default: true },
  { key: 'fdtdDrive', type: 'enum', default: "coil", values: ["coil","transformer"] },
  { key: 'halbachLinear', type: 'bool', default: false, share: true, live: true },
  { key: 'audio', type: 'bool', default: false },
  { key: 'embed', type: 'bool', default: false },
  { key: 'embedOrigins', type: 'list', default: [] },
  { key: 'experiment', type: 'string', default: null, pattern: "^[a-z0-9][a-z0-9-]{0,63}$", share: true, live: true },
  { key: 'mode', type: 'string', default: null, pattern: "^[a-z0-9][a-z0-9-]{0,31}$", share: true, live: true },
  { key: 'drive', type: 'number', default: null, min: 0, max: 1, url: [], share: true, live: true },
  { key: 'field', type: 'number', default: null, min: 0, max: 1, url: [], share: true, live: true },
  { key: 'bmult', type: 'number', default: null, min: 0.5, max: 2, url: [], share: true, live: true },
  { key: 'highlight', type: 'string', default: null, pattern: "^[A-Za-z0-9_-]{1,48}$", url: [], share: true, live: true },
  { key: 'tour', type: 'bool', default: null, url: [], share: true, live: true },
  { key: 'tourStep', type: 'int', default: null, min: 0, max: 999, url: [], share: true, live: true },
  { key: 'setpoints', type: 'setpoints', default: {}, url: [], share: true, live: true }
];

export const LAB_CONFIG_FIELDS: readonly LabFieldSpec[] = ROWS.map((r) => ({ url: [r.key], share: false, live: false, ...r }));

/** Every field's default (validated against its type by the codegen). */
export const LAB_CONFIG_DEFAULTS = Object.fromEntries(
  LAB_CONFIG_FIELDS.map((f) => [f.key, f.default])
) as unknown as Readonly<LabConfig>;

/** Hash of the field specs — versions `.lab.json` and #lab2= payloads. */
export const LAB_CONFIG_SCHEMA_HASH = 'd539cbe47be9';
