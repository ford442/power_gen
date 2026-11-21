/**
 * Bench ports (#256, ADR-0018) — where a catalog bench meets a drawn circuit.
 *
 * A device declares its ports in physics/devices.json (`"ports"`, codegen
 * → generated/circuit-ports.ts); each names a driver here. A driver
 *
 *   expand   adds the bench's own electrical part to the netlist between the
 *            port's two terminal nodes (internal nodes are its own), and
 *   before   writes plant → circuit once per substep (an EMF from ω, the
 *            generator's amplitude from drive),
 *   after    reads circuit → plant once per substep: window averages from the
 *            solver's readout (∫i dt / h, ∫i² dt / h), never a single
 *            sample, so a fast ring inside one 1/60 s substep still moves the
 *            plant by the right impulse.
 *
 * While wired the device is circuit-owned (`_circuitOwned` on its physics
 * state): its JS plant does not step (stepDevicePhysics returns early), a C++
 * focus plant's result is not applied, and the driver writes the device's
 * telemetry keys itself — so meshes, telemetry and experiments keep reading
 * the keys they always read.
 *
 * Energy: the homopolar torque is k·ī with k = ½ B r², the same k as its
 * EMF = k ω, so the mechanical power taken from the disc equals the source
 * power Σ v·i the solver books for the port — exactly, per substep (EMF is
 * held constant across it). (The free-running plant's load torque I·B·r/2
 * uses r, not r²; see docs/CIRCUIT.md → Bench ports.)
 */
import { CIRCUIT_PORTS, type CircuitPortDecl } from '../../generated/circuit-ports';
import { HOMOPOLAR, TRANSFORMER } from '../../generated/physics-constants';
import { HOMOPOLAR_PLANT } from '../devices/quanta/homopolar-generator';
import { PULSE_COIL, estimatePulseCoilPeakBT } from '../devices/quanta/pulse-coil';
import type { NetBuilder } from './netlist';
import type { ReadoutView } from './readout';

export type PortState = Record<string, unknown> & { _circuitOwned?: boolean };

export interface PortStepContext {
  /** Solver parameter write (CircuitSim.setParam). */
  setParam(elem: number, index: number, value: number): boolean;
  readout: ReadoutView;
  state: PortState;
  dt: number;
  drive: number;
  /** Solver time at the end of the substep (after) / its start (before). */
  t: number;
}

export interface CompiledPort {
  /** Document element id of the PORT. */
  id: string;
  device: string;
  port: string;
  decl: CircuitPortDecl;
  driver: PortDriver;
  /** Named internal solver elements (src, r, l, …). */
  elems: Readonly<Record<string, number>>;
  nodes: Readonly<Record<string, number>>;
}

export interface PortDriver {
  name: string;
  /** The internal element on the + terminal: its rms current is the cable's flow. */
  currentElem: string;
  expand(b: NetBuilder, owner: string, plus: number, minus: number): Omit<CompiledPort, 'id' | 'device' | 'port' | 'decl' | 'driver'>;
  before(p: CompiledPort, ctx: PortStepContext): void;
  after(p: CompiledPort, ctx: PortStepContext): void;
  /**
   * Energy (J) the bench put into the circuit over the last window (> 0) or
   * took out of it (< 0) — Σ v·i over the port's internal elements.
   */
  energyIn(p: CompiledPort, ro: ReadoutView): number;
}

const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

// ── homopolar: EMF k·ω, the disc's R and L in series ──────────────────────

const HOMOPOLAR_K = 0.5 * HOMOPOLAR.bAxialT * HOMOPOLAR.discRadiusM * HOMOPOLAR.discRadiusM;
const discX = new Float64Array(2);
const discDx = new Float64Array(2);

