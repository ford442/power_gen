/**
 * Hardware Twin panel → "Estimator" section (#257): the EKF's verdict, the
 * normalised innovation per channel, the filtered state, Q / R multipliers,
 * and the one-click Calibrate with its profile status. Mounted by
 * hardware-panel.ts under the sensor stream; repainted on its 10 Hz tick.
 *
 * Reads the session twin (twin/session-twin.ts); the only thing it can make
 * the rig do is start a calibration run, which goes through the bridge.
 */
import { TWIN_RIG } from '../../generated/twin-rig';
import type { SessionTwin } from './session-twin';
import { profileWarnings } from './profile';

const DIAGNOSIS_TEXT: Record<string, string> = {
  idle: 'filling χ² window…',
  consistent: 'consistent — residual inside the 3σ band',
  'sensor-noisy': 'sensor noisy — white but large innovations (raise R)',
  'model-mismatch': 'model mismatch — biased / correlated innovations (Calibrate)',
  overcautious: 'overcautious — innovations smaller than Q/R predict (lower Q or R)'
};

const fmtSigned = (v: number, d = 2): string => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(d)}` : '—');

/** Log slider position (−3…3) ↔ multiplier 10^p. */
const toScale = (pos: number): number => 10 ** pos;
const toPos = (scale: number): number => Math.log10(scale);

export class TwinPanelSection {
  readonly el: HTMLElement;
  private readonly q: HTMLInputElement;
  private readonly r: HTMLInputElement;
  private readonly calibrateBtn: HTMLButtonElement;

  constructor(private readonly twin: () => SessionTwin | null) {
    const el = document.createElement('div');
    el.className = 'hw-twin-est';
    el.id = 'hwTwinEstimator';
    el.innerHTML = `
      <div class="ctrl-section-title" style="margin-top:10px">Estimator</div>
      <div class="hw-est-verdict" id="hwEstVerdict" role="status">off</div>
      <div class="hw-est-gauge" aria-hidden="true"><span class="hw-est-band"></span><span class="hw-est-mark" id="hwEstMark"></span></div>
      <div class="hw-stream">
        <div><span class="hw-k">ν/σ RPM</span> <span id="hwNuRpm">—</span></div>
        <div><span class="hw-k">ν/σ I</span> <span id="hwNuI">—</span></div>
        <div><span class="hw-k">ν/σ V</span> <span id="hwNuV">—</span></div>
        <div><span class="hw-k">NIS/dof</span> <span id="hwNis">—</span></div>
        <div><span class="hw-k">ω̂</span> <span id="hwEstRpm">—</span> RPM</div>
        <div><span class="hw-k">Î</span> <span id="hwEstI">—</span> A</div>
      </div>
      <label class="hw-est-slider">Q × <output id="hwQOut">1</output>
        <input type="range" id="hwQ" min="-3" max="3" step="0.1" value="0" aria-label="Process noise multiplier (log scale)"></label>
      <label class="hw-est-slider">R × <output id="hwROut">1</output>
        <input type="range" id="hwR" min="-3" max="3" step="0.1" value="0" aria-label="Sensor noise multiplier (log scale)"></label>
      <div class="hw-btn-row">
        <button type="button" class="seg-op-btn" id="hwCalibrateBtn" title="Fit inertia, friction, coil R/L and k_e to the recorded run (drives a 30 s staircase first if the run is too quiet)">Calibrate</button>
        <button type="button" class="seg-op-btn" id="hwNominalBtn" title="Forget the profile: catalog nominal parameters">Nominal</button>
        <button type="button" class="seg-op-btn" id="hwTwinPlotsBtn" title="Innovation and estimate with 3σ bands, covariance ellipse, fit cost curve">Plots</button>
      </div>
      <div class="hw-est-profile" id="hwProfile"></div>
      <p class="hw-hint">Simulated, not metrology: the twin fits a lumped model (catalog <code>seg.twin</code>) to this rig.</p>`;
    this.el = el;
    this.q = el.querySelector('#hwQ')!;
    this.r = el.querySelector('#hwR')!;
    this.calibrateBtn = el.querySelector('#hwCalibrateBtn')!;
  }

  wire(signal: AbortSignal): void {
    const onSlide = (): void => {
      this.twin()?.setNoiseScale(toScale(Number(this.q.value)), toScale(Number(this.r.value)));
    };
    this.q.addEventListener('input', onSlide, { signal });
    this.r.addEventListener('input', onSlide, { signal });
    this.calibrateBtn.addEventListener('click', () => { void this.twin()?.calibrate(); }, { signal });
    this.el.querySelector('#hwNominalBtn')?.addEventListener('click', () => {
      this.twin()?.applyProfile(null, { persist: true });
    }, { signal });
    this.el.querySelector('#hwTwinPlotsBtn')?.addEventListener('click', () => {
      void import('../analysis/analysis-panel')
        .then((m) => m.openAnalysisPanel(undefined, { twin: true }))
        .catch((err: unknown) => console.warn('[twin] analysis panel failed to load', err));
    }, { signal });
  }

  render(): void {
    const twin = this.twin();
    const set = (id: string, text: string): void => {
      const n = this.el.querySelector<HTMLElement>(`#${id}`);
      if (n && n.textContent !== text) n.textContent = text;
    };
    const verdict = this.el.querySelector<HTMLElement>('#hwEstVerdict');
    const busy = twin?.calibration.phase === 'exciting' || twin?.calibration.phase === 'fitting';
    this.calibrateBtn.disabled = !twin || busy || twin.state !== 'ready';
    if (!twin || twin.state !== 'ready' || !twin.host || !(twin.host.estimate.updates > 0)) {
      set('hwEstVerdict', twin?.state === 'needs-wasm' || twin?.state === 'error' ? twin.message : twin?.state === 'loading' ? 'loading estimator…' : 'off — connect the rig or the mock');
      verdict?.setAttribute('data-diag', 'idle');
      set('hwProfile', this.profileText(twin));
      return;
    }
    const e = twin.host.estimate;
    const w = e.window;
    verdict?.setAttribute('data-diag', w.diagnosis);
    set('hwEstVerdict', DIAGNOSIS_TEXT[w.diagnosis] ?? w.diagnosis);
    set('hwNuRpm', fmtSigned(e.nu[0] / e.nuSigma[0]));
    set('hwNuI', fmtSigned(e.nu[1] / e.nuSigma[1]));
    set('hwNuV', fmtSigned(e.nu[2] / e.nuSigma[2]));
    const perDof = w.dof > 0 ? 1 / w.dof : NaN;
    const nis = w.nis * perDof;
    set('hwNis', Number.isFinite(nis) ? `${nis.toFixed(2)} [${(w.lo * perDof).toFixed(2)}–${(w.hi * perDof).toFixed(2)}]` : '—');
    const rpmPer = 30 / Math.PI;
    set('hwEstRpm', `${(e.x[0] * rpmPer).toFixed(1)} ± ${(3 * Math.sqrt(Math.max(0, e.P[0])) * rpmPer).toFixed(1)}`);
    set('hwEstI', `${e.x[1].toFixed(3)} ± ${(3 * Math.sqrt(Math.max(0, e.P[3]))).toFixed(3)}`);
    // Gauge: log₁₀(NIS/dof) over ±1.5 decades, band = the χ² window's 95 % bounds.
    const pos = (v: number): number => Math.max(0, Math.min(100, 50 + (Math.log10(Math.max(1e-3, v)) / 1.5) * 50));
    const band = this.el.querySelector<HTMLElement>('.hw-est-band');
    const mark = this.el.querySelector<HTMLElement>('#hwEstMark');
    if (band && Number.isFinite(perDof)) {
      const lo = pos(w.lo * perDof), hi = pos(w.hi * perDof);
      band.style.left = `${lo}%`;
      band.style.width = `${Math.max(1, hi - lo)}%`;
    }
    if (mark && Number.isFinite(nis)) mark.style.left = `${pos(nis)}%`;
    const { q, r } = twin.noiseScale;
    set('hwQOut', q.toPrecision(2));
    set('hwROut', r.toPrecision(2));
    if (document.activeElement !== this.q) this.q.value = String(toPos(q));
    if (document.activeElement !== this.r) this.r.value = String(toPos(r));
    set('hwProfile', this.profileText(twin));
  }

  private profileText(twin: SessionTwin | null): string {
    if (!twin) return '';
    const c = twin.calibration;
    if (c.phase === 'exciting') return `Calibration run ${(c.progress * 100).toFixed(0)} % — ${c.message}`;
    if (c.phase === 'fitting') return `Fitting… iteration ${c.progress}${c.costHistory.length ? `, cost ${c.costHistory[c.costHistory.length - 1].toPrecision(4)}` : ''}`;
    const lines: string[] = [];
    if (c.phase === 'failed') lines.push(c.message);
    if (twin.profileError) lines.push(`profile refused: ${twin.profileError}`);
    const p = twin.profile;
    if (!p) {
      lines.push('Parameters: catalog nominal (no calibration profile).');
      return lines.join(' · ');
    }
    const params = TWIN_RIG.params.map((s, i) => `${s.label} ${p.theta[i].toPrecision(3)} ±${(100 * p.relSigma[i]).toFixed(1)} %`).join(', ');
    const r2 = TWIN_RIG.sensors.map((s, i) => (Number.isFinite(p.r2[i]) ? `${s.label} ${p.r2[i].toFixed(3)}` : null)).filter(Boolean).join(', ');
    lines.push(`Calibrated (${p.durationS.toFixed(0)} s run): ${params}. R² ${r2}.`);
    lines.push(...profileWarnings(p.warnings).map((w) => `⚠ ${w}`));
    if (c.phase === 'done') lines.push(c.message);
    return lines.join(' · ');
  }
}

export const TWIN_SECTION_CSS = `
  .hw-est-verdict { color: #9cf; margin: 4px 0; font-size: 0.7rem; }
  .hw-est-verdict[data-diag="consistent"] { color: #0f8; }
  .hw-est-verdict[data-diag="model-mismatch"] { color: #fa0; }
  .hw-est-verdict[data-diag="sensor-noisy"], .hw-est-verdict[data-diag="overcautious"] { color: #fc6; }
  .hw-est-gauge { position: relative; height: 8px; background: #061018; border: 1px solid #0ff2; border-radius: 4px; margin: 4px 0 6px; }
  .hw-est-band { position: absolute; top: 0; bottom: 0; background: #0f83; }
  .hw-est-mark { position: absolute; top: -2px; width: 2px; height: 10px; background: #fff; }
  .hw-est-slider { display: flex; align-items: center; gap: 6px; margin: 4px 0; }
  .hw-est-slider input { flex: 1; }
  .hw-est-profile { color: #9ab; font-size: 0.65rem; line-height: 1.35; margin-top: 4px; }
`;
