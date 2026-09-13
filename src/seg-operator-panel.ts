/**
 * SEG Operator Panel — SCADA instrumentation UI.
 * Reads live numbers only from TelemetryHub (no visualizer digs).
 * Control setpoints still write to segOperator plant state.
 */

import { segOperator, SEG_SPEC, OPERATOR_STATUS, type SEGOperatorState } from './seg-operator-state';
import { telemetryHub } from './telemetry-hub';
import {
  deviceLabel,
  formatTelemetryValue,
  readTelemetryKey,
  telemetryFieldsForDevice
} from './telemetry/telemetry-fields';
import type { DeviceTelemetrySnap, TelemetrySnapshot } from './telemetry/types';

const RPM_GAUGE_MAX = 3200;

export interface SEGOperatorPanelOptions {
  state?: SEGOperatorState;
  onParticleCountChange?: ((count: number) => void) | null;
}

interface PanelElements {
  leftPanel: HTMLElement | null;
  rightPanel: HTMLElement | null;
  status: HTMLElement | null;
  statusDot: HTMLElement | null;
  startBtn: HTMLButtonElement | null;
  stopBtn: HTMLButtonElement | null;
  resetBtn: HTMLButtonElement | null;
  driveControl: HTMLInputElement | null;
  driveVal: HTMLElement | null;
  fieldControl: HTMLInputElement | null;
  fieldVal: HTMLElement | null;
  loadControl: HTMLInputElement | null;
  loadVal: HTMLElement | null;
  speedControl: HTMLInputElement | null;
  speedVal: HTMLElement | null;
  particleSlider: HTMLInputElement | null;
  particleVal: HTMLElement | null;
  schematicToggle: HTMLInputElement | null;
  schematicOverlay: HTMLElement | null;
  aboutToggle: HTMLElement | null;
  aboutSection: HTMLElement | null;
  rpmGauge: HTMLElement | null;
  rpmNeedle: SVGLineElement | null;
  rpmArc: SVGPathElement | null;
  rpmInner: HTMLElement | null;
  voltage: HTMLElement | null;
  current: HTMLElement | null;
  power: HTMLElement | null;
  magneticField: HTMLElement | null;
  temperature: HTMLElement | null;
  efficiency: HTMLElement | null;
  efficiencyBar: HTMLElement | null;
  energy: HTMLElement | null;
  thermalFill: HTMLElement | null;
  thermalVal: HTMLElement | null;
  coronaVal: HTMLElement | null;
  deviceReadout: HTMLElement | null;
  deviceReadoutTitle: HTMLElement | null;
  deviceReadoutGrid: HTMLElement | null;
  collapseLeft: HTMLElement | null;
  collapseRight: HTMLElement | null;
  main: HTMLElement | null;
}

export class SEGOperatorPanel {
  state: SEGOperatorState;
  onParticleCountChange: ((count: number) => void) | null;
  els!: PanelElements;
  private _rafPending: boolean;
  private _lastTelemetry: TelemetrySnapshot['seg'];
  private _schematicVisible: boolean;
  private _unsubHub: (() => void) | null;
  private _readoutKeys = '';
  private _readoutCells: HTMLElement[] = [];

  constructor(options: SEGOperatorPanelOptions = {}) {
    this.state = options.state || segOperator;
    this.onParticleCountChange = options.onParticleCountChange || null;
    this._rafPending = false;
    this._lastTelemetry = null;
    this._schematicVisible = false;
    this._unsubHub = null;

    this._bindDom();
    this._wireControls();
    this._wireKeyboard();
    this._renderRpmGaugeSvg();
    this._renderSchematicSvg();
    this.updateStatusUi();

    // Single update path: hub publishes; panel paints DOM
    this._unsubHub = telemetryHub.subscribe((snap) => this.applySnapshot(snap), {
      immediate: true
    });
  }

