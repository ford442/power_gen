/**
 * Analysis panel → Twin view (#257 §2–3) — live, not a recorded run:
 *
 *   1. normalised innovation ν/σ_ν per channel, with the ±3 band;
 *   2. RPM: reading, estimate and its ±3σ band (uPlot band series);
 *   3. coil current: the same;
 *   4. χ² window NIS/dof inside its two-sided 95 % band;
 *
 * plus the (ω, I) 3σ covariance ellipse and the last calibration's cost
 * curve and fitted parameters. Polls the session twin at 5 Hz while shown.
 * Simulated, not metrology: the bands are this model's uncertainty.
 */
import uPlot from 'uplot';
import { TWIN_RIG } from '../../generated/twin-rig';
import { covarianceEllipse } from '../twin/readout';
import { profileWarnings } from '../twin/profile';
import type { SessionTwin } from '../twin/session-twin';
import type { TwinHistoryKey } from '../twin/estimator-host';

const COLORS = ['#3987e5', '#d95926', '#199e70'];
const BAND = 'rgba(57, 135, 229, 0.18)';
const OK_BAND = 'rgba(25, 158, 112, 0.16)';
const AXIS_INK = '#9fbcc4';
const GRID = 'rgba(159, 188, 196, 0.12)';
const SYNC = 'seg-twin';

interface StripSpec {
  title: string;
  /** Data columns, in order; `hi` / `lo` entries form a band (index pairs below). */
  columns: Array<{ label: string; get: (h: Cols) => number[]; color?: string; band?: boolean; points?: boolean }>;
  bands: Array<[number, number, string]>;
}

type Cols = Record<TwinHistoryKey, number[]>;

const plus = (a: number[], b: number[], k: number): number[] => a.map((v, i) => v + k * b[i]);

const STRIPS: StripSpec[] = [
  {
    title: 'ν/σ (inside ±3 ⇒ consistent)',
    columns: [
      { label: '+3', get: (h) => h.t.map(() => 3), band: true },
      { label: '−3', get: (h) => h.t.map(() => -3), band: true },
      { label: 'RPM', get: (h) => h.nuNormRpm, color: COLORS[0] },
      { label: 'I', get: (h) => h.nuNormI, color: COLORS[1] },
      { label: 'V', get: (h) => h.nuNormV, color: COLORS[2] }
    ],
    bands: [[1, 2, OK_BAND]]
  },
  {
    title: 'RPM — reading, estimate ± 3σ',
    columns: [
      { label: '+3σ', get: (h) => plus(h.estRpm, h.estSdRpm, 3), band: true },
      { label: '−3σ', get: (h) => plus(h.estRpm, h.estSdRpm, -3), band: true },
      { label: 'reading', get: (h) => h.zRpm, color: COLORS[1], points: true },
      { label: 'estimate', get: (h) => h.estRpm, color: COLORS[0] }
    ],
    bands: [[1, 2, BAND]]
  },
  {
    title: 'Coil current (A) — reading, estimate ± 3σ',
    columns: [
      { label: '+3σ', get: (h) => plus(h.estI, h.estSdI, 3), band: true },
      { label: '−3σ', get: (h) => plus(h.estI, h.estSdI, -3), band: true },
      { label: 'reading', get: (h) => h.zI, color: COLORS[1], points: true },
      { label: 'estimate', get: (h) => h.estI, color: COLORS[0] }
    ],
    bands: [[1, 2, BAND]]
  },
  {
    title: 'NIS / dof — χ² window (95 % band)',
    columns: [
      { label: 'hi', get: (h) => h.chi2HiPerDof, band: true },
      { label: 'lo', get: (h) => h.chi2LoPerDof, band: true },
      { label: 'NIS/dof', get: (h) => h.nisPerDof, color: COLORS[2] }
    ],
    bands: [[1, 2, OK_BAND]]
  }
];

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), props);
}

