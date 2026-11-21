/**
 * CircuitHost (#256, ADR-0018) — one loaded netlist on the C++ solver, stepped
 * on the plant clock.
 *
 * Per plant substep dt (LabSession.stepPlant live, ExperimentBench offline):
 *
 *   1. every bench port's `before` writes plant → circuit (EMF from ω, …);
 *   2. the solver advances dt — split into ⌈dt · scopeHz⌉ calls so the scope
 *      sees the waveform, not one sample per 1/60 s substep (the solver's own
 *      internal steps are chosen by its error control either way);
 *   3. every port's `after` reads circuit → plant from the window integrals
 *      accumulated over those calls (∫i, ∫i², ∫v·i);
 *   4. the energy books close the window: W_source − W_dissipated − ΔE_stored,
 *      over a sliding second, is the residual the energy network shows for the
 *      solved edges (Tellegen on the discrete solution — trapezoidal O(h³)).
 *
 * Epochs (ADR-0009): replay freezes the circuit (no step); leaving replay and
 * an operator RESET (status back to STANDBY) put it back at its initial
 * conditions; START / STOP / E-stop do not — the drive they change reaches
 * the circuit through the port sources, as it reaches every plant.
 *
 * No TS mirror of the solver: without sim_core the host reports `needs-wasm`
 * and the wiring view stays read-only (docs/WEBGL2.md, docs/CIRCUIT.md).
 */
import type { SolvedEnergyBooks } from '../renderers/shared/energy-network';
import type { CircuitSimInstance, SimCoreModule } from '../wasm/sim-core/abi.generated';
import { CIRCUIT_STATUS, ST } from './kinds';
import { parseCircuitKey, type CircuitAccess } from './keys';
import { compileCircuit, paramSlot, paramProblem, renderableDoc, type CircuitDoc, type CompiledCircuit } from './netlist';
import { portEnergyIn, type CompiledPort, type PortState, type PortStepContext } from './ports';
import { CircuitReadout, type ReadoutView } from './readout';

export type CircuitHostState = 'empty' | 'ok' | 'error' | 'needs-wasm';

type DeviceLike = { physicsState?: unknown; physics?: unknown } | null | undefined;
export type DeviceSource = () => Record<string, DeviceLike>;

/** Window integrals of the port elements, summed over the sub-calls of one substep. */
class PortWindow {
  readonly wE = new Map<number, number>();
  readonly wQ = new Map<number, number>();
  readonly wI2 = new Map<number, number>();
  clear(elems: Iterable<number>): void {
    for (const e of elems) { this.wE.set(e, 0); this.wQ.set(e, 0); this.wI2.set(e, 0); }
  }
  add(ro: CircuitReadout, elems: Iterable<number>): void {
    for (const e of elems) {
      this.wE.set(e, (this.wE.get(e) ?? 0) + ro.wE(e));
      this.wQ.set(e, (this.wQ.get(e) ?? 0) + ro.wQ(e));
      this.wI2.set(e, (this.wI2.get(e) ?? 0) + ro.wI2(e));
    }
  }
}

/** The last readout, with window integrals that span the whole substep (ports read this). */
function substepReadout(ro: CircuitReadout, w: PortWindow): ReadoutView {
  return {
    time: () => ro.time(),
    nodeV: (n) => ro.nodeV(n),
    elemI: (e) => ro.elemI(e),
    elemV: (e) => ro.elemV(e),
    elemP: (e) => ro.elemP(e),
    wE: (e) => w.wE.get(e) ?? ro.wE(e),
    wQ: (e) => w.wQ.get(e) ?? ro.wQ(e),
    wI2: (e) => w.wI2.get(e) ?? ro.wI2(e)
  };
}

export interface CircuitBooks {
  /** Sliding-second sums (J). */
  source: number;
  dissipated: number;
  storedDelta: number;
  /** |source − dissipated − ΔE| / max(|source|, |dissipated|), or 0 with nothing flowing. */
  residual: number;
  /** Bench port → mean power into the circuit over the last second (W). */
  portW: Record<string, number>;
}

export interface ScopeTrace {
  keys: string[];
  t: Float64Array;
  ch: Float64Array[];
}

const BOOK_TAU_S = 1;
const SCOPE_CAPACITY = 8192;

