/**
 * Thermoelectric module run as a cooler, with a resolved leg — the TS twin of
 * cpp/src/plant/peltier_plant.h, term for term.
 *
 * One equivalent 1-D leg carries the whole module (S = seebeck·couples V/K,
 * R, K), cut into `legCells` finite volumes; four lumped nodes close the ends:
 *
 *   [0] cold block ─ [1] cold plate ─ [2 … N+1] leg cells ─ [N+2] hot plate ─ [N+3] heat sink ─ ambient
 *        ↑ load W        ↑ Peltier −S·I·T                        ↑ Peltier +S·I·T           ↑ sinkWK
 *
 * Per cell: Fourier conduction, Joule heat I²R/N, and — when the Seebeck
 * coefficient is given a slope — the Thomson heat. The discrete system
 * conserves energy exactly: at steady state Q_h = Q_c + I·V, and with constant
 * properties Q_c = S·I·T_c − ½I²R − K·ΔT, the textbook lumped result.
 *
 * It is linear in T for a fixed current and stiff (cells relax in
 * milliseconds, the sink in tens of seconds), so it runs on ros23
 * (renderers/shared/integrate.ts) like the C++ plant.
 *
 * What it is not: one equivalent leg, not 127 couples; constant R and K; no
 * contact resistances inside the module, no radiation, no condensation on the
 * cold side. docs/FLUIDS.md → Peltier lists the limits.
 */

import { PELTIER } from '../../../generated/physics-constants';
import { PLANT_ODE, PeltierState as PS } from '../../../generated/plant-ode';
import {
  addStats,
  advanceAdaptive,
  eulerFixed,
  integratorFor,
  isAdaptive,
  odeStats,
  rk4Fixed,
  toleranceOf,
  type OdePlant,
  type StepperState
} from '../../renderers/shared/integrate';
import type { DevicePlugin } from '../types';
import type { DevicePhysicsState } from '../../renderers/shared/device-physics';

/** The module and bench numbers the model reads — `PELTIER`, or a test's variation of it. */
export interface PeltierParams {
  seebeckVK: number;
  seebeckSlopeVK2: number;
  seebeckRefK: number;
  couples: number;
  rInternalOhm: number;
  conductanceWK: number;
  legCells: number;
  legHeatCapJK: number;
  plateHeatCapJK: number;
  coldBlockHeatCapJK: number;
  sinkHeatCapJK: number;
  blockContactWK: number;
  sinkContactWK: number;
  sinkWK: number;
  coldLeakWK: number;
  iMaxA: number;
  loadMaxW: number;
  ambientK: number;
  deltaTRefK: number;
  clampBelowAmbientK: number;
  clampAboveAmbientK: number;
}

/** Catalog numbers (physics/constants.json `peltier`), shared with the C++ plant. */
export const PELTIER_PARAMS: PeltierParams = PELTIER;

/** Node indices, cold end → hot end. */
export const PELTIER_NODE = Object.freeze({
  coldBlock: 0,
  coldPlate: 1,
  firstCell: 2,
  hotPlate: PELTIER.legCells + 2,
  sink: PELTIER.legCells + 3,
  count: PELTIER.legCells + 4
});

export interface PeltierInput {
  /** Signed drive current, A — held over one advance. */
  currentA: number;
  /** Heat fed into the cold block, W. */
  loadW: number;
}

export interface PeltierOutputs {
  hotK: number;
  coldK: number;
  deltaTK: number;
  voltageV: number;
  powerW: number;
  cop: number;
  qcW: number;
  qhW: number;
}

/** Fixed-step overrides (euler / rk4) substep at this size; explicit steps must stay under ~1.4 ms. */
const H_FIXED_S = 5e-4;
/** |COP| reported at most this; near zero input power the ratio is unbounded. */
const COP_LIMIT = 100;
const P_MIN_W = 1e-3;

