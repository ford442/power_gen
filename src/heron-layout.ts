/**
 * Heron's Fountain — parameterized build shapes + hydraulic model.
 *
 * Each preset defines vessel positions, plumbing paths, and pipe/nozzle
 * dimensions used by Swamee–Jain friction + Bernoulli exit velocity.
 */
import type { HeronLayout } from './renderers/shared/device-physics';

export type HeronLayoutPresetId = 'classic' | 'compact' | 'tower' | 'wide' | 'spiral';

export const HERON_LAYOUT_PRESETS: Record<HeronLayoutPresetId, HeronLayoutPresetId> = {
  classic: 'classic',
  compact: 'compact',
  tower: 'tower',
  wide: 'wide',
  spiral: 'spiral'
};

export const HERON_LAYOUT_DESCRIPTIONS: Record<string, string> = {
  classic: 'Textbook vertical stack — balanced head, moderate pipe losses.',
  compact: 'Short bench model — low head, tight plumbing, brisk cycling.',
  tower: 'Tall narrow tower — high driving head, long pipes, more friction.',
  wide: 'Museum spread layout — lateral runs, decorative wide footprint.',
  spiral: 'Spiral jet ascent — longest effective path, ornate glass helix.'
};

const STEEL: [number, number, number] = [0.62, 0.66, 0.72];
const WATER: [number, number, number] = [0.35, 0.55, 0.72];
const BRASS: [number, number, number] = [0.72, 0.58, 0.32];
const GLASS: [number, number, number] = [0.55, 0.72, 0.85];
const SLATE: [number, number, number] = [0.38, 0.42, 0.48];

type Vec3 = [number, number, number] | number[];
type Quat = [number, number, number, number];

function pack(pos: number[], ringIndex: number, rot: number[], color: number[], emissive: number): number[] {
  return [
    pos[0], pos[1], pos[2], ringIndex,
    rot[0], rot[1], rot[2], rot[3],
    color[0], color[1], color[2], emissive
  ];
}

function quatFromAxisAngle(axis: number[], angle: number): Quat {
  const half = angle * 0.5;
  const s = Math.sin(half);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(half)];
}

function quatFromYTo(dir: number[]): Quat {
  const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  const d = [dir[0] / len, dir[1] / len, dir[2] / len];
  const dot = d[1];
  if (dot > 0.9999) return [0, 0, 0, 1];
  if (dot < -0.9999) return [1, 0, 0, 0];
  const axis = [d[2], 0, -d[0]];
  const axisLen = Math.hypot(axis[0], axis[1], axis[2]) || 1;
  const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
  const s = Math.sin(angle / 2);
  return [
    (axis[0] / axisLen) * s,
    (axis[1] / axisLen) * s,
    (axis[2] / axisLen) * s,
    Math.cos(angle / 2)
  ];
}

export const TUBE_MESH_HEIGHT = 1.6;
export const TUBE_MESH_RADIUS = 0.09;

function tubeSegments(from: Vec3, to: Vec3, color: number[] = BRASS, emissive = 0.06, ringIndex = 12): number[][] {
  const dir = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  const len = Math.hypot(dir[0], dir[1], dir[2]);
  if (len < 1e-4) return [];
  const rot = quatFromYTo(dir);
  const n = Math.max(1, Math.ceil(len / (TUBE_MESH_HEIGHT * 0.95)));
  const out: number[][] = [];
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    out.push(pack(
      [from[0] + dir[0] * t, from[1] + dir[1] * t, from[2] + dir[2] * t],
      ringIndex, rot, color, emissive
    ));
  }
  return out;
}

/** Approximate spiral jet path as short tube segments. */
function spiralJet(base: Vec3, topY: number, turns = 2.5, radius = 0.55): number[][] {
  const segments: number[][] = [];
  const steps = Math.max(12, Math.floor(turns * 14));
  for (let i = 0; i < steps; i++) {
    const t0 = i / steps;
    const t1 = (i + 1) / steps;
    const ang0 = t0 * turns * Math.PI * 2;
    const ang1 = t1 * turns * Math.PI * 2;
    const y0 = base[1] + (topY - base[1]) * t0;
    const y1 = base[1] + (topY - base[1]) * t1;
    const r0 = radius * (1 - t0 * 0.35);
    const r1 = radius * (1 - t1 * 0.35);
    const p0 = [base[0] + Math.cos(ang0) * r0, y0, base[2] + Math.sin(ang0) * r0];
    const p1 = [base[0] + Math.cos(ang1) * r1, y1, base[2] + Math.sin(ang1) * r1];
    segments.push(...tubeSegments(p0, p1, GLASS, 0.16));
  }
  return segments;
}

