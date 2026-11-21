/**
 * SPICE netlists for the Circuit Lab (#256 §4) — export of every kind, import
 * of R, L, C, V, I, D and K (the stretch goal; the rest is reported).
 *
 * Export is for reading or re-running the circuit elsewhere (ngspice, LTspice):
 * a switch becomes the resistor of its present state, a voltmeter a comment,
 * an ammeter the classic 0 V source, and a bench port a comment naming the
 * bench and its model — the plant that drives it is not a SPICE element.
 *
 * Import lays the parts out on a grid and wires each net as a chain; it does
 * not try to recover a drawing. SPICE's `M` suffix is milli, as SPICE reads it.
 */
import { CIRCUIT_PORTS } from '../../generated/circuit-ports';
import { compileCircuit, ELEM_ID, paramValue, waveOf, type CircuitDoc, type CircuitElemDoc } from './netlist';
import { formatSpice, parseSi } from './si';

const f = formatSpice;

/** The SPICE letter an element's card starts with, and the id it is named from. */
function cardStem(e: CircuitElemDoc): [string, string] | null {
  switch (e.k) {
    case 'S': return ['R', `S_${e.id}`];
    case 'AM': return ['V', `AM_${e.id}`];
    case 'VM': case 'PORT': case 'GND': return null;
    default: return [e.k, e.id];
  }
}

/**
 * One SPICE name per element, unique as SPICE compares them (case-blind):
 * `A` and `LA` must not both become `LA`, nor `r1` and `R1` one resistor.
 */
function spiceNames(doc: CircuitDoc): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<string>();
  for (const e of doc.e) {
    const stem = cardStem(e);
    if (!stem) continue;
    const [letter, id] = stem;
    const base = id.toUpperCase().startsWith(letter) ? id : `${letter}${id}`;
    let name = base;
    for (let k = 2; used.has(name.toUpperCase()); k++) name = `${base}_${k}`;
    used.add(name.toUpperCase());
    out.set(e.id, name);
  }
  return out;
}

function sourceSpec(e: CircuitElemDoc): string {
  const p = (n: string) => f(paramValue(e, n));
  switch (waveOf(e)) {
    case 'sin': return `SIN(${p('off')} ${p('amp')} ${p('f')} ${p('td')} ${p('damp')} ${p('ph')})`;
    case 'pulse': return `PULSE(${p('v1')} ${p('v2')} ${p('td')} ${p('tr')} ${p('tf')} ${p('pw')} ${p('per')})`;
    default: return `DC ${p('dc')}`;
  }
}