export class TwinAnalysisView {
  // Own class names: the run view's `.analysis-notes` / `.analysis-meta` /
  // `.analysis-plots` are looked up by selector (and by the E2E), and this
  // view sits before them in the panel.
  readonly el = h('div', { className: 'analysis-twin', hidden: true });
  private readonly plotsEl = h('div', { className: 'analysis-twin-plots' });
  private readonly statusEl = h('p', { className: 'analysis-twin-status' });
  // Own class: the dashboard's global `canvas { width: 100% }` would stretch them.
  private readonly ellipse = h('canvas', { width: 220, height: 160, className: 'analysis-twin-canvas' });
  private readonly cost = h('canvas', { width: 300, height: 160, className: 'analysis-twin-canvas' });
  private readonly fitEl = h('ul', { className: 'analysis-twin-fit' });
  private plots: uPlot[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly twin: () => SessionTwin | null) {
    this.statusEl.setAttribute('role', 'status');
    this.ellipse.setAttribute('aria-label', '3σ covariance ellipse of the rotor speed and coil current estimate');
    this.cost.setAttribute('aria-label', 'Calibration cost per Levenberg–Marquardt iteration (log scale)');
    const side = h('div', { className: 'analysis-row' });
    side.append(this.ellipse, this.cost);
    this.el.append(this.statusEl, this.plotsEl, side, this.fitEl);
  }

  start(): void {
    this.el.hidden = false;
    this.stop();
    this.refresh();
    this.timer = setInterval(() => this.refresh(), 200);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    for (const p of this.plots) p.destroy();
    this.plots = [];
    this.plotsEl.replaceChildren();
  }

  hide(): void {
    this.stop();
    this.el.hidden = true;
  }

  private refresh(): void {
    const twin = this.twin();
    const host = twin?.host;
    if (!twin || !host || host.historyCount < 2) {
      this.statusEl.textContent = twin?.state === 'needs-wasm' || twin?.state === 'error'
        ? twin.message
        : 'No estimator samples yet — connect the rig (or Mock) in the Hardware Twin panel.';
      this.drawCost(twin);
      return;
    }
    const cols = Object.fromEntries((['t', 'zRpm', 'estRpm', 'estSdRpm', 'zI', 'estI', 'estSdI', 'nuNormRpm', 'nuNormI', 'nuNormV', 'nisPerDof', 'chi2LoPerDof', 'chi2HiPerDof'] as TwinHistoryKey[])
      .map((k) => [k, host.historyColumn(k)])) as Cols;
    const t0 = cols.t[cols.t.length - 1];
    const x = cols.t.map((t) => t - t0);
    const w = host.estimate.window;
    this.statusEl.textContent = `${w.diagnosis} · ${twin.profile ? 'calibrated profile' : 'catalog nominal'} · last ${(-x[0]).toFixed(1)} s · board clock ${twin.calibration.phase === 'idle' ? '' : `· calibration ${twin.calibration.phase}`}`;
    const width = Math.max(260, this.plotsEl.clientWidth || 600);
    if (this.plots.length !== STRIPS.length) {
      for (const p of this.plots) p.destroy();
      this.plotsEl.replaceChildren();
      this.plots = STRIPS.map((s, i) => this.makePlot(s, width, i === STRIPS.length - 1));
    }
    STRIPS.forEach((s, i) => {
      this.plots[i].setData([x, ...s.columns.map((c) => c.get(cols))] as uPlot.AlignedData);
    });
    this.drawEllipse(host.estimate.P);
    this.drawCost(twin);
  }

  private makePlot(s: StripSpec, width: number, last: boolean): uPlot {
    const host = h('div');
    this.plotsEl.append(host);
    const axis = (label?: string): uPlot.Axis => ({ stroke: AXIS_INK, grid: { stroke: GRID, width: 1 }, ticks: { stroke: GRID, width: 1 }, label, labelSize: label ? 22 : 0 });
    const opts: uPlot.Options = {
      title: s.title,
      width,
      height: 130,
      scales: { x: { time: false } },
      cursor: { sync: { key: SYNC } },
      legend: { show: true, live: false },
      axes: [axis(last ? 't (s, 0 = now)' : undefined), { ...axis(), size: 56 }],
      series: [
        { label: 't' },
        ...s.columns.map((c): uPlot.Series => ({
          label: c.label,
          stroke: c.band ? 'transparent' : c.color,
          width: c.band ? 0 : 1.5,
          show: true,
          spanGaps: false,
          paths: c.points ? () => null : undefined,
          points: c.points ? { show: true, size: 3, stroke: c.color, fill: c.color } : { show: false }
        }))
      ],
      bands: s.bands.map(([a, b, fill]) => ({ series: [a, b], fill }))
    };
    return new uPlot(opts, [[], ...s.columns.map(() => [])] as unknown as uPlot.AlignedData, host);
  }

