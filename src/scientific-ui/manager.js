/**
 * Scientific UI Manager — panel orchestration + TelemetryHub subscription.
 */

import { MagneticFieldGauge } from './gauges/magnetic-field-gauge.js';
import { EnergyDensityGauge } from './gauges/energy-density-gauge.js';
import { TorqueGauge } from './gauges/torque-gauge.js';
import { ParticleFluxGauge } from './gauges/particle-flux-gauge.js';
import { BatteryGauge } from './gauges/battery-gauge.js';
import { SolarPanelGauge } from './gauges/solar-panel-gauge.js';
import { LEDArrayGauge } from './gauges/ledarray-gauge.js';
import { EnergyBalanceDisplay } from './gauges/energy-balance-display.js';
import { telemetryHub } from '../telemetry-hub.js';

/**
 * Scientific UI Manager - Orchestrates all gauge components
 * Manages panel visibility, layout, and data updates via TelemetryHub.
 */
export class ScientificUIManager {
  constructor(options = {}) {
    this.options = {
      panelId: 'scientific-panel',
      showToggle: true,
      subscribeToHub: true,
      ...options
    };

    this.panel = null;
    this.gauges = {};
    this.wolframPanel = null;
    this.isVisible = false;
    this.cache = new Map();
    this._unsubHub = null;

    this.init();
  }

  init() {
    this.createPanel();
    if (this.options.showToggle) {
      this.createToggleButton();
    }
    this.initGauges();
  }

  createPanel() {
    let panel = document.getElementById(this.options.panelId);
    if (!panel) {
      panel = document.createElement('div');
      panel.id = this.options.panelId;
      panel.className = 'sci-panel collapsed';
      document.body.appendChild(panel);
    }

    this.panel = panel;
    this.panel.innerHTML = `
      <div class="sci-panel-header">
        <div class="sci-panel-title">
          <span class="sci-panel-icon">⊙</span>
          <span>SEG Physics Monitor</span>
        </div>
        <div class="sci-panel-controls">
          <button class="sci-panel-btn" id="sci-collapse-btn" title="Collapse">−</button>
        </div>
      </div>
      <div class="sci-panel-content">
        <div id="sci-wolfram-status"></div>
        <div id="sci-magnetic-gauge"></div>
        <div id="sci-energy-gauge"></div>
        <div id="sci-torque-gauge"></div>
        <div id="sci-flux-gauge"></div>
        <div id="sci-battery-gauge"></div>
        <div id="sci-solar-gauge"></div>
        <div id="sci-led-gauge"></div>
        <div id="sci-energy-flow-gauge"></div>
      </div>
    `;

    this.panel.querySelector('#sci-collapse-btn').addEventListener('click', () => {
      this.hide();
    });

    this.setupDrag();
  }

  createToggleButton() {
    const toggle = document.createElement('button');
    toggle.id = 'sci-panel-toggle';
    toggle.className = 'sci-panel-toggle';
    toggle.innerHTML = '⊞';
    toggle.title = 'Show Scientific Panel';
    toggle.addEventListener('click', () => this.show());
    document.body.appendChild(toggle);
  }