/** dT/dt for every node. `x` and `dxdt` have `legCells + 4` entries. */
export function peltierDerivs(p: PeltierParams, x: ArrayLike<number>, u: PeltierInput, dxdt: Float64Array): void {
  const N = p.legCells;
  const CB = 0, CP = 1, C0 = 2, HP = N + 2, SK = N + 3;
  const I = u.currentA;
  const a0 = p.seebeckVK * p.couples;
  const a1 = p.seebeckSlopeVK2 * p.couples;
  const G = p.conductanceWK * N;
  const Gf = 2 * G;
  const qJoule = (I * I * p.rInternalOhm) / N;
  const cCell = p.legHeatCapJK / N;
  const Tcb = x[CB], Tcp = x[CP], Thp = x[HP], Tsk = x[SK];

  // Peltier heat: absorbed from the cold plate, released into the hot one.
  const qPeltierC = (a0 + a1 * (Tcp - p.seebeckRefK)) * I * Tcp;
  const qPeltierH = (a0 + a1 * (Thp - p.seebeckRefK)) * I * Thp;

  dxdt[CB] = (p.blockContactWK * (Tcp - Tcb) + p.coldLeakWK * (p.ambientK - Tcb) + u.loadW) / p.coldBlockHeatCapJK;
  dxdt[CP] = (p.blockContactWK * (Tcb - Tcp) + Gf * (x[C0] - Tcp) - qPeltierC) / p.plateHeatCapJK;
  for (let i = 0; i < N; i++) {
    const k = C0 + i;
    const T = x[k];
    // Face temperatures: the plates at the ends, the mean of two cells inside.
    const faceC = i === 0 ? Tcp : 0.5 * (x[k - 1] + T);
    const faceH = i === N - 1 ? Thp : 0.5 * (T + x[k + 1]);
    const fromC = i === 0 ? Gf * (Tcp - T) : G * (x[k - 1] - T);
    const fromH = i === N - 1 ? Gf * (Thp - T) : G * (x[k + 1] - T);
    // Thomson heat −I·∫T·dS over the cell = −a1·I·(T_h² − T_c²)/2 between its faces.
    const qThomson = -0.5 * a1 * I * (faceH * faceH - faceC * faceC);
    dxdt[k] = (fromC + fromH + qJoule + qThomson) / cCell;
  }
  dxdt[HP] = (Gf * (x[HP - 1] - Thp) + p.sinkContactWK * (Tsk - Thp) + qPeltierH) / p.plateHeatCapJK;
  dxdt[SK] = (p.sinkContactWK * (Thp - Tsk) - p.sinkWK * (Tsk - p.ambientK)) / p.sinkHeatCapJK;
}

/**
 * ∂(dT/dt)/∂T, row-major — exact, and tridiagonal: each node only talks to its
 * neighbours. The C++ plant gets the same matrix from a Dual evaluation.
 */
export function peltierJacobian(p: PeltierParams, x: ArrayLike<number>, u: PeltierInput, J: Float64Array): void {
  const N = p.legCells;
  const n = N + 4;
  const CB = 0, CP = 1, C0 = 2, HP = N + 2, SK = N + 3;
  const I = u.currentA;
  const a0 = p.seebeckVK * p.couples;
  const a1 = p.seebeckSlopeVK2 * p.couples;
  const G = p.conductanceWK * N;
  const Gf = 2 * G;
  const cCell = p.legHeatCapJK / N;
  J.fill(0);
  // d/dT of (a0 + a1·(T − Tref))·I·T
  const dPeltier = (T: number): number => I * (a0 + a1 * (2 * T - p.seebeckRefK));

  J[CB * n + CB] = -(p.blockContactWK + p.coldLeakWK) / p.coldBlockHeatCapJK;
  J[CB * n + CP] = p.blockContactWK / p.coldBlockHeatCapJK;
  J[CP * n + CB] = p.blockContactWK / p.plateHeatCapJK;
  J[CP * n + CP] = (-p.blockContactWK - Gf - dPeltier(x[CP])) / p.plateHeatCapJK;
  J[CP * n + C0] = Gf / p.plateHeatCapJK;
  for (let i = 0; i < N; i++) {
    const k = C0 + i;
    const first = i === 0;
    const last = i === N - 1;
    const faceC = first ? x[CP] : 0.5 * (x[k - 1] + x[k]);
    const faceH = last ? x[HP] : 0.5 * (x[k] + x[k + 1]);
    // Thomson heat −½·a1·I·(faceH² − faceC²): each face is a plate or a two-cell mean.
    const th = -a1 * I;
    const dC = (first ? Gf : G) - th * faceC * (first ? 1 : 0.5);
    const dH = (last ? Gf : G) + th * faceH * (last ? 1 : 0.5);
    const dSelf = -(first ? Gf : G) - (last ? Gf : G)
      + th * (faceH * (last ? 0 : 0.5) - faceC * (first ? 0 : 0.5));
    J[k * n + k - 1] = dC / cCell;
    J[k * n + k] = dSelf / cCell;
    J[k * n + k + 1] = dH / cCell;
  }
  J[HP * n + HP - 1] = Gf / p.plateHeatCapJK;
  J[HP * n + HP] = (-Gf - p.sinkContactWK + dPeltier(x[HP])) / p.plateHeatCapJK;
  J[HP * n + SK] = p.sinkContactWK / p.plateHeatCapJK;
  J[SK * n + HP] = p.sinkContactWK / p.sinkHeatCapJK;
  J[SK * n + SK] = -(p.sinkContactWK + p.sinkWK) / p.sinkHeatCapJK;
}

