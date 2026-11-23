/**
 * The IR view's legend (`?thermal=1`, docs/FLUIDS.md → IR view): the ramp
 * with its scale, and one line on where the focused bench's temperature
 * comes from. A readout, not a control. Both renderers.
 */
import { telemetryHub } from '../telemetry-hub';
import type { TelemetrySnapshot } from '../telemetry/types';
import { labConfig } from '../config/lab-config';
import { IR_AMBIENT_K, IR_RAMP, IR_SCALE, irHasModel, type IrViewState } from './ir-view';

const celsius = (k: number): string => `${k - 273.15 >= 0 ? '+' : '−'}${Math.abs(Math.round(k - 273.15))} °C`;

/** A rise above the room in the unit that reads: kelvin, or millikelvin under a hundredth of one. */
function rise(k: number): string {
  const d = k - IR_AMBIENT_K;
  if (Math.abs(d) < 0.01) return `${(d * 1000).toFixed(1)} mK`;
  return `${d.toFixed(d < 10 ? 2 : 1)} K`;
}

/** The legend's line for a view. Pure — the test and the DOM both call it. */
export function irLegendText(view: string | null | undefined, s: IrViewState | null | undefined): string {
  const tail = 'simulated, not thermography';
  if (!view || view === 'overview') {
    return `IR view: false colour by temperature · Peltier, the pulse coil and the drop tube have a thermal model; every other bench is at the room's ${celsius(IR_AMBIENT_K)} · ${tail}`;
  }
  if (view === 'peltier') {
    const nodes = s?.peltierNodesK;
    const block = nodes?.[0] ?? s?.peltierColdK ?? IR_AMBIENT_K;
    const sink = nodes?.[nodes.length - 1] ?? s?.peltierHotK ?? IR_AMBIENT_K;
    return `IR view: the plant's own temperatures — cold block ${celsius(block)}, heat sink ${celsius(sink)}, the module between its plates · ${tail}`;
  }
  if (view === 'pulse-coil') {
    return `IR view: the winding as one lump of copper heated by I²R — ${rise(s?._irBodyK ?? IR_AMBIENT_K)} above the room, minutes to settle · ${tail}`;
  }
  if (view === 'drop-tube') {
    return `IR view: the tube wall heated by the eddy brake — ${rise(s?._irBodyK ?? IR_AMBIENT_K)} above the room. A whole drop is m·g·h, tens of millijoules: below what a camera resolves · ${tail}`;
  }
  return `IR view: this bench has no thermal model, so it is shown at the room's ${celsius(IR_AMBIENT_K)} — the view does not invent one · ${tail}`;
}

/** The ramp as a CSS gradient (linear working space → display, by a 1/2.2 power). */
export function irLegendGradient(): string {
  const stops = IR_RAMP.map((c, i) => {
    const [r, g, b] = c.map((v) => Math.round(255 * Math.min(1, Math.max(0, v)) ** (1 / 2.2)));
    return `rgb(${r}, ${g}, ${b}) ${Math.round((100 * i) / (IR_RAMP.length - 1))}%`;
  });
  return `linear-gradient(to right, ${stops.join(', ')})`;
}

export class IrLegend {
  text = '';
  private root: HTMLElement | null = null;
  private line: HTMLElement | null = null;
  private last = -Infinity;
  private readonly unsubscribe: () => void;

  constructor(private readonly read: (view: string) => IrViewState | null) {
    this.unsubscribe = telemetryHub.subscribe((snap) => this.onSnapshot(snap));
  }

  private onSnapshot(snap: TelemetrySnapshot): void {
    const now = performance.now();
    if (now - this.last < 500) return;
    this.last = now;
    const text = irLegendText(snap.view, this.read(snap.view ?? ''));
    if (text === this.text && this.root) return;
    this.text = text;
    if (!this.root) this.mount();
    this.line!.textContent = text;
  }

  private mount(): void {
    const root = document.createElement('div');
    root.id = 'ir-legend';
    root.setAttribute('role', 'note');
    root.style.cssText = 'position:absolute;left:12px;top:44px;z-index:5;max-width:320px;background:rgba(2,10,18,0.88);'
      + 'border:1px solid #0ff3;border-radius:5px;padding:6px 8px;pointer-events:none;font-size:0.62rem;color:#9fb4c8;line-height:1.35';
    const bar = document.createElement('div');
    bar.style.cssText = `height:8px;border-radius:2px;background:${irLegendGradient()}`;
    const scale = document.createElement('div');
    scale.style.cssText = 'display:flex;justify-content:space-between;margin:2px 0 4px';
    for (const label of [celsius(IR_SCALE.minK), celsius(IR_AMBIENT_K), celsius(IR_SCALE.maxK)]) {
      const span = document.createElement('span');
      span.textContent = label;
      scale.appendChild(span);
    }
    this.line = document.createElement('div');
    root.append(bar, scale, this.line);
    (document.getElementById('canvas-wrapper') ?? document.body).appendChild(root);
    this.root = root;
  }

  destroy(): void {
    this.unsubscribe();
    this.root?.remove();
  }
}

declare global {
  interface Window {
    irLegend?: IrLegend;
  }
}

/** Mount the legend when the IR view is on (idempotent). */
export function initIrLegend(): IrLegend | null {
  if (typeof window === 'undefined' || !labConfig().thermal) return null;
  if (window.irLegend) return window.irLegend;
  const read = (view: string): IrViewState | null => {
    const devices = (window.multiVisualizer as { devices?: Record<string, { physicsState?: IrViewState; physics?: IrViewState }> } | undefined)?.devices;
    const d = devices?.[view];
    return d?.physicsState ?? d?.physics ?? null;
  };
  window.irLegend = new IrLegend(read);
  return window.irLegend;
}

export { irHasModel };
