/**
 * Twin residual time-series. In estimate mode with the estimator running
 * (#257) it plots the *normalised innovation* ν/σ_ν per channel (RPM, I, V)
 * against the ±3 band, and the header gives the χ² window verdict — so "model
 * wrong" (a biased / drifting trace) and "sensor noisy" (white, wide) read
 * differently. Otherwise it plots the raw sim − hardware ΔRPM, ΔV, ΔI.
 * Data from TelemetryHub.hardwareTwin.{estimate, shadowResidual}.
 */

import type { HardwareTwinTelemetry } from '../../telemetry/types';

const HISTORY = 90;

function finite(n: number | undefined, fallback: number = 0): number {
  return Number.isFinite(n) ? (n as number) : fallback;
}

type ConnectionState = HardwareTwinTelemetry['connectionState'];

export class ShadowResidualGauge {
  container: HTMLElement;
  historyRpm: number[];
  historyV: number[];
  historyI: number[];
  connected: boolean;
  connectionState: ConnectionState;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  rpmEl: HTMLElement | null;
  vEl: HTMLElement | null;
  iEl: HTMLElement | null;
  stateEl: HTMLElement | null;
  width: number = 0;
  height: number = 0;
  /** Plotting ν/σ_ν (fixed ±3 band) rather than raw residuals. */
  normalized = false;
  private labelEl: HTMLElement | null = null;