/** Derived telemetry at a state. */
export function peltierOutputs(p: PeltierParams, x: ArrayLike<number>, u: PeltierInput): PeltierOutputs {
  const N = p.legCells;
  const Tcp = x[1];
  const Thp = x[N + 2];
  const I = u.currentA;
  const a0 = p.seebeckVK * p.couples;
  const a1 = p.seebeckSlopeVK2 * p.couples;
  const Gf = 2 * p.conductanceWK * N;
  const dT = Thp - Tcp;
  // Open-circuit EMF ∫S dT across the leg, plus the ohmic drop.
  const v = a0 * dT + a1 * (0.5 * (Thp * Thp - Tcp * Tcp) - p.seebeckRefK * dT) + I * p.rInternalOhm;
  const power = I * v;
  // Heat leaving the cold plate into the leg / entering the hot plate from it.
  const qc = (a0 + a1 * (Tcp - p.seebeckRefK)) * I * Tcp + Gf * (Tcp - x[2]);
  const qh = (a0 + a1 * (Thp - p.seebeckRefK)) * I * Thp + Gf * (x[N + 1] - Thp);
  return {
    hotK: Thp,
    coldK: Tcp,
    deltaTK: dT,
    voltageV: v,
    powerW: power,
    cop: power > P_MIN_W ? Math.max(-COP_LIMIT, Math.min(COP_LIMIT, qc / power)) : 0,
    qcW: qc,
    qhW: qh
  };
}

/** The plant as an {@link OdePlant} for a parameter set (x = node temperatures). */
export function makePeltierPlant(p: PeltierParams): OdePlant<PeltierInput> {
  const lo = p.ambientK - p.clampBelowAmbientK;
  const hi = p.ambientK + p.clampAboveAmbientK;
  return {
    stateSize: p.legCells + 4,
    derivs(_t, x, u, dxdt) {
      peltierDerivs(p, x, u, dxdt);
    },
    jacobian(_t, x, u, J) {
      peltierJacobian(p, x, u, J);
    },
    /**
     * Every node stays within [ambient − clampBelow, ambient + clampAbove]: a
     * reversed current into the insulated block has no other limit.
     */
    constrain(x) {
      let changed = false;
      for (let i = 0; i < x.length; i++) {
        const c = Math.max(lo, Math.min(hi, x[i]));
        if (c !== x[i]) {
          x[i] = c;
          changed = true;
        }
      }
      return changed;
    }
  };
}

const PELTIER_ODE = PLANT_ODE.peltier;
const PELTIER_TOL = toleranceOf(PELTIER_ODE);
export const PELTIER_PLANT = makePeltierPlant(PELTIER_PARAMS);

const nodeX = new Float64Array(PELTIER_NODE.count);
const nodeU: PeltierInput = { currentA: 0, loadW: 0 };
const nodeStepper: StepperState = { h: 0, errOld: 1e-4 };

