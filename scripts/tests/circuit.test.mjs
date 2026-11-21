/**
 * Circuit Lab (#256, ADR-0018, docs/CIRCUIT.md).
 *
 *   1. native   `sim_core_test --mode circuit`: the ten analytic goldens
 *               (RC τ, RLC f/Q, half-wave ripple, transformer ratio,
 *               lossless-LC energy, flyback, bridge, VCVS, VCCS, MOSFET).
 *   2. WASM     `--mode circuit-json` hands every golden's packed netlist,
 *               schedule and samples to the shipped sim_core.wasm: the same
 *               trajectory (parity), and the LC-energy and RLC-Q claims judged
 *               again on the binary the browser runs. Kind names and the
 *               format version agree across C++, WASM and src/circuit/kinds.ts.
 *   3. TS       SI values, the document compiler and key checks, SPICE
 *               export / import, the host (needs-wasm, books, ports, the
 *               teacher examples), LabConfig / share-link round-trips.
 *
 * Needs `npm run wasm:native` (cpp/build/sim_core_test) and the committed
 * src/wasm/sim-core/sim_core.wasm.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import { bundleTs, ROOT } from '../test-harness.mjs';
import { loadSimCoreFromDisk } from '../lib/sim-core-shim.mjs';

const NATIVE = join(ROOT, 'cpp', 'build', 'sim_core_test');
const GOLDEN_IDS = ['rc-charge', 'rlc-ring', 'halfwave-ripple', 'transformer-ratio', 'lc-energy', 'switch-flyback',
  'bridge-rc', 'vcvs-inverting', 'vccs', 'mosfet-level1'];

const X = await bundleTs({
  contents: `
export * from './src/circuit/kinds';
export { parseSi, formatSi, formatSpice } from './src/circuit/si';
export { compileCircuit, validateCircuitDoc, circuitKeyProblem, paramSlot } from './src/circuit/netlist';
export { toSpice, fromSpice } from './src/circuit/spice';
export { circuitExample, CIRCUIT_EXAMPLE_IDS, resolveCircuitConfig } from './src/circuit/examples';
export { CircuitHost } from './src/circuit/host';
export { parseCircuitKey, isCircuitKnob } from './src/circuit/keys';
export { PORT_DRIVER_NAMES, portDriver } from './src/circuit/ports';
export { CIRCUIT_PORTS } from './generated/circuit-ports';
export { createDevicePhysicsState } from './src/renderers/shared/device-physics';
export { coerceLabField, sanitizeFields } from './src/config/lab-config';
export { encodeShareHash, decodeShareHash } from './src/config/share-link';
export { validateExperiment } from './src/experiments/validate';
`,
  sourcefile: 'circuit-entry.ts'
});

const wasm = await loadSimCoreFromDisk(join(ROOT, 'src/wasm/sim-core'));

// ── 1. native goldens ───────────────────────────────────────────────────
const nativeExists = existsSync(NATIVE);
const table = nativeExists ? spawnSync(NATIVE, ['--mode', 'circuit'], { encoding: 'utf8' }) : null;
const dump = nativeExists ? spawnSync(NATIVE, ['--mode', 'circuit-json'], { encoding: 'utf8', maxBuffer: 64 << 20 }) : null;

describe('native --mode circuit', () => {
  it('runs and exits 0', () => {
    assert.ok(nativeExists, 'native binary missing at cpp/build/sim_core_test — run `npm run wasm:native` first');
    if (table.status !== 0) process.stdout.write(table.stdout);
    assert.equal(table.status, 0, 'a circuit golden failed (table above)');
    assert.match(table.stdout, /^circuit goldens OK$/m);
  });
  it('every golden is in the table and passes', () => {
    const rows = new Map([...table.stdout.matchAll(/^ {2}(\S+)\s+(PASS|FAIL)\s/gm)].map((m) => [m[1], m[2]]));
    for (const id of GOLDEN_IDS) assert.equal(rows.get(id), 'PASS', `${id}: ${rows.get(id) ?? 'missing'}`);
  });
});

// ── 2. the goldens on the shipped WASM ──────────────────────────────────
/** One golden on `sim_core.wasm`: every host step's t, stored energy and probes. */
function replay(c) {
  const sim = new wasm.CircuitSim();
  try {
    assert.equal(sim.load(c.packed), 0, `${c.id}: WASM load — ${sim.errorText()}`);
    const t = [], stored = [], ch = c.probes.map(() => []);
    const sample = () => {
      t.push(sim.time());
      stored.push(sim.storedEnergy());
      c.probes.forEach((p, k) => ch[k].push(p.node ? sim.nodeVoltage(p.index) : sim.elemCurrent(p.index)));
    };
    sample();
    for (let s = 0; s < c.steps; s++) {
      for (const [step, elem, index, value] of c.events) if (step === s) sim.setParam(elem, index, value);
      const rc = sim.step(c.hostStep);
      assert.ok(rc >= 0, `${c.id}: WASM step ${s} — ${sim.errorText()}`);
      sample();
    }
    return { t, stored, ch, steps: sim.stat(X.ST.steps) };
  } finally {
    sim.delete();
  }
}