const homopolarEmf: PortDriver = {
  name: 'homopolar-emf',
  currentElem: 'l',
  expand(b, owner, plus, minus) {
    const mid = b.node(), mid2 = b.node();
    const src = b.add('V', [mid, minus], [0, 0], owner);
    const r = b.add('R', [mid, mid2], [HOMOPOLAR.rOhm], owner);
    const l = b.add('L', [mid2, plus], [HOMOPOLAR.lHenry, 0], owner);
    return { elems: { src, r, l }, nodes: { plus, minus } };
  },
  before(p, ctx) {
    const field = num(ctx.state.homopolarFieldT, HOMOPOLAR.bAxialT);
    const k = 0.5 * field * HOMOPOLAR.discRadiusM * HOMOPOLAR.discRadiusM;
    ctx.setParam(p.elems.src, 1, k * num(ctx.state.homopolarOmega));
  },
  after(p, ctx) {
    const s = ctx.state;
    const field = num(s.homopolarFieldT, HOMOPOLAR.bAxialT);
    const k = 0.5 * field * HOMOPOLAR.discRadiusM * HOMOPOLAR.discRadiusM;
    const omega0 = num(s.homopolarOmega);
    // Current out of the + terminal, averaged over the substep (the source's
    // branch current runs p → n through it, so delivering is negative).
    const iAvg = -ctx.readout.wQ(p.elems.src) / ctx.dt;
    // Drive torque and drag from the plant itself (its load term with I = 0),
    // then the circuit's k·ī — the catalog integrator for the disc is Euler.
    discX[0] = omega0;
    discX[1] = 0;
    HOMOPOLAR_PLANT.derivs(0, discX, { drive: ctx.drive, fieldT: field }, discDx);
    const omega = Math.max(0, omega0 + (discDx[0] - (k * iAvg) / HOMOPOLAR.inertiaKgM2) * ctx.dt);
    const rpm = (omega * 30) / Math.PI;
    s.homopolarOmega = omega;
    s.homopolarAngle = num(s.homopolarAngle) + omega * ctx.dt;
    s.homopolarRpm = rpm;
    s.homopolarEmfV = k * omega0;
    s.homopolarCurrentA = iAvg;
    s.homopolarCurrent = iAvg;
    s.homopolarFieldT = field;
    s.energyLevel = Math.min(1, ctx.drive * 0.45 + (rpm / HOMOPOLAR.rpmMax) * 0.55);
  },
  energyIn(p, ro) {
    return -ro.wE(p.elems.src);
  }
};

// ── transformer: generator → R_p → L_p ⇄ L_s → R_s → the port ─────────────

const transformerSecondary: PortDriver = {
  name: 'transformer-secondary',
  currentElem: 'rs',
  expand(b, owner, plus, minus) {
    const t = TRANSFORMER;
    const g = b.node(), pri = b.node(), s1 = b.node();
    const src = b.add('V', [g, 0], [1, 0, 0, t.fHz, 0, 0, 0], owner);
    const rp = b.add('R', [g, pri], [t.rpOhm], owner);
    const lp = b.add('L', [pri, 0], [t.lpH, 0], owner);
    const ls = b.add('L', [s1, minus], [t.lsH, 0], owner);
    const k = b.add('K', [], [lp, ls, t.kIdeal], owner);
    const rs = b.add('R', [s1, plus], [t.rsOhm], owner);
    return { elems: { src, rp, lp, ls, k, rs }, nodes: { plus, minus, g } };
  },
  before(p, ctx) {
    const t = TRANSFORMER;
    ctx.setParam(p.elems.src, 2, t.vPrimaryPeak * Math.max(0, Math.min(1, ctx.drive)));
    ctx.setParam(p.elems.k, 2, ctx.state.transformerLeakage ? t.kLeakage : t.kIdeal);
  },
  after(p, ctx) {
    const t = TRANSFORMER;
    const ro = ctx.readout;
    const s = ctx.state;
    const k = s.transformerLeakage ? t.kLeakage : t.kIdeal;
    const i1 = ro.elemI(p.elems.lp), i2 = ro.elemI(p.elems.ls);
    const omega = 2 * Math.PI * t.fHz;
    const M = k * Math.sqrt(t.lpH * t.lsH);
    const phase = (omega * ro.time()) % (2 * Math.PI);
    s.transformerIpA = i1;
    s.transformerIsA = i2;
    s.transformerPhase = phase;
    s.transformerVp = ro.nodeV(p.nodes.g);
    s.transformerVs = ro.nodeV(p.nodes.plus) - ro.nodeV(p.nodes.minus);
    s.transformerK = k;
    s.transformerFluxN = Math.max(0, Math.min(1, Math.abs(t.lpH * i1 + M * i2) / (t.vPrimaryPeak / omega)));
    s.transformerTurnsRatio = t.ns / t.np;
    s.energyLevel = Math.min(1, ctx.drive * 0.55 + (Math.abs(i2) / 3) * 0.45);
  },
  energyIn(p, ro) {
    return -ro.wE(p.elems.src);
  }
};

