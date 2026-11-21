/**
 * Circuit Lab netlist document + compiler (#256, ADR-0018).
 *
 * The document is what the wiring view edits and what LabConfig carries
 * (`circuit` field → `#lab2=`, `.lab.json`):
 *
 *   {
 *     "v": 1,
 *     "e": [                                   elements (≤ 256)
 *       { "id": "R1", "k": "R", "x": 4, "y": 2, "rot": 0, "p": { "r": 1000 } },
 *       { "id": "V1", "k": "V", "p": { "w": "sin", "amp": 10, "f": 60 } },
 *       { "id": "K1", "k": "K", "p": { "a": "L1", "b": "L2", "k": 0.97 } },
 *       { "id": "P1", "k": "PORT", "dev": "homopolar", "port": "out" },
 *       { "id": "G1", "k": "GND" }
 *     ],
 *     "w": [["R1.1", "C1.0"], …],              wires between terminal refs <id>.<index>
 *     "n": { "out": "C1.0" },                  node names (experiments, scope, SPICE)
 *     "scope": ["circuit.node.out.v", "circuit.elem.R1.i"],
 *     "opt": { "maxStep": 1e-4 }               solver options (circuit.h Options)
 *   }
 *
 * `compileCircuit` turns it into the packed Float32Array the C++ solver
 * loads (format v1, cpp/src/circuit/circuit.h) plus the maps the host needs:
 * doc id → solver element, terminal / name → node, bench ports and their
 * internal elements. Topology a matrix cannot survive — a loop of voltage
 * sources and ammeters — is refused here with a message naming the loop.
 */
import { parseCircuitKey } from './keys';
import {
  CIRCUIT_FORMAT_VERSION,
  CIRCUIT_MAX_ELEMENTS,
  CIRCUIT_MAX_NODES,
  KIND_SPECS,
  OPTION_NAMES,
  WAVE_IDS,
  WAVE_PARAMS,
  type CircuitOptionName,
  type DocKind,
  type ParamSpec,
  type SolverKind,
  type WaveKind
} from './kinds';
import { portDriver, type CompiledPort } from './ports';

export interface CircuitElemDoc {
  id: string;
  k: DocKind;
  x?: number;
  y?: number;
  /** Quarter turns, 0–3. */
  rot?: number;
  p?: Record<string, number | string>;
  /** PORT: catalog device id and port id. */
  dev?: string;
  port?: string;
}

export interface CircuitDoc {
  v: 1;
  title?: string;
  e: CircuitElemDoc[];
  w: [string, string][];
  n?: Record<string, string>;
  scope?: string[];
  opt?: Partial<Record<CircuitOptionName, number>>;
}

export const ELEM_ID = /^[A-Za-z][A-Za-z0-9_]{0,15}$/;
export const NODE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,15}$/;