function risingCrossings(t, y) {
  const out = [];
  for (let k = 1; k < y.length; k++) {
    if (y[k - 1] < 0 && y[k] >= 0) out.push(t[k - 1] + (-y[k - 1] / (y[k] - y[k - 1])) * (t[k] - t[k - 1]));
  }
  return out;
}

function peaks(t, y) {
  const out = [];
  for (let k = 1; k + 1 < y.length; k++) {
    if (!(y[k] > 0 && y[k] >= y[k - 1] && y[k] > y[k + 1])) continue;
    const [a, b, c] = [y[k - 1], y[k], y[k + 1]];
    const den = a - 2 * b + c;
    const d = den !== 0 ? (0.5 * (a - c)) / den : 0;
    out.push([t[k] + d * (t[k + 1] - t[k]), b - 0.25 * (a - c) * d]);
  }
  return out;
}

describe('the goldens on sim_core.wasm (circuit-json replay)', () => {
  let doc;
  const traces = new Map();
  before(() => {
    assert.ok(nativeExists, 'native binary missing — run `npm run wasm:native` first');
    assert.equal(dump.status, 0, 'native --mode circuit-json failed');
    doc = JSON.parse(dump.stdout);
  });

  it('format version and kind names agree: C++, WASM, kinds.ts', () => {
    assert.equal(doc.format, X.CIRCUIT_FORMAT_VERSION);
    assert.equal(wasm.circuit_format_version(), X.CIRCUIT_FORMAT_VERSION);
    assert.deepEqual(doc.kinds, [...X.WIRE_KIND_NAMES]);
    assert.deepEqual(doc.kinds.map((_, k) => wasm.circuit_kind_name(k)), [...X.WIRE_KIND_NAMES]);
  });

  it('every golden replays on WASM onto the native trajectory', () => {
    assert.deepEqual(doc.cases.map((c) => c.id), GOLDEN_IDS);
    for (const c of doc.cases) {
      assert.ok(c.pass, `${c.id}: native verdict`);
      const tr = replay(c);
      traces.set(c.id, tr);
      const scale = [tr.stored, ...tr.ch].map((y) => Math.max(1e-30, ...y.map(Math.abs)));
      for (const row of c.samples) {
        const [k, t, ...vals] = row;
        assert.ok(Math.abs(tr.t[k] - t) <= 1e-12 * Math.max(1, t), `${c.id}: t at step ${k}`);
        vals.forEach((want, j) => {
          const got = j === 0 ? tr.stored[k] : tr.ch[j - 1][k];
          assert.ok(Math.abs(got - want) <= 1e-9 * scale[j], `${c.id}: ${j === 0 ? 'stored energy' : `probe ${j - 1}`} at step ${k}: wasm ${got} vs native ${want}`);
        });
      }
    }
  });

  it('lossless LC on WASM: 1000+ periods at a 1/60 s host step, energy within 1e-4', () => {
    const tr = traces.get('lc-energy');
    assert.ok(tr, 'lc-energy replayed');
    const E0 = 0.5 * Math.fround(10e-6) * 1;
    const dev = Math.max(...tr.stored.map((e) => Math.abs(e / E0 - 1)));
    const periods = tr.t[tr.t.length - 1] / (2 * Math.PI * Math.sqrt(Math.fround(1e-3) * Math.fround(10e-6)));
    assert.ok(periods >= 1000, `periods ${periods}`);
    assert.ok(dev < 1e-4, `max |E/E0 − 1| = ${dev}`);
  });

  it('series RLC on WASM: f_d within 0.1 %, Q = √(L/C)/R within 0.2 %', () => {
    const tr = traces.get('rlc-ring');
    assert.ok(tr, 'rlc-ring replayed');
    const [L, C, R] = [Math.fround(10e-3), Math.fround(10e-6), Math.fround(1)];
    const alpha = R / (2 * L), w0 = 1 / Math.sqrt(L * C), wd = Math.sqrt(w0 * w0 - alpha * alpha);
    const zc = risingCrossings(tr.t, tr.ch[1]);
    const fd = (zc.length - 1) / (zc[zc.length - 1] - zc[0]);
    const pk = peaks(tr.t, tr.ch[1]);
    let aSum = 0, aN = 0;
    for (let k = 0; k + 1 < pk.length && k < 8; k++, aN++) aSum += Math.log(pk[k][1] / pk[k + 1][1]) / (pk[k + 1][0] - pk[k][0]);
    const a = aSum / aN, wMeas = 2 * Math.PI * fd;
    const q = Math.sqrt(wMeas * wMeas + a * a) / (2 * a), qExact = Math.sqrt(L / C) / R;
    assert.ok(Math.abs(fd / (wd / (2 * Math.PI)) - 1) < 1e-3, `f_d ${fd} vs ${wd / (2 * Math.PI)}`);
    assert.ok(Math.abs(q / qExact - 1) < 2e-3, `Q ${q} vs ${qExact}`);
  });
});

