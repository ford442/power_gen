/**
 * MHD velocity-profile overlay — both renderers, MHD focus only.
 *
 * The duct's parcels already bend into the Hartmann profile
 * (devices/core/mhd-parcels.ts); this card is the same solution as a graph,
 * with the comparison the parcels cannot show at once: the live profile at the
 * plant's Hartmann number beside the parabola the same duct would have at
 * B = 0. Raise the field and the solid curve flattens away from the dashed
 * one.
 *
 * A readout, not a render path: one 2D canvas, redrawn when the plant's Ha or
 * mean speed moves, driven by TelemetryHub. Nothing is solved here — the curve
 * is the analytic steady solution (physics/hartmann.ts) evaluated at the
 * plant's `mhdHartmann`, so it is exact for the model and says nothing about
 * entry length, side walls or turbulence.
 */
import { MHD } from '../generated/physics-constants';
import { hartmannCentre, hartmannLayerFraction, hartmannProfile } from './physics/hartmann';
import { telemetryHub } from './telemetry-hub';
import type { TelemetrySnapshot } from './telemetry/types';

/** Bench whose focus view shows the card. */
export const MHD_PROFILE_OWNER = 'mhd';

/** CSS pixels. */
const PLOT_W = 208;
const PLOT_H = 148;
/** Samples across the gap; 65 puts three on a Hartmann layer at Ha = 20. */
const SAMPLES = 65;
/** u/Ū at the right edge of the plot: the Poiseuille peak is 1.5. */
const U_AXIS_MAX = 1.6;
const PAD = { left: 30, right: 8, top: 8, bottom: 22 };

export interface MhdProfileCurves {
  /** η = y/a, −1 … 1. */
  eta: Float64Array;
  /** u/Ū at the plant's Ha. */
  live: Float64Array;
  /** u/Ū at Ha = 0 — the B = 0 parabola. */
  parabola: Float64Array;
  hartmann: number;
  /** u(0)/Ū. */
  centre: number;
  /** Hartmann-layer thickness a/Ha, metres. */
  layerM: number;
}

/** The two curves the card draws, for a Hartmann number. Pure. */
export function mhdProfileCurves(hartmann: number, samples = SAMPLES): MhdProfileCurves {
  const ha = Number.isFinite(hartmann) ? Math.abs(hartmann) : 0;
  const eta = new Float64Array(samples);
  const live = new Float64Array(samples);
  const parabola = new Float64Array(samples);
  for (let i = 0; i < samples; i++) {
    const e = samples > 1 ? -1 + (2 * i) / (samples - 1) : 0;
    eta[i] = e;
    live[i] = hartmannProfile(e, ha);
    parabola[i] = hartmannProfile(e, 0);
  }
  return {
    eta,
    live,
    parabola,
    hartmann: ha,
    centre: hartmannCentre(ha),
    layerM: hartmannLayerFraction(ha) * MHD.halfGapM
  };
}

/** One-line reading of the card, also its accessible label. */
export function mhdProfileSummary(c: MhdProfileCurves, flowU: number): string {
  const layerUm = c.layerM * 1e6;
  const layer = c.hartmann > 1
    ? `Hartmann layer ${layerUm >= 100 ? layerUm.toFixed(0) : layerUm.toFixed(1)} µm`
    : 'no distinct Hartmann layer';
  return `Ha ${c.hartmann.toFixed(1)}: centre speed ${c.centre.toFixed(2)} × the mean ${flowU.toFixed(2)} m/s `
    + `(1.50 × at B = 0), ${layer}`;
}

/** Plot-space x for u/Ū and y for η. */
export function mhdProfilePlotPoint(uOverMean: number, eta: number, w = PLOT_W, h = PLOT_H): [number, number] {
  const x = PAD.left + (Math.max(0, uOverMean) / U_AXIS_MAX) * (w - PAD.left - PAD.right);
  const y = PAD.top + ((1 - eta) / 2) * (h - PAD.top - PAD.bottom);
  return [x, y];
}