// ── pulse coil: the coil's R and L; the armature feels ⟨i²⟩ ───────────────

const pulseCoilCoil: PortDriver = {
  name: 'pulse-coil-coil',
  currentElem: 'r',
  expand(b, owner, plus, minus) {
    const m = b.node();
    const r = b.add('R', [plus, m], [PULSE_COIL.R_ohm], owner);
    const l = b.add('L', [m, minus], [PULSE_COIL.L_H, 0], owner);
    return { elems: { r, l }, nodes: { plus, minus } };
  },
  before() {
    /* passive: nothing flows plant → circuit */
  },
  after(p, ctx) {
    const { armatureMassKg: m, armatureTravelMaxM: xMax, kAttract, cDamp } = PULSE_COIL;
    const s = ctx.state;
    const ro = ctx.readout;
    const i = ro.elemI(p.elems.l);
    const i2Mean = ro.wI2(p.elems.l) / ctx.dt;
    let x = num(s.pulseCoilArmatureM), vArm = num(s.pulseCoilArmatureVel);
    vArm += ((kAttract * i2Mean - 22 * x - cDamp * vArm) / m) * ctx.dt;
    x = Math.max(0, Math.min(xMax, x + vArm * ctx.dt));
    if ((x <= 0 && vArm < 0) || (x >= xMax && vArm > 0)) vArm = 0;
    // Peak over the window: at least the rms, and both end samples.
    const iPeak = Math.max(Math.abs(i), Math.abs(num(s.pulseCoilCurrent)), Math.sqrt(Math.max(0, i2Mean)));
    const decay = Math.exp(-1.2 * ctx.dt);
    const peakI = Math.max(iPeak, num(s.pulseCoilPeakIA) * decay);
    s.pulseCoilCurrent = i;
    s.pulseCoilCurrentA = i;
    s.pulseCoilPeakIA = peakI;
    s.pulseCoilBPeakT = Math.max(estimatePulseCoilPeakBT(iPeak), num(s.pulseCoilBPeakT) * decay);
    s.pulseCoilVCap = ro.nodeV(p.nodes.plus) - ro.nodeV(p.nodes.minus);
    s.pulseCoilArmatureM = x;
    s.pulseCoilArmatureMm = x * 1000;
    s.pulseCoilArmatureVel = vArm;
    s.pulseCoilFiring = Math.abs(i) > 0.4;
    s.energyLevel = Math.min(1, Math.min(1, peakI / 80) * 0.7 + ctx.drive * 0.3);
  },
  energyIn(p, ro) {
    return -(ro.wE(p.elems.r) + ro.wE(p.elems.l));
  }
};

const DRIVERS: Readonly<Record<string, PortDriver>> = Object.fromEntries(
  [homopolarEmf, transformerSecondary, pulseCoilCoil].map((d) => [d.name, d])
);

/** Driver names codegen checks catalog `ports[].driver` against. */
export const PORT_DRIVER_NAMES: readonly string[] = Object.keys(DRIVERS);

export interface BoundPortDriver {
  decl: CircuitPortDecl;
  expand(b: NetBuilder, owner: string, plus: number, minus: number): CompiledPort;
}

/** The catalog port `device.port` with its driver, or null. */
export function portDriver(device: string, port: string): BoundPortDriver | null {
  const decl = CIRCUIT_PORTS.find((p) => p.device === device && p.id === port);
  const driver = decl ? DRIVERS[decl.driver] : undefined;
  if (!decl || !driver) return null;
  return {
    decl,
    expand: (b, owner, plus, minus) => ({ id: owner, device, port, decl, driver, ...driver.expand(b, owner, plus, minus) })
  };
}

export { HOMOPOLAR_K };