export class CircuitHost implements CircuitAccess {
  state: CircuitHostState = 'empty';
  message = '';
  /** The last document loaded (shown even when it did not compile, or without WASM). */
  doc: CircuitDoc | null = null;
  compiled: CompiledCircuit | null = null;
  /** Calls per second of plant time the solver is advanced in (scope resolution). */
  scopeHz = 4800;

  private sim: CircuitSimInstance | null = null;
  private readout: CircuitReadout | null = null;
  private owned = new Set<string>();
  private readonly window = new PortWindow();
  private portElems: number[] = [];
  private books = { source: 0, dissipated: 0, storedDelta: 0, abs: 0, portJ: new Map<string, number>() };
  /** Port id → rms terminal current over the last substep (A) — the cable's flow. */
  private portIrms = new Map<string, number>();
  private scopeKeys: string[] = [];
  private scopeT = new Float64Array(SCOPE_CAPACITY);
  private scopeCh = [new Float64Array(SCOPE_CAPACITY), new Float64Array(SCOPE_CAPACITY)];
  private scopeN = 0;
  private scopeHead = 0;
  private epoch: number | null = null;
  private wasReplay = false;
  /** Bumped on every load / reset (UI redraws, cables re-read). */
  generation = 0;
  /** Called when the solver stops mid-run (the live lab detaches it). */
  onFail: (() => void) | null = null;

  constructor(
    private readonly mod: SimCoreModule | null,
    private readonly devices: DeviceSource
  ) {
    if (!mod?.CircuitSim) {
      this.state = 'needs-wasm';
      this.message = 'The circuit solver is C++ (sim_core.wasm), and it is not loaded: the wiring view is read-only.';
    }
  }

  get loaded(): boolean {
    return this.state === 'ok';
  }

  /** Load (or clear, with null) a netlist document. False with `message` set on failure. */
  load(doc: CircuitDoc | unknown | null): boolean {
    this.release();
    this.generation++;
    // A rejected document stays on the sheet (so it can be fixed) only when
    // the wiring view can draw it; anything else is not a CircuitDoc.
    this.doc = renderableDoc(doc);
    if (doc == null) {
      if (this.state !== 'needs-wasm') { this.state = 'empty'; this.message = ''; }
      return true;
    }
    let compiled: CompiledCircuit;
    try {
      compiled = compileCircuit(doc);
    } catch (err) {
      this.compiled = null;
      if (this.state !== 'needs-wasm') this.state = 'error';
      this.message = err instanceof Error ? err.message : String(err);
      return false;
    }
    this.compiled = compiled;
    // One document object from here on: value edits (writeKey) and the
    // wiring view's moves land in what a share link captures.
    this.doc = compiled.doc;
    if (!this.mod?.CircuitSim) return false;
    const sim = new this.mod.CircuitSim();
    const rc = sim.load(compiled.packed);
    if (rc !== 0) {
      this.state = 'error';
      this.message = `solver refused the netlist (${CIRCUIT_STATUS[rc] ?? rc}): ${sim.errorText()}`;
      sim.delete();
      return false;
    }
    this.sim = sim;
    this.readout = new CircuitReadout(this.mod, sim, compiled.nodeCount);
    this.readout.refresh();
    this.portElems = compiled.ports.flatMap((p) => Object.values(p.elems));
    this.state = 'ok';
    this.message = compiled.warnings.join('; ');
    this.scopeKeys = (compiled.doc.scope ?? []).slice(0, 2);
    this.clearBooks();
    for (const p of compiled.ports) {
      const st = this.portState(p);
      st._circuitOwned = true;
      this.owned.add(p.device);
    }
    return true;
  }

  /** Back to the netlist's initial conditions (parameters keep their current values). */
  reset(): void {
    if (!this.sim) return;
    this.sim.reset();
    this.readout?.refresh();
    this.clearBooks();
    // The solver's clock is back at 0: drop the old samples so the scope (and
    // Send to analysis) never sees time run backwards. The channels stay.
    this.scopeN = 0;
    this.scopeHead = 0;
    this.portIrms.clear();
    this.generation++;
  }

  /** Whether a device's electrical state is the circuit's (its plant must not step it). */
  owns(deviceId: string): boolean {
    return this.owned.has(deviceId);
  }

  ownedDevices(): string[] {
    return [...this.owned];
  }

  /** ADR-0009: call once per batch with the operator's epoch; resets on RESET / after replay. */
  syncEpoch(epoch: number, standby: boolean, replay: boolean): void {
    if (this.epoch !== null && epoch !== this.epoch && (standby || this.wasReplay !== replay)) this.reset();
    this.epoch = epoch;
    this.wasReplay = replay;
  }