function trace(ctx: CanvasRenderingContext2D, eta: Float64Array, u: Float64Array): void {
  ctx.beginPath();
  for (let i = 0; i < eta.length; i++) {
    const [x, y] = mhdProfilePlotPoint(u[i], eta[i]);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
}

/** Paint the card's canvas (CSS-pixel coordinates; the caller scales for DPR). */
export function drawMhdProfile(ctx: CanvasRenderingContext2D, c: MhdProfileCurves): void {
  const w = PLOT_W;
  const h = PLOT_H;
  ctx.clearRect(0, 0, w, h);
  const [x0, yTop] = mhdProfilePlotPoint(0, 1);
  const [xMax, yBot] = mhdProfilePlotPoint(U_AXIS_MAX, -1);

  // Walls (the Hartmann walls, y = ±a) and the mean-speed line.
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#6a7f96';
  ctx.beginPath();
  ctx.moveTo(x0, yTop); ctx.lineTo(xMax, yTop);
  ctx.moveTo(x0, yBot); ctx.lineTo(xMax, yBot);
  ctx.moveTo(x0, yTop); ctx.lineTo(x0, yBot);
  ctx.stroke();
  const [xMean] = mhdProfilePlotPoint(1, 0);
  ctx.strokeStyle = '#2c3e52';
  ctx.beginPath();
  ctx.moveTo(xMean, yTop); ctx.lineTo(xMean, yBot);
  ctx.stroke();

  // B = 0 parabola, dashed.
  ctx.setLineDash([4, 3]);
  ctx.strokeStyle = '#9aa7b6';
  ctx.lineWidth = 1.25;
  trace(ctx, c.eta, c.parabola);
  ctx.stroke();
  ctx.setLineDash([]);

  // Live profile: filled to the axis, then stroked.
  trace(ctx, c.eta, c.live);
  ctx.lineTo(x0, yBot);
  ctx.lineTo(x0, yTop);
  ctx.closePath();
  ctx.fillStyle = 'rgba(64, 200, 255, 0.16)';
  ctx.fill();
  ctx.strokeStyle = '#4fd0ff';
  ctx.lineWidth = 2;
  trace(ctx, c.eta, c.live);
  ctx.stroke();

  // Axis labels.
  ctx.fillStyle = '#8fa3b8';
  ctx.font = '9px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  ctx.fillText('+a', x0 - 4, yTop);
  ctx.fillText('0', x0 - 4, (yTop + yBot) / 2);
  ctx.fillText('−a', x0 - 4, yBot);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText('0', x0, yBot + 4);
  ctx.fillText('Ū', xMean, yBot + 4);
  const [x15] = mhdProfilePlotPoint(1.5, 0);
  ctx.fillText('1.5 Ū', x15, yBot + 4);
}

export interface MhdProfileOverlayOptions {
  /** Test seam: override the hub subscription. */
  subscribe?: (fn: (snap: TelemetrySnapshot) => void) => () => void;
}

export class MhdProfileOverlay {
  /** True while the card is on screen. */
  active = false;
  private root: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private readout: HTMLElement | null = null;
  private unsubscribe: (() => void) | null = null;
  private curves: MhdProfileCurves = mhdProfileCurves(0);
  private flowU = 0;
  private drawnHa = Number.NaN;
  private drawnU = Number.NaN;
  private draws = 0;

  constructor(opts: MhdProfileOverlayOptions = {}) {
    const subscribe = opts.subscribe ?? ((fn) => telemetryHub.subscribe(fn));
    this.unsubscribe = subscribe((snap) => this.onSnapshot(snap));
  }

  private onSnapshot(snap: TelemetrySnapshot): void {
    const open = snap.view === MHD_PROFILE_OWNER;
    if (open !== this.active) {
      if (open) this.show();
      else this.hide();
    }
    if (!open) return;
    const d = snap.devices?.[MHD_PROFILE_OWNER];
    const ha = d?.mhdHartmann ?? 0;
    const u = d?.mhdFlowU ?? 0;
    // Redraw only when the picture would change: Ha to 0.01, speed to 1 cm/s.
    if (Math.abs(ha - this.drawnHa) < 0.01 && Math.abs(u - this.drawnU) < 0.01) return;
    this.update(ha, u);
  }

  /** Set the plotted state and repaint. Exposed for tests and the console. */
  update(hartmann: number, flowU: number): void {
    this.curves = mhdProfileCurves(hartmann);
    this.flowU = Number.isFinite(flowU) ? flowU : 0;
    this.drawnHa = hartmann;
    this.drawnU = flowU;
    if (this.ctx) {
      drawMhdProfile(this.ctx, this.curves);
      this.draws++;
    }
    const summary = mhdProfileSummary(this.curves, this.flowU);
    if (this.readout) {
      this.readout.textContent = `Ha ${this.curves.hartmann.toFixed(1)} · u₀ = ${this.curves.centre.toFixed(2)} Ū`
        + ` · Ū = ${this.flowU.toFixed(2)} m/s`;
    }
    this.canvas?.setAttribute('aria-label', `Velocity profile across the duct gap. ${summary}.`);
  }

  private show(): void {
    if (typeof document === 'undefined') return;
    if (!this.root) this.mount();
    if (this.root) this.root.hidden = false;
    this.active = true;
    this.drawnHa = Number.NaN;
  }

  private hide(): void {
    this.active = false;
    if (this.root) this.root.hidden = true;
  }

  private mount(): void {
    const root = document.createElement('div');
    root.id = 'mhd-profile-overlay';
    root.hidden = true;
    root.innerHTML = `
      <div class="mhd-profile-title">Velocity profile across the gap</div>
      <canvas class="mhd-profile-canvas" role="img"></canvas>
      <div class="mhd-profile-readout"></div>
      <div class="mhd-profile-legend">
        <span class="mhd-profile-key mhd-profile-key-live"></span>now
        <span class="mhd-profile-key mhd-profile-key-ref"></span>B = 0 (parabola)
      </div>
      <div class="mhd-profile-note">Analytic Hartmann solution, laminar, fully developed · simulated, not a measurement</div>
    `;
    if (!document.getElementById('mhd-profile-styles')) {
      const styles = document.createElement('style');
      styles.id = 'mhd-profile-styles';
      styles.textContent = `
        /* Bottom-left, above #corner-bl's mode label — the tachometer owns bottom-right. */
        #mhd-profile-overlay {
          position: absolute; left: 12px; bottom: 34px; z-index: 5;
          background: rgba(2, 10, 18, 0.88); border: 1px solid #0ff3;
          border-radius: 5px; padding: 6px 8px 5px;
          /* A readout, not a control: never eat a camera drag. */
          pointer-events: none;
          font-size: 0.62rem; color: #9fb4c8; line-height: 1.35;
        }
        #mhd-profile-overlay[hidden] { display: none; }
        .mhd-profile-title { color: #9cf; margin-bottom: 4px; letter-spacing: 0.04em; }
        .mhd-profile-canvas { display: block; width: ${PLOT_W}px; height: ${PLOT_H}px; }
        .mhd-profile-readout { margin-top: 3px; color: #cfe3f5; font-variant-numeric: tabular-nums; }
        .mhd-profile-legend { margin-top: 2px; display: flex; align-items: center; gap: 5px; }
        .mhd-profile-key { display: inline-block; width: 16px; height: 0; border-top: 2px solid #4fd0ff; }
        .mhd-profile-key-ref { border-top: 1.25px dashed #9aa7b6; margin-left: 8px; }
        .mhd-profile-note { margin-top: 3px; color: #6f8296; max-width: ${PLOT_W}px; }
      `;
      document.head.appendChild(styles);
    }
    (document.getElementById('canvas-wrapper') ?? document.body).appendChild(root);

    this.root = root;
    this.readout = root.querySelector<HTMLElement>('.mhd-profile-readout');
    this.canvas = root.querySelector<HTMLCanvasElement>('.mhd-profile-canvas');
    if (this.canvas) {
      const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
      this.canvas.width = Math.round(PLOT_W * dpr);
      this.canvas.height = Math.round(PLOT_H * dpr);
      this.ctx = this.canvas.getContext('2d');
      this.ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  /**
   * Agent / e2e hook: enough to tell "the card is up and tracks the plant"
   * from "a blank rectangle", without reading pixels.
   */
  stats(): { active: boolean; hartmann: number; centre: number; flowU: number; draws: number } {
    return {
      active: this.active,
      hartmann: this.curves.hartmann,
      centre: this.curves.centre,
      flowU: this.flowU,
      draws: this.draws
    };
  }

  destroy(): void {
    this.hide();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.root?.remove();
    this.root = null;
    this.canvas = null;
    this.ctx = null;
    this.readout = null;
  }
}

/** Install the card. Hidden, and costing one hub subscription, until MHD is focused. */
export function initMhdProfileOverlay(opts: MhdProfileOverlayOptions = {}): MhdProfileOverlay {
  const overlay = new MhdProfileOverlay(opts);
  if (typeof window !== 'undefined') window.mhdProfileOverlay = overlay;
  return overlay;
}
