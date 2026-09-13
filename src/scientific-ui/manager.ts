/**
 * Scientific UI Manager — panel orchestration + TelemetryHub subscription.
 */

import { MagneticFieldGauge } from './gauges/magnetic-field-gauge';
import { EnergyDensityGauge } from './gauges/energy-density-gauge';
import { TorqueGauge } from './gauges/torque-gauge';
import { ParticleFluxGauge } from './gauges/particle-flux-gauge';
import { BatteryGauge, type BatteryState } from './gauges/battery-gauge';
import { SolarPanelGauge, type SolarOutput } from './gauges/solar-panel-gauge';
import { LEDArrayGauge, type LEDStatusUpdate } from './gauges/ledarray-gauge';
import { EnergyBalanceDisplay, type EnergyFlowsUpdate } from './gauges/energy-balance-display';
import { ShadowResidualGauge } from './gauges/shadow-residual-gauge';
import { telemetryHub } from '../telemetry-hub';
import type { TelemetrySnapshot } from '../telemetry/types';

export interface ScientificUIManagerOptions {
  panelId?: string;
  showToggle?: boolean;
  subscribeToHub?: boolean;
}

interface FieldUpdateData {
  magneticField?: number;
  energyDensity?: number;
  torqueInner?: number;
  torqueOuter?: number;
  particleFlux?: number;
}

interface CacheEntry {
  result: unknown;
  timestamp: number;
}

interface Gauges {
  magnetic?: MagneticFieldGauge;
  shadowResidual?: ShadowResidualGauge;
  energy?: EnergyDensityGauge;
  torque?: TorqueGauge;
  flux?: ParticleFluxGauge;
  battery?: BatteryGauge;
  solar?: SolarPanelGauge;
  led?: LEDArrayGauge;
  energyFlow?: EnergyBalanceDisplay;
}

/**
 * Scientific UI Manager - Orchestrates all gauge components
 * Manages panel visibility, layout, and data updates via TelemetryHub.
 */
export class ScientificUIManager {
  options: Required<ScientificUIManagerOptions>;
  panel: HTMLElement | null;
  gauges: Gauges;
  isVisible: boolean;
  cache: Map<string, unknown>;
  private _unsubHub: (() => void) | null;

  constructor(options: ScientificUIManagerOptions = {}) {
    this.options = {
      panelId: 'scientific-panel',
      showToggle: true,
      subscribeToHub: true,
      ...options
    };

    this.panel = null;
    this.gauges = {};
    this.isVisible = false;
    this.cache = new Map();
    this._unsubHub = null;

    this.init();
  }

  init(): void {
    this.createPanel();
    if (this.options.showToggle) {
      this.createToggleButton();
    }
    this.initGauges();
  }

  createPanel(): void {
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
        <div id="sci-shadow-residual-gauge"></div>
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

    this.panel.querySelector('#sci-collapse-btn')!.addEventListener('click', () => {
      this.hide();
    });

    this.setupDrag();
  }

  createToggleButton(): void {
    const toggle = document.createElement('button');
    toggle.id = 'sci-panel-toggle';
    toggle.className = 'sci-panel-toggle';
    toggle.innerHTML = '⊞';
    toggle.title = 'Show Scientific Panel';
    toggle.addEventListener('click', () => this.show());
    document.body.appendChild(toggle);
  }

  setupDrag(): void {
    const header = this.panel!.querySelector('.sci-panel-header') as HTMLElement;
    let isDragging = false;
    let startX: number, startY: number, startLeft: number, startTop: number;

    header.addEventListener('mousedown', (e: MouseEvent) => {
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = this.panel!.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      this.panel!.classList.add('dragging');
    });

    window.addEventListener('mousemove', (e: MouseEvent) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      this.panel!.style.left = (startLeft + dx) + 'px';
      this.panel!.style.top = (startTop + dy) + 'px';
      this.panel!.style.right = 'auto';
    });

