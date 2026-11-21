/**
 * Example circuits (#256) — what `?circuit=<id>` opens and what the reference
 * experiments wire. A LabConfig `circuit` value is either one of these ids or
 * a whole netlist document (src/circuit/netlist.ts); `resolveCircuitConfig`
 * turns both into a document.
 *
 * Teacher links (docs/CIRCUIT.md):
 *   ?labMode=lab&mode=transformer&circuit=transformer-bridge-rc   ripple at 2f
 *   ?labMode=lab&mode=homopolar&circuit=homopolar-bridge-rc       a DC machine: no ripple
 *   ?labMode=lab&mode=pulse-coil&circuit=pulse-coil-ring          LC ring through the coil
 */
import type { CircuitDoc, CircuitElemDoc } from './netlist';

const SILICON = { is: 1e-14, n: 1, rs: 0.02 };
/** A low-drop (Schottky-like) diode: the homopolar's ~2 V would vanish in two silicon drops. */
const SCHOTTKY = { is: 1e-6, n: 1.05, rs: 0.01 };

/**
 * A full-wave bridge drawn as a ladder (wires route horizontal-first, so this
 * reads without crossings): two vertical diode legs, the port between them
 * feeding each leg's midpoint, the DC rails along the top (+) and bottom (−)
 * with the reservoir C and the load R dropping off them.
 */
function bridge(port: CircuitElemDoc, diode: Record<string, number>, c: number, r: number, title: string): CircuitDoc {
  return {
    v: 1,
    title,
    e: [
      // Terminal 0 (+) on the left, at leg A's midpoint; terminal 1 (−) at leg B's.
      { ...port, x: 8, y: 6, rot: 0 },
      // rot 3: anode (terminal 0) at the bottom, cathode at the top — every diode conducts upwards.
      { id: 'D1', k: 'D', x: 4, y: 4, rot: 3, p: { ...diode } },
      { id: 'D2', k: 'D', x: 12, y: 4, rot: 3, p: { ...diode } },
      { id: 'D3', k: 'D', x: 4, y: 8, rot: 3, p: { ...diode } },
      { id: 'D4', k: 'D', x: 12, y: 8, rot: 3, p: { ...diode } },
      { id: 'C1', k: 'C', x: 16, y: 6, rot: 1, p: { c } },
      { id: 'R1', k: 'R', x: 20, y: 6, rot: 1, p: { r } },
      { id: 'G1', k: 'GND', x: 8, y: 11 }
    ],
    w: [
      // AC side: port + to D1 anode / D3 cathode, port − to D2 anode / D4 cathode.
      ['P1.0', 'D1.0'], ['P1.0', 'D3.1'],
      ['P1.1', 'D2.0'], ['P1.1', 'D4.1'],
      // DC + rail: D1 / D2 cathodes to the reservoir cap and the load.
      ['D1.1', 'D2.1'], ['D2.1', 'C1.0'], ['D2.1', 'R1.0'],
      // DC − rail: D3 / D4 anodes, cap and load to ground.
      ['D3.0', 'D4.0'], ['D4.0', 'C1.1'], ['D4.0', 'R1.1'], ['G1.0', 'D3.0']
    ],
    n: { out: 'C1.0', acp: 'P1.0', acn: 'P1.1' },
    scope: ['circuit.node.out.v', 'circuit.elem.D1.i']
  };
}

const EXAMPLES: Readonly<Record<string, () => CircuitDoc>> = {
  'transformer-bridge-rc': () =>
    bridge({ id: 'P1', k: 'PORT', dev: 'transformer', port: 'sec' }, SILICON, 470e-6, 100,
      'Transformer secondary → bridge rectifier → RC load'),
  'homopolar-bridge-rc': () =>
    bridge({ id: 'P1', k: 'PORT', dev: 'homopolar', port: 'out' }, SCHOTTKY, 2200e-6, 4.7,
      'Homopolar disc → bridge rectifier → RC load'),
  'pulse-coil-ring': (): CircuitDoc => ({
    v: 1,
    title: 'Charged capacitor → switch → pulse coil (series RLC ring)',
    e: [
      { id: 'C1', k: 'C', x: 2, y: 4, rot: 1, p: { c: 2.2e-3, ic: 24 } },
      // One-shot: closes at 50 ms and stays closed.
      { id: 'S1', k: 'S', x: 4, y: 2, rot: 0, p: { period: 1e6, duty: 1, delay: 0.05 } },
      { id: 'AM1', k: 'AM', x: 10, y: 2, rot: 0 },
      { id: 'P1', k: 'PORT', dev: 'pulse-coil', port: 'coil', x: 16, y: 4, rot: 1 },
      { id: 'G1', k: 'GND', x: 8, y: 10 }
    ],
    w: [['C1.0', 'S1.0'], ['S1.1', 'AM1.0'], ['AM1.1', 'P1.0'], ['P1.1', 'G1.0'], ['C1.1', 'G1.0']],
    n: { cap: 'C1.0', coil: 'P1.0' },
    scope: ['circuit.elem.AM1.i', 'circuit.node.cap.v']
  }),
  'rc-step': (): CircuitDoc => ({
    v: 1,
    title: 'Square wave → RC low-pass',
    e: [
      { id: 'V1', k: 'V', x: 2, y: 4, rot: 1, p: { w: 'pulse', v1: 0, v2: 5, td: 0, tr: 1e-5, tf: 1e-5, pw: 5e-3, per: 1e-2 } },
      { id: 'R1', k: 'R', x: 4, y: 2, rot: 0, p: { r: 1000 } },
      { id: 'C1', k: 'C', x: 10, y: 4, rot: 1, p: { c: 1e-6 } },
      { id: 'G1', k: 'GND', x: 6, y: 10 }
    ],
    w: [['V1.0', 'R1.0'], ['R1.1', 'C1.0'], ['V1.1', 'G1.0'], ['C1.1', 'G1.0']],
    n: { in: 'V1.0', out: 'C1.0' },
    scope: ['circuit.node.in.v', 'circuit.node.out.v']
  }),
  'rlc-ring': (): CircuitDoc => ({
    v: 1,
    title: 'Series RLC from a charged capacitor',
    e: [
      { id: 'C1', k: 'C', x: 2, y: 4, rot: 1, p: { c: 10e-6, ic: 10 } },
      { id: 'L1', k: 'L', x: 4, y: 2, rot: 0, p: { l: 10e-3 } },
      { id: 'R1', k: 'R', x: 10, y: 4, rot: 1, p: { r: 1 } },
      { id: 'G1', k: 'GND', x: 6, y: 10 }
    ],
    w: [['C1.0', 'L1.0'], ['L1.1', 'R1.0'], ['R1.1', 'G1.0'], ['C1.1', 'G1.0']],
    n: { cap: 'C1.0' },
    scope: ['circuit.node.cap.v', 'circuit.elem.L1.i']
  })
};

export const CIRCUIT_EXAMPLE_IDS: readonly string[] = Object.keys(EXAMPLES);

/** A fresh copy of an example document, or null. */
export function circuitExample(id: string): CircuitDoc | null {
  return EXAMPLES[id]?.() ?? null;
}

/** LabConfig `circuit` value (example id or document) → document, or null. Does not validate. */
export function resolveCircuitConfig(value: unknown): CircuitDoc | null {
  if (typeof value === 'string') return circuitExample(value);
  if (value && typeof value === 'object') return structuredClone(value) as CircuitDoc;
  return null;
}