  private _bindDom(): void {
    this.els = {
      leftPanel: document.getElementById('left-panel'),
      rightPanel: document.getElementById('right-panel'),
      status: document.getElementById('status'),
      statusDot: document.getElementById('statusDot'),
      startBtn: document.getElementById('startBtn') as HTMLButtonElement | null,
      stopBtn: document.getElementById('stopBtn') as HTMLButtonElement | null,
      resetBtn: document.getElementById('resetBtn') as HTMLButtonElement | null,
      driveControl: document.getElementById('driveControl') as HTMLInputElement | null,
      driveVal: document.getElementById('driveVal'),
      fieldControl: document.getElementById('fieldControl') as HTMLInputElement | null,
      fieldVal: document.getElementById('fieldVal'),
      loadControl: document.getElementById('loadControl') as HTMLInputElement | null,
      loadVal: document.getElementById('loadVal'),
      speedControl: document.getElementById('speedControl') as HTMLInputElement | null,
      speedVal: document.getElementById('speedVal'),
      particleSlider: document.getElementById('particleSlider') as HTMLInputElement | null,
      particleVal: document.getElementById('particleVal'),
      schematicToggle: document.getElementById('schematicToggle') as HTMLInputElement | null,
      schematicOverlay: document.getElementById('seg-schematic-overlay'),
      aboutToggle: document.getElementById('segAboutToggle'),
      aboutSection: document.getElementById('seg-op-about'),
      rpmGauge: document.getElementById('seg-rpm-gauge'),
      rpmNeedle: document.getElementById('seg-rpm-needle') as unknown as SVGLineElement | null,
      rpmArc: document.getElementById('seg-rpm-arc') as unknown as SVGPathElement | null,
      rpmInner: document.getElementById('rpm-inner'),
      voltage: document.getElementById('voltage'),
      current: document.getElementById('current'),
      power: document.getElementById('power'),
      magneticField: document.getElementById('magnetic-field'),
      temperature: document.getElementById('temperature'),
      efficiency: document.getElementById('efficiency'),
      efficiencyBar: document.getElementById('efficiency-bar'),
      energy: document.getElementById('energy'),
      thermalFill: document.getElementById('seg-thermal-fill'),
      thermalVal: document.getElementById('seg-thermal-val'),
      coronaVal: document.getElementById('seg-corona-val'),
      deviceReadout: document.getElementById('device-readout'),
      deviceReadoutTitle: document.getElementById('device-readout-title'),
      deviceReadoutGrid: document.getElementById('device-readout-grid'),
      collapseLeft: document.getElementById('collapse-left'),
      collapseRight: document.getElementById('collapse-right'),
      main: document.getElementById('main'),
    };

    this.els.leftPanel?.classList.add('seg-op-controls', 'seg-op-panel');
    this.els.rightPanel?.classList.add('seg-op-instrument', 'seg-op-panel');
  }

  private _wireControls(): void {
    const s = this.state;

    if (this.els.driveControl) {
      s.targetDrive = parseInt(this.els.driveControl.value, 10) / 100;
      this.els.driveControl.addEventListener('input', (e) => {
        const v = parseInt((e.target as HTMLInputElement).value, 10);
        s.targetDrive = v / 100;
        if (this.els.driveVal) this.els.driveVal.textContent = `${v}%`;
      });
    }

    if (this.els.fieldControl) {
      s.magneticFieldStrength = parseInt(this.els.fieldControl.value, 10) / 100;
      this.els.fieldControl.addEventListener('input', (e) => {
        const v = parseInt((e.target as HTMLInputElement).value, 10);
        s.magneticFieldStrength = v / 100;
        if (this.els.fieldVal) this.els.fieldVal.textContent = `${v}%`;
      });
    }

    if (this.els.loadControl) {
      s.loadResistance = parseInt(this.els.loadControl.value, 10);
      this.els.loadControl.addEventListener('input', (e) => {
        const v = parseInt((e.target as HTMLInputElement).value, 10);
        s.loadResistance = v;
        if (this.els.loadVal) this.els.loadVal.textContent = String(v);
      });
    }

    this.els.startBtn?.addEventListener('click', () => {
      if (s.isRunning && s.status !== OPERATOR_STATUS.ESTOP) {
        s.stop();
      } else {
        s.clearEstop();
        s.start();
      }
      this.updateStatusUi();
    });

    this.els.stopBtn?.addEventListener('click', () => {
      s.estop();
      this.updateStatusUi();
    });

    this.els.resetBtn?.addEventListener('click', () => {
      s.reset();
      this.updateStatusUi();
      this.refreshTelemetry(0);
    });

    this.els.schematicToggle?.addEventListener('change', (e) => {
      this._schematicVisible = (e.target as HTMLInputElement).checked;
      this.els.schematicOverlay?.classList.toggle('visible', this._schematicVisible);
      window.segDiagram2D?.setVisible?.(this._schematicVisible);
    });

    this.els.aboutToggle?.addEventListener('click', () => {
      this.els.aboutSection?.classList.toggle('expanded');
    });

    this.els.collapseLeft?.addEventListener('click', () => {
      this.els.main?.classList.toggle('left-collapsed');
      if (this.els.collapseLeft) {
        this.els.collapseLeft.textContent = this.els.main?.classList.contains('left-collapsed') ? '›' : '‹';
      }
    });

    this.els.collapseRight?.addEventListener('click', () => {
      this.els.main?.classList.toggle('right-collapsed');
      if (this.els.collapseRight) {
        this.els.collapseRight.textContent = this.els.main?.classList.contains('right-collapsed') ? '‹' : '›';
      }
    });

    this.els.particleSlider?.addEventListener('input', (e) => {
      const count = parseInt((e.target as HTMLInputElement).value, 10);
      if (this.els.particleVal) this.els.particleVal.textContent = count.toLocaleString();
      this.onParticleCountChange?.(count);
    });
  }