/** Throws with every problem found; returns the document typed. */
export function validateCircuitDoc(raw: unknown): CircuitDoc {
  const errors: string[] = [];
  const fail = (m: string) => errors.push(m);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('circuit: a netlist object { v: 1, e: [...], w: [...] }');
  const d = raw as Record<string, unknown>;
  if (d.v !== 1) fail(`v must be 1 (got ${JSON.stringify(d.v)})`);
  const elems = Array.isArray(d.e) ? (d.e as unknown[]) : (fail('e: an array of elements'), []);
  if (elems.length > CIRCUIT_MAX_ELEMENTS) fail(`${elems.length} elements (at most ${CIRCUIT_MAX_ELEMENTS})`);
  const ids = new Map<string, CircuitElemDoc>();
  for (const [i, x] of elems.entries()) {
    const e = x as CircuitElemDoc;
    const where = `e[${i}]`;
    if (!e || typeof e !== 'object') { fail(`${where}: an object`); continue; }
    if (typeof e.id !== 'string' || !ELEM_ID.test(e.id)) { fail(`${where}: id ${JSON.stringify(e.id)} (letter, then letters / digits / _, ≤ 16)`); continue; }
    if (ids.has(e.id)) fail(`${where}: duplicate id ${e.id}`);
    ids.set(e.id, e);
    const spec = KIND_SPECS[e.k as DocKind];
    if (!spec) { fail(`${e.id}: unknown kind ${JSON.stringify(e.k)}`); continue; }
    for (const c of ['x', 'y', 'rot'] as const) {
      if (e[c] !== undefined && (typeof e[c] !== 'number' || !Number.isFinite(e[c]))) fail(`${e.id}.${c}: a number`);
    }
    if (e.p !== undefined && (typeof e.p !== 'object' || e.p === null || Array.isArray(e.p))) fail(`${e.id}.p: an object`);
    if (e.k === 'PORT') {
      if (typeof e.dev !== 'string' || typeof e.port !== 'string') fail(`${e.id}: a PORT needs "dev" and "port"`);
      else if (!portDriver(e.dev, e.port)) fail(`${e.id}: no port ${e.dev}.${e.port} (physics/devices.json "ports")`);
    }
    for (const err of paramErrors(e)) fail(`${e.id}: ${err}`);
  }
  for (const e of ids.values()) {
    if (e.k !== 'K') continue;
    const a = ids.get(String(e.p?.a)), b = ids.get(String(e.p?.b));
    if (!a || a.k !== 'L' || !b || b.k !== 'L' || a === b) fail(`${e.id}: couples ${String(e.p?.a)} and ${String(e.p?.b)} — two different inductors`);
  }
  const wires = Array.isArray(d.w) ? (d.w as unknown[]) : (d.w === undefined ? [] : (fail('w: an array of [ref, ref]'), []));
  for (const [i, w] of wires.entries()) {
    if (!Array.isArray(w) || w.length !== 2) { fail(`w[${i}]: a pair of terminal refs`); continue; }
    for (const ref of w) {
      const why = refError(ids, ref);
      if (why) fail(`w[${i}]: ${why}`);
    }
  }
  if (d.n !== undefined) {
    if (!d.n || typeof d.n !== 'object' || Array.isArray(d.n)) fail('n: an object { name: ref }');
    else for (const [name, ref] of Object.entries(d.n as Record<string, unknown>)) {
      if (!NODE_NAME.test(name)) fail(`n.${name}: a node name (letter, then letters / digits / _)`);
      const why = refError(ids, ref);
      if (why) fail(`n.${name}: ${why}`);
    }
  }
  if (d.scope !== undefined && (!Array.isArray(d.scope) || d.scope.length > 2 || d.scope.some((s) => typeof s !== 'string'))) {
    fail('scope: at most two record keys');
  }
  if (d.opt !== undefined) {
    if (!d.opt || typeof d.opt !== 'object') fail('opt: an object');
    else for (const [k, v] of Object.entries(d.opt as Record<string, unknown>)) {
      if (!(OPTION_NAMES as readonly string[]).includes(k)) fail(`opt.${k}: unknown solver option`);
      else if (typeof v !== 'number' || !(v > 0)) fail(`opt.${k}: a positive number`);
    }
  }
  if (errors.length) throw new Error(`circuit: ${errors.join('; ')}`);
  return { ...(d as unknown as CircuitDoc), w: wires as [string, string][] };
}

function refError(ids: Map<string, CircuitElemDoc>, ref: unknown): string | null {
  if (typeof ref !== 'string') return `terminal ref ${JSON.stringify(ref)} (a string <id>.<index>)`;
  const dot = ref.lastIndexOf('.');
  const e = ids.get(ref.slice(0, dot));
  const t = Number(ref.slice(dot + 1));
  if (!e) return `${ref}: no element ${ref.slice(0, dot)}`;
  const n = KIND_SPECS[e.k]?.terminals.length ?? 0;
  if (!(dot > 0) || !Number.isInteger(t) || t < 0 || t >= n) return `${ref}: ${e.id} has terminals 0…${n - 1}`;
  return null;
}

/** The parameter specs an element takes (V / I: its waveform's). */
export function paramSpecs(e: Pick<CircuitElemDoc, 'k' | 'p'>): readonly ParamSpec[] {
  if (e.k === 'V' || e.k === 'I') return WAVE_PARAMS[waveOf(e)];
  return KIND_SPECS[e.k]?.params ?? [];
}

export function waveOf(e: Pick<CircuitElemDoc, 'p'>): WaveKind {
  const w = e.p?.w;
  return w === 'sin' || w === 'pulse' ? w : 'dc';
}

/** A parameter's value: the document's, else the spec default. */
export function paramValue(e: Pick<CircuitElemDoc, 'k' | 'p'>, name: string): number {
  const v = e.p?.[name];
  if (typeof v === 'number') return v;
  return paramSpecs(e).find((s) => s.name === name)?.default ?? Number.NaN;
}

export function paramProblem(spec: ParamSpec, v: number): string | null {
  if (!Number.isFinite(v)) return `${spec.name} must be a finite number`;
  if (spec.positive && !(v > 0)) return `${spec.name} must be > 0`;
  if (spec.min !== undefined && v < spec.min) return `${spec.name} must be ≥ ${spec.min}`;
  if (spec.max !== undefined && v > spec.max) return `${spec.name} must be ≤ ${spec.max}`;
  return null;
}

