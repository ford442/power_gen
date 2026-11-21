/**
 * AUTO-GENERATED from physics/devices.json (`fieldSources`) — do not edit.
 * Regenerate: npm run codegen:catalog. Schema: scripts/lib/catalog-field-sources.mjs.
 */

export const FIELD_KIND_DIPOLE = 0;
export const FIELD_KIND_SEGMENT = 1;
export const FIELD_KIND_BOX = 2;
export const FIELD_KIND_CYLINDER = 3;

export type FieldV3 = [number, number, number];

export interface FieldDrive {
  /** physicsState key whose live value multiplies the group's strength. */
  key: string;
  factor?: number;
  offset?: number;
  abs?: boolean;
}

export interface FieldGroupDecl {
  kind?: 'dipole' | 'segment' | 'box' | 'cylinder';
  builder?: string;
  params?: Record<string, unknown>;
  drive?: FieldDrive;
  label?: string;
  at?: FieldV3;
  moment?: FieldV3;
  coreM?: number;
  points?: FieldV3[];
  closed?: boolean;
  currentA?: number;
  wireM?: number;
  center?: FieldV3;
  halfSize?: FieldV3;
  brT?: FieldV3 | number;
  yawDeg?: number;
  axis?: FieldV3;
  radius?: number;
  halfLength?: number;
  turns?: number;
}

export interface FieldSourceDecl {
  unitM: number;
  bounds: [FieldV3, FieldV3];
  probe: FieldV3;
  model: string;
  efield?: { dir: FieldV3; key: string; factor?: number };
  groups: FieldGroupDecl[];
}

/** Benches with a field volume, in catalog order. */
export const FIELD_DEVICE_IDS: readonly string[] = ["seg","maglev","pulse-coil","homopolar","halbach-viz","transformer","hall","lorentz-sled","jumping-ring"];

