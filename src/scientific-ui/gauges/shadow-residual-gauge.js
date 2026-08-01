/**
 * Shadow twin residual time-series — ΔRPM, ΔV, ΔI (sim vs mock/serial).
 * Data from TelemetryHub.hardwareTwin.shadowResidual.
 */

import { formatCompact } from '../utils/index.js';

const HISTORY = 90;

function finite(n, fallback = 0) {
  return Number.isFinite(n) ? n : fallback;
}

export class ShadowResidualGauge {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this.historyRpm = new Array(HISTORY).fill(0);
    this.historyV = new Array(HISTORY).fill(0);
    this.historyI = new Array(HISTORY).fill(0);
    this.connected = false;
    this.connectionState = 'disconnected';
    this.render();
    this.canvas = this.container.querySelector('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.rpmEl = this.container.querySelector('[data-res="rpm"]');
    this.vEl = this.container.querySelector('[data-res="v"]');
    this.iEl = this.container.querySelector('[data-res="i"]');
    this.stateEl = this.container.querySelector('[data-state]');
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, rect.width * dpr);
    this.canvas.height = Math.max(1, rect.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.width = rect.width;
    this.height = rect.height;
    this.draw();
  }

  render() {
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

  /**
   * @param {import('../../telemetry/types').HardwareTwinTelemetry|null} twin
   */
  updateFromTwin(twin) {
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
    const r = twin.shadowResidual || {};
    const rpmErr = finite(r.rpmError);
    const vErr = finite(r.voltageError);
    const iErr = finite(r.currentError);

    this.historyRpm.push(rpmErr);
    this.historyV.push(vErr);
    this.historyI.push(iErr);
    this.historyRpm.shift();
    this.historyV.shift();
    this.historyI.shift();

    if (this.rpmEl) this.rpmEl.textContent = `${rpmErr >= 0 ? '+' : ''}${rpmErr.toFixed(1)}`;
    if (this.vEl) this.vEl.textContent = `${vErr >= 0 ? '+' : ''}${vErr.toFixed(2)} V`;
    if (this.iEl) this.iEl.textContent = `${iErr >= 0 ? '+' : ''}${iErr.toFixed(2)} A`;

    if (this.stateEl) {
      const labels = { mock: 'mock', serial: 'serial', disconnected: 'off' };
      this.stateEl.textContent = labels[this.connectionState] || this.connectionState;
      this.stateEl.className = 'sci-gauge-value'
        + (this.connectionState === 'mock' ? ' warning' : '')
        + (this.connectionState === 'serial' ? '' : '');
    }

    this.draw();
  }

  draw() {
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
      { data: this.historyRpm, color: '#fc6', scale: 120 },
      { data: this.historyV, color: '#4af', scale: 8 },
      { data: this.historyI, color: '#f84', scale: 4 }
    ];

    const maxAbs = Math.max(
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

      ctx.beginPath();
      s.data.forEach((value, i) => {
        const x = (i / (HISTORY - 1)) * this.width;
        const y = mid - (value / s.scale / maxAbs) * (laneH * 0.42);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });
  }
}
