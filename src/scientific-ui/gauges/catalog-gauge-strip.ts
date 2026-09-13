/**
 * Generic catalog gauge strip — one DOM strip that renders whatever
 * `telemetryKeys` the focused device declares in `physics/devices.json`.
 *
 * Replaces "a bespoke gauge class per device": labels, units and precision come
 * from `DEVICE_TELEMETRY_FIELDS`, values from `TelemetryHub.devices[id]`. The
 * SEG-specific gauges (field, energy density, torque, flux) stay as they are and
 * own SEG focus.
 *
 * Values are **simulated** plant state, not calibrated instrument readings
 * (ADR-0004, docs/DEVICE_GALLERY.md).
 */

import {
  deviceLabel,
  formatTelemetryValue,
  readTelemetryKey,
  telemetryFieldsForDevice,
  type DeviceTelemetryField
} from '../../telemetry/telemetry-fields';
import type { DeviceTelemetrySnap } from '../../telemetry/types';

export class CatalogGaugeStrip {
  container: HTMLElement | null;
  private _titleEl: HTMLElement | null = null;
  private _gridEl: HTMLElement | null = null;
  private _signature = '';
  private _valueEls: HTMLElement[] = [];
  private _fields: readonly DeviceTelemetryField[] = [];

  constructor(containerId: string) {
    this.container = document.getElementById(containerId);
    this.render();
  }

  render(): void {
    if (!this.container) return;
    this.container.innerHTML = `
      <div class="sci-gauge-header">
        <span class="sci-gauge-label">Device Telemetry</span>
        <span class="sci-gauge-value" data-catalog-device>—</span>
      </div>
      <div class="sci-gauge-container sci-catalog-strip">
        <div class="sci-catalog-grid" data-catalog-grid></div>
        <p class="sci-shadow-hint">Catalog keys for the focused device — simulated plant state, not metrology.</p>
      </div>
    `;
    this._titleEl = this.container.querySelector('[data-catalog-device]');
    this._gridEl = this.container.querySelector('[data-catalog-grid]');
  }

  /** Point the strip at a focused view; SEG / overview hide it. */
  update(view: string, device: DeviceTelemetrySnap | null | undefined): void {
    if (!this.container) return;
    const fields = telemetryFieldsForDevice(view);

    if (!fields.length || !device) {
      this.container.hidden = true;
      return;
    }

    this.container.hidden = false;
    if (this._titleEl) this._titleEl.textContent = deviceLabel(view);

    const signature = `${view}:${fields.map((f) => f.key).join(',')}`;
    if (signature !== this._signature) {
      this._buildCells(fields);
      this._signature = signature;
    }

    this._fields.forEach((f, i) => {
      const el = this._valueEls[i];
      if (el) el.textContent = formatTelemetryValue(readTelemetryKey(device, f.key), f);
    });
  }

  private _buildCells(fields: readonly DeviceTelemetryField[]): void {
    const grid = this._gridEl;
    if (!grid) return;
    grid.textContent = '';
    this._fields = fields;
    this._valueEls = fields.map((f) => {
      const cell = document.createElement('div');
      cell.className = 'sci-catalog-cell';
      const label = document.createElement('span');
      label.className = 'sci-catalog-key';
      label.textContent = f.label;
      label.title = `${f.key}${f.unit ? ` (${f.unit})` : ''}`;
      const value = document.createElement('b');
      value.className = 'sci-catalog-val';
      value.dataset.column = f.column;
      cell.append(label, value);
      grid.appendChild(cell);
      return value;
    });
  }
}