    window.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        this.panel!.classList.remove('dragging');
      }
    });
  }

  initGauges(): void {
    this.gauges.magnetic = new MagneticFieldGauge('sci-magnetic-gauge');
    this.gauges.shadowResidual = new ShadowResidualGauge('sci-shadow-residual-gauge');
    this.gauges.energy = new EnergyDensityGauge('sci-energy-gauge');
    this.gauges.torque = new TorqueGauge('sci-torque-gauge');
    this.gauges.flux = new ParticleFluxGauge('sci-flux-gauge');

    this.gauges.battery = new BatteryGauge('sci-battery-gauge');
    this.gauges.solar = new SolarPanelGauge('sci-solar-gauge');
    this.gauges.led = new LEDArrayGauge('sci-led-gauge');
    this.gauges.energyFlow = new EnergyBalanceDisplay('sci-energy-flow-gauge');

    if (this.options.subscribeToHub) {
      this._unsubHub = telemetryHub.subscribe((snap) => this.applyHubSnapshot(snap), {
        immediate: true
      });
    }
  }

  applyHubSnapshot(snap: TelemetrySnapshot | null | undefined): void {
    if (!snap) return;
    const sci = snap.scientific || ({} as TelemetrySnapshot['scientific']);
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

    if (this.gauges.shadowResidual) {
      this.gauges.shadowResidual.updateFromTwin(snap.hardwareTwin ?? null);
    }
  }

  show(): void {
    this.panel!.classList.remove('collapsed');
    const toggle = document.getElementById('sci-panel-toggle');
    if (toggle) toggle.classList.add('hidden');
    this.isVisible = true;

    requestAnimationFrame(() => {
      this.gauges.magnetic!.resize();
      this.gauges.flux!.resize();
      this.gauges.battery!.resize();
      this.gauges.solar!.resize();
    });
  }

  hide(): void {
    this.panel!.classList.add('collapsed');
    const toggle = document.getElementById('sci-panel-toggle');
    if (toggle) toggle.classList.remove('hidden');
    this.isVisible = false;
  }

  toggle(): void {
    if (this.isVisible) this.hide();
    else this.show();
  }

  updateMagneticField(value: number): void {
    if (this.gauges.magnetic) {
      this.gauges.magnetic.setValue(value);
    }
  }

  updateEnergyDensity(value: number): void {
    if (this.gauges.energy) {
      this.gauges.energy.setValue(value);
    }
  }

  updateTorque(inner: number, outer: number): void {
    if (this.gauges.torque) {
      this.gauges.torque.setValues(inner, outer);
    }
  }

  updateParticleFlux(rate: number): void {
    if (this.gauges.flux) {
      this.gauges.flux.setRate(rate);
    }
  }

  updateFieldData(data: FieldUpdateData): void {
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

  cacheQueryResult(query: string, result: unknown): void {
    this.cache.set(query, {
      result: result,
      timestamp: Date.now()
    });
  }

  getCachedResult(query: string, maxAge: number = 300000): unknown {
    const entry = this.cache.get(query) as CacheEntry | undefined;
    if (!entry) return null;

    if (Date.now() - entry.timestamp > maxAge) {
      this.cache.delete(query);
      return null;
    }

    return entry.result;
  }

  clearCache(): void {
    this.cache.clear();
  }

  getCacheStats(): { size: number } {
    return {
      size: this.cache.size
    };
  }

  updateBatteryState(state: BatteryState): void {
    if (this.gauges.battery) {
      this.gauges.battery.updateState(state);
    }
  }

  updateSolarOutput(output: SolarOutput): void {
    if (this.gauges.solar) {
      this.gauges.solar.updateOutput(output);
    }
  }

  updateLEDStatus(leds: LEDStatusUpdate[]): void {
    if (this.gauges.led) {
      this.gauges.led.updateStatus(leds);
    }
  }

  updateEnergyBalance(flows: EnergyFlowsUpdate): void {
    if (this.gauges.energyFlow) {
      this.gauges.energyFlow.updateFlows(flows);
    }
  }

  destroy(): void {
    if (this._unsubHub) {
      this._unsubHub();
      this._unsubHub = null;
    }
    this.hide();
    this.panel?.remove();
    document.getElementById('sci-panel-toggle')?.remove();
  }
}