export interface HeronMeshData {
  vessels: number[][];
  platform: number[][];
  tubes: number[][];
  flow: { apexY: number; supplyX: number; drainBasinY: number };
}

interface HeronPresetDef extends HeronLayout {
  id: HeronLayoutPresetId;
  name: string;
  jetApexY: number;
  build(): HeronMeshData;
}

const PRESET_DEFS: Record<HeronLayoutPresetId, HeronPresetDef> = {
  classic: {
    id: HERON_LAYOUT_PRESETS.classic,
    name: 'Classic Stack',
    headMaxM: 4.5,
    pipeLengthM: 4.0,
    pipeDiameterM: 0.08,
    nozzleDiameterM: 0.04,
    roughness: 0.02,
    dischargeCoeff: 0.35,
    pumpRate: 2.2,
    drainCoeff: 0.30,
    jetApexY: 6.1,
    build() {
      const vessels = [
        pack([0, -2.2, 0], 0, [0, 0, 0, 1], STEEL, 0.05),
        pack([0, -0.4, 0], 0, [0, 0, 0, 1], STEEL, 0.04),
        pack([0, 2.0, 0], 0, [0, 0, 0, 1], WATER, 0.12),
        pack([0, 4.8, 0], 0, [0, 0, 0, 1], WATER, 0.15)
      ];
      const platform = [pack([0, -2.65, 0], 11, quatFromAxisAngle([1, 0, 0], Math.PI / 2), SLATE, 0.03)];
      const tubes = [
        ...tubeSegments([-1.6, 4.6, 0], [-1.6, -0.4, 0], BRASS, 0.05),
        ...tubeSegments([-1.6, 4.6, 0], [-0.6, 4.8, 0], BRASS, 0.05),
        ...tubeSegments([-1.6, -0.4, 0], [-0.6, -0.4, 0], BRASS, 0.05),
        ...tubeSegments([1.6, -0.4, 0], [1.6, 4.6, 0], BRASS, 0.05),
        ...tubeSegments([0.6, -0.4, 0], [1.6, -0.4, 0], BRASS, 0.05),
        ...tubeSegments([1.6, 4.6, 0], [0.6, 4.8, 0], BRASS, 0.05),
        ...tubeSegments([0, 4.8, 0], [0, 6.1, 0], GLASS, 0.14)
      ];
      return { vessels, platform, tubes, flow: { apexY: 6.1, supplyX: 1.6, drainBasinY: -2.2 } };
    }
  },
  compact: {
    id: HERON_LAYOUT_PRESETS.compact,
    name: 'Compact Bench',
    headMaxM: 2.8,
    pipeLengthM: 2.4,
    pipeDiameterM: 0.06,
    nozzleDiameterM: 0.035,
    roughness: 0.022,
    dischargeCoeff: 0.38,
    pumpRate: 2.8,
    drainCoeff: 0.42,
    jetApexY: 4.2,
    build() {
      const vessels = [
        pack([0, -1.4, 0], 0, [0, 0, 0, 1], STEEL, 0.05),
        pack([0, -0.15, 0], 0, [0, 0, 0, 1], STEEL, 0.04),
        pack([0, 1.1, 0], 0, [0, 0, 0, 1], WATER, 0.12),
        pack([0, 2.8, 0], 0, [0, 0, 0, 1], WATER, 0.15)
      ];
      const platform = [pack([0, -1.75, 0], 11, quatFromAxisAngle([1, 0, 0], Math.PI / 2), SLATE, 0.03)];
      const tubes = [
        ...tubeSegments([-0.9, 2.6, 0], [-0.9, -0.15, 0], BRASS, 0.05),
        ...tubeSegments([0.9, -0.15, 0], [0.9, 2.6, 0], BRASS, 0.05),
        ...tubeSegments([0, 2.8, 0], [0, 4.2, 0], GLASS, 0.14)
      ];
      return { vessels, platform, tubes, flow: { apexY: 4.2, supplyX: 0.9, drainBasinY: -1.4 } };
    }
  },
  tower: {
    id: HERON_LAYOUT_PRESETS.tower,
    name: 'Tall Tower',
    headMaxM: 6.5,
    pipeLengthM: 7.2,
    pipeDiameterM: 0.05,
    nozzleDiameterM: 0.03,
    roughness: 0.018,
    dischargeCoeff: 0.32,
    pumpRate: 1.6,
    drainCoeff: 0.22,
    jetApexY: 8.8,
    build() {
      const vessels = [
        pack([0, -3.6, 0], 0, [0, 0, 0, 1], STEEL, 0.05),
        pack([0, -1.2, 0], 0, [0, 0, 0, 1], STEEL, 0.04),
        pack([0, 2.8, 0], 0, [0, 0, 0, 1], WATER, 0.12),
        pack([0, 6.2, 0], 0, [0, 0, 0, 1], WATER, 0.15)
      ];
      const platform = [pack([0, -4.1, 0], 11, quatFromAxisAngle([1, 0, 0], Math.PI / 2), SLATE, 0.03)];
      const tubes = [
        ...tubeSegments([-1.2, 6.0, 0], [-1.2, -1.2, 0], BRASS, 0.05),
        ...tubeSegments([1.2, -1.2, 0], [1.2, 6.0, 0], BRASS, 0.05),
        ...tubeSegments([0, 6.2, 0], [0, 8.8, 0], GLASS, 0.16)
      ];
      return { vessels, platform, tubes, flow: { apexY: 8.8, supplyX: 1.2, drainBasinY: -3.6 } };
    }
  },
  wide: {
    id: HERON_LAYOUT_PRESETS.wide,
    name: 'Wide Museum',
    headMaxM: 3.6,
    pipeLengthM: 6.5,
    pipeDiameterM: 0.07,
    nozzleDiameterM: 0.045,
    roughness: 0.025,
    dischargeCoeff: 0.33,
    pumpRate: 2.0,
    drainCoeff: 0.28,
    jetApexY: 5.8,
    build() {
      const vessels = [
        pack([-2.8, -1.6, 0], 0, [0, 0, 0, 1], STEEL, 0.05),
        pack([2.8, -1.6, 0], 0, [0, 0, 0, 1], STEEL, 0.04),
        pack([0, 1.4, 0], 0, [0, 0, 0, 1], WATER, 0.12),
        pack([0, 4.2, 0], 0, [0, 0, 0, 1], WATER, 0.15)
      ];
      const platform = [pack([0, -2.1, 0], 11, quatFromAxisAngle([1, 0, 0], Math.PI / 2), SLATE, 0.03)];
      const tubes = [
        ...tubeSegments([0, 4.0, 0], [-2.8, -1.6, 0], BRASS, 0.05),
        ...tubeSegments([2.8, -1.6, 0], [0, 4.0, 0], BRASS, 0.05),
        ...tubeSegments([-2.8, -1.6, 0], [2.8, -1.6, 0], BRASS, 0.04),
        ...tubeSegments([0, 4.2, 0], [0, 5.8, 0], GLASS, 0.14)
      ];
      return { vessels, platform, tubes, flow: { apexY: 5.8, supplyX: 2.8, drainBasinY: -1.6 } };
    }
  },
  spiral: {
    id: HERON_LAYOUT_PRESETS.spiral,
    name: 'Spiral Jet',
    headMaxM: 4.2,
    pipeLengthM: 8.0,
    pipeDiameterM: 0.055,
    nozzleDiameterM: 0.038,
    roughness: 0.02,
    dischargeCoeff: 0.30,
    pumpRate: 1.9,
    drainCoeff: 0.26,
    jetApexY: 7.4,
    build() {
      const vessels = [
        pack([0, -2.0, 0], 0, [0, 0, 0, 1], STEEL, 0.05),
        pack([0, -0.3, 0], 0, [0, 0, 0, 1], STEEL, 0.04),
        pack([0, 2.2, 0], 0, [0, 0, 0, 1], WATER, 0.12),
        pack([0, 4.6, 0], 0, [0, 0, 0, 1], WATER, 0.15)
      ];
      const platform = [pack([0, -2.5, 0], 11, quatFromAxisAngle([1, 0, 0], Math.PI / 2), SLATE, 0.03)];
      const tubes = [
        ...tubeSegments([-1.4, 4.4, 0], [-1.4, -0.3, 0], BRASS, 0.05),
        ...tubeSegments([1.4, -0.3, 0], [1.4, 4.4, 0], BRASS, 0.05),
        ...spiralJet([0, 4.6, 0], 7.4, 2.8, 0.65)
      ];
      return { vessels, platform, tubes, flow: { apexY: 7.4, supplyX: 1.4, drainBasinY: -2.0 } };
    }
  }
};