/** The document as a SPICE deck (title line first, `.end` last). */
export function toSpice(doc: CircuitDoc): string {
  const c = compileCircuit(doc);
  const nameOf = new Map<number, string>([[0, '0']]);
  // Every explicit name is reserved before any is generated, so an unnamed
  // node never takes `n2` from a node the document calls n2 (one net, not two).
  const taken = new Set<string>(['0']);
  for (const [name, n] of c.nodeByName) {
    if (name === 'gnd' || nameOf.has(n)) continue;
    nameOf.set(n, name);
    taken.add(name.toUpperCase());
  }
  const node = (ref: string) => {
    const n = c.nodeOfRef.get(ref);
    if (n === undefined) return 'NC';
    if (!nameOf.has(n)) {
      let name = `n${n}`;
      for (let k = 2; taken.has(name.toUpperCase()); k++) name = `n${n}_${k}`;
      taken.add(name.toUpperCase());
      nameOf.set(n, name);
    }
    return nameOf.get(n)!;
  };
  const t = (e: CircuitElemDoc, i: number) => node(`${e.id}.${i}`);
  const lines: string[] = [`* ${doc.title ?? 'Circuit Lab netlist'}`, '* exported by the SEG lab Circuit Lab (#256) — simulated, not metrology'];
  const models: string[] = [];
  const names = spiceNames(doc);
  const spiceName = (e: CircuitElemDoc) => names.get(e.id)!;
  let tMax = 0;
  for (const e of doc.e) {
    const p = (n: string) => f(paramValue(e, n));
    switch (e.k) {
      case 'R': lines.push(`${spiceName(e)} ${t(e, 0)} ${t(e, 1)} ${p('r')}`); break;
      case 'C': lines.push(`${spiceName(e)} ${t(e, 0)} ${t(e, 1)} ${p('c')} IC=${p('ic')}`); break;
      case 'L': lines.push(`${spiceName(e)} ${t(e, 0)} ${t(e, 1)} ${p('l')} IC=${p('ic')}`); break;
      case 'V': lines.push(`${spiceName(e)} ${t(e, 0)} ${t(e, 1)} ${sourceSpec(e)}`); break;
      case 'I': lines.push(`${spiceName(e)} ${t(e, 0)} ${t(e, 1)} ${sourceSpec(e)}`); break;
      case 'K': {
        const a = names.get(String(e.p?.a)), b = names.get(String(e.p?.b));
        if (a && b) lines.push(`${spiceName(e)} ${a} ${b} ${p('k')}`);
        break;
      }
      case 'E': lines.push(`${spiceName(e)} ${t(e, 0)} ${t(e, 1)} ${t(e, 2)} ${t(e, 3)} ${p('gain')}`); break;
      case 'G': lines.push(`${spiceName(e)} ${t(e, 0)} ${t(e, 1)} ${t(e, 2)} ${t(e, 3)} ${p('gm')}`); break;
      case 'D': {
        const model = `D_${spiceName(e)}`;
        lines.push(`${spiceName(e)} ${t(e, 0)} ${t(e, 1)} ${model}`);
        models.push(`.model ${model} D(IS=${p('is')} N=${p('n')} RS=${p('rs')})`);
        break;
      }
      case 'M': {
        const pmos = paramValue(e, 'pol') < 0;
        const model = `${pmos ? 'P' : 'N'}_${spiceName(e)}`;
        lines.push(`${spiceName(e)} ${t(e, 0)} ${t(e, 1)} ${t(e, 2)} ${t(e, 2)} ${model}`);
        models.push(`.model ${model} ${pmos ? 'PMOS' : 'NMOS'}(LEVEL=1 VTO=${f((pmos ? -1 : 1) * paramValue(e, 'vt'))} KP=${p('kp')} LAMBDA=${p('lambda')})`);
        break;
      }
      case 'S': {
        const clocked = paramValue(e, 'period') > 0;
        const closed = !clocked && paramValue(e, 'closed') >= 0.5;
        lines.push(`* switch ${e.id}: ron ${p('ron')}, roff ${p('roff')}${clocked ? `, clock period ${p('period')} duty ${p('duty')} delay ${p('delay')} — exported open` : ''}`);
        lines.push(`${spiceName(e)} ${t(e, 0)} ${t(e, 1)} ${closed ? p('ron') : p('roff')}`);
        if (clocked) tMax = Math.max(tMax, paramValue(e, 'delay') + 4 * paramValue(e, 'period'));
        break;
      }
      case 'VM': lines.push(`* voltmeter ${e.id} across ${t(e, 0)} ${t(e, 1)} (ideal: no element)`); break;
      case 'AM': lines.push(`${spiceName(e)} ${t(e, 0)} ${t(e, 1)} DC 0 ; ammeter ${e.id}`); break;
      case 'PORT': {
        const decl = CIRCUIT_PORTS.find((x) => x.device === e.dev && x.id === e.port);
        lines.push(`* bench port ${e.id} = ${e.dev}.${e.port} between ${t(e, 0)} (+) and ${t(e, 1)} (−): ${decl?.model ?? ''}`);
        lines.push('*   the lab plant drives it; it is not a SPICE element — put your own source here');
        break;
      }
      default: break;
    }
  }
  lines.push(...models, `.tran ${f(Math.max(1e-5, (doc.opt?.maxStep ?? 1e-4)))} ${f(Math.max(0.1, tMax))} UIC`, '.end', '');
  return lines.join('\n');
}

// ── import ───────────────────────────────────────────────────────────────

/** Logical lines: `+` continuations joined, comments and blank lines dropped. */
function spiceLines(text: string): string[] {
  const out: string[] = [];
  const raw = text.replace(/\r/g, '').split('\n');
  raw.forEach((line, i) => {
    if (i === 0) return; // SPICE: the first line is the title, whatever it says
    const body = line.replace(/[;$].*$/, '').trimEnd();
    if (!body.trim() || body.trimStart().startsWith('*')) return;
    if (body.trimStart().startsWith('+') && out.length) out[out.length - 1] += ` ${body.trimStart().slice(1)}`;
    else out.push(body.trim());
  });
  return out;
}

function value(tok: string | undefined): number {
  return tok === undefined ? Number.NaN : parseSi(tok, { spice: true });
}

/** `SIN(0 10 60)` / `PULSE(...)` / `DC 5` / `5` → document parameters. */
function sourceParams(tokens: string[], warn: (m: string) => void, where: string): Record<string, number | string> {
  const joined = tokens.join(' ');
  const fn = /(SIN|PULSE)\s*\(([^)]*)\)/i.exec(joined);
  if (fn) {
    const args = fn[2].trim().split(/[\s,]+/).map(value);
    if (fn[1].toUpperCase() === 'SIN') {
      const [off = 0, amp = 0, fr = 0, td = 0, damp = 0, ph = 0] = args;
      return { w: 'sin', off, amp, f: fr, td, damp, ph };
    }
    const [v1 = 0, v2 = 0, td = 0, tr = 0, tf = 0, pw = 0, per = 0] = args;
    return { w: 'pulse', v1, v2, td, tr, tf, pw, per };
  }
  if (/\bAC\b/i.test(joined)) warn(`${where}: AC analysis values ignored`);
  const dc = /\bDC\s+(\S+)/i.exec(joined)?.[1] ?? tokens.find((t) => Number.isFinite(value(t)));
  return { w: 'dc', dc: Number.isFinite(value(dc)) ? value(dc) : 0 };
}

function cleanId(name: string, used: Set<string>): string {
  let id = name.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 14);
  if (!ELEM_ID.test(id)) id = `X${id}`.slice(0, 14);
  let k = id, i = 2;
  while (used.has(k)) k = `${id}${i++}`;
  used.add(k);
  return k;
}

