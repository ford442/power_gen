/**
 * Heron bench: a one-line note saying what is drawing the water (ADR-0022,
 * docs/FLUIDS.md → Heron). On WebGPU in focus it is a liquid solver, shown
 * slowed down; everywhere else it is stateless droplets, and the note says
 * which and why — including "the liquid solver needs WebGPU" on the fallback
 * renderer.
 *
 * A readout, not a control. Both renderers. It reads the renderer's own
 * report (`window.getRendererInfo().fluid`) a couple of times a second while
 * the bench is in focus, and nothing otherwise.
 */
import { telemetryHub } from './telemetry-hub';
import type { TelemetrySnapshot } from './telemetry/types';

export const HERON_LIQUID_NOTE_OWNER = 'heron';
/** Milliseconds between refreshes of the note's text. */
const REFRESH_MS = 500;

/** The part of the renderer's `fluid` report the note reads (visualizer/heron-liquid-pass.ts `HeronLiquidInfo`). */
export interface HeronLiquidNoteFluid {
  choice: string;
  /** The lab mode's say while `choice` is `auto`; the cap the profiler has put on `auto`. */
  preset?: string | null;
  ceiling?: string;
  build: string;
  allocated: boolean;
  active: boolean;
  tier: string | null;
  grid: number[] | null;
  live: number;
  timeScale: number;
  substeps: number;
}

export interface HeronLiquidNoteState {
  renderer: string | null | undefined;
  /** Absent on WebGL2. */
  fluid?: HeronLiquidNoteFluid | null;
}

/** "1/6" for a time scale of 0.1667; the plain number when it is not a clean fraction. */
function speedLabel(timeScale: number): string {
  const inv = 1 / timeScale;
  return Math.abs(inv - Math.round(inv)) < 0.02 ? `1/${Math.round(inv)}` : timeScale.toFixed(2);
}

/** The note for a renderer state. Pure — the test and the DOM both call it. */
export function heronLiquidNoteText(s: HeronLiquidNoteState): string {
  if (s.renderer !== 'webgpu') {
    return 'Liquid solver needs WebGPU — these droplets are ballistic, each on its own. Simulated, not a measurement.';
  }
  const f = s.fluid;
  if (!f) return 'Droplets: ballistic, each on its own. Simulated, not a measurement.';
  if (f.choice === 'off') return 'Liquid solver off (fluid=off) — stand-in droplets on a fixed path, not a liquid.';
  if (f.choice === 'auto' && f.preset === 'off') {
    return 'Liquid solver off in this lab mode (fluid=low turns it on) — stand-in droplets on a fixed path, not a liquid.';
  }
  if (f.build === 'failed') return 'Liquid solver unavailable on this GPU — stand-in droplets on a fixed path, not a liquid.';
  if (f.allocated && f.active && f.substeps > 0 && f.grid) {
    return `Liquid: MLS-MPM, ${f.grid.join('×')} grid, ${f.live.toLocaleString('en-US')} particles · shown at ${speedLabel(f.timeScale)} speed · `
      + 'the basin is a drain · simulated, not a measurement';
  }
  if (f.active) return 'Liquid solver starting…';
  if (f.choice === 'auto' && f.ceiling === 'off') {
    return 'Liquid solver off — this GPU could not keep its frame rate with it. Stand-in droplets on a fixed path, not a liquid.';
  }
  if (f.build === 'pending') return 'Liquid solver starting…';
  return 'Liquid solver off at this quality tier — stand-in droplets on a fixed path, not a liquid.';
}

export interface HeronLiquidNoteOptions {
  /** Test seams: the hub subscription and where the renderer state comes from. */
  subscribe?: (fn: (snap: TelemetrySnapshot) => void) => () => void;
  read?: () => HeronLiquidNoteState;
  now?: () => number;
}

export class HeronLiquidNote {
  /** True while the note is on screen. */
  active = false;
  /** The text last written (also what a test reads). */
  text = '';
  private root: HTMLElement | null = null;
  private last = -Infinity;
  private readonly read: () => HeronLiquidNoteState;
  private readonly now: () => number;
  private readonly unsubscribe: () => void;

  constructor(opts: HeronLiquidNoteOptions = {}) {
    this.read = opts.read ?? (() => ({
      renderer: window.currentRenderer,
      fluid: (window.getRendererInfo?.() as { fluid?: HeronLiquidNoteFluid } | null | undefined)?.fluid ?? null
    }));
    this.now = opts.now ?? (() => performance.now());
    const subscribe = opts.subscribe ?? ((fn) => telemetryHub.subscribe(fn));
    this.unsubscribe = subscribe((snap) => this.onSnapshot(snap));
  }

  private onSnapshot(snap: TelemetrySnapshot): void {
    const open = snap.view === HERON_LIQUID_NOTE_OWNER;
    if (open !== this.active) {
      this.active = open;
      this.last = -Infinity;
      if (this.root) this.root.hidden = !open;
    }
    if (!open) return;
    const t = this.now();
    if (t - this.last < REFRESH_MS) return;
    this.last = t;
    const text = heronLiquidNoteText(this.read());
    if (text === this.text && this.root) return;
    this.text = text;
    if (typeof document === 'undefined') return;
    if (!this.root) this.mount();
    this.root!.hidden = false;
    this.root!.textContent = text;
  }

  private mount(): void {
    const root = document.createElement('div');
    root.id = 'heron-liquid-note';
    root.setAttribute('role', 'note');
    if (!document.getElementById('heron-liquid-note-styles')) {
      const styles = document.createElement('style');
      styles.id = 'heron-liquid-note-styles';
      styles.textContent = `
        /* Bottom-left, above #corner-bl's mode label — where the MHD bench puts its card. */
        #heron-liquid-note {
          position: absolute; left: 12px; bottom: 34px; z-index: 5; max-width: 340px;
          background: rgba(2, 10, 18, 0.88); border: 1px solid #0ff3; border-radius: 5px;
          padding: 5px 8px; pointer-events: none;
          font-size: 0.62rem; color: #9fb4c8; line-height: 1.35;
        }
        #heron-liquid-note[hidden] { display: none; }
      `;
      document.head.appendChild(styles);
    }
    (document.getElementById('canvas-wrapper') ?? document.body).appendChild(root);
    this.root = root;
  }

  dispose(): void {
    this.unsubscribe();
    this.root?.remove();
    this.root = null;
    this.active = false;
  }
}

export function initHeronLiquidNote(opts: HeronLiquidNoteOptions = {}): HeronLiquidNote {
  const note = new HeronLiquidNote(opts);
  if (typeof window !== 'undefined') window.heronLiquidNote = note;
  return note;
}