/** getHeronLayout() also spreads the preset's display name/description onto the base HeronLayout shape. */
export function getHeronLayout(presetId: string = HERON_LAYOUT_PRESETS.classic): HeronPresetDef & HeronMeshData & { description: string } {
  const def = PRESET_DEFS[presetId as HeronLayoutPresetId] || PRESET_DEFS[HERON_LAYOUT_PRESETS.classic];
  const mesh = def.build();
  return {
    ...def,
    ...mesh,
    description: HERON_LAYOUT_DESCRIPTIONS[def.id] || ''
  };
}

/**
 * Swamee–Jain friction factor (turbulent pipe flow).
 */
export function swameeJainFriction(f: number, Re: number, D: number): number {
  const ReClamped = Math.max(Re, 1);
  const term = f / 3.7 + 5.74 / Math.pow(ReClamped, 0.9);
  return 0.25 / Math.pow(Math.log10(Math.max(term, 1e-6)), 2);
}

export interface HeronHydraulics {
  vExit: number;
  headLoss: number;
  Re: number;
  flowM3s: number;
  flowLmin: number;
  pressureKPa: number;
  vIdeal: number;
}

/**
 * Bernoulli exit velocity with Swamee–Jain head loss.
 * @param headM  driving head (m)
 * @param layout  from getHeronLayout()
 */
