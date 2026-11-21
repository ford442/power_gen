/**
 * The live lab's circuit (#256) — lazy chunk. `applyCircuitConfig` is what a
 * LabConfig `circuit` value does on the running page (boot `?circuit=`, a
 * `#lab2=` link, a `.lab.json`, a live experiment's config): build or reload
 * the session's CircuitHost on the main-thread sim_core module and open the
 * wiring view. Without the module the netlist still loads — read-only, with
 * the "needs WASM" note — so a link never silently drops its circuit.
 */
import type { LabSession } from '../session/lab-session';
import { getSimCore, loadSimCore } from '../wasm/index';
import { circuitExample, resolveCircuitConfig } from './examples';
import { CircuitHost } from './host';
import type { CircuitDoc } from './netlist';

function liveSession(): LabSession | null {
  return window.multiVisualizer?.session ?? null;
}

let host: CircuitHost | null = null;
/** The example the document came from — shared as its id while unedited. */
let sourceId: string | null = null;
const listeners = new Set<() => void>();

/** The live host (created on first use; `needs-wasm` when sim_core is unavailable). */
export async function liveCircuitHost(): Promise<CircuitHost | null> {
  const session = liveSession();
  if (!session) return null;
  if (!host) {
    const mod = getSimCore() ?? (await loadSimCore());
    host = new CircuitHost(mod, () => session.devices);
  }
  return host;
}

/** The host if one was made (no load). */
export function currentCircuitHost(): CircuitHost | null {
  return host;
}

/** Called after every load / edit (the wiring view redraws). */
export function onCircuitChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** LabConfig value for the live circuit: the example id while unedited, else the document. */
function shareValue(): string | Record<string, unknown> | null {
  const doc = host?.doc;
  if (!doc) return null;
  if (sourceId) {
    const ex = circuitExample(sourceId);
    if (ex && JSON.stringify(ex) === JSON.stringify(doc)) return sourceId;
  }
  return doc as unknown as Record<string, unknown>;
}

/** Attach / detach the host from the session's plant clock as its state changes. */
export function syncSessionCircuit(): void {
  const session = liveSession();
  if (!session || !host) return;
  const h = host;
  session.circuit = h.loaded ? h : null;
  session.circuitShare = h.doc ? shareValue : null;
  session.energyNetwork.setSolvedEdges(h.loaded ? () => h.solvedEdges() : null);
  for (const fn of listeners) fn();
}

/** Load a LabConfig `circuit` value (example id or document; null clears) into the live lab. */
export async function applyCircuitConfig(value: unknown, opts: { open?: boolean } = {}): Promise<CircuitHost | null> {
  const h = await liveCircuitHost();
  if (!h) return null;
  sourceId = typeof value === 'string' ? value : null;
  const doc: CircuitDoc | null = value == null ? null : resolveCircuitConfig(value);
  if (value != null && !doc) {
    h.load(null);
    if (h.state !== 'needs-wasm') h.state = 'error';
    h.message = `no example circuit ${JSON.stringify(value)}`;
  } else {
    h.load(doc);
  }
  syncSessionCircuit();
  if (opts.open !== false && value != null) {
    const { openWiringView } = await import('../circuit-ui/panel');
    await openWiringView();
  }
  return h;
}

/** The wiring view's edit path: reload the edited document (it recompiles; state resets). */
export function editCircuit(doc: CircuitDoc | null): boolean {
  if (!host) return false;
  const ok = host.load(doc);
  syncSessionCircuit();
  return ok;
}

/** The live netlist document (for share links / `.lab.json`), or undefined with none. */
export function liveCircuitDoc(): CircuitDoc | undefined {
  return host?.doc ?? undefined;
}