/** A SPICE deck → a document. Unsupported cards are skipped with a warning each. */
export function fromSpice(text: string): { doc: CircuitDoc; warnings: string[] } {
  const warnings: string[] = [];
  const warn = (m: string) => warnings.push(m);
  const first = text.replace(/\r/g, '').split('\n')[0]?.trim() ?? '';
  const title = first.replace(/^\*\s*/, '') || 'Imported netlist';
  const models = new Map<string, Record<string, number>>();
  const cards: string[][] = [];
  for (const line of spiceLines(text)) {
    const tokens = line.split(/\s+/);
    if (/^\.model$/i.test(tokens[0])) {
      const m = /^\.model\s+(\S+)\s+(\w+)\s*\(?([^)]*)\)?/i.exec(line);
      if (m && m[2].toUpperCase() === 'D') {
        const params: Record<string, number> = {};
        for (const [, k, v] of m[3].matchAll(/(\w+)\s*=\s*(\S+)/g)) params[k.toUpperCase()] = value(v);
        models.set(m[1].toUpperCase(), params);
      } else if (m) warn(`.model ${m[1]} (${m[2]}) not imported`);
      continue;
    }
    if (tokens[0].startsWith('.')) {
      if (!/^\.(end|tran|op|options?|ic|title)$/i.test(tokens[0])) warn(`${tokens[0]} ignored`);
      continue;
    }
    cards.push(tokens);
  }
  const used = new Set<string>();
  const doc: CircuitDoc = { v: 1, title, e: [], w: [], n: {} };
  const nets = new Map<string, string[]>();
  const spiceToId = new Map<string, string>();
  const at = (i: number) => ({ x: 4 + (i % 6) * 6, y: 3 + Math.floor(i / 6) * 5, rot: 0 });
  const attach = (net: string, ref: string) => {
    const key = net === '0' || /^gnd$/i.test(net) ? '0' : net;
    if (!nets.has(key)) nets.set(key, []);
    nets.get(key)!.push(ref);
  };
  const ks: string[][] = [];
  for (const tokens of cards) {
    const [name, ...rest] = tokens;
    const letter = name[0].toUpperCase();
    if (letter === 'K') { ks.push(tokens); continue; }
    const id = cleanId(name, used);
    spiceToId.set(name.toUpperCase(), id);
    const pos = at(doc.e.length);
    const two = (k: CircuitElemDoc['k'], p: Record<string, number | string>) => {
      if (rest.length < 2) { warn(`${name}: needs two nodes`); return; }
      doc.e.push({ id, k, ...pos, p });
      attach(rest[0], `${id}.0`);
      attach(rest[1], `${id}.1`);
    };
    const ic = Number.isFinite(value(/IC=(\S+)/i.exec(tokens.join(' '))?.[1])) ? value(/IC=(\S+)/i.exec(tokens.join(' '))?.[1]) : 0;
    switch (letter) {
      case 'R': two('R', { r: value(rest[2]) }); break;
      case 'C': two('C', { c: value(rest[2]), ic }); break;
      case 'L': two('L', { l: value(rest[2]), ic }); break;
      case 'V': two('V', sourceParams(rest.slice(2), warn, name)); break;
      case 'I': two('I', sourceParams(rest.slice(2), warn, name)); break;
      case 'D': {
        const m = models.get((rest[2] ?? '').toUpperCase()) ?? {};
        if (rest[2] && !models.has(rest[2].toUpperCase())) warn(`${name}: model ${rest[2]} not found — default diode`);
        two('D', { is: m.IS ?? 1e-14, n: m.N ?? 1, rs: m.RS ?? 0 });
        break;
      }
      default: warn(`${name}: ${letter} elements are not imported`); used.delete(id); spiceToId.delete(name.toUpperCase());
    }
  }
  for (const [name, la, lb, kv] of ks) {
    const a = spiceToId.get((la ?? '').toUpperCase()), b = spiceToId.get((lb ?? '').toUpperCase());
    if (!a || !b) { warn(`${name}: inductors ${la} / ${lb} not found`); continue; }
    doc.e.push({ id: cleanId(name, used), k: 'K', p: { a, b, k: value(kv) } });
  }
  for (const [net, refs] of nets) {
    if (net === '0') {
      const g = cleanId('G0', used);
      doc.e.push({ id: g, k: 'GND', ...at(doc.e.length) });
      refs.unshift(`${g}.0`);
    } else {
      const name = /^[A-Za-z][A-Za-z0-9_]{0,15}$/.test(net) ? net : `n${net.replace(/[^A-Za-z0-9_]/g, '_')}`.slice(0, 16);
      if (/^[A-Za-z][A-Za-z0-9_]{0,15}$/.test(name) && name !== 'gnd') doc.n![name] = refs[0];
    }
    for (let i = 1; i < refs.length; i++) doc.w.push([refs[i - 1], refs[i]]);
  }
  if (!nets.has('0')) warn('no ground node (0) — add a ground');
  return { doc, warnings };
}
