/**
 * SEG Operator Panel — SCADA instrumentation UI.
 * Reads live numbers only from TelemetryHub (no visualizer digs).
 * Control setpoints still write to segOperator plant state.
 */

import { segOperator, SEG_SPEC, OPERATOR_STATUS } from './seg-operator-state.js';
import { telemetryHub } from './telemetry-hub.js';

const RPM_GAUGE_MAX = 3200;

export class SEGOperatorPanel {
  constructor(options = {}) {
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

  _bindDom() {
    this.els = {
      leftPanel: document.getElementById('left-panel'),
      rightPanel: document.getElementById('right-panel'),
      status: document.getElementById('status'),
      statusDot: document.getElementById('statusDot'),
      startBtn: document.getElementById('startBtn'),
      stopBtn: document.getElementById('stopBtn'),
      resetBtn: document.getElementById('resetBtn'),
      driveControl: document.getElementById('driveControl'),
      driveVal: document.getElementById('driveVal'),
      fieldControl: document.getElementById('fieldControl'),
      fieldVal: document.getElementById('fieldVal'),
      loadControl: document.getElementById('loadControl'),
      loadVal: document.getElementById('loadVal'),
      speedControl: document.getElementById('speedControl'),
      speedVal: document.getElementById('speedVal'),
      particleSlider: document.getElementById('particleSlider'),
      particleVal: document.getElementById('particleVal'),
      schematicToggle: document.getElementById('schematicToggle'),
      schematicOverlay: document.getElementById('seg-schematic-overlay'),
      aboutToggle: document.getElementById('segAboutToggle'),
      aboutSection: document.getElementById('seg-op-about'),
      rpmGauge: document.getElementById('seg-rpm-gauge'),
      rpmNeedle: document.getElementById('seg-rpm-needle'),
      rpmArc: document.getElementById('seg-rpm-arc'),
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
      collapseLeft: document.getElementById('collapse-left'),
      collapseRight: document.getElementById('collapse-right'),
      main: document.getElementById('main'),
    };

    this.els.leftPanel?.classList.add('seg-op-controls', 'seg-op-panel');
    this.els.rightPanel?.classList.add('seg-op-instrument', 'seg-op-panel');
  }

  _wireControls() {
    const s = this.state;

    if (this.els.driveControl) {
      s.targetDrive = parseInt(this.els.driveControl.value, 10) / 100;
      this.els.driveControl.addEventListener('input', (e) => {
        const v = parseInt(e.target.value, 10);
        s.targetDrive = v / 100;
        if (this.els.driveVal) this.els.driveVal.textContent = `${v}%`;
      });
    }

    if (this.els.fieldControl) {
      s.magneticFieldStrength = parseInt(this.els.fieldControl.value, 10) / 100;
      this.els.fieldControl.addEventListener('input', (e) => {
        const v = parseInt(e.target.value, 10);
        s.magneticFieldStrength = v / 100;
        if (this.els.fieldVal) this.els.fieldVal.textContent = `${v}%`;
      });
    }

    if (this.els.loadControl) {
      s.loadResistance = parseInt(this.els.loadControl.value, 10);
      this.els.loadControl.addEventListener('input', (e) => {
        const v = parseInt(e.target.value, 10);
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
      this._schematicVisible = e.target.checked;
      this.els.schematicOverlay?.classList.toggle('visible', this._schematicVisible);
      window.segDiagram2D?.setVisible?.(this._schematicVisible);
    });

    this.els.aboutToggle?.addEventListener('click', () => {
      this.els.aboutSection?.classList.toggle('expanded');
    });

    this.els.collapseLeft?.addEventListener('click', () => {
      this.els.main?.classList.toggle('left-collapsed');
      this.els.collapseLeft.textContent = this.els.main?.classList.contains('left-collapsed') ? '›' : '‹';
    });

    this.els.collapseRight?.addEventListener('click', () => {
      this.els.main?.classList.toggle('right-collapsed');
      this.els.collapseRight.textContent = this.els.main?.classList.contains('right-collapsed') ? '‹' : '›';
    });

    this.els.particleSlider?.addEventListener('input', (e) => {
      const count = parseInt(e.target.value, 10);
      if (this.els.particleVal) this.els.particleVal.textContent = count.toLocaleString();
      this.onParticleCountChange?.(count);
    });
  }

  _wireKeyboard() {
    window.addEventListener('keydown', (e) => {
      if (e.target.matches('input, textarea, select')) return;
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

  _renderRpmGaugeSvg() {
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
    this.els.rpmArc = document.getElementById('seg-rpm-arc');
    this.els.rpmNeedle = document.getElementById('seg-rpm-needle');

    const track = document.getElementById('seg-rpm-track');
    if (track) track.setAttribute('d', this._arcPath(cx, cy, r, startA, endA));
    if (this.els.rpmArc) this.els.rpmArc.setAttribute('d', this._arcPath(cx, cy, r, startA, startA));
  }

  _arcPath(cx, cy, r, startDeg, endDeg) {
    const toRad = (d) => d * Math.PI / 180;
    const x1 = cx + r * Math.cos(toRad(startDeg));
    const y1 = cy + r * Math.sin(toRad(startDeg));
    const x2 = cx + r * Math.cos(toRad(endDeg));
    const y2 = cy + r * Math.sin(toRad(endDeg));
    const large = endDeg - startDeg > 180 ? 1 : 0;
    return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
  }

  _renderSchematicSvg() {
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

  updateStatusUi() {
    const s = this.state;
    const labels = {
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
  tick(deltaTime) {
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
  applySnapshot(snap) {
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

  /** Footer / battery strip from multi-device physics on the hub */
  _updateFooterFromSnapshot(snap) {
    const modeFooter = document.getElementById('modeFooter');
    const batteryFooter = document.getElementById('batteryFooter');
    const view = snap.view || 'overview';
    const modeLabels = {
      seg: 'SEG',
      heron: "Heron's Fountain",
      kelvin: "Kelvin's Thunderstorm",
      solar: 'LEDs + Solar',
      overview: 'Multi-Device Overview',
      peltier: 'Peltier',
      mhd: 'MHD',
      maglev: 'Mag Levitation',
      homopolar: 'Homopolar Generator'
    };
    if (modeFooter) modeFooter.textContent = modeLabels[view] || view.toUpperCase();

    const heron = snap.devices?.heron;
    const kelvin = snap.devices?.kelvin;
    const solar = snap.devices?.solar;

    if (batteryFooter) {
      if (view === 'heron' && heron) {
        batteryFooter.textContent = [
          `Head ${heron.heronHead.toFixed(2)}/${heron.heronHeadMax.toFixed(1)} m`,
          `v ${heron.heronVExit.toFixed(2)} m/s`,
          `Q ${heron.heronFlowRateLmin.toFixed(1)} L/min`,
          `P ${heron.heronPressureKPa.toFixed(1)} kPa`
        ].join(' · ');
      } else if (view === 'kelvin' && kelvin) {
        const spark = kelvin.kelvinSparkTimer > 0 ? ' ⚡' : '';
        const v = kelvin.kelvinVoltageN * (kelvin.kelvinVbreak || 1);
        batteryFooter.textContent = `V ${v.toFixed(0)} V (${(kelvin.kelvinVoltageN * 100).toFixed(0)}%)${spark}`;
      } else if (solar) {
        batteryFooter.textContent = `${Math.round((solar.batteryCharge || 0) * 100)}%`;
      } else if (view === 'homopolar' && snap.devices?.homopolar) {
        const h = snap.devices.homopolar;
        batteryFooter.textContent = [
          `RPM ${(h.homopolarRpm || 0).toFixed(0)}`,
          `EMF ${(h.homopolarEmfV || 0).toFixed(3)} V`,
          `I ${(h.homopolarCurrentA || 0).toFixed(2)} A`,
          `B ${(h.homopolarFieldT || 0).toFixed(2)} T`
        ].join(' · ');
      } else if (view === 'maglev' && snap.devices?.maglev) {
        const m = snap.devices.maglev;
        batteryFooter.textContent = [
          `gap ${(m.maglevGapMm || 0).toFixed(1)} mm`,
          `B ${(m.maglevFieldT || 0).toFixed(2)} T`,
          `${(m.maglevRpm || 0).toFixed(0)} RPM`
        ].join(' · ');
      } else {
        batteryFooter.textContent = '—';
      }
    }

    const batteryEl = document.getElementById('batteryCharge');
    const batteryStat = document.getElementById('batteryStat');
    if (batteryEl && batteryStat && solar) {
      batteryEl.textContent = `${Math.round((solar.batteryCharge || 0) * 100)}%`;
      batteryStat.style.display = view === 'solar' ? 'flex' : 'none';
    }
  }

  /** Force a SEG-only refresh (e.g. after reset) */
  refreshTelemetry(deltaTime = 0.016) {
    telemetryHub.publishFrame({ dt: deltaTime });
  }

  destroy() {
    if (this._unsubHub) {
      this._unsubHub();
      this._unsubHub = null;
    }
  }

  _updateRpmGauge(rpm) {
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
      this.els.rpmNeedle.setAttribute('x2', nx);
      this.els.rpmNeedle.setAttribute('y2', ny);
    }
  }

  getTelemetry() {
    return this._lastTelemetry;
  }
}

/** @returns {SEGOperatorPanel} */
export function initSEGOperatorPanel(options = {}) {
  if (window.segOperatorPanel) return window.segOperatorPanel;
  window.segOperator = window.segOperator || segOperator;
  window.segOperatorPanel = new SEGOperatorPanel(options);
  return window.segOperatorPanel;
}

export { SEG_SPEC };