  private _wireKeyboard(): void {
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).matches('input, textarea, select')) return;
      const key = e.key.toLowerCase();

      if (key === 's' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        this.state.clearEstop();
        this.state.start();
        this.updateStatusUi();
      } else if (key === 'x' || (key === 'e' && e.shiftKey)) {
        e.preventDefault();
        this.state.estop();
        this.updateStatusUi();
      } else if (key === 'r' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        this.state.reset();
        this.updateStatusUi();
        this.refreshTelemetry(0);
      }
    });
  }

  private _renderRpmGaugeSvg(): void {
    if (!this.els.rpmGauge) return;
    const cx = 100, cy = 95, r = 72;
    const startA = 135, endA = 405;
    this.els.rpmGauge.innerHTML = `
      <svg viewBox="0 0 200 120" role="img" aria-label="Inner ring RPM gauge">
        <defs>
          <linearGradient id="rpmGrad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stop-color="#1a5a4a"/>
            <stop offset="60%" stop-color="#4ecdc4"/>
            <stop offset="85%" stop-color="#ffb020"/>
            <stop offset="100%" stop-color="#ff4444"/>
          </linearGradient>
        </defs>
        <path id="seg-rpm-track" fill="none" stroke="#1a2830" stroke-width="10" stroke-linecap="round"/>
        <path id="seg-rpm-arc" fill="none" stroke="url(#rpmGrad)" stroke-width="10" stroke-linecap="round"/>
        <line id="seg-rpm-needle" x1="${cx}" y1="${cy}" x2="${cx}" y2="${cy - r + 12}"
          stroke="#e0f0f0" stroke-width="2.5" stroke-linecap="round"/>
        <circle cx="${cx}" cy="${cy}" r="4" fill="#e0f0f0"/>
        ${[0, 800, 1600, 2400, 3200].map((tick) => {
          const a = (startA + (tick / RPM_GAUGE_MAX) * (endA - startA)) * Math.PI / 180;
          const x1 = cx + Math.cos(a) * (r - 14);
          const y1 = cy + Math.sin(a) * (r - 14);
          const x2 = cx + Math.cos(a) * (r - 4);
          const y2 = cy + Math.sin(a) * (r - 4);
          return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#2a4a5a" stroke-width="1.5"/>`;
        }).join('')}
      </svg>
    `;
    this.els.rpmArc = document.getElementById('seg-rpm-arc') as unknown as SVGPathElement | null;
    this.els.rpmNeedle = document.getElementById('seg-rpm-needle') as unknown as SVGLineElement | null;

    const track = document.getElementById('seg-rpm-track');
    if (track) track.setAttribute('d', this._arcPath(cx, cy, r, startA, endA));
    if (this.els.rpmArc) this.els.rpmArc.setAttribute('d', this._arcPath(cx, cy, r, startA, startA));
  }

  private _arcPath(cx: number, cy: number, r: number, startDeg: number, endDeg: number): string {
    const toRad = (d: number) => d * Math.PI / 180;
    const x1 = cx + r * Math.cos(toRad(startDeg));
    const y1 = cy + r * Math.sin(toRad(startDeg));
    const x2 = cx + r * Math.cos(toRad(endDeg));
    const y2 = cy + r * Math.sin(toRad(endDeg));
    const large = endDeg - startDeg > 180 ? 1 : 0;
    return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
  }

  private _renderSchematicSvg(): void {
    const host = this.els.schematicOverlay?.querySelector('.seg-schematic-svg');
    if (!host) return;
    host.innerHTML = `
      <svg viewBox="0 0 280 160" aria-hidden="true">
        <rect x="10" y="10" width="260" height="140" fill="none" stroke="#2a6a7a" stroke-width="1"/>
        <circle cx="140" cy="80" r="18" fill="none" stroke="#4ecdc4" stroke-width="1.5"/>
        <circle cx="140" cy="80" r="35" fill="none" stroke="#3a5a6a" stroke-width="1" stroke-dasharray="4 3"/>
        <circle cx="140" cy="80" r="55" fill="none" stroke="#3a5a6a" stroke-width="1" stroke-dasharray="4 3"/>
        <circle cx="140" cy="80" r="72" fill="none" stroke="#3a5a6a" stroke-width="1" stroke-dasharray="4 3"/>
        ${[0, 1, 2, 3, 4, 5].map((i) => {
          const a = (i / 6) * Math.PI * 2 - Math.PI / 2;
          const x = 140 + Math.cos(a) * 55;
          const y = 80 + Math.sin(a) * 55;
          return `<circle cx="${x}" cy="${y}" r="5" fill="#ffb020" opacity="0.85"/>`;
        }).join('')}
        <text x="140" y="155" text-anchor="middle" fill="#5a7a8a" font-size="8" font-family="monospace">CROSS-SECTION · STATOR + 3 ROLLER RINGS</text>
      </svg>
    `;
  }

  updateStatusUi(): void {
    const s = this.state;
    const labels: Record<string, { text: string; dot: string; cls: string }> = {
      [OPERATOR_STATUS.STANDBY]: { text: 'STANDBY', dot: 'status-standby', cls: '' },
      [OPERATOR_STATUS.SPINUP]: { text: 'SPIN-UP', dot: 'status-active', cls: 'status-spinup' },
      [OPERATOR_STATUS.OPERATIONAL]: { text: 'OPERATIONAL', dot: 'status-active', cls: 'status-operational' },
      [OPERATOR_STATUS.STOPPING]: { text: 'STOPPING', dot: 'status-inactive', cls: '' },
      [OPERATOR_STATUS.ESTOP]: { text: 'E-STOP', dot: 'status-inactive', cls: 'status-estop' },
    };
    const info = labels[s.status] || labels[OPERATOR_STATUS.STANDBY];

    if (this.els.status) {
      this.els.status.textContent = info.text;
      this.els.status.className = info.cls;
    }
    if (this.els.statusDot) {
      this.els.statusDot.className = `status-indicator ${info.dot}`;
    }
    if (this.els.startBtn) {
      this.els.startBtn.classList.toggle('active', s.isRunning);
      this.els.startBtn.disabled = s.status === OPERATOR_STATUS.ESTOP;
    }
    if (this.els.stopBtn) {
      this.els.stopBtn.classList.toggle('latched', s.status === OPERATOR_STATUS.ESTOP);
    }
  }

  /**
   * Legacy per-frame hook. Prefer visualizers calling telemetryHub.publishFrame().
   * If the hub was not updated this frame, publishes SEG-only telemetry so gauges move.
   */
  tick(deltaTime: number): void {
    if (this._rafPending) return;
    this._rafPending = true;
    requestAnimationFrame(() => {
      this._rafPending = false;
      // Fallback publish when a renderer forgot to call the hub (keeps START→RPM working)
      const snap = telemetryHub.getSnapshot();
      const stale = !snap.seg || (performance.now() - (snap.timeMs || 0)) > 100;
      if (stale) {
        telemetryHub.publishFrame({ dt: deltaTime, view: snap.view || 'overview' });
      }
    });
  }

  /** Apply a TelemetryHub snapshot to the dashboard DOM (SEG primary gauges). */
  applySnapshot(snap: TelemetrySnapshot): void {
    const t = snap?.seg;
    if (!t) return;
    this._lastTelemetry = t;
    this.updateStatusUi();

    if (this.els.rpmInner) {
      this.els.rpmInner.textContent = t.rpmDisplay.toLocaleString();
    }

    this._updateRpmGauge(t.rpmDisplay);

    // SEG electrical model is the authority for voltage/current/power on the main LEDs.
    // View-specific footers use device snapshots separately.
    if (this.els.voltage) this.els.voltage.textContent = `${t.voltage.toFixed(2)} V`;
    if (this.els.current) this.els.current.textContent = `${t.current.toFixed(3)} A`;
    if (this.els.power) {
      const pStr = t.power >= 1000 ? `${(t.power / 1000).toFixed(2)} kW` : `${t.power.toFixed(1)} W`;
      this.els.power.textContent = pStr;
    }

    if (this.els.magneticField) {
      const unc = snap.meta?.B_surface;
      const mark = unc?.isValidated ? '' : ' ~';
      this.els.magneticField.textContent = `${t.fieldSim.toFixed(3)} T${mark}`;
      if (this.els.magneticField.title !== undefined) {
        this.els.magneticField.title = unc
          ? `B_surface ref ${unc.value.toFixed(3)} T (±${((unc.uncertainty || 0) * 100).toFixed(0)}%)`
          : '';
      }
    }

    if (this.els.temperature) {
      this.els.temperature.textContent = `${t.temperature.toFixed(1)} °C`;
      this.els.temperature.className = 'seg-led-value'
        + (t.temperature > 80 ? ' critical' : t.temperature > 60 ? ' warning' : '');
    }

    if (this.els.thermalFill) {
      const pct = Math.min(100, ((t.temperature - 25) / 75) * 100);
      this.els.thermalFill.style.width = `${pct}%`;
    }
    if (this.els.thermalVal) {
      this.els.thermalVal.textContent = `${t.temperature.toFixed(1)} °C`;
    }

    if (this.els.coronaVal) {
      this.els.coronaVal.textContent = `${Math.round(t.corona * 100)}%`;
    }

    if (this.els.efficiency) {
      this.els.efficiency.textContent = `${t.efficiency.toFixed(1)}%`;
    }
    if (this.els.efficiencyBar) {
      this.els.efficiencyBar.style.width = `${t.efficiency.toFixed(1)}%`;
    }

    if (this.els.energy) {
      this.els.energy.textContent = `${t.totalEnergy.toFixed(4)} kWh`;
    }

    this._updateFooterFromSnapshot(snap);
  }

  /**
   * Focus chrome for the current view, driven by the device catalog.
   *
   * Labels, units and precision come from `physics/devices.json` →
   * `DEVICE_TELEMETRY_FIELDS`, so a plugin device's readouts are its own keys
   * (no SEG RPM gauge standing in for Hall voltage) and a new catalog device
   * needs no edit here. SEG keeps its dedicated gauges above.
   *
   * Every value is **simulated** plant state, not a calibrated instrument
   * reading (ADR-0004, docs/DEVICE_GALLERY.md).
   */
  private _updateFooterFromSnapshot(snap: TelemetrySnapshot): void {
    const view = snap.view || 'overview';
    const modeFooter = document.getElementById('modeFooter');
    if (modeFooter) {
      modeFooter.textContent = view === 'overview'
        ? 'Multi-Device Overview'
        : deviceLabel(view);
    }

    const fields = telemetryFieldsForDevice(view);
    const device: DeviceTelemetrySnap | undefined = snap.devices?.[view];

    const batteryFooter = document.getElementById('batteryFooter');
    if (batteryFooter) {
      batteryFooter.textContent = fields.length && device
        ? fields
          .map((f) => `${f.label} ${formatTelemetryValue(readTelemetryKey(device, f.key), f)}`)
          .join(' · ')
        : '—';
    }

    this._renderDeviceReadout(view, device, fields);

    const solar = snap.devices?.solar;
    const batteryEl = document.getElementById('batteryCharge');
    const batteryStat = document.getElementById('batteryStat') as HTMLElement | null;
    if (batteryEl && batteryStat && solar) {
      batteryEl.textContent = `${Math.round((solar.batteryCharge || 0) * 100)}%`;
      batteryStat.style.display = view === 'solar' ? 'flex' : 'none';
    }
  }

  /** Instrument-panel cells for the focused catalog device (hidden for SEG / overview). */
  private _renderDeviceReadout(
    view: string,
    device: DeviceTelemetrySnap | undefined,
    fields: ReturnType<typeof telemetryFieldsForDevice>
  ): void {
    const host = this.els.deviceReadout;
    const grid = this.els.deviceReadoutGrid;
    if (!host || !grid) return;

    if (!fields.length || !device) {
      host.hidden = true;
      grid.textContent = '';
      this._readoutKeys = '';
      return;
    }

    host.hidden = false;
    if (this.els.deviceReadoutTitle) {
      this.els.deviceReadoutTitle.textContent = deviceLabel(view);
    }

    // Rebuild cells only when the focused device changes; per-frame work is
    // limited to writing the value text nodes.
    const signature = `${view}:${fields.map((f) => f.key).join(',')}`;
    if (this._readoutKeys !== signature) {
      grid.textContent = '';
      this._readoutCells = fields.map((f) => {
        const cell = document.createElement('div');
        cell.className = 'seg-led-cell';
        const label = document.createElement('div');
        label.className = 'seg-led-label';
        label.textContent = f.label;
        const badge = document.createElement('span');
        badge.className = 'seg-src-badge sim';
        badge.textContent = 'SIM';
        label.append(' ', badge);
        const value = document.createElement('div');
        value.className = 'seg-led-value';
        value.id = `device-readout-${f.column}`;
        cell.append(label, value);
        grid.appendChild(cell);
        return value;
      });
      this._readoutKeys = signature;
    }

    fields.forEach((f, i) => {
      const cell = this._readoutCells[i];
      if (cell) cell.textContent = formatTelemetryValue(readTelemetryKey(device, f.key), f);
    });
  }

  /** Force a SEG-only refresh (e.g. after reset) */
  refreshTelemetry(deltaTime = 0.016): void {
    telemetryHub.publishFrame({ dt: deltaTime });
  }

  destroy(): void {
    if (this._unsubHub) {
      this._unsubHub();
      this._unsubHub = null;
    }
  }

  private _updateRpmGauge(rpm: number): void {
    const cx = 100, cy = 95, r = 72;
    const startA = 135, endA = 405;
    const pct = Math.min(1, rpm / RPM_GAUGE_MAX);
    const angleDeg = startA + pct * (endA - startA);
    const angleRad = angleDeg * Math.PI / 180;

    if (this.els.rpmArc) {
      this.els.rpmArc.setAttribute('d', this._arcPath(cx, cy, r, startA, angleDeg));
    }
    if (this.els.rpmNeedle) {
      const nx = cx + Math.cos(angleRad) * (r - 12);
      const ny = cy + Math.sin(angleRad) * (r - 12);
      this.els.rpmNeedle.setAttribute('x2', String(nx));
      this.els.rpmNeedle.setAttribute('y2', String(ny));
    }
  }

  getTelemetry(): TelemetrySnapshot['seg'] {
    return this._lastTelemetry;
  }
}

export function initSEGOperatorPanel(options: SEGOperatorPanelOptions = {}): SEGOperatorPanel {
  if (window.segOperatorPanel) return window.segOperatorPanel;
  window.segOperator = window.segOperator || segOperator;
  window.segOperatorPanel = new SEGOperatorPanel(options);
  return window.segOperatorPanel;
}

export { SEG_SPEC };
