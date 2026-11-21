/**
 * Wiring-view schematic (#256) — an SVG editor over a CircuitDoc.
 *
 * Grid units (GRID px): an element sits at its centre (x, y) and turns in
 * quarter turns (`rot`). Two-terminal parts span 4 units, terminal 0 on the
 * left at rot 0. Wires are orthogonal L-shapes between terminal points.
 *
 *   - palette: click a part (or drag it onto the sheet) to place it;
 *   - drag a part to move it; R rotates the selection; Delete removes it;
 *   - click one terminal, then another, to wire them; click a wire to select it.
 *
 * Read-only (no sim_core): nothing moves or wires; selection still shows
 * values. Edits call `onEdit` with the document already changed in place.
 */
import { KIND_SPECS, type DocKind } from '../circuit/kinds';
import { paramSpecs, waveOf, type CircuitDoc, type CircuitElemDoc } from '../circuit/netlist';
import { formatSi } from '../circuit/si';

export const GRID = 20;
const SVG_NS = 'http://www.w3.org/2000/svg';
const INK = '#d6ebf0';
const DIM = '#7f9aa3';
const ACCENT = '#38d6ff';
const SELECT = '#f2cf73';

export type Selection = { kind: 'elem'; id: string } | { kind: 'wire'; index: number } | null;

type Pt = [number, number];

/** Terminal offsets from the centre at rot 0 (grid units). */
function terminalOffsets(k: DocKind): Pt[] {
  const n = KIND_SPECS[k].terminals.length;
  if (k === 'GND') return [[0, -1]];
  if (k === 'M') return [[1, -2], [-2, 0], [1, 2]];
  if (n === 4) return [[2, -1], [2, 1], [-2, -1], [-2, 1]];
  return [[-2, 0], [2, 0]];
}

function rotate([x, y]: Pt, rot: number): Pt {
  let p: Pt = [x, y];
  for (let i = 0; i < (((rot % 4) + 4) % 4); i++) p = [-p[1], p[0]];
  return p;
}

/** Terminal `index` of `e` in grid units. */
export function terminalPoint(e: CircuitElemDoc, index: number): Pt {
  const off = rotate(terminalOffsets(e.k)[index] ?? [0, 0], e.rot ?? 0);
  return [(e.x ?? 0) + off[0], (e.y ?? 0) + off[1]];
}

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
}