export function computeHeronHydraulics(headM: number, layout: HeronLayout): HeronHydraulics {
  const g = 9.81;
  const rho = 1000;
  const L = layout.pipeLengthM;
  const D = layout.pipeDiameterM;
  const f = layout.roughness ?? 0.02;
  const Cd = layout.dischargeCoeff ?? 0.35;
  const head = Math.max(headM, 0);

  const vIdeal = Math.sqrt(2 * g * head);
  const nu = 1e-6;
  const Re = vIdeal * D / nu;
  const fSw = swameeJainFriction(f, Re, D);
  const headLoss = fSw * (L / D) * (vIdeal * vIdeal / (2 * g));
  const vExit = Math.sqrt(2 * g * Math.max(head - headLoss, 0)) * Cd;

  const nozzleR = (layout.nozzleDiameterM ?? 0.04) * 0.5;
  const areaNozzle = Math.PI * nozzleR * nozzleR;
  const flowM3s = areaNozzle * vExit;
  const flowLmin = flowM3s * 60000;
  const pressureKPa = (rho * g * head) / 1000;

  return {
    vExit,
    headLoss,
    Re,
    flowM3s,
    flowLmin,
    pressureKPa,
    vIdeal
  };
}

export interface HeronMeshBundle {
  cylinders: number[][];
  tubes: number[][];
  flow: HeronMeshData['flow'];
  layout: ReturnType<typeof getHeronLayout>;
}

/**
 * Build instanced mesh data for a Heron layout preset.
 */
export function buildHeronMesh(presetId: string): HeronMeshBundle {
  const layout = getHeronLayout(presetId);
  return {
    cylinders: [...layout.vessels, ...layout.platform],
    tubes: layout.tubes,
    flow: layout.flow,
    layout
  };
}

export function parseHeronLayoutPreset(params: URLSearchParams = new URLSearchParams()): HeronLayoutPresetId {
  const p = params.get('heronLayout');
  if (p && p in PRESET_DEFS) return p as HeronLayoutPresetId;
  const win = typeof window !== 'undefined' ? (window as unknown as { HERON_LAYOUT_PRESET?: string }) : undefined;
  if (win?.HERON_LAYOUT_PRESET && win.HERON_LAYOUT_PRESET in PRESET_DEFS) {
    return win.HERON_LAYOUT_PRESET as HeronLayoutPresetId;
  }
  return HERON_LAYOUT_PRESETS.classic;
}
