/**
 * Circuit record keys and knobs (#256) — what an experiment may `set` and
 * `record` on the wired circuit, and what the scope plots:
 *
 *   circuit.node.<name>.v        node voltage (names from the netlist `n`, or `gnd`)
 *   circuit.elem.<id>.i | v | p  element current (a → b) / voltage / power
 *   circuit.elem.<id>.<param>    a parameter (`circuit.elem.C1.c`) — also a knob
 *   circuit.port.<id>.p          power the bench port puts into the circuit (W, window mean)
 *   circuit.residual             energy-book residual over the last second (fraction)
 *
 * Keys are resolved against the loaded netlist at run time; validate.ts only
 * checks their shape (and, when the experiment carries its circuit, that the
 * element / node exists).
 */
export type CircuitKey =
  | { kind: 'node'; name: string }
  | { kind: 'elem'; id: string; what: 'i' | 'v' | 'p' }
  | { kind: 'param'; id: string; name: string }
  | { kind: 'port'; id: string }
  | { kind: 'residual' };

const NAME = '[A-Za-z][A-Za-z0-9_]{0,15}';
const NODE_RE = new RegExp(`^circuit\\.node\\.(${NAME})\\.v$`);
const ELEM_RE = new RegExp(`^circuit\\.elem\\.(${NAME})\\.([a-z][a-z0-9]{0,7})$`);
const PORT_RE = new RegExp(`^circuit\\.port\\.(${NAME})\\.p$`);

export function isCircuitKey(key: string): boolean {
  return key.startsWith('circuit.');
}

/** Parse a `circuit.*` key, or null when it is not one. */
export function parseCircuitKey(key: string): CircuitKey | null {
  if (key === 'circuit.residual') return { kind: 'residual' };
  let m = NODE_RE.exec(key);
  if (m) return { kind: 'node', name: m[1] };
  m = PORT_RE.exec(key);
  if (m) return { kind: 'port', id: m[1] };
  m = ELEM_RE.exec(key);
  if (m) {
    const what = m[2];
    return what === 'i' || what === 'v' || what === 'p' ? { kind: 'elem', id: m[1], what } : { kind: 'param', id: m[1], name: what };
  }
  return null;
}

/** Whether a parsed key can be written (`set` / `ramp` / `sweep`). */
export function isCircuitKnob(key: string): boolean {
  return parseCircuitKey(key)?.kind === 'param';
}

/** What a plant view exposes of its circuit (CircuitHost implements it). */
export interface CircuitAccess {
  /** Current value of a `circuit.*` record key; NaN when not available. */
  readKey(key: string): number;
  /** Write a `circuit.elem.<id>.<param>` knob; false when refused. */
  writeKey(key: string, value: number): boolean;
}
