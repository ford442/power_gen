/**
 * Circuit Lab wiring view (#256, ADR-0018) — lazy chunk, both renderers.
 *
 *   palette     R, C, L, diode, switch, sources, meters, ground, and one glyph
 *               per catalog bench port (physics/devices.json `ports`)
 *   sheet       src/circuit-ui/schematic.ts
 *   inspector   the selection's values (SI prefixes: 4.7k, 100n, 2.2m),
 *               its terminals' node names, its live i / v / p
 *   meters      every voltmeter / ammeter, the bench ports' power, the energy
 *               books' residual
 *   scope       two `circuit.*` channels → "Send to analysis" (uPlot panel)
 *
 * A value edit on a loaded circuit is a live `setParam` (the run continues);
 * a topology edit recompiles and restarts the circuit from its initial
 * conditions. Without sim_core.wasm the view is read-only and says why
 * (docs/WEBGL2.md, docs/CIRCUIT.md). Simulated — not metrology.
 */
/// <reference types="vite/client" />
import panelCss from './panel.css?inline';
import { CIRCUIT_PORTS } from '../../generated/circuit-ports';
import { KIND_SPECS, WAVE_PARAMS, type DocKind, type WaveKind } from '../circuit/kinds';
import { CIRCUIT_EXAMPLE_IDS, circuitExample } from '../circuit/examples';
import type { CircuitHost } from '../circuit/host';
import { paramProblem, paramSpecs, waveOf, type CircuitDoc, type CircuitElemDoc } from '../circuit/netlist';
import { formatSi, parseSi } from '../circuit/si';
import { applyCircuitConfig, currentCircuitHost, editCircuit, liveCircuitHost, onCircuitChange, syncSessionCircuit } from '../circuit/session-circuit';
import { onFrame } from '../frame-clock';
import { Schematic, type Selection } from './schematic';
import { SCOPE_COLORS, SCOPE_SPANS_S, drawScope, scopeRun } from './scope';

const PALETTE: readonly DocKind[] = ['R', 'C', 'L', 'D', 'S', 'V', 'I', 'VM', 'AM', 'GND'];

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  Object.assign(n, props);
  n.append(...children);
  return n;
}