export const FIELD_SOURCE_CATALOG: Readonly<Record<string, FieldSourceDecl>> = {
  "seg": {"unitM":0.5,"bounds":[[-3.8,-1.6,-3.8],[3.8,1.6,3.8]],"probe":[1.55,0.5,0],"model":"Roller magnets as uniformly magnetised spheres (dipole outside, uniform inside), tangential moment M·V of the drawn roller, alternating poles; vacuum, no stator iron; the coil rings sit outside the volume","groups":[{"builder":"segRollers","params":{"magnetizationAPerM":1121660,"seedsPerRoller":2},"label":"rollers"}]},
  "maglev": {"unitM":0.01,"bounds":[[-3.8,-0.6,-3.8],[3.8,1.6,3.8]],"probe":[2.8,0.95,0],"model":"12-block Halbach wheel (magnetisation turning 90° per block in the radial–Y plane, N52 Br) under an axially magnetised floater disc at the plant's gap; exact box / cylinder fields, vacuum","groups":[{"builder":"halbachRing","params":{"count":12,"radius":2.8,"y":0.35,"halfSize":[0.6,0.4,0.7],"stepDeg":90,"brT":1.48},"label":"Halbach track"},{"builder":"floaterMagnet","params":{"y0":0.55,"gapKey":"maglevGap","gapUnitM":1,"radius":0.8,"halfLength":0.1,"brT":1.2},"label":"floater"}]},
  "pulse-coil": {"unitM":0.05625,"bounds":[[-1.6,-1.6,-1.6],[1.6,2,1.6]],"probe":[0,0.165,0],"model":"48-turn coil as an ideal solenoid (coil radius 45 mm, the drawn length) carrying the plant's signed current; the iron armature is not modelled (vacuum)","groups":[{"kind":"cylinder","center":[0,0.165,0],"axis":[0,1,0],"radius":0.8,"halfLength":1.37,"turns":48,"currentA":1,"drive":{"key":"pulseCoilCurrent"},"label":"coil"}]},
  "homopolar": {"unitM":0.3125,"bounds":[[-1,-0.6,-1],[1,0.95,1]],"probe":[0.3,0.16,0],"model":"Axial pole pair solved so B at the disc equals the plant's homopolarFieldT; radial disc current from axle to rim brush as a straight segment; vacuum","groups":[{"builder":"polePair","params":{"shape":"cylinder","center":[0,0.16,0],"gap":0.18,"thickness":0.25,"radius":0.55},"drive":{"key":"homopolarFieldT"},"label":"pole pair"},{"kind":"segment","points":[[0,0.16,0],[0.448,0.16,0]],"currentA":1,"wireM":0.004,"drive":{"key":"homopolarCurrentA"},"label":"disc current"}]},
  "halbach-viz": {"unitM":0.1,"bounds":[[-2,-0.6,-2],[2,1,2]],"probe":[0,0.2,0],"model":"N magnetised blocks (t × t × arc, N52 Br) at the plant's segment count, layout and magnetisation step; exact surface-charge box fields, vacuum","groups":[{"builder":"halbachArray","params":{"radiusM":0.14,"thicknessM":0.028,"y":0.2,"brT":1.48},"label":"Halbach blocks"}]},
  "transformer": {"unitM":0.1,"bounds":[[-1.1,-0.7,-0.6],[1.1,1.2,0.6]],"probe":[0,0.8,0],"model":"Iron core as equivalent ampere-turns on a toroidal winding (core B = |λ|/λref × 1 T, vacuum otherwise); primary 120 t and secondary 40 t as ideal solenoids on the limbs, live currents","groups":[{"builder":"toroidCore","params":{"majorRadius":0.55,"minorRadius":0.16,"cy":0.25,"turns":24,"pointsPerTurn":12,"seedLines":12},"drive":{"key":"transformerFluxN","abs":true},"label":"core flux"},{"kind":"cylinder","center":[-0.55,0.235,0],"axis":[0,1,0],"radius":0.24,"halfLength":0.2,"turns":120,"currentA":1,"drive":{"key":"transformerIpA"},"label":"primary"},{"kind":"cylinder","center":[0.55,0.215,0],"axis":[0,1,0],"radius":0.24,"halfLength":0.16,"turns":40,"currentA":1,"drive":{"key":"transformerIsA"},"label":"secondary"}]},
  "hall": {"unitM":1,"bounds":[[-0.6,-0.3,-0.4],[0.6,0.3,0.4]],"probe":[0,0,0],"model":"Pole pair (not drawn) solved so B at the strip equals hallFieldT, along +Y; strip current along X; Hall field E = V_H / w across Z for the particle pusher; vacuum","efield":{"dir":[0,0,1],"key":"hallVoltage","factor":12.5},"groups":[{"builder":"polePair","params":{"shape":"box","center":[0,0,0],"gap":0.06,"thickness":0.06,"halfSize":[0.3,0.15]},"drive":{"key":"hallFieldT"},"label":"pole pair"},{"kind":"segment","points":[[-0.25,0,0],[0.25,0,0]],"currentA":1,"wireM":0.01,"drive":{"key":"hallCurrent"},"label":"strip current"}]},
  "lorentz-sled": {"unitM":0.16667,"bounds":[[-7.5,-2.6,-3.6],[7.5,2.6,3.6]],"probe":[0,0,0],"model":"Pole plates above and below the track solved so B at the centre equals lorentzFieldT; rails and armature as straight segments carrying the plant's current (X scale; the drawn Z is stretched); vacuum","groups":[{"builder":"polePair","params":{"shape":"box","center":[0,0,0],"gap":1.4,"thickness":0.6,"halfSize":[6,3.2]},"drive":{"key":"lorentzFieldT"},"label":"pole plates"},{"builder":"lorentzCircuit","params":{"x0":-6,"halfGap":2.6,"y":0,"posKey":"lorentzPositionM","posScale":6},"drive":{"key":"lorentzCurrentA"},"label":"rails + armature"}]},
  "jumping-ring": {"unitM":0.012,"bounds":[[-4.5,-8,-4.5],[4.5,10,4.5]],"probe":[0,-4.4,0],"model":"Primary as an ideal 300-turn solenoid, ring as a single-turn loop at the plant's height, both live currents; the iron pole is not modelled (vacuum)","groups":[{"kind":"cylinder","center":[0,-4.4,0],"axis":[0,1,0],"radius":1.7,"halfLength":1.6,"turns":300,"currentA":1,"drive":{"key":"ringPrimaryIA"},"label":"primary"},{"builder":"loop","params":{"radius":2.8,"segments":32,"y":-1,"yKey":"ringHeightM","yScale":83.333,"wireM":0.002},"drive":{"key":"ringCurrentA"},"label":"ring"}]}
} as unknown as Readonly<Record<string, FieldSourceDecl>>;
