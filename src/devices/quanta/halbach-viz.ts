/**
 * Halbach array field visualizer — Quanta Magnetics catalog entry.
 *
 * Configurable N-segment Halbach ring or linear array with CPU field-line
 * tracing and |B| slice heatmap (focus view). Educational dipole superposition.
 *
 * References:
 *   - K. Halbach — permanent multipole magnets (1980)
 *   - M. V. Berry — levitation of spinning magnets (1996)
 */

import { packInstance, type InstanceArray, type InstanceFloats } from '../../device-mesh-layouts';
import { writeMeshCylinders } from '../update-helpers';
import {
  buildHalbachSegments,
  estimatePeakFieldT,
  estimateDipoleForceN,
  halbachPeriodM,
  traceHalbachFieldLines,
  sampleFieldHeatmap,
  MAGNET_BR
} from './halbach-field';
import type { HalbachConfig } from './halbach-field';
import type { DevicePlugin } from '../types';
import type { DevicePhysicsState } from '../../renderers/shared/device-physics';
import { catalogIdentity } from '../../../generated/device-catalog';
import { HALBACH_VIZ } from '../../../generated/physics-constants';

export { HALBACH_VIZ };

/**
 * JS-only plant by design (ADR-0002 — no `wasmMode`), so codegen emits TS
 * only: physics/constants.json (`halbachViz` block) → `HALBACH_VIZ`.
 * SCENE_SCALE stays local — it is a render scale, not a physical constant.
 */
const SCENE_SCALE = 10;
const RADIUS_M = HALBACH_VIZ.radiusM;
const THICKNESS_M = HALBACH_VIZ.thicknessM;

function yawQuat(angleRad: number): number[] {
  const half = angleRad * 0.5;
  return [0, Math.sin(half), 0, Math.cos(half)];
}

export function halbachConfigFromState(state: Partial<DevicePhysicsState> | null | undefined): HalbachConfig {
  const segmentCount = state?.halbachSegmentCount ?? 8;
  const magAngleDeg = state?.halbachMagAngleDeg ?? (360 / segmentCount);
  const layout = state?.halbachLayout ?? 'ring';
  return {
    segmentCount,
    magAngleDeg,
    layout,
    radiusM: RADIUS_M,
    thicknessM: THICKNESS_M,
    remanenceT: MAGNET_BR
  };
}

function magnetColor(i: number, n: number, magAngleDeg: number): number[] {
  const hue = (i / n + magAngleDeg / 360) % 1;
  const north = hue < 0.5;
  return north
    ? [0.12 + hue * 0.4, 0.45 + hue * 0.3, 0.92]
    : [0.82, 0.22 + hue * 0.2, 0.18];
}

/** Build magnet segment cylinders for ring or linear Halbach layout. */
function buildSegmentInstances(config: HalbachConfig): InstanceArray {
  const segments = buildHalbachSegments(config);
  const out: InstanceArray = [];
  const majorR = RADIUS_M * SCENE_SCALE;
  const thick = THICKNESS_M * SCENE_SCALE * 3.5;

  if (config.layout === 'linear') {
    for (const seg of segments) {
      const x = seg.position.x * SCENE_SCALE;
      const mAngle = Math.atan2(seg.moment.z, seg.moment.x);
      const rot = yawQuat(mAngle);
      const color = magnetColor(seg.index, segments.length, config.magAngleDeg);
      out.push(packInstance([x, 0.2, 0], thick, rot, color, 0.32));
    }
    return out;
  }

  for (const seg of segments) {
    const x = seg.position.x * SCENE_SCALE;
    const z = seg.position.z * SCENE_SCALE;
    const mAngle = Math.atan2(seg.moment.z, seg.moment.x);
    const rot = yawQuat(mAngle);
    const color = magnetColor(seg.index, segments.length, config.magAngleDeg);
    out.push(packInstance([x, 0.2, z], thick, rot, color, 0.3));
  }
  return out;
}

function buildBaseInstances(): InstanceArray {
  const steel = [0.4, 0.42, 0.46];
  return [
    packInstance([0, -0.5, 0], 1, [0, 0, 0, 1], steel, 0.04),
    packInstance([0, 0.05, 0], 1, [0, 0, 0, 1], [0.3, 0.32, 0.36], 0.02)
  ];
}

/** Slice plane marker (thin disc) for |B| heatmap reference. */
function buildSlicePlaneInstance(): InstanceFloats {
  return packInstance([0, 0.02, 0], 20, [0, 0, 0, 1], [0.2, 0.55, 0.9], 0.08);
}

export function buildHalbachVizMesh(config: HalbachConfig): { cylinders: () => InstanceArray } {
  return {
    cylinders: (): InstanceArray => [
      ...buildBaseInstances(),
      ...buildSegmentInstances(config),
      buildSlicePlaneInstance()
    ]
  };
}

/**
 * Recompute field lines and heatmap when segment params change.
 */
export function refreshHalbachFieldGeometry(state: Partial<DevicePhysicsState>): void {
  const config = halbachConfigFromState(state);
  const segments = buildHalbachSegments(config);
  const lineCount = Math.min(20, 6 + Math.floor(config.segmentCount / 2));

  state.halbachFieldLines = traceHalbachFieldLines(
    segments,
    lineCount,
    config.layout,
    RADIUS_M
  ).map((line) => {
    const scaled = new Float32Array(line.length);
    for (let i = 0; i < line.length; i += 3) {
      scaled[i] = line[i] * SCENE_SCALE;
      scaled[i + 1] = line[i + 1] * SCENE_SCALE + 0.15;
      scaled[i + 2] = line[i + 2] * SCENE_SCALE;
    }
    return scaled;
  });

  state.halbachHeatmap = sampleFieldHeatmap(segments, 24, RADIUS_M * 2.2, 0);
  state.halbachPeakBT = estimatePeakFieldT(segments);
  state.halbachPeriodM = halbachPeriodM(config);
  state.halbachDipoleForceN = estimateDipoleForceN(
    0.002,
    { x: 0, y: 0.08, z: 0 },
    segments
  );
}