// ── 3. TS: values, documents, SPICE ─────────────────────────────────────
describe('SI values', () => {
  it('parses engineering prefixes and units', () => {
    const cases = [['4.7k', 4700], ['100nF', 100e-9], ['2.2m', 2.2e-3], ['10µ', 10e-6], ['10u', 10e-6], ['1meg', 1e6],
      ['3e-6', 3e-6], ['-5 V', -5], ['470 µF', 470e-6], ['1M', 1e6], ['.5', 0.5]];
    for (const [text, want] of cases) assert.ok(Math.abs(X.parseSi(text) - want) <= 1e-12 * Math.abs(want), `${text} → ${X.parseSi(text)}`);
  });
  it('SPICE spelling: M is milli; junk is NaN', () => {
    assert.ok(Math.abs(X.parseSi('1M', { spice: true }) - 1e-3) < 1e-15);
    for (const bad of ['', 'abc', '1..2', 'k4', '4,7k']) assert.ok(Number.isNaN(X.parseSi(bad)), `${bad} is NaN`);
  });
  it('formatSi / formatSpice round-trip through parseSi', () => {
    assert.equal(X.formatSi(4700, 'Ω'), '4.7 kΩ');
    assert.equal(X.formatSi(470e-6, 'F'), '470 µF');
    for (const v of [1, 4700, 2.2e-3, 470e-6, 1e-14, 1e6, -12, 0.05]) {
      assert.ok(Math.abs(X.parseSi(X.formatSpice(v), { spice: true }) / v - 1) < 1e-6, `${v} → ${X.formatSpice(v)}`);
    }
  });
});