function paramErrors(e: CircuitElemDoc): string[] {
  const out: string[] = [];
  const p = e.p ?? {};
  if ((e.k === 'V' || e.k === 'I') && p.w !== undefined && !(p.w === 'dc' || p.w === 'sin' || p.w === 'pulse')) {
    out.push(`p.w must be "dc", "sin" or "pulse"`);
  }
  const specs = paramSpecs(e);
  for (const [name, v] of Object.entries(p)) {
    if (name === 'w' && (e.k === 'V' || e.k === 'I')) continue;
    if (e.k === 'K' && (name === 'a' || name === 'b')) continue;
    const spec = specs.find((s) => s.name === name);
    if (!spec) { out.push(`unknown parameter p.${name}`); continue; }
    const why = paramProblem(spec, typeof v === 'number' ? v : Number.NaN);
    if (why) out.push(why);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// Compile
// ─────────────────────────────────────────────────────────────

/** Packs solver elements in the v1 wire format (ports use it to add theirs). */
export class NetBuilder {
  nodes = 1;
  readonly body: number[] = [];
  /** Per solver element: kind and where its parameters start in `body`. */
  readonly elems: { kind: SolverKind; paramAt: number; nParams: number; owner: string }[] = [];

  node(): number {
    return this.nodes++;
  }

  add(kind: SolverKind, terminals: readonly number[], params: readonly number[], owner: string): number {
    this.body.push(KIND_SPECS[kind].wire, terminals.length, ...terminals, params.length);
    this.elems.push({ kind, paramAt: this.body.length, nParams: params.length, owner });
    this.body.push(...params);
    return this.elems.length - 1;
  }

  pack(options: readonly number[]): Float32Array {
    return Float32Array.from([CIRCUIT_FORMAT_VERSION, this.nodes, this.elems.length, options.length, ...options, ...this.body]);
  }
}

export interface CompiledCircuit {
  doc: CircuitDoc;
  packed: Float32Array;
  nodeCount: number;
  /** Doc element id → solver element index (every solver-backed element, meters included). */
  elemIndex: ReadonlyMap<string, number>;
  /** Terminal ref (`R1.0`) → node index. */
  nodeOfRef: ReadonlyMap<string, number>;
  /** Node name (`n`, plus `gnd`) → node index. */
  nodeByName: ReadonlyMap<string, number>;
  ports: CompiledPort[];
  warnings: string[];
}

class UnionFind {
  private readonly parent = new Map<string, string>();
  find(x: string): string {
    let p = this.parent.get(x) ?? x;
    if (p !== x) {
      p = this.find(p);
      this.parent.set(x, p);
    }
    return p;
  }
  union(a: string, b: string): boolean {
    const ra = this.find(a), rb = this.find(b);
    if (ra === rb) return false;
    this.parent.set(ra, rb);
    return true;
  }
}

const GROUND = '#gnd';

/** Netlist document → packed solver netlist + index maps. Throws on bad documents / topology. */
export function compileCircuit(raw: unknown): CompiledCircuit {
  const doc = validateCircuitDoc(raw);
  const warnings: string[] = [];
  const nets = new UnionFind();
  for (const e of doc.e) {
    if (e.k === 'GND') nets.union(`${e.id}.0`, GROUND);
  }
  for (const [a, b] of doc.w) nets.union(a, b);

  // Nodes: ground is 0; every other net in first-seen order.
  const b = new NetBuilder();
  const netNode = new Map<string, number>([[nets.find(GROUND), 0]]);
  const nodeOfRef = new Map<string, number>();
  const refsPerNet = new Map<string, number>();
  const nodeOf = (ref: string): number => {
    const root = nets.find(ref);
    let n = netNode.get(root);
    if (n === undefined) {
      n = b.node();
      netNode.set(root, n);
    }
    nodeOfRef.set(ref, n);
    return n;
  };
  for (const e of doc.e) {
    const nt = KIND_SPECS[e.k].terminals.length;
    for (let t = 0; t < nt; t++) {
      const ref = `${e.id}.${t}`;
      nodeOf(ref);
      const root = nets.find(ref);
      refsPerNet.set(root, (refsPerNet.get(root) ?? 0) + 1);
    }
  }
  if (b.nodes > CIRCUIT_MAX_NODES) throw new Error(`circuit: ${b.nodes} nodes (at most ${CIRCUIT_MAX_NODES})`);
  for (const [root, count] of refsPerNet) {
    if (count === 1 && root !== nets.find(GROUND)) warnings.push(`a terminal is wired to nothing (node ${netNode.get(root)})`);
  }
  if (!doc.e.some((e) => e.k === 'GND')) warnings.push('no ground: node voltages are relative to the first net');

  // A loop made only of voltage-defined branches (V, AM, E outputs, port
  // EMFs are in series with their R) is a singular matrix: refuse it by name.
  const vLoop = new UnionFind();
  for (const e of doc.e) {
    if (e.k !== 'V' && e.k !== 'AM' && e.k !== 'E') continue;
    const na = String(nodeOfRef.get(`${e.id}.0`)), nb = String(nodeOfRef.get(`${e.id}.1`));
    if (!vLoop.union(na, nb)) {
      throw new Error(`circuit: ${e.id} closes a loop of voltage sources / ammeters — add a resistor in the loop`);
    }
  }

  const elemIndex = new Map<string, number>();
  const ports: CompiledPort[] = [];
  const terms = (e: CircuitElemDoc) => KIND_SPECS[e.k].terminals.map((_, t) => nodeOfRef.get(`${e.id}.${t}`)!);
  // Couplings reference inductors by solver index: place every L first-come, K last.
  for (const e of doc.e) {
    if (e.k === 'GND' || e.k === 'K') continue;
    if (e.k === 'PORT') {
      const [plus, minus] = terms(e);
      ports.push(portDriver(e.dev!, e.port!)!.expand(b, e.id, plus, minus));
      continue;
    }
    const kind = e.k as SolverKind;
    let params: number[];
    if (kind === 'V' || kind === 'I') {
      const w = waveOf(e);
      params = [WAVE_IDS[w], ...WAVE_PARAMS[w].map((s) => paramValue(e, s.name))];
    } else {
      params = KIND_SPECS[kind].params.map((s) => paramValue(e, s.name));
    }
    elemIndex.set(e.id, b.add(kind, terms(e), params, e.id));
  }
  for (const e of doc.e) {
    if (e.k !== 'K') continue;
    const la = elemIndex.get(String(e.p!.a))!, lb = elemIndex.get(String(e.p!.b))!;
    elemIndex.set(e.id, b.add('K', [], [la, lb, paramValue(e, 'k')], e.id));
  }
  if (b.elems.length > CIRCUIT_MAX_ELEMENTS) throw new Error(`circuit: ${b.elems.length} solver elements with the bench ports expanded (at most ${CIRCUIT_MAX_ELEMENTS})`);

  const nodeByName = new Map<string, number>([['gnd', 0]]);
  for (const [name, ref] of Object.entries(doc.n ?? {})) nodeByName.set(name, nodeOfRef.get(ref)!);

  const options = OPTION_NAMES.map((name) => doc.opt?.[name] ?? 0);
  return {
    doc,
    packed: b.pack(options),
    nodeCount: b.nodes,
    elemIndex,
    nodeOfRef,
    nodeByName,
    ports,
    warnings
  };
}

/** Solver parameter slot of `<id>.<name>` (null when the element / parameter does not exist). */
export function paramSlot(c: CompiledCircuit, id: string, name: string): { elem: number; index: number; spec: ParamSpec } | null {
  const e = c.doc.e.find((x) => x.id === id);
  const elem = c.elemIndex.get(id);
  if (!e || elem === undefined || (e.k === 'K' && name !== 'k')) return null;
  if (e.k === 'K') return { elem, index: 2, spec: KIND_SPECS.K.params[0] };
  const specs = paramSpecs(e);
  const i = specs.findIndex((s) => s.name === name);
  if (i < 0) return null;
  // V / I: packed [wave id, …wave params].
  return { elem, index: e.k === 'V' || e.k === 'I' ? i + 1 : i, spec: specs[i] };
}

/**
 * Why a `circuit.*` key does not resolve on this netlist (null: it does) —
 * experiments validate their knobs and record keys with it (validate.ts).
 */
export function circuitKeyProblem(c: CompiledCircuit, key: string, knob = false): string | null {
  const k = parseCircuitKey(key);
  if (!k) return `${key} is not a circuit key (circuit.node.<name>.v, circuit.elem.<id>.i|v|p|<param>, circuit.port.<id>.p, circuit.residual)`;
  if (knob && k.kind !== 'param') return `${key} cannot be set — only circuit.elem.<id>.<param>`;
  switch (k.kind) {
    case 'node':
      return c.nodeByName.has(k.name) ? null : `no node named ${k.name} (the netlist's n: ${[...c.nodeByName.keys()].join(', ')})`;
    case 'elem':
      return c.elemIndex.has(k.id) ? null : `no element ${k.id}`;
    case 'param': {
      if (!c.elemIndex.has(k.id)) return `no element ${k.id}`;
      return paramSlot(c, k.id, k.name) ? null : `${k.id} has no parameter ${k.name}`;
    }
    case 'port':
      return c.ports.some((p) => p.id === k.id) ? null : `no bench port ${k.id}`;
    case 'residual':
      return null;
  }
}