  private drawEllipse(P: readonly number[]): void {
    const ctx = this.ellipse.getContext('2d');
    if (!ctx) return;
    const W = this.ellipse.width, H = this.ellipse.height;
    ctx.clearRect(0, 0, W, H);
    const rpmPer = 30 / Math.PI;
    // In display units: ω → RPM; the ellipse in each axis' own σ scale.
    const Pd = [P[0] * rpmPer * rpmPer, P[1] * rpmPer, P[2] * rpmPer, P[3]];
    const sx = 3 * Math.sqrt(Math.max(1e-30, Pd[0])), sy = 3 * Math.sqrt(Math.max(1e-30, Pd[3]));
    const norm = [Pd[0] / (sx * sx), Pd[1] / (sx * sy), Pd[2] / (sx * sy), Pd[3] / (sy * sy)];
    const e = covarianceEllipse(norm, 3);
    const scale = (Math.min(W, H) * 0.38) / Math.max(e.a, 1e-9);
    ctx.strokeStyle = GRID;
    ctx.beginPath();
    ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H);
    ctx.stroke();
    ctx.strokeStyle = COLORS[0];
    ctx.fillStyle = BAND;
    ctx.beginPath();
    ctx.ellipse(W / 2, H / 2, e.a * scale, e.b * scale, -e.angle, 0, 2 * Math.PI);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = AXIS_INK;
    ctx.font = '10px monospace';
    const rho = P[1] / Math.sqrt(Math.max(1e-30, P[0] * P[3]));
    ctx.fillText(`3σ (ω, I), ρ ${rho.toFixed(2)}`, 4, 12);
    ctx.fillText(`±${sx.toFixed(2)} RPM, ±${sy.toFixed(4)} A`, 4, H - 5);
  }

  private drawCost(twin: SessionTwin | null): void {
    const ctx = this.cost.getContext('2d');
    if (!ctx) return;
    const W = this.cost.width, H = this.cost.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = AXIS_INK;
    ctx.font = '10px monospace';
    const c = twin?.calibration;
    const hist = (c?.costHistory ?? []).filter((v) => v > 0 && Number.isFinite(v));
    if (hist.length < 2) {
      ctx.fillText(c?.phase === 'exciting' ? `calibration run ${(c.progress * 100).toFixed(0)} %` : 'Calibrate → cost per LM iteration', 4, 12);
    } else {
      const logs = hist.map((v) => Math.log10(v));
      const lo = Math.min(...logs), hi = Math.max(...logs);
      ctx.strokeStyle = COLORS[2];
      ctx.beginPath();
      logs.forEach((v, i) => {
        const px = 30 + (i / (logs.length - 1)) * (W - 40);
        const py = H - 18 - ((v - lo) / Math.max(1e-9, hi - lo)) * (H - 36);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      });
      ctx.stroke();
      ctx.fillText(`cost (χ²/2, log): 10^${hi.toFixed(1)} → 10^${lo.toFixed(1)} in ${logs.length - 1} iterations`, 4, 12);
    }
    const p = twin?.profile;
    const items: string[] = [];
    if (p) {
      TWIN_RIG.params.forEach((s, i) => items.push(`${s.label} = ${p.theta[i].toPrecision(4)} ${s.unit} ± ${(100 * p.relSigma[i]).toFixed(1)} % (catalog ${s.nominal})`));
      items.push(`R² ${TWIN_RIG.sensors.map((s, i) => `${s.label} ${Number.isFinite(p.r2[i]) ? p.r2[i].toFixed(4) : '—'}`).join(', ')} · χ²_red ${p.reducedChi2.toFixed(2)}`);
      items.push(...profileWarnings(p.warnings).map((w) => `⚠ ${w}`));
    }
    this.fitEl.replaceChildren(...items.map((t) => h('li', { textContent: t })));
  }
}