describe('netlist documents', () => {
  it('every example compiles with no warnings; its scope and names resolve', () => {
    assert.ok(X.CIRCUIT_EXAMPLE_IDS.length >= 5);
    for (const id of X.CIRCUIT_EXAMPLE_IDS) {
      const c = X.compileCircuit(X.circuitExample(id));
      assert.deepEqual(c.warnings, [], `${id}: warnings`);
      assert.ok(c.packed.length > 3 && c.nodeCount > 1, `${id}: packed`);
      for (const key of c.doc.scope ?? []) assert.equal(X.circuitKeyProblem(c, key), null, `${id}: scope key ${key}`);
      for (const name of Object.keys(c.doc.n ?? {})) assert.ok(c.nodeByName.has(name), `${id}: node ${name}`);
    }
  });
  it('ports bind to catalog ports with a driver', () => {
    for (const p of X.CIRCUIT_PORTS) {
      assert.ok(X.PORT_DRIVER_NAMES.includes(p.driver), `${p.device}.${p.id}: driver ${p.driver}`);
      assert.ok(X.portDriver(p.device, p.id), `${p.device}.${p.id}: portDriver`);
    }
    const c = X.compileCircuit(X.circuitExample('transformer-bridge-rc'));
    assert.deepEqual(c.ports.map((p) => `${p.device}.${p.id}`), ['transformer.P1']);
  });
  it('keys: what can be read, what can be set', () => {
    const c = X.compileCircuit(X.circuitExample('transformer-bridge-rc'));
    for (const ok of ['circuit.node.out.v', 'circuit.elem.D1.i', 'circuit.elem.R1.p', 'circuit.residual', 'circuit.port.P1.p']) {
      assert.equal(X.circuitKeyProblem(c, ok), null, ok);
    }
    assert.equal(X.circuitKeyProblem(c, 'circuit.elem.C1.c', true), null, 'C1.c is a knob');
    assert.ok(X.circuitKeyProblem(c, 'circuit.elem.C1.i', true), 'a current is not a knob');
    for (const bad of ['circuit.node.nope.v', 'circuit.elem.X9.i', 'circuit.elem.C1.zz', 'circuit.port.Q.p']) {
      assert.ok(X.circuitKeyProblem(c, bad), `${bad} is refused`);
    }
    assert.ok(X.isCircuitKnob('circuit.elem.C1.c') && !X.isCircuitKnob('circuit.node.out.v'));
    assert.deepEqual(X.paramSlot(c, 'C1', 'c')?.index, 0);
  });
  it('rejects malformed documents', () => {
    const base = X.circuitExample('rc-step');
    const bad = [
      { ...base, v: 2 },
      { ...base, e: [...base.e, { id: 'Z1', k: 'ZZ' }] },
      { ...base, e: [...base.e, { ...base.e[1] }] },
      { ...base, w: [...base.w, ['R1.0', 'Q7.1']] },
      { ...base, w: [...base.w, ['R1.0', 'R1.5']] },
      { ...base, e: base.e.map((e) => (e.id === 'R1' ? { ...e, p: { r: -1 } } : e)) },
      { ...base, e: [...base.e, { id: 'P9', k: 'PORT', dev: 'seg', port: 'out' }] }
    ];
    for (const d of bad) assert.throws(() => X.compileCircuit(d), undefined, JSON.stringify(d).slice(0, 120));
  });
  it('LabConfig `circuit`: example id, document, JSON text; junk refused', () => {
    assert.equal(X.coerceLabField('circuit', 'transformer-bridge-rc'), 'transformer-bridge-rc');
    const doc = X.circuitExample('rlc-ring');
    assert.deepEqual(X.coerceLabField('circuit', doc), doc);
    assert.deepEqual(X.coerceLabField('circuit', JSON.stringify(doc)), doc);
    for (const junk of [42, [], { v: 2, e: [] }, '{not json', 'Has Spaces!']) {
      assert.equal(X.coerceLabField('circuit', junk), undefined, JSON.stringify(junk));
    }
    assert.equal(X.resolveCircuitConfig('no-such-example'), null);
    assert.deepEqual(X.resolveCircuitConfig('rlc-ring'), doc);
  });
  it('#lab2= share link carries the whole netlist', async () => {
    const doc = X.circuitExample('homopolar-bridge-rc');
    const hash = await X.encodeShareHash({ mode: 'homopolar', circuit: doc });
    assert.ok(hash.startsWith('#lab2='));
    const back = X.sanitizeFields(await X.decodeShareHash(hash), true);
    assert.deepEqual(back.circuit, doc);
    assert.equal(back.mode, 'homopolar');
  });
});