/** Glyph path (rot 0, grid units scaled by GRID, centred on 0, 0). */
function glyph(e: CircuitElemDoc): SVGGElement {
  const g = el('g', { fill: 'none', stroke: INK, 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  const u = GRID;
  const path = (d: string, extra: Record<string, string | number> = {}) => g.append(el('path', { d, ...extra }));
  const lead = (a: number, b: number) => path(`M ${-2 * u} 0 H ${a * u} M ${b * u} 0 H ${2 * u}`);
  const circle = (label: string) => {
    lead(-1, 1);
    g.append(el('circle', { cx: 0, cy: 0, r: u }));
    const t = el('text', { x: 0, y: 4, 'text-anchor': 'middle', fill: INK, stroke: 'none', 'font-size': 12 });
    t.textContent = label;
    g.append(t);
  };
  switch (e.k) {
    case 'R': {
      lead(-1.2, 1.2);
      const zig: string[] = [`M ${-1.2 * u} 0`];
      for (let i = 0; i < 6; i++) zig.push(`L ${(-1.0 + i * 0.4) * u} ${(i % 2 ? 0.45 : -0.45) * u}`);
      zig.push(`L ${1.2 * u} 0`);
      path(zig.join(' '));
      break;
    }
    case 'C':
      lead(-0.25, 0.25);
      path(`M ${-0.25 * u} ${-0.8 * u} V ${0.8 * u} M ${0.25 * u} ${-0.8 * u} V ${0.8 * u}`);
      break;
    case 'L': {
      lead(-1.2, 1.2);
      const arcs: string[] = [`M ${-1.2 * u} 0`];
      for (let i = 0; i < 4; i++) arcs.push(`a ${0.3 * u} ${0.3 * u} 0 0 1 ${0.6 * u} 0`);
      path(arcs.join(' '));
      break;
    }
    case 'D':
      lead(-0.5, 0.5);
      path(`M ${-0.5 * u} ${-0.55 * u} L ${0.5 * u} 0 L ${-0.5 * u} ${0.55 * u} Z M ${0.5 * u} ${-0.55 * u} V ${0.55 * u}`);
      break;
    case 'S': {
      lead(-0.8, 0.8);
      const closed = Number(e.p?.closed ?? 0) >= 0.5 && !(Number(e.p?.period ?? 0) > 0);
      path(closed ? `M ${-0.8 * u} 0 L ${0.8 * u} 0` : `M ${-0.8 * u} 0 L ${0.7 * u} ${-0.6 * u}`);
      g.append(el('circle', { cx: -0.8 * u, cy: 0, r: 2.5, fill: INK }), el('circle', { cx: 0.8 * u, cy: 0, r: 2.5, fill: INK }));
      break;
    }
    case 'V':
      circle(waveOf(e) === 'sin' ? '~' : waveOf(e) === 'pulse' ? '⎍' : '±');
      break;
    case 'I':
      circle('→');
      break;
    case 'VM':
      circle('V');
      break;
    case 'AM':
      circle('A');
      break;
    case 'GND':
      path(`M 0 ${-u} V 0 M ${-0.6 * u} 0 H ${0.6 * u} M ${-0.4 * u} ${0.25 * u} H ${0.4 * u} M ${-0.2 * u} ${0.5 * u} H ${0.2 * u}`);
      break;
    case 'PORT': {
      lead(-1.4, 1.4);
      g.append(el('rect', { x: -1.4 * u, y: -0.9 * u, width: 2.8 * u, height: 1.8 * u, rx: 5, stroke: ACCENT }));
      const t = el('text', { x: 0, y: 4, 'text-anchor': 'middle', fill: ACCENT, stroke: 'none', 'font-size': 10 });
      t.textContent = e.dev ?? 'bench';
      g.append(t);
      break;
    }
    default: {
      g.append(el('rect', { x: -1.4 * u, y: -1.4 * u, width: 2.8 * u, height: 2.8 * u, rx: 3 }));
      const t = el('text', { x: 0, y: 4, 'text-anchor': 'middle', fill: INK, stroke: 'none', 'font-size': 11 });
      t.textContent = e.k;
      g.append(t);
    }
  }
  return g;
}

/** The value worth printing beside a part (its first parameter). */
export function valueLabel(e: CircuitElemDoc): string {
  if (e.k === 'PORT') return e.port ?? '';
  if (e.k === 'V' || e.k === 'I') {
    const unit = e.k === 'V' ? 'V' : 'A';
    const w = waveOf(e);
    const p = e.p ?? {};
    if (w === 'sin') return `${formatSi(Number(p.amp ?? 1), unit)} ${formatSi(Number(p.f ?? 60), 'Hz')}`;
    if (w === 'pulse') return `${formatSi(Number(p.v2 ?? 1), unit)} ⎍`;
    return formatSi(Number(p.dc ?? 1), unit);
  }
  const spec = paramSpecs(e)[0];
  if (!spec) return '';
  const v = Number(e.p?.[spec.name] ?? spec.default);
  return spec.unit ? formatSi(v, spec.unit) : String(v);
}

export interface SchematicOpts {
  readOnly: () => boolean;
  onEdit: () => void;
  onSelect: (sel: Selection) => void;
  /** Kind armed by the palette (placed on the next sheet click), or null. */
  armed: () => { kind: DocKind; dev?: string; port?: string } | null;
  disarm: () => void;
}

export class Schematic {
  readonly svg: SVGSVGElement;
  selection: Selection = null;
  private pendingTerminal: string | null = null;
  private drag: { id: string; dx: number; dy: number; moved: boolean } | null = null;

  constructor(private doc: () => CircuitDoc | null, private readonly opts: SchematicOpts) {
    this.svg = el('svg', { class: 'circuit-sheet', role: 'img', 'aria-label': 'Circuit schematic' });
    this.svg.addEventListener('pointerdown', (ev) => this.pointerDown(ev));
    this.svg.addEventListener('pointermove', (ev) => this.pointerMove(ev));
    this.svg.addEventListener('pointerup', () => this.pointerUp());
    this.svg.addEventListener('dragover', (ev) => { if (!this.opts.readOnly()) ev.preventDefault(); });
    this.svg.addEventListener('drop', (ev) => this.drop(ev));
  }

  /** Grid point under a client position. */
  private gridAt(clientX: number, clientY: number): Pt {
    const r = this.svg.getBoundingClientRect();
    return [Math.round((clientX - r.left) / GRID), Math.round((clientY - r.top) / GRID)];
  }

  private nextId(kind: DocKind): string {
    const d = this.doc();
    const prefix = kind === 'PORT' ? 'P' : kind === 'GND' ? 'G' : kind;
    let i = 1;
    while (d?.e.some((e) => e.id === `${prefix}${i}`)) i++;
    return `${prefix}${i}`;
  }

  /** Add a part of `kind` at grid (x, y) with its default values. */
  place(kind: DocKind, x: number, y: number, extra: Partial<CircuitElemDoc> = {}): CircuitElemDoc | null {
    const d = this.doc();
    if (!d || this.opts.readOnly()) return null;
    const e: CircuitElemDoc = { id: this.nextId(kind), k: kind, x, y, rot: 0, ...extra };
    const p: Record<string, number | string> = {};
    if (kind === 'V' || kind === 'I') p.w = 'dc';
    for (const s of paramSpecs({ ...e, p })) p[s.name] = s.default;
    if (Object.keys(p).length) e.p = p;
    d.e.push(e);
    this.select({ kind: 'elem', id: e.id });
    this.opts.onEdit();
    return e;
  }

  private drop(ev: DragEvent): void {
    if (this.opts.readOnly()) return;
    ev.preventDefault();
    const raw = ev.dataTransfer?.getData('application/x-circuit-part');
    if (!raw) return;
    const part = JSON.parse(raw) as { kind: DocKind; dev?: string; port?: string };
    const [x, y] = this.gridAt(ev.clientX, ev.clientY);
    this.place(part.kind, x, y, part.dev ? { dev: part.dev, port: part.port } : {});
  }

  private pointerDown(ev: PointerEvent): void {
    const target = ev.target as Element;
    const term = target.closest('[data-term]')?.getAttribute('data-term');
    const elemId = target.closest('[data-elem]')?.getAttribute('data-elem');
    const wire = target.closest('[data-wire]')?.getAttribute('data-wire');
    const ro = this.opts.readOnly();
    if (term && !ro) return this.clickTerminal(term);
    if (elemId) {
      this.select({ kind: 'elem', id: elemId });
      const e = this.doc()?.e.find((x) => x.id === elemId);
      if (e && !ro) {
        const [gx, gy] = this.gridAt(ev.clientX, ev.clientY);
        this.drag = { id: elemId, dx: (e.x ?? 0) - gx, dy: (e.y ?? 0) - gy, moved: false };
        this.svg.setPointerCapture?.(ev.pointerId);
      }
      return;
    }
    if (wire !== null && wire !== undefined) return this.select({ kind: 'wire', index: Number(wire) });
    const armed = this.opts.armed();
    if (armed && !ro) {
      const [x, y] = this.gridAt(ev.clientX, ev.clientY);
      this.place(armed.kind, x, y, armed.dev ? { dev: armed.dev, port: armed.port } : {});
      this.opts.disarm();
      return;
    }
    this.pendingTerminal = null;
    this.select(null);
  }

  private pointerMove(ev: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    const e = this.doc()?.e.find((x) => x.id === d.id);
    if (!e) return;
    const [gx, gy] = this.gridAt(ev.clientX, ev.clientY);
    const nx = gx + d.dx, ny = gy + d.dy;
    if (nx !== e.x || ny !== e.y) {
      e.x = nx;
      e.y = ny;
      d.moved = true;
      this.render();
    }
  }

  private pointerUp(): void {
    // A move changes only the drawing — the netlist is the same, so no reload.
    this.drag = null;
  }

  private clickTerminal(ref: string): void {
    const d = this.doc();
    if (!d) return;
    if (!this.pendingTerminal) {
      this.pendingTerminal = ref;
      this.render();
      return;
    }
    const a = this.pendingTerminal;
    this.pendingTerminal = null;
    if (a !== ref && !d.w.some(([x, y]) => (x === a && y === ref) || (x === ref && y === a))) {
      d.w.push([a, ref]);
      this.opts.onEdit();
    }
    this.render();
  }

  select(sel: Selection): void {
    this.selection = sel;
    this.opts.onSelect(sel);
    this.render();
  }

  /** R / Delete on the selection. */
  key(ev: KeyboardEvent): boolean {
    const d = this.doc();
    const sel = this.selection;
    if (!d || !sel || this.opts.readOnly()) return false;
    if (ev.key === 'Delete' || ev.key === 'Backspace') {
      if (sel.kind === 'wire') d.w.splice(sel.index, 1);
      else {
        d.e = d.e.filter((e) => e.id !== sel.id);
        d.w = d.w.filter(([a, b]) => !a.startsWith(`${sel.id}.`) && !b.startsWith(`${sel.id}.`));
        for (const [name, ref] of Object.entries(d.n ?? {})) if (ref.startsWith(`${sel.id}.`)) delete d.n![name];
      }
      this.select(null);
      this.opts.onEdit();
      return true;
    }
    if ((ev.key === 'r' || ev.key === 'R') && sel.kind === 'elem') {
      const e = d.e.find((x) => x.id === sel.id);
      if (e) e.rot = ((e.rot ?? 0) + 1) % 4;
      this.render();
      return true;
    }
    return false;
  }

  render(): void {
    const d = this.doc();
    const svg = this.svg;
    svg.replaceChildren();
    const defs = el('defs');
    const pat = el('pattern', { id: 'circuit-grid', width: GRID, height: GRID, patternUnits: 'userSpaceOnUse' });
    pat.append(el('circle', { cx: 0, cy: 0, r: 0.8, fill: 'rgba(159,188,196,0.25)' }));
    defs.append(pat);
    svg.append(defs, el('rect', { x: 0, y: 0, width: '100%', height: '100%', fill: 'url(#circuit-grid)' }));
    if (!d) return;
    let maxX = 0, maxY = 0;
    const byId = new Map(d.e.map((e) => [e.id, e]));
    const pointOf = (ref: string): Pt | null => {
      const [id, idx] = ref.split('.');
      const e = byId.get(id);
      return e ? terminalPoint(e, Number(idx)) : null;
    };
    // Wires under the parts.
    d.w.forEach(([a, b], i) => {
      const pa = pointOf(a), pb = pointOf(b);
      if (!pa || !pb) return;
      const sel = this.selection?.kind === 'wire' && this.selection.index === i;
      const pts = `${pa[0] * GRID},${pa[1] * GRID} ${pb[0] * GRID},${pa[1] * GRID} ${pb[0] * GRID},${pb[1] * GRID}`;
      const g = el('g', { 'data-wire': i, class: 'circuit-wire' });
      g.append(
        el('polyline', { points: pts, fill: 'none', stroke: 'transparent', 'stroke-width': 10 }),
        el('polyline', { points: pts, fill: 'none', stroke: sel ? SELECT : ACCENT, 'stroke-width': sel ? 2.4 : 1.6 })
      );
      svg.append(g);
    });
    for (const e of d.e) {
      if (e.k === 'K') continue;
      const cx = (e.x ?? 0) * GRID, cy = (e.y ?? 0) * GRID;
      maxX = Math.max(maxX, cx + 3 * GRID);
      maxY = Math.max(maxY, cy + 3 * GRID);
      const selected = this.selection?.kind === 'elem' && this.selection.id === e.id;
      const g = el('g', { 'data-elem': e.id, class: 'circuit-part', transform: `translate(${cx} ${cy})` });
      const body = el('g', { transform: `rotate(${(e.rot ?? 0) * 90})` });
      body.append(el('rect', { x: -2 * GRID, y: -GRID, width: 4 * GRID, height: 2 * GRID, fill: selected ? 'rgba(242,207,115,0.08)' : 'transparent', stroke: 'none' }));
      body.append(glyph(e));
      g.append(body);
      const label = el('text', { x: 0, y: -1.25 * GRID, 'text-anchor': 'middle', fill: selected ? SELECT : DIM, 'font-size': 10 });
      label.textContent = e.k === 'GND' ? '' : `${e.id} ${valueLabel(e)}`;
      g.append(label);
      svg.append(g);
      // Terminals on top (absolute coordinates).
      KIND_SPECS[e.k].terminals.forEach((name, i) => {
        const [tx, ty] = terminalPoint(e, i);
        const ref = `${e.id}.${i}`;
        const pending = this.pendingTerminal === ref;
        const t = el('circle', {
          cx: tx * GRID, cy: ty * GRID, r: pending ? 5 : 3.5,
          fill: pending ? SELECT : '#0a1420', stroke: pending ? SELECT : ACCENT, 'stroke-width': 1.4,
          'data-term': ref, class: 'circuit-term'
        });
        const title = el('title');
        title.textContent = `${e.id} ${name}${e.k === 'PORT' ? ' (bench terminal)' : ''}`;
        t.append(title);
        svg.append(t);
      });
    }
    // K couplings: a dashed arc between their inductors.
    for (const e of d.e) {
      if (e.k !== 'K') continue;
      const a = byId.get(String(e.p?.a ?? '')), b = byId.get(String(e.p?.b ?? ''));
      if (!a || !b) continue;
      svg.append(el('line', {
        x1: (a.x ?? 0) * GRID, y1: (a.y ?? 0) * GRID, x2: (b.x ?? 0) * GRID, y2: (b.y ?? 0) * GRID,
        stroke: DIM, 'stroke-dasharray': '4 3', 'data-elem': e.id
      }));
    }
    svg.setAttribute('width', String(Math.max(560, maxX)));
    svg.setAttribute('height', String(Math.max(320, maxY)));
  }
}