/**
 * @param drive 0..1 from speed slider
 */
export const stepHalbachVizPhysics: NonNullable<DevicePlugin['stepPhysics']> = (state, dt, drive) => {
  const segmentCount = Math.max(
    HALBACH_VIZ.segmentMin,
    Math.min(HALBACH_VIZ.segmentMax,
      HALBACH_VIZ.segmentMin + Math.round(drive * HALBACH_VIZ.segmentSpan))
  );
  const idealStep = 360 / segmentCount;
  const magAngleDeg = idealStep * (HALBACH_VIZ.magAngleBase + drive * HALBACH_VIZ.magAngleSpan);

  const layoutParam = typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('halbachLinear') === '1'
    ? 'linear'
    : 'ring';

  const changed = segmentCount !== state.halbachSegmentCount
    || Math.abs(magAngleDeg - (state.halbachMagAngleDeg ?? 0)) > 0.05
    || layoutParam !== state.halbachLayout;

  state.halbachSegmentCount = segmentCount;
  state.halbachMagAngleDeg = magAngleDeg;
  state.halbachLayout = layoutParam;

  if (changed || !state.halbachFieldLines) {
    refreshHalbachFieldGeometry(state);
  }

  state.energyLevel = Math.min(1, drive * 0.5 + (state.halbachPeakBT ?? 0) * 0.5);
};

export function createHalbachVizPhysicsState(): Partial<DevicePhysicsState> {
  const state: Partial<DevicePhysicsState> = {
    halbachSegmentCount: 8,
    halbachMagAngleDeg: 45,
    halbachLayout: 'ring',
    halbachPeakBT: 0,
    halbachPeriodM: 0,
    halbachDipoleForceN: 0,
    halbachFieldLines: null,
    halbachHeatmap: null
  };
  refreshHalbachFieldGeometry(state);
  return state;
}

export const HALBACH_VIZ_REFERENCES = [
  {
    title: 'Design of permanent multipole magnets with oriented rare earth cobalt material',
    authors: 'K. Halbach',
    year: 1980,
    note: 'Halbach array — field concentration via rotating magnetization pattern'
  },
  {
    title: 'The levitation of spinning magnets',
    authors: 'M. V. Berry',
    year: 1996,
    note: 'Magnetic forces and stability in permanent-magnet assemblies'
  },
  {
    title: 'NdFeB N52 magnet specifications',
    authors: 'ValidatedConstants.MAGNET_BR',
    year: 2018,
    note: `Remanence B_r ≈ ${MAGNET_BR.toFixed(2)} T`
  }
];

const halbachUpdateMesh: NonNullable<DevicePlugin['updateMesh']> = (instance) => {
  const config = halbachConfigFromState(instance.physicsState);
  writeMeshCylinders(instance, buildHalbachVizMesh(config));
};

const halbachComputeRawEnergy: NonNullable<DevicePlugin['computeRawEnergy']> = (instance, ctx) => {
  const fieldN = Math.min(1, (instance.physicsState?.halbachPeakBT ?? 0) / 0.8);
  return Math.min(1.0, fieldN * 0.8 + ctx.speedNorm * 0.2);
};

const halbachUpdateEffects: NonNullable<DevicePlugin['updateEffects']> = (instance, ctx) => {
  const { budget, energy, gate, pushParticle, time } = ctx;
  const fieldGate = Math.pow(gate(energy, 0.15, 0.85), 1.2);
  const sparkCount = Math.floor(budget * 0.45 * fieldGate);
  for (let i = 0; i < sparkCount; i++) {
    const a = (i / Math.max(1, sparkCount)) * Math.PI * 2 + time * 0.8;
    const r = 0.8 + Math.random() * 2.2;
    const y = 0.2 + Math.sin(time * 3 + i * 0.2) * 0.1;
    pushParticle(Math.cos(a) * r, y, Math.sin(a) * r, 3.0 + Math.random());
  }
  return true;
};

export const halbachVizPlugin: DevicePlugin = {
  ...catalogIdentity('halbach-viz'),
  needsPhysicsState: true,
  defaults: {
    particleCount: 4500,
    color: [0.35, 0.75, 1.0],
    cameraOffset: [0, 4.0, 12]
  },
  references: HALBACH_VIZ_REFERENCES,
  telemetrySchema: {
    halbachSegmentCount: { label: 'Segments', unit: '', source: 'sim' },
    halbachMagAngleDeg: { label: 'Mag. angle', unit: '°', source: 'sim' },
    halbachPeakBT: { label: 'Peak |B|', unit: 'T', source: 'fallback-physics' },
    halbachPeriodM: { label: 'Period', unit: 'm', source: 'sim' },
    halbachDipoleForceN: { label: 'Dipole force', unit: 'N', source: 'fallback-physics' }
  },
  meshLayout: {
    cylinders: () => buildHalbachVizMesh(halbachConfigFromState({ halbachSegmentCount: 8, halbachMagAngleDeg: 45 })).cylinders()
  },
  createPhysicsState: createHalbachVizPhysicsState,
  stepPhysics: stepHalbachVizPhysics,
  updateMesh: halbachUpdateMesh,
  computeRawEnergy: halbachComputeRawEnergy,
  updateEffects: halbachUpdateEffects,
  wantsThermalHaze: true
};

export { SCENE_SCALE, RADIUS_M };