  constructor(containerId: string) {
    this.container = document.getElementById(containerId) as HTMLElement;
    this.historyRpm = new Array(HISTORY).fill(0);
    this.historyV = new Array(HISTORY).fill(0);
    this.historyI = new Array(HISTORY).fill(0);
    this.connected = false;
    this.connectionState = 'disconnected';
    this.render();
    this.canvas = this.container.querySelector('canvas')!;
    this.ctx = this.canvas.getContext('2d')!;
    this.rpmEl = this.container.querySelector('[data-res="rpm"]');
    this.vEl = this.container.querySelector('[data-res="v"]');
    this.iEl = this.container.querySelector('[data-res="i"]');
    this.stateEl = this.container.querySelector('[data-state]');
    this.labelEl = this.container.querySelector('.sci-gauge-label');
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize(): void {
    const rect = this.canvas.parentElement!.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, rect.width * dpr);
    this.canvas.height = Math.max(1, rect.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.width = rect.width;
    this.height = rect.height;
    this.draw();
  }

  render(): void {
    this.container.innerHTML = `
      <div class="sci-gauge-header">
        <span class="sci-gauge-label">Shadow Twin Residual</span>
        <span class="sci-gauge-value" data-state>off</span>
      </div>
      <div class="sci-gauge-container sci-shadow-residual">
        <div class="sci-shadow-residual-readouts">
          <span>ΔRPM <b data-res="rpm">—</b></span>
          <span>ΔV <b data-res="v">—</b></span>
          <span>ΔI <b data-res="i">—</b></span>
        </div>
        <div class="sci-flux-sparkline sci-shadow-sparkline">
          <canvas></canvas>
        </div>
        <p class="sci-shadow-hint">Sim vs hardware — mock/serial. V/I residuals use plant telemetry; not metrology.</p>
      </div>
    `;
  }

  updateFromTwin(twin: HardwareTwinTelemetry | null): void {
    if (!twin?.connected) {
      this.connected = false;
      this.connectionState = 'disconnected';
      if (this.stateEl) {
        this.stateEl.textContent = 'off';
        this.stateEl.className = 'sci-gauge-value';
      }
      return;
    }

    this.connected = true;
    this.connectionState = twin.connectionState || (twin.mock ? 'mock' : 'serial');
    const est = twin.twinMode === 'estimate' ? twin.estimate : null;
    const normalized = !!est;
    if (normalized !== this.normalized) {
      this.normalized = normalized;
      this.historyRpm.fill(0);
      this.historyV.fill(0);
      this.historyI.fill(0);
      if (this.labelEl) this.labelEl.textContent = normalized ? 'Twin innovation ν/σ' : 'Shadow Twin Residual';
    }
    const r = twin.shadowResidual || ({} as HardwareTwinTelemetry['shadowResidual']);
    const rpmErr = est ? finite(est.innovation.rpm) : finite(r.rpmError);
    const vErr = est ? finite(est.innovation.voltage) : finite(r.voltageError);
    const iErr = est ? finite(est.innovation.current) : finite(r.currentError);

    this.historyRpm.push(rpmErr);
    this.historyV.push(vErr);
    this.historyI.push(iErr);
    this.historyRpm.shift();
    this.historyV.shift();
    this.historyI.shift();

    const sign = (v: number): string => (v >= 0 ? '+' : '');
    if (this.rpmEl) this.rpmEl.textContent = est ? `${sign(rpmErr)}${rpmErr.toFixed(2)}σ` : `${sign(rpmErr)}${rpmErr.toFixed(1)}`;
    if (this.vEl) this.vEl.textContent = est ? `${sign(vErr)}${vErr.toFixed(2)}σ` : `${sign(vErr)}${vErr.toFixed(2)} V`;
    if (this.iEl) this.iEl.textContent = est ? `${sign(iErr)}${iErr.toFixed(2)}σ` : `${sign(iErr)}${iErr.toFixed(2)} A`;

    if (this.stateEl) {
      const labels: Record<ConnectionState, string> = {
        mock: 'mock',
        serial: 'serial',
        bluetooth: 'BLE',
        usb: 'USB',
        disconnected: 'off'
      };
      const link = labels[this.connectionState] || this.connectionState;
      this.stateEl.textContent = est
        ? `${link} · χ²/dof ${est.nisPerDof.toFixed(2)} · ${est.diagnosis}`
        : link;
      // The mock is flagged (simulated rig); so is an inconsistent estimate.
      this.stateEl.className = 'sci-gauge-value'
        + (this.connectionState === 'mock' || (est && !est.consistent) ? ' warning' : '');
    }

    this.draw();
  }

  draw(): void {
    if (!this.ctx || !this.width) return;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width, this.height);

    if (!this.connected) {
      ctx.fillStyle = 'rgba(100,120,140,0.35)';
      ctx.font = '11px monospace';
      ctx.fillText('Connect mock or serial twin to chart residuals', 8, this.height * 0.55);
      return;
    }

    const series = [
      { data: this.historyRpm, color: '#fc6', scale: this.normalized ? 1 : 120 },
      { data: this.historyV, color: '#4af', scale: this.normalized ? 1 : 8 },
      { data: this.historyI, color: '#f84', scale: this.normalized ? 1 : 4 }
    ];

    // ν/σ: a fixed ±4.5 range so the ±3 band always sits in the same place.
    const maxAbs = this.normalized ? 4.5 : Math.max(
      1e-6,
      ...series.flatMap((s) => s.data.map((v) => Math.abs(v) / s.scale))
    );

    series.forEach((s, si) => {
      const laneH = (this.height - 8) / 3;
      const y0 = 4 + si * laneH;
      const mid = y0 + laneH * 0.5;

      ctx.strokeStyle = 'rgba(80,100,120,0.25)';
      ctx.beginPath();
      ctx.moveTo(0, mid);
      ctx.lineTo(this.width, mid);
      ctx.stroke();
      if (this.normalized) {
        // ±3σ band: inside it the residual is what the noise model predicts.
        const band = (3 / maxAbs) * (laneH * 0.42);
        ctx.fillStyle = 'rgba(25,158,112,0.14)';
        ctx.fillRect(0, mid - band, this.width, 2 * band);
      }

      ctx.beginPath();
      s.data.forEach((value, i) => {
        const x = (i / (HISTORY - 1)) * this.width;
        const v = Math.max(-maxAbs, Math.min(maxAbs, value / s.scale));
        const y = mid - (v / maxAbs) * (laneH * 0.42);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });
  }
}