  /** Advance the circuit and its wired benches over the batch's substeps. */
  stepBatch(simSteps: readonly number[], drive: number): void {
    if (!this.sim) return;
    for (const dt of simSteps) if (dt > 0) this.stepSubstep(dt, drive);
  }

  stepSubstep(dt: number, drive: number): void {
    const sim = this.sim, ro = this.readout, c = this.compiled;
    if (!sim || !ro || !c || !(dt > 0)) return;
    const ctxOf = (p: CompiledPort, readout: ReadoutView): PortStepContext => ({
      setParam: (e, i, v) => sim.setParam(e, i, v),
      readout,
      state: this.portState(p),
      dt,
      drive,
      t: readout.time()
    });
    for (const p of c.ports) p.driver.before(p, ctxOf(p, ro));
    const calls = Math.max(1, Math.min(4096, Math.ceil(dt * this.scopeHz - 1e-9)));
    const h = dt / calls;
    this.window.clear(this.portElems);
    let source = 0, dissipated = 0;
    const stored0 = sim.storedEnergy();
    for (let k = 0; k < calls; k++) {
      const rc = sim.step(h);
      ro.refresh();
      if (rc < 0) return this.fail(`solver stopped (${CIRCUIT_STATUS[rc] ?? rc}) at t = ${ro.time().toPrecision(4)} s: ${sim.errorText()}`);
      this.window.add(ro, this.portElems);
      source += ro.wSource();
      dissipated += ro.wDissipated();
      this.sampleScope(ro);
    }
    const whole = substepReadout(ro, this.window);
    for (const p of c.ports) {
      p.driver.after(p, ctxOf(p, whole));
      const e = p.elems[p.driver.currentElem];
      this.portIrms.set(p.id, e === undefined ? 0 : Math.sqrt(Math.max(0, whole.wI2(e)) / dt));
    }
    this.closeBooks(dt, source, dissipated, sim.storedEnergy() - stored0, whole);
  }

  /**
   * The solver stopped: drop it and hand the wired benches back to their own
   * physics, so nothing is left owned with no stepper. The document stays on
   * the sheet, so a value can be fixed and the circuit reloaded.
   */
  private fail(message: string): void {
    this.release();
    this.state = 'error';
    this.message = message;
    this.generation++;
    this.onFail?.();
  }

  // ── energy books ───────────────────────────────────────────────────────

  private clearBooks(): void {
    this.books = { source: 0, dissipated: 0, storedDelta: 0, abs: 0, portJ: new Map() };
  }

  private closeBooks(dt: number, source: number, dissipated: number, dStored: number, ro: ReadoutView): void {
    const decay = Math.exp(-dt / BOOK_TAU_S);
    const b = this.books;
    b.source = b.source * decay + source;
    b.dissipated = b.dissipated * decay + dissipated;
    b.storedDelta = b.storedDelta * decay + dStored;
    for (const p of this.compiled?.ports ?? []) {
      b.portJ.set(p.id, (b.portJ.get(p.id) ?? 0) * decay + portEnergyIn(p, ro));
    }
  }

  /** The energy network's view (EnergyNetwork.setSolvedEdges). */
  solvedEdges(): SolvedEnergyBooks {
    const b = this.energyBooks();
    return {
      edges: (this.compiled?.ports ?? []).map((p) => ({
        from: p.device,
        to: 'circuit',
        powerW: b.portW[p.id] ?? 0,
        currentA: this.portIrms.get(p.id) ?? 0
      })),
      residual: b.residual,
      sourceW: b.source / BOOK_TAU_S,
      dissipatedW: b.dissipated / BOOK_TAU_S
    };
  }

  energyBooks(): CircuitBooks {
    const b = this.books;
    const scale = Math.max(Math.abs(b.source), Math.abs(b.dissipated), 1e-12);
    const flowing = scale > 1e-9;
    const portW: Record<string, number> = {};
    for (const [id, j] of b.portJ) portW[id] = j / BOOK_TAU_S;
    return {
      source: b.source,
      dissipated: b.dissipated,
      storedDelta: b.storedDelta,
      residual: flowing ? Math.abs(b.source - b.dissipated - b.storedDelta) / scale : 0,
      portW
    };
  }

  // ── keys (experiments, scope, meters) ──────────────────────────────────