describe('SPICE', () => {
  const values = (doc) => Object.fromEntries(doc.e.filter((e) => e.k !== 'GND').map((e) => [e.id, e.p ?? {}]));
  it('.cir export → import keeps elements, values and topology (rlc-ring, rc-step)', () => {
    for (const id of ['rlc-ring', 'rc-step']) {
      const doc = X.circuitExample(id);
      const text = X.toSpice(doc);
      assert.match(text, /^\.end$/m, `${id}: .end`);
      assert.match(text, /^\.tran /m, `${id}: .tran`);
      const { doc: back, warnings } = X.fromSpice(text);
      assert.deepEqual(warnings, [], `${id}: import warnings`);
      const a = X.compileCircuit(doc), b = X.compileCircuit(back);
      assert.equal(b.nodeCount, a.nodeCount, `${id}: node count`);
      const [va, vb] = [values(doc), values(back)];
      for (const [eid, p] of Object.entries(va)) {
        assert.ok(vb[eid], `${id}: ${eid} imported`);
        for (const [name, v] of Object.entries(p)) {
          if (typeof v === 'number') assert.ok(Math.abs(Number(vb[eid][name]) - v) <= 1e-6 * Math.max(1e-30, Math.abs(v)), `${id}: ${eid}.${name} ${vb[eid][name]} vs ${v}`);
          else assert.equal(vb[eid][name], v, `${id}: ${eid}.${name}`);
        }
      }
    }
  });
  it('diodes export with a .model; a port exports as a commented stand-in', () => {
    const text = X.toSpice(X.circuitExample('transformer-bridge-rc'));
    assert.match(text, /^D1 \S+ \S+ \S+/m);
    assert.match(text, /^\.model \S+ D\(/m);
    assert.match(text, /^\*.*P1/m);
  });
  it('imports R L C V I D K; unsupported lines warn instead of failing', () => {
    const { doc, warnings } = X.fromSpice([
      'divider and a transformer',
      'V1 in 0 SIN(0 10 50)',
      'R1 in mid 4.7k',
      'C1 mid 0 100n',
      'I1 0 mid DC 1m',
      'L1 in 0 10m',
      'L2 sec 0 1m',
      'K1 L1 L2 0.97',
      'D1 sec out DMOD',
      'R2 out 0 1k',
      '.model DMOD D(IS=1e-14 N=1.8)',
      'Q1 a b c QMOD',
      '.tran 1u 10m',
      '.end'
    ].join('\n'));
    const kinds = Object.fromEntries(doc.e.map((e) => [e.id, e.k]));
    assert.deepEqual([kinds.V1, kinds.R1, kinds.C1, kinds.I1, kinds.L1, kinds.K1, kinds.D1], ['V', 'R', 'C', 'I', 'L', 'K', 'D']);
    const p = values(doc);
    assert.equal(p.R1.r, 4700);
    assert.equal(p.V1.w, 'sin');
    assert.ok(Math.abs(p.D1.n - 1.8) < 1e-12 && Math.abs(p.D1.is - 1e-14) < 1e-26, 'diode .model');
    assert.ok(Math.abs(p.K1.k - 0.97) < 1e-12);
    assert.ok(warnings.some((w) => /Q1/.test(w)), `warns on Q1: ${warnings.join(' | ')}`);
    assert.doesNotThrow(() => X.compileCircuit(doc));
  });
});

// ── 3b. the host on WASM ────────────────────────────────────────────────
/** Run an example `secs` of plant time at 60 Hz host frames; returns host + bench states. */
function runExample(id, device, drive, secs) {
  const devices = device ? { [device]: { physicsState: X.createDevicePhysicsState(device, {}) } } : {};
  const host = new X.CircuitHost(wasm, () => devices);
  assert.ok(host.load(X.circuitExample(id)), `${id}: load — ${host.message}`);
  for (let i = 0; i < Math.round(secs * 60); i++) host.stepBatch([1 / 60], drive);
  return { host, state: device ? devices[device].physicsState : null };
}

function lastWindow(trace, ch, span) {
  const tEnd = trace.t[trace.t.length - 1];
  let lo = Infinity, hi = -Infinity, n = 0;
  for (let i = 0; i < trace.t.length; i++) {
    if (trace.t[i] <= tEnd - span) continue;
    lo = Math.min(lo, trace.ch[ch][i]);
    hi = Math.max(hi, trace.ch[ch][i]);
    n++;
  }
  return { lo, hi, p2p: hi - lo, n };
}

describe('CircuitHost', () => {
  it('without sim_core: needs-wasm, compiles (read-only view), reads NaN', () => {
    const host = new X.CircuitHost(null, () => ({}));
    assert.equal(host.state, 'needs-wasm');
    assert.equal(host.load(X.circuitExample('rlc-ring')), false);
    assert.equal(host.state, 'needs-wasm');
    assert.ok(host.compiled, 'the document still compiles for the wiring view');
    assert.ok(Number.isNaN(host.readKey('circuit.node.cap.v')));
    assert.equal(host.writeKey('circuit.elem.C1.c', 1e-6), false);
  });

  it('transformer → bridge → RC: ripple on the scope, books close under 1 %, solved edge', () => {
    const { host, state } = runExample('transformer-bridge-rc', 'transformer', 1, 1);
    try {
      assert.equal(host.state, 'ok');
      assert.ok(state._circuitOwned, 'the circuit owns the bench');
      const w = lastWindow(host.scopeTrace(), 0, 0.1);
      assert.ok(w.n > 100, `scope samples ${w.n}`);
      assert.ok(w.lo > 5 && w.hi < 9, `v(out) ${w.lo}–${w.hi} V`);
      assert.ok(w.p2p > 0.3 && w.p2p < 1.5, `ripple ${w.p2p} V p-p`);
      const b = host.energyBooks();
      assert.ok(b.residual < 0.01, `residual ${b.residual}`);
      const s = host.solvedEdges();
      assert.equal(s.edges.length, 1);
      assert.equal(s.edges[0].from, 'transformer');
      assert.ok(s.edges[0].powerW > 0.1 && s.edges[0].currentA > 0.01, `edge ${JSON.stringify(s.edges[0])}`);
      // A knob: the reservoir cap halves → the ripple roughly doubles from here on.
      assert.ok(host.writeKey('circuit.elem.C1.c', 235e-6));
      assert.ok(Math.abs(host.readKey('circuit.elem.C1.c') / 235e-6 - 1) < 1e-6, 'the knob reads back');
    } finally {
      host.dispose();
    }
  });

  it('teacher link: homopolar → bridge → RC — the disc drives the load, books close under 1 %', () => {
    const { host, state } = runExample('homopolar-bridge-rc', 'homopolar', 1, 3);
    try {
      assert.equal(host.state, 'ok');
      assert.ok(state.homopolarOmega > 1, `disc ω ${state.homopolarOmega}`);
      const w = lastWindow(host.scopeTrace(), 0, 0.5);
      assert.ok(w.n > 100 && w.lo > 0, `v(out) ${w.lo}–${w.hi} V over ${w.n} samples`);
      const b = host.energyBooks();
      assert.ok(b.residual < 0.01, `residual ${b.residual}`);
      assert.ok(b.portW.P1 > 0, `port power ${b.portW.P1}`);
    } finally {
      host.dispose();
    }
  });

  it('pulse coil: the ring is the coil\'s R and L, the books close once it rings', () => {
    const { host, state } = runExample('pulse-coil-ring', 'pulse-coil', 0.5, 0.2);
    try {
      assert.equal(host.state, 'ok');
      assert.ok(state._circuitOwned);
      assert.ok(host.energyBooks().residual < 0.01, `residual ${host.energyBooks().residual}`);
      assert.ok(Math.abs(host.readKey('circuit.node.cap.v')) < 1, 'the cap has rung down through the coil');
    } finally {
      host.dispose();
    }
  });

  it('experiments: circuit keys are checked against the netlist', () => {
    const exp = (record) => ({
      id: 'circuit-unit', title: 'unit', config: { mode: 'transformer', circuit: 'transformer-bridge-rc' }, dt: 1 / 4800,
      steps: [{ at: 0, record, hz: 100, until: 0.1 }]
    });
    assert.ok(X.validateExperiment(exp(['circuit.node.out.v', 'circuit.elem.D1.i'])), 'known keys validate');
    assert.throws(() => X.validateExperiment(exp(['circuit.node.nope.v'])));
  });
});