  setupDrag() {
    const header = this.panel.querySelector('.sci-panel-header');
    let isDragging = false;
    let startX, startY, startLeft, startTop;

    header.addEventListener('mousedown', (e) => {
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = this.panel.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      this.panel.classList.add('dragging');
    });

    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      this.panel.style.left = (startLeft + dx) + 'px';
      this.panel.style.top = (startTop + dy) + 'px';
      this.panel.style.right = 'auto';
    });

    window.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        this.panel.classList.remove('dragging');
      }
    });
  }

  initGauges() {
    this.gauges.magnetic = new MagneticFieldGauge('sci-magnetic-gauge');
    this.gauges.energy = new EnergyDensityGauge('sci-energy-gauge');
    this.gauges.torque = new TorqueGauge('sci-torque-gauge');
    this.gauges.flux = new ParticleFluxGauge('sci-flux-gauge');

    this.gauges.battery = new BatteryGauge('sci-battery-gauge');
    this.gauges.solar = new SolarPanelGauge('sci-solar-gauge');
    this.gauges.led = new LEDArrayGauge('sci-led-gauge');
    this.gauges.energyFlow = new EnergyBalanceDisplay('sci-energy-flow-gauge');

    this.wolframPanel = null;

    if (this.options.subscribeToHub) {
      this._unsubHub = telemetryHub.subscribe((snap) => this.applyHubSnapshot(snap), {
        immediate: true
      });
    }
  }

  applyHubSnapshot(snap) {
    if (!snap) return;
    const sci = snap.scientific || {};
    const seg = snap.seg;
    const meta = snap.meta || {};
    const solar = snap.devices?.solar;

    if (sci.maxFieldMagnitude !== undefined) {
      this.updateMagneticField(sci.maxFieldMagnitude);
    } else if (seg?.fieldSim !== undefined) {
      this.updateMagneticField(seg.fieldSim);
    }

    if (sci.avgEnergyDensity !== undefined) {
      this.updateEnergyDensity(sci.avgEnergyDensity / 1000);
    }

    this.updateTorque(
      sci.innerRingTorque ?? 0,
      sci.outerRingTorque ?? (sci.middleRingTorque ?? 0)
    );

    if (sci.particleFlux !== undefined) {
      this.updateParticleFlux(sci.particleFlux);
    }

    if (solar && this.gauges.battery) {
      const charge = solar.batteryCharge ?? 0.5;
      const voltage = 3.0 + charge * 1.2;
      this.updateBatteryState({
        chargePercent: charge * 100,
        voltage,
        current: seg?.current ?? 0,
        temperature: seg?.temperature ?? 25
      });
    }

    this.cache.set('meta', meta);
  }

  show() {
    this.panel.classList.remove('collapsed');
    const toggle = document.getElementById('sci-panel-toggle');
    if (toggle) toggle.classList.add('hidden');
    this.isVisible = true;

    requestAnimationFrame(() => {
      this.gauges.magnetic.resize();
      this.gauges.flux.resize();
      this.gauges.battery.resize();
      this.gauges.solar.resize();
    });
  }

  hide() {
    this.panel.classList.add('collapsed');
    const toggle = document.getElementById('sci-panel-toggle');
    if (toggle) toggle.classList.remove('hidden');
    this.isVisible = false;
  }

  toggle() {
    if (this.isVisible) this.hide();
    else this.show();
  }

  updateMagneticField(value) {
    if (this.gauges.magnetic) {
      this.gauges.magnetic.setValue(value);
    }
  }

  updateEnergyDensity(value) {
    if (this.gauges.energy) {
      this.gauges.energy.setValue(value);
    }
  }

  updateTorque(inner, outer) {
    if (this.gauges.torque) {
      this.gauges.torque.setValues(inner, outer);
    }
  }

  updateParticleFlux(rate) {
    if (this.gauges.flux) {
      this.gauges.flux.setRate(rate);
    }
  }

  updateFieldData(data) {
    if (data.magneticField !== undefined) {
      this.updateMagneticField(data.magneticField);
    }
    if (data.energyDensity !== undefined) {
      this.updateEnergyDensity(data.energyDensity);
    }
    if (data.torqueInner !== undefined || data.torqueOuter !== undefined) {
      this.updateTorque(data.torqueInner || 0, data.torqueOuter || 0);
    }
    if (data.particleFlux !== undefined) {
      this.updateParticleFlux(data.particleFlux);
    }
  }

  updateWolframStatus(status) {
    if (!this.wolframPanel) return;

    if (status.state) {
      this.wolframPanel.setStatus(status.state, status.message);
    }
    if (status.dataSource) {
      this.wolframPanel.setDataSource(status.dataSource);
    }
    if (status.cacheHits !== undefined && status.cacheMisses !== undefined) {
      this.wolframPanel.updateCacheStats(status.cacheHits, status.cacheMisses);
    }
  }

  cacheQueryResult(query, result) {
    this.cache.set(query, {
      result: result,
      timestamp: Date.now()
    });
  }

  getCachedResult(query, maxAge = 300000) {
    const entry = this.cache.get(query);
    if (!entry) {
      this.wolframPanel?.recordMiss();
      return null;
    }

    if (Date.now() - entry.timestamp > maxAge) {
      this.cache.delete(query);
      this.wolframPanel?.recordMiss();
      return null;
    }

    this.wolframPanel?.recordHit();
    this.wolframPanel?.addLogEntry(query, 'hit');
    return entry.result;
  }

  clearCache() {
    this.cache.clear();
    this.wolframPanel?.updateCacheStats(0, 0);
  }

  getCacheStats() {
    return {
      size: this.cache.size,
      hits: this.wolframPanel?.cacheHits || 0,
      misses: this.wolframPanel?.cacheMisses || 0
    };
  }

  updateBatteryState(state) {
    if (this.gauges.battery) {
      this.gauges.battery.updateState(state);
    }
  }

  updateSolarOutput(output) {
    if (this.gauges.solar) {
      this.gauges.solar.updateOutput(output);
    }
  }

  updateLEDStatus(leds) {
    if (this.gauges.led) {
      this.gauges.led.updateStatus(leds);
    }
  }

  updateEnergyBalance(flows) {
    if (this.gauges.energyFlow) {
      this.gauges.energyFlow.updateFlows(flows);
    }
  }

  destroy() {
    if (this._unsubHub) {
      this._unsubHub();
      this._unsubHub = null;
    }
    this.hide();
    this.panel?.remove();
    document.getElementById('sci-panel-toggle')?.remove();
  }
}