/** A fresh profile: every node at ambient. */
function ambientNodes(): number[] {
  return new Array<number>(PELTIER_NODE.count).fill(PELTIER_PARAMS.ambientK);
}

/**
 * One frame of the cooler. Mirrors `_stepPeltier` in
 * cpp/src/plant/peltier_plant.cpp: the drive sets the current magnitude, the
 * polarity setpoint its direction, the load setpoint feeds the cold block, and
 * the node temperatures advance on the catalog integrator (or
 * `state.integratorOverride`).
 *
 * @param drive 0..1 — fraction of `iMaxA`
 */
export const stepPeltierPhysics: NonNullable<DevicePlugin['stepPhysics']> = (state, dt, drive) => {
  if (!(dt > 0) || !Number.isFinite(dt)) return;
  const p = PELTIER_PARAMS;
  let nodes = state.peltierNodesK;
  if (!nodes || nodes.length !== PELTIER_NODE.count) nodes = state.peltierNodesK = ambientNodes();

  const d = Math.max(0, Math.min(1, drive));
  const u = nodeU;
  u.currentA = ((state.peltierPolarity ?? 1) < 0 ? -1 : 1) * d * p.iMaxA;
  u.loadW = Math.max(0, Math.min(p.loadMaxW, state.peltierLoadW ?? 0));

  const x = nodeX;
  for (let i = 0; i < x.length; i++) x[PS.nodesK + i] = nodes[i];

  const method = integratorFor(PELTIER_ODE, state.integratorOverride);
  if (isAdaptive(method)) {
    nodeStepper.h = state.peltierStepH ?? 0;
    nodeStepper.errOld = state.peltierStepErrOld ?? 1e-4;
    addStats(odeStats, advanceAdaptive(method, PELTIER_PLANT, x, u, dt, PELTIER_TOL, nodeStepper));
    state.peltierStepH = nodeStepper.h;
    state.peltierStepErrOld = nodeStepper.errOld;
  } else {
    // Explicit and fixed: only stable in small substeps (a reference, not the
    // way to run this plant).
    const nSub = Math.max(1, Math.ceil(dt / H_FIXED_S));
    const h = dt / nSub;
    const fixed = method === 'euler' ? eulerFixed : rk4Fixed;
    for (let i = 0; i < nSub; i++) {
      addStats(odeStats, fixed(PELTIER_PLANT, 0, h, x, u));
      PELTIER_PLANT.constrain?.(x);
    }
  }
  for (let i = 0; i < x.length; i++) nodes[i] = x[PS.nodesK + i];

  const y = peltierOutputs(p, x, u);
  state.peltierHotK = y.hotK;
  state.peltierColdK = y.coldK;
  state.peltierDeltaT = y.deltaTK;
  state.peltierVoltage = y.voltageV;
  state.peltierCurrent = u.currentA;
  state.peltierPowerW = y.powerW;
  state.peltierCOP = y.cop;
  state.peltierQcW = y.qcW;
  state.peltierQhW = y.qhW;
  state.energyLevel = Math.min(1, Math.abs(y.deltaTK) / p.deltaTRefK);
};

export function createPeltierPhysicsState(): Partial<DevicePhysicsState> {
  const p = PELTIER_PARAMS;
  // Every node at ambient, exactly like PeltierState's C++ defaults — the
  // drive current is what opens ΔT.
  return {
    peltierNodesK: ambientNodes(),
    peltierLoadW: 0,
    peltierPolarity: 1,
    peltierHotK: p.ambientK,
    peltierColdK: p.ambientK,
    peltierDeltaT: 0,
    peltierVoltage: 0,
    peltierCurrent: 0,
    peltierPowerW: 0,
    peltierCOP: 0,
    peltierQcW: 0,
    peltierQhW: 0,
    peltierStepH: 0,
    peltierStepErrOld: 1e-4,
    energyLevel: 0
  };
}

/** Module figure of merit Z = S² / (R·K), 1/K. */
export function peltierFigureOfMerit(p: PeltierParams = PELTIER_PARAMS): number {
  const s = p.seebeckVK * p.couples;
  return (s * s) / (p.rInternalOhm * p.conductanceWK);
}