  readKey(key: string): number {
    const c = this.compiled, ro = this.readout, sim = this.sim;
    const k = parseCircuitKey(key);
    if (!k || !c) return Number.NaN;
    if (k.kind === 'residual') return this.energyBooks().residual;
    if (!ro || !sim) return Number.NaN;
    switch (k.kind) {
      case 'node': {
        const n = c.nodeByName.get(k.name);
        return n === undefined ? Number.NaN : ro.nodeV(n);
      }
      case 'elem': {
        const e = c.elemIndex.get(k.id);
        if (e === undefined) return Number.NaN;
        return k.what === 'i' ? ro.elemI(e) : k.what === 'v' ? ro.elemV(e) : ro.elemP(e);
      }
      case 'param': {
        const slot = paramSlot(c, k.id, k.name);
        return slot ? sim.getParam(slot.elem, slot.index) : Number.NaN;
      }
      case 'port':
        return this.energyBooks().portW[k.id] ?? Number.NaN;
    }
    return Number.NaN;
  }

  writeKey(key: string, value: number): boolean {
    const k = parseCircuitKey(key);
    const c = this.compiled, sim = this.sim;
    if (!k || k.kind !== 'param' || !c || !sim) return false;
    const slot = paramSlot(c, k.id, k.name);
    if (!slot || paramProblem(slot.spec, value)) return false;
    const ok = sim.setParam(slot.elem, slot.index, value);
    if (ok) {
      // Keep the document in step, so a share link / export carries it.
      const e = c.doc.e.find((x) => x.id === k.id);
      if (e) e.p = { ...(e.p ?? {}), [k.name]: value };
      this.readout?.refresh();
    }
    return ok;
  }

  /** Solver statistics (circuit.h ST_*), for the wiring view's footer. */
  stats(): Record<keyof typeof ST, number> {
    const out = {} as Record<keyof typeof ST, number>;
    for (const [name, i] of Object.entries(ST)) out[name as keyof typeof ST] = this.sim?.stat(i) ?? 0;
    return out;
  }

  time(): number {
    return this.readout?.time() ?? 0;
  }

  // ── scope ──────────────────────────────────────────────────────────────

  setScope(keys: readonly string[]): void {
    this.scopeKeys = keys.slice(0, 2);
    if (this.doc) this.doc.scope = [...this.scopeKeys];
    this.scopeN = 0;
    this.scopeHead = 0;
  }

  private sampleScope(ro: CircuitReadout): void {
    if (!this.scopeKeys.length) return;
    const i = this.scopeHead;
    this.scopeT[i] = ro.time();
    for (let c = 0; c < this.scopeKeys.length; c++) this.scopeCh[c][i] = this.readKey(this.scopeKeys[c]);
    this.scopeHead = (i + 1) % SCOPE_CAPACITY;
    this.scopeN = Math.min(SCOPE_CAPACITY, this.scopeN + 1);
  }

  /** The scope's samples, oldest first (copies). */
  scopeTrace(): ScopeTrace {
    const n = this.scopeN;
    const start = (this.scopeHead - n + SCOPE_CAPACITY) % SCOPE_CAPACITY;
    const take = (src: Float64Array) => {
      const out = new Float64Array(n);
      for (let k = 0; k < n; k++) out[k] = src[(start + k) % SCOPE_CAPACITY];
      return out;
    };
    return { keys: [...this.scopeKeys], t: take(this.scopeT), ch: this.scopeKeys.map((_, c) => take(this.scopeCh[c])) };
  }

  // ── devices ────────────────────────────────────────────────────────────

  private portState(p: CompiledPort): PortState {
    const d = this.devices()[p.device];
    const st = (d?.physicsState ?? d?.physics) as PortState | undefined;
    return st ?? (this.orphanStates[p.device] ??= {});
  }

  private orphanStates: Record<string, PortState> = {};

  private release(): void {
    for (const id of this.owned) {
      const d = this.devices()[id];
      const st = (d?.physicsState ?? d?.physics) as PortState | undefined;
      if (st) st._circuitOwned = false;
    }
    this.owned.clear();
    this.sim?.delete();
    this.sim = null;
    this.readout = null;
    this.portElems = [];
    this.portIrms.clear();
    this.scopeN = 0;
    this.scopeHead = 0;
  }

  dispose(): void {
    this.release();
    this.compiled = null;
    if (this.state !== 'needs-wasm') this.state = 'empty';
  }
}