function download(name: string, text: string, type = 'text/plain'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

class WiringView {
  readonly root: HTMLElement;
  private readonly sheet: Schematic;
  private readonly status = h('div', { className: 'circuit-status' });
  private readonly inspector = h('div', { className: 'circuit-inspector' });
  private readonly meters = h('div', { className: 'circuit-meters' });
  private readonly scopeCanvas = h('canvas', { className: 'circuit-scope' });
  private readonly scopeLegend = h('div', { className: 'circuit-scope-legend' });
  private readonly chSelects = [h('select'), h('select')];
  private readonly spanSelect = h('select');
  private readonly exampleSelect = h('select', { title: 'Open an example circuit' });
  private readonly palette = h('div', { className: 'circuit-palette', role: 'toolbar', ariaLabel: 'Parts' });
  private armed: { kind: DocKind; dev?: string; port?: string } | null = null;
  private span = 0.05;
  private offFrame: (() => void) | null = null;
  private offChange: (() => void) | null = null;

  constructor(private readonly host: CircuitHost) {
    this.root = h('section', { className: 'circuit-panel', role: 'dialog', ariaLabel: 'Circuit Lab wiring view' });
    this.root.tabIndex = -1;
    this.sheet = new Schematic(() => this.host.doc, {
      readOnly: () => this.readOnly,
      onEdit: () => this.topologyEdited(),
      onSelect: (sel) => this.renderInspector(sel),
      armed: () => this.armed,
      disarm: () => { this.armed = null; this.renderPalette(); }
    });
    this.build();
    this.offChange = onCircuitChange(() => this.refreshAll());
    this.offFrame = onFrame(() => this.tick(), { hz: 15 });
    this.root.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') { this.close(); return; }
      if ((ev.target as HTMLElement).closest('input, select, textarea')) return;
      if (this.sheet.key(ev)) ev.preventDefault();
    });
  }

  get readOnly(): boolean {
    return this.host.state === 'needs-wasm';
  }

  private build(): void {
    const close = h('button', { type: 'button', className: 'ctrl-btn', textContent: '×', title: 'Close (Esc)', onclick: () => this.close() });
    this.exampleSelect.append(h('option', { value: '', textContent: 'Examples…' }), ...CIRCUIT_EXAMPLE_IDS.map((id) => h('option', { value: id, textContent: circuitExample(id)?.title ?? id })));
    this.exampleSelect.onchange = () => {
      const id = this.exampleSelect.value;
      this.exampleSelect.value = '';
      if (id) void applyCircuitConfig(id, { open: false });
    };
    const clear = h('button', { type: 'button', className: 'ctrl-btn', textContent: 'New', title: 'An empty sheet', onclick: () => {
      editCircuit({ v: 1, title: 'Untitled circuit', e: [{ id: 'G1', k: 'GND', x: 6, y: 12 }], w: [] });
    } });
    const exportCir = h('button', { type: 'button', className: 'ctrl-btn', textContent: '.cir', title: 'Export a SPICE netlist', onclick: () => void this.exportSpice() });
    const importCir = h('button', { type: 'button', className: 'ctrl-btn', textContent: 'Import', title: 'Import a SPICE netlist (R, L, C, V, I, D, K)', onclick: () => this.importSpice() });
    const header = h('header', { className: 'circuit-header' },
      h('h2', { textContent: 'Circuit Lab' }), this.exampleSelect, clear, exportCir, importCir, close);

    for (const span of SCOPE_SPANS_S) this.spanSelect.append(h('option', { value: String(span), textContent: formatSi(span, 's', 2) }));
    this.spanSelect.value = String(this.span);
    this.spanSelect.onchange = () => { this.span = Number(this.spanSelect.value); };
    this.chSelects.forEach((sel, c) => {
      sel.style.borderColor = SCOPE_COLORS[c];
      sel.onchange = () => this.host.setScope(this.chSelects.map((s) => s.value).filter(Boolean));
    });
    const send = h('button', { type: 'button', className: 'ctrl-btn', textContent: 'Send to analysis', title: 'The scope buffer as a run in the analysis panel', onclick: () => void this.sendToAnalysis() });
    const scopeBar = h('div', { className: 'circuit-scope-bar' }, 'Scope ', this.chSelects[0], this.chSelects[1], this.spanSelect, send);

    const sheetWrap = h('div', { className: 'circuit-sheet-wrap' }, this.sheet.svg);
    const foot = h('footer', { className: 'circuit-foot', textContent: 'Simulated — not metrology. Solver: C++ MNA, trapezoidal with backward-Euler restarts (ADR-0018).' });
    this.root.append(h('style', { textContent: panelCss }), header, this.status, this.palette, sheetWrap,
      h('div', { className: 'circuit-side' }, this.inspector, this.meters), scopeBar, this.scopeCanvas, this.scopeLegend, foot);
    this.refreshAll();
  }

  private renderPalette(): void {
    const parts: { label: string; title: string; part: { kind: DocKind; dev?: string; port?: string } }[] = PALETTE.map((k) => ({
      label: k === 'GND' ? '⏚' : k, title: KIND_SPECS[k].label, part: { kind: k }
    }));
    for (const p of CIRCUIT_PORTS) {
      parts.push({ label: `⎓ ${p.device}`, title: `${p.label} — ${p.model}`, part: { kind: 'PORT', dev: p.device, port: p.id } });
    }
    this.palette.replaceChildren(...parts.map(({ label, title, part }) => {
      const b = h('button', { type: 'button', className: 'ctrl-btn circuit-part-btn', textContent: label, title, disabled: this.readOnly, draggable: !this.readOnly });
      if (this.armed && this.armed.kind === part.kind && this.armed.dev === part.dev) b.classList.add('armed');
      b.onclick = (ev) => {
        // Enter / Space (a click with no pointer, detail 0): place it now on a
        // free spot, focused, so a keyboard user can move it with the arrows.
        if (ev.detail === 0 && !this.readOnly) {
          this.armed = null;
          this.renderPalette();
          this.sheet.placeFree(part);
          return;
        }
        this.armed = this.armed?.kind === part.kind && this.armed.dev === part.dev ? null : part;
        this.renderPalette();
      };
      b.ondragstart = (ev) => ev.dataTransfer?.setData('application/x-circuit-part', JSON.stringify(part));
      return b;
    }));
  }

  private renderStatus(): void {
    const s = this.host;
    const title = s.doc?.title ? `${s.doc.title} · ` : '';
    const text: Record<string, string> = {
      empty: 'No circuit: open an example or place parts.',
      ok: `${title}solving${s.message ? ` — ${s.message}` : ''}`,
      error: `${title}not solving: ${s.message}`,
      'needs-wasm': `${title}needs WASM — ${s.message} The netlist is shown read-only.`
    };
    this.status.textContent = text[s.state] ?? s.state;
    this.status.dataset.state = s.state;
  }

  private scopeKeys(): string[] {
    const d = this.host.doc;
    if (!d) return [];
    const keys = Object.keys(d.n ?? {}).map((n) => `circuit.node.${n}.v`);
    for (const e of d.e) {
      if (e.k === 'GND' || e.k === 'PORT' || e.k === 'K') continue;
      keys.push(`circuit.elem.${e.id}.i`, `circuit.elem.${e.id}.v`);
    }
    for (const e of d.e) if (e.k === 'PORT') keys.push(`circuit.port.${e.id}.p`);
    return keys;
  }

  private renderScopeSelects(): void {
    const keys = this.scopeKeys();
    const chosen = this.host.doc?.scope ?? [];
    this.chSelects.forEach((sel, c) => {
      sel.replaceChildren(h('option', { value: '', textContent: c ? '— ch 2 off' : '— ch 1 off' }), ...keys.map((k) => h('option', { value: k, textContent: k.replace(/^circuit\./, '') })));
      sel.value = chosen[c] && keys.includes(chosen[c]) ? chosen[c] : '';
    });
  }

  private refreshAll(): void {
    this.renderStatus();
    this.renderPalette();
    this.renderScopeSelects();
    this.sheet.render();
    this.renderInspector(this.sheet.selection);
  }

  /** Topology changed: recompile + restart (values stay in the document). */
  private topologyEdited(): void {
    const doc = this.host.doc;
    if (!doc) return;
    editCircuit(doc);
  }

  private selectedElem(sel: Selection): CircuitElemDoc | null {
    if (sel?.kind !== 'elem') return null;
    return this.host.doc?.e.find((e) => e.id === sel.id) ?? null;
  }

  private renderInspector(sel: Selection): void {
    const box = this.inspector;
    box.replaceChildren();
    const e = this.selectedElem(sel);
    if (!e) {
      box.append(h('p', { className: 'circuit-hint', textContent: this.readOnly
        ? 'Read-only: the solver is C++ (sim_core.wasm) and it is not loaded.'
        : 'Click a part to edit it. Click two terminals to wire them. R rotates, Delete removes. Drag parts to move them. '
          + 'Keyboard: Enter on a palette part places it, Tab reaches parts and terminals, Enter selects or wires, arrows move.' }));
      if (sel?.kind === 'wire') box.append(h('p', { textContent: `wire ${this.host.doc?.w[sel.index]?.join(' — ') ?? ''} (Delete removes it)` }));
      return;
    }
    const spec = KIND_SPECS[e.k];
    box.append(h('h3', { textContent: `${e.id} · ${spec.label}${e.k === 'PORT' ? ` · ${e.dev}.${e.port}` : ''}` }));
    if (e.k === 'PORT') {
      const decl = CIRCUIT_PORTS.find((p) => p.device === e.dev && p.id === e.port);
      if (decl) box.append(h('p', { className: 'circuit-hint', textContent: decl.model }));
    }
    if (e.k === 'V' || e.k === 'I') {
      const wave = h('select', { disabled: this.readOnly });
      for (const w of Object.keys(WAVE_PARAMS) as WaveKind[]) wave.append(h('option', { value: w, textContent: w }));
      wave.value = waveOf(e);
      wave.onchange = () => {
        const w = wave.value as WaveKind;
        e.p = { w, ...Object.fromEntries(WAVE_PARAMS[w].map((s) => [s.name, s.default])) };
        this.topologyEdited();
      };
      box.append(h('label', { className: 'circuit-field' }, 'waveform ', wave));
    }
    for (const s of paramSpecs(e)) {
      const unit = e.k === 'V' && !s.unit ? 'V' : e.k === 'I' && !s.unit ? 'A' : s.unit;
      const cur = Number(e.p?.[s.name] ?? s.default);
      const input = h('input', { type: 'text', value: unit ? formatSi(cur, '', 4) : String(cur), disabled: this.readOnly, size: 9 });
      const err = h('span', { className: 'circuit-err' });
      input.onchange = () => {
        const v = parseSi(input.value);
        const why = paramProblem(s, v);
        err.textContent = why ?? '';
        if (why) return;
        this.setValue(e, s.name, v);
        input.value = unit ? formatSi(v, '', 4) : String(v);
      };
      box.append(h('label', { className: 'circuit-field', title: s.label }, `${s.name} `, input, ` ${unit}`, err));
    }
    // Node names at the terminals (experiments and the scope read them).
    spec.terminals.forEach((tname, i) => {
      const ref = `${e.id}.${i}`;
      const named = Object.entries(this.host.doc?.n ?? {}).find(([, r]) => r === ref)?.[0] ?? '';
      const input = h('input', { type: 'text', value: named, placeholder: 'node name', disabled: this.readOnly, size: 7 });
      input.onchange = () => this.nameNode(ref, input.value.trim(), named);
      box.append(h('label', { className: 'circuit-field' }, `${tname} `, input));
    });
    const live = h('div', { className: 'circuit-live' });
    live.dataset.elem = e.id;
    box.append(live);
  }

  private nameNode(ref: string, name: string, previous: string): void {
    const d = this.host.doc;
    if (!d) return;
    d.n ??= {};
    if (previous) delete d.n[previous];
    if (name && /^[A-Za-z][A-Za-z0-9_]{0,15}$/.test(name) && name !== 'gnd') d.n[name] = ref;
    this.topologyEdited();
  }

  /** A value edit: live setParam when the solver has the slot, else recompile. */
  private setValue(e: CircuitElemDoc, name: string, v: number): void {
    if (this.host.loaded && this.host.writeKey(`circuit.elem.${e.id}.${name}`, v)) {
      this.sheet.render();
      return;
    }
    e.p = { ...(e.p ?? {}), [name]: v };
    this.topologyEdited();
  }

  private tick(): void {
    if (!this.root.isConnected) return;
    const s = this.host;
    // Meters.
    const rows: string[][] = [];
    const d = s.doc;
    if (d && s.loaded) {
      for (const e of d.e) {
        if (e.k === 'VM') rows.push([e.id, formatSi(s.readKey(`circuit.elem.${e.id}.v`), 'V', 4)]);
        if (e.k === 'AM') rows.push([e.id, formatSi(s.readKey(`circuit.elem.${e.id}.i`), 'A', 4)]);
      }
      const books = s.energyBooks();
      for (const e of d.e) if (e.k === 'PORT') rows.push([`${e.id} → circuit`, formatSi(books.portW[e.id] ?? 0, 'W', 3)]);
      rows.push(['energy residual', `${(books.residual * 100).toFixed(3)} %`]);
      const st = s.stats();
      rows.push(['solver', `t = ${formatSi(s.time(), 's', 4)} · ${st.steps} steps · ${st.rejected} rejected · ${st.reused} LU reuses`]);
    }
    this.meters.replaceChildren(...rows.map(([k, v]) => h('div', { className: 'circuit-meter' }, h('span', { textContent: k }), h('b', { textContent: v }))));
    const live = this.inspector.querySelector<HTMLElement>('.circuit-live');
    const id = live?.dataset.elem;
    if (live && id && s.loaded) {
      const i = s.readKey(`circuit.elem.${id}.i`), v = s.readKey(`circuit.elem.${id}.v`), p = s.readKey(`circuit.elem.${id}.p`);
      live.textContent = Number.isFinite(i) ? `i ${formatSi(i, 'A', 4)} · v ${formatSi(v, 'V', 4)} · p ${formatSi(p, 'W', 3)}` : '';
    }
    // Scope.
    const trace = s.scopeTrace();
    const ranges = drawScope(this.scopeCanvas, trace, this.span);
    this.scopeLegend.replaceChildren(...trace.keys.map((k, c) => {
      const [lo, hi] = ranges[c] ?? [Number.NaN, Number.NaN];
      const unit = /\.i$/.test(k) ? 'A' : /\.p$/.test(k) ? 'W' : 'V';
      const span = h('span', { textContent: `${k.replace(/^circuit\./, '')}: ${formatSi(lo, unit)} … ${formatSi(hi, unit)} (p-p ${formatSi(hi - lo, unit)})` });
      span.style.color = SCOPE_COLORS[c];
      return span;
    }));
  }

  private async sendToAnalysis(): Promise<void> {
    const trace = this.host.scopeTrace();
    if (!trace.t.length) return;
    const run = scopeRun(trace, `Circuit scope — ${this.host.doc?.title ?? 'circuit'}`, this.host.scopeHz);
    const store = window.analysisRuns ?? (await import('../analysis/run-store'));
    store.addRun(run);
    await window.openAnalysis?.([run.id]);
  }

  private async exportSpice(): Promise<void> {
    const d = this.host.doc;
    if (!d) return;
    const { toSpice } = await import('../circuit/spice');
    download(`${(d.title ?? 'circuit').replace(/[^\w-]+/g, '-').toLowerCase()}.cir`, toSpice(d));
  }

  private importSpice(): void {
    if (this.readOnly) return;
    const input = h('input', { type: 'file', accept: '.cir,.sp,.net,.txt' });
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const { fromSpice } = await import('../circuit/spice');
      try {
        const { doc, warnings } = fromSpice(await file.text());
        editCircuit(doc);
        if (warnings.length) this.status.textContent += ` · import: ${warnings.join('; ')}`;
      } catch (err) {
        this.status.textContent = `import failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    };
    input.click();
  }

  close(): void {
    this.offFrame?.();
    this.offChange?.();
    this.root.remove();
    view = null;
  }
}

let view: WiringView | null = null;

/** Open (or focus) the wiring view on the live circuit. */
export async function openWiringView(): Promise<void> {
  const host = currentCircuitHost() ?? (await liveCircuitHost());
  if (!host) throw new Error('the lab has not booted yet');
  syncSessionCircuit();
  if (!view) {
    view = new WiringView(host);
    document.body.append(view.root);
  }
  view.root.focus();
}

export function closeWiringView(): void {
  view?.close();
}

/** For tests / console: the document on the sheet. */
export function wiringViewDoc(): CircuitDoc | null {
  return currentCircuitHost()?.doc ?? null;
}
