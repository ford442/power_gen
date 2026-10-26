/**
 * Hardware connect panel — digital twin UI for the mock / Serial / Bluetooth /
 * WebUSB transports (ADR-0005 WS3).
 * Injects into #left-panel; streams S telemetry; coil override pad.
 *
 * Buttons for links this browser cannot open are disabled rather than hidden,
 * so a classroom can see *why* the wireless twin isn't offered here.
 */

import { HardwareBridge, TWIN_MODES, type SensorSnapshot } from './hardware-bridge';
import { syncHardwareTwinBadgeFromBridge } from './hardware-twin-badge';
import { ElectromagnetController } from './electromagnet-controller';

function bits(mask: number, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((mask >> i) & 1);
  return out;
}

export interface HardwarePanelVisualizer {
  hardwareBridge?: HardwareBridge | null;
  emController?: ElectromagnetController | null;
}

export interface HardwarePanelOptions {
  visualizer?: HardwarePanelVisualizer | null;
  bridge?: HardwareBridge | null;
}

export class HardwarePanel {
  visualizer: HardwarePanelVisualizer | null;
  bridge: HardwareBridge | null;
  private _root: HTMLElement | null;
  /** Bridge event subscriptions (status / sensor / twinMode / error). */
  private _unsub: Array<() => void>;
  /** Aborts every DOM listener `_wire` added — on re-attach and destroy. */
  private _wireAbort: AbortController | null;
  private _raf: number;
  private _collapsed: boolean;

  constructor(options: HardwarePanelOptions = {}) {
    this.visualizer = options.visualizer || null;
    this.bridge = options.bridge || null;
    this._root = null;
    this._unsub = [];
    this._wireAbort = null;
    this._raf = 0;
    this._collapsed = false;
  }

  /**
   * Attach bridge + inject UI. Creates bridge if missing.
   *
   * The bridge usually already exists (LabSession owns it and its `onError`
   * slot), so the panel listens through `bridge.on(...)` rather than the
   * constructor callbacks. Idempotent: attaching again to the same bridge only
   * refreshes the status; a different bridge drops the old subscriptions and
   * button handlers first, so nothing fires twice.
   */
  attach(visualizer: HardwarePanelVisualizer): void {
    this.visualizer = visualizer;
    if (!visualizer.hardwareBridge) {
      visualizer.hardwareBridge = new HardwareBridge();
    }
    const bridge = visualizer.hardwareBridge;
    if (!visualizer.emController) {
      visualizer.emController = new ElectromagnetController(bridge.config);
    }
    const injected = this._inject(bridge);
    if (this.bridge === bridge && this._unsub.length) {
      if (injected) {
        // Panel DOM was rebuilt: its buttons need handlers, and the new select
        // starts on 'open' whatever mode the bridge is in.
        this._wire();
        this._syncTwinUI(bridge.twinMode);
      }
      this._renderStatus(bridge.status);
      return;
    }
    this._detachBridge();
    this.bridge = bridge;
    this._unsub = [
      bridge.on('status', (st) => this._renderStatus(st)),
      bridge.on('sensor', (snap) => this._renderSensors(snap)),
      bridge.on('error', (e) => this._setError(e.message || String(e))),
      bridge.on('twinMode', (m) => this._syncTwinUI(m))
    ];
    this._wire();
    this._renderStatus(bridge.status);
    this._syncTwinUI(bridge.twinMode);
    this._loop();
  }

  private _detachBridge(): void {
    for (const off of this._unsub) off();
    this._unsub = [];
    this._wireAbort?.abort();
    this._wireAbort = null;
    cancelAnimationFrame(this._raf);
    this._raf = 0;
  }

  /** Returns true when it created the panel element (false if present or no host). */
  private _inject(bridge: HardwareBridge): boolean {
    const left = document.getElementById('left-panel');
    if (!left || document.getElementById('hardware-panel')) return false;

    const el = document.createElement('div');
    el.id = 'hardware-panel';
    el.className = 'hw-panel';
    el.innerHTML = `
      <div class="ctrl-section-title hw-title" id="hwTitle" role="button" tabindex="0" aria-controls="hardware-panel">Hardware Twin</div>
      <div class="hw-status-row">
        <span class="hw-dot" id="hwDot"></span>
        <span id="hwStatusText">Disconnected</span>
        <span class="hw-serial-badge" id="hwSerialBadge"></span>
      </div>
      <div class="hw-btn-row">
        <button type="button" class="seg-op-btn" id="hwConnectBtn" title="USB CDC serial port">Serial</button>
        <button type="button" class="seg-op-btn" id="hwBleBtn" title="Wireless Nordic UART (BLE)">BLE</button>
        <button type="button" class="seg-op-btn" id="hwUsbBtn" title="Raw WebUSB CDC — only if Serial can't see the board">USB</button>
        <button type="button" class="seg-op-btn" id="hwMockBtn" title="No Arduino required">Mock</button>
        <button type="button" class="seg-op-btn seg-op-btn-estop" id="hwDisconnectBtn" disabled>Disconnect</button>
      </div>
      <div class="hw-twin-row">
        <label>Mode
          <select id="hwTwinMode" class="hw-select">
            <option value="open">Open-loop (sim → HW)</option>
            <option value="closed">Closed-loop (HW → viz)</option>
            <option value="shadow">Shadow (compare)</option>
          </select>
        </label>
      </div>
      <div class="hw-stream" id="hwStream">
        <div><span class="hw-k">Phase</span> <span id="hwPhase">—</span>°</div>
        <div><span class="hw-k">RPM</span> <span id="hwRpm">—</span></div>
        <div><span class="hw-k">|B|</span> <span id="hwMag">—</span> µT</div>
        <div><span class="hw-k">Hall</span> <span id="hwHall" class="hw-bits">—</span></div>
        <div><span class="hw-k">Coils</span> <span id="hwCoils" class="hw-bits">—</span></div>
        <div id="hwShadowRow" class="hw-shadow" style="display:none">
          <span class="hw-k">Δφ</span> <span id="hwPhaseErr">—</span>°
          · <span class="hw-k">ΔRPM</span> <span id="hwRpmErr">—</span>
          · <span class="hw-k">ΔV</span> <span id="hwVoltErr">—</span>
          · <span class="hw-k">ΔI</span> <span id="hwCurrErr">—</span>
        </div>
      </div>
      <div class="ctrl-section-title" style="margin-top:10px">Coil override</div>
      <div class="hw-coil-pad" id="hwCoilPad"></div>
      <div class="hw-btn-row">
        <button type="button" class="seg-op-btn" id="hwClearManualBtn">Clear override</button>
        <button type="button" class="seg-op-btn" id="hwBrakeBtn">Brake</button>
      </div>
      <div class="hw-error" id="hwError"></div>
      <p class="hw-hint">Chrome/Edge. Serial is the reference link; BLE is ~20 Hz. Protocol: docs/hardware_connection.md</p>
    `;
    left.appendChild(el);
    this._root = el;

    // Lab mode (src/lab-mode.ts) decides whether the panel starts folded away.
    const title = el.querySelector<HTMLElement>('#hwTitle');
    const toggle = (): void => this.setCollapsed(!this._collapsed);
    title?.addEventListener('click', toggle);
    title?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      }
    });
    this.setCollapsed(document.body.dataset.hwPanel === 'collapsed');

    // Coil pad buttons
    const pad = el.querySelector('#hwCoilPad');
    // `bridge`, not `this.bridge`: on first attach the field is not set yet.
    const n = bridge.config?.numCoils || 8;
    for (let i = 0; i < n; i++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'hw-coil-btn';
      b.dataset.coil = String(i);
      b.textContent = String(i);
      b.title = `Toggle coil ${i}`;
      pad?.appendChild(b);
    }

    this._injectStyles();
    return true;
  }

  /**
   * Fold the panel down to its title. Folding never disconnects or coasts: the
   * link, the coil override and the header badge carry on underneath.
   */
  setCollapsed(collapsed: boolean): void {
    this._collapsed = collapsed;
    const root = this._root;
    if (!root) return;
    root.dataset.collapsed = String(collapsed);
    root.querySelector('#hwTitle')?.setAttribute('aria-expanded', String(!collapsed));
  }

  private _injectStyles(): void {
    if (document.getElementById('hw-panel-styles')) return;
    const s = document.createElement('style');
    s.id = 'hw-panel-styles';
    s.textContent = `
      .hw-panel { margin-top: 12px; padding-top: 10px; border-top: 1px solid #0ff3; font-size: 0.75rem; }
      .hw-title { cursor: pointer; user-select: none; }
      .hw-title::after { content: ' ▾'; color: #0aa; }
      .hw-panel[data-collapsed="true"] .hw-title::after { content: ' ▸'; }
      .hw-panel[data-collapsed="true"] > :not(.hw-title) { display: none; }
      .hw-status-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
      .hw-dot { width: 8px; height: 8px; border-radius: 50%; background: #555; box-shadow: 0 0 6px #000; }
      .hw-dot.on { background: #0f8; box-shadow: 0 0 8px #0f8; }
      .hw-dot.mock { background: #fa0; box-shadow: 0 0 8px #fa0; }
      .hw-dot.err { background: #f44; }
      .hw-serial-badge { margin-left: auto; color: #678; font-size: 0.65rem; }
      .hw-btn-row { display: flex; gap: 6px; margin: 6px 0; flex-wrap: wrap; }
      .hw-btn-row .seg-op-btn { flex: 1; min-width: 70px; font-size: 0.7rem; padding: 6px 4px; }
      .hw-btn-row .seg-op-btn[data-unsupported] { opacity: 0.4; text-decoration: line-through; }
      .hw-select { width: 100%; background: #0a1520; color: #0ff; border: 1px solid #0ff5; border-radius: 4px; padding: 4px; margin-top: 4px; }
      .hw-stream { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 8px; color: #9cf; background: #061018; padding: 8px; border-radius: 4px; border: 1px solid #0ff2; }
      .hw-k { color: #567; margin-right: 4px; }
      .hw-bits { font-family: ui-monospace, monospace; letter-spacing: 1px; }
      .hw-shadow { grid-column: 1 / -1; color: #fc6; }
      .hw-coil-pad { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; margin: 6px 0; }
      .hw-coil-btn { background: #111; border: 1px solid #0ff4; color: #0aa; border-radius: 4px; padding: 6px; cursor: pointer; }
      .hw-coil-btn.on { background: #063; border-color: #0f8; color: #0f8; box-shadow: 0 0 8px #0f84; }
      .hw-error { color: #f66; min-height: 1em; margin-top: 4px; font-size: 0.7rem; }
      .hw-hint { color: #456; font-size: 0.65rem; margin: 6px 0 0; line-height: 1.3; }
    `;
    document.head.appendChild(s);
  }

  private _wire(): void {
    const b = this.bridge;
    if (!b) return;
    this._wireAbort?.abort();
    this._wireAbort = new AbortController();
    const { signal } = this._wireAbort;
    document.getElementById('hwConnectBtn')?.addEventListener('click', async () => {
      this._setError('');
      if (!HardwareBridge.isSerialSupported()) {
        this._setError('Web Serial not available — use Mock');
        return;
      }
      await b.connectSerial();
    }, { signal });
    document.getElementById('hwBleBtn')?.addEventListener('click', async () => {
      this._setError('');
      if (!HardwareBridge.isBluetoothSupported()) {
        this._setError('Web Bluetooth not available — use Serial or Mock');
        return;
      }
      await b.connectBluetooth();
    }, { signal });
    document.getElementById('hwUsbBtn')?.addEventListener('click', async () => {
      this._setError('');
      if (!HardwareBridge.isWebUsbSupported()) {
        this._setError('WebUSB not available — use Serial or Mock');
        return;
      }
      await b.connectUsb();
    }, { signal });
    document.getElementById('hwMockBtn')?.addEventListener('click', async () => {
      this._setError('');
      await b.connectMock();
    }, { signal });
    document.getElementById('hwDisconnectBtn')?.addEventListener('click', async () => {
      await b.disconnect();
      this._renderSensors(null);
    }, { signal });
    document.getElementById('hwTwinMode')?.addEventListener('change', (e) => {
      b.setTwinMode((e.target as HTMLSelectElement).value);
    }, { signal });
    document.getElementById('hwClearManualBtn')?.addEventListener('click', () => {
      b.clearManual();
      this._paintCoilPad(0);
    }, { signal });
    document.getElementById('hwBrakeBtn')?.addEventListener('click', () => b.brake(), { signal });

    document.getElementById('hwCoilPad')?.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('[data-coil]') as HTMLElement | null;
      if (!btn) return;
      const i = parseInt(btn.dataset.coil || '0', 10);
      let mask = b.manualCoilMask;
      if (mask & (1 << i)) mask &= ~(1 << i);
      else mask |= (1 << i);
      if (mask === 0) b.clearManual();
      else b.setManualCoils(mask, 1.0);
      this._paintCoilPad(mask);
    }, { signal });

    // Feature badge: which links this browser could actually open.
    const badge = document.getElementById('hwSerialBadge');
    if (badge) {
      const kinds = HardwareBridge.supportedTransports().filter((k) => k !== 'mock');
      badge.textContent = kinds.length ? kinds.join(' / ') : 'mock only';
    }

    // Disable links this browser lacks (Safari/Firefox: no Serial, no BLE, no USB).
    const gate = (id: string, supported: boolean, why: string) => {
      const el = document.getElementById(id) as HTMLButtonElement | null;
      if (!el || supported) return;
      el.disabled = true;
      el.dataset.unsupported = '1';
      el.title = why;
    };
    gate('hwConnectBtn', HardwareBridge.isSerialSupported(), 'Web Serial unavailable in this browser');
    gate('hwBleBtn', HardwareBridge.isBluetoothSupported(), 'Web Bluetooth unavailable in this browser');
    gate('hwUsbBtn', HardwareBridge.isWebUsbSupported(), 'WebUSB unavailable in this browser');
  }

  private _renderStatus(status: string): void {
    const dot = document.getElementById('hwDot');
    const text = document.getElementById('hwStatusText');
    const conn = document.getElementById('hwConnectBtn') as HTMLButtonElement | null;
    const mock = document.getElementById('hwMockBtn') as HTMLButtonElement | null;
    const disc = document.getElementById('hwDisconnectBtn') as HTMLButtonElement | null;
    const live = this.bridge?.isConnected ?? false;
    if (dot) {
      dot.className = 'hw-dot'
        + (live && status !== 'mock' ? ' on' : '')
        + (status === 'mock' ? ' mock' : '')
        + (status === 'error' ? ' err' : '');
    }
    if (text) {
      const labels: Record<string, string> = {
        disconnected: 'Disconnected',
        connecting: 'Connecting…',
        connected: 'Serial connected',
        mock: 'Mock stream',
        bluetooth: 'BLE connected',
        usb: 'WebUSB connected',
        error: 'Error'
      };
      text.textContent = labels[status] || status;
    }
    const busy = live || status === 'connecting';
    const ble = document.getElementById('hwBleBtn') as HTMLButtonElement | null;
    const usb = document.getElementById('hwUsbBtn') as HTMLButtonElement | null;
    for (const [btn, supported] of [
      [conn, HardwareBridge.isSerialSupported()],
      [ble, HardwareBridge.isBluetoothSupported()],
      [usb, HardwareBridge.isWebUsbSupported()],
      [mock, true]
    ] as Array<[HTMLButtonElement | null, boolean]>) {
      if (btn) btn.disabled = busy || !supported;
    }
    if (disc) disc.disabled = !live;
    if (status === 'error' && this.bridge?.lastError) this._setError(this.bridge.lastError);
    syncHardwareTwinBadgeFromBridge(this.bridge);
  }

  private _renderSensors(snap: SensorSnapshot | null): void {
    const set = (id: string, v: string) => {
      const el = document.getElementById(id);
      if (el) el.textContent = v;
    };
    if (!snap) {
      set('hwPhase', '—');
      set('hwRpm', '—');
      set('hwMag', '—');
      set('hwHall', '—');
      set('hwCoils', '—');
      return;
    }
    set('hwPhase', snap.phase.toFixed(1));
    set('hwRpm', snap.rpm.toFixed(1));
    set('hwMag', (snap.magMagnitudeUt ?? 0).toFixed(1));
    const n = this.bridge?.config.numCoils || 8;
    set('hwHall', bits(snap.hallMask, n).join(''));
    set('hwCoils', bits(snap.coilMask, n).join(''));
    if (!this.bridge?.manualMode) this._paintCoilPad(snap.coilMask);

    const shadowRow = document.getElementById('hwShadowRow');
    if (shadowRow) {
      const show = this.bridge?.twinMode === TWIN_MODES.SHADOW;
      shadowRow.style.display = show ? 'block' : 'none';
      if (show && snap.shadow) {
        set('hwPhaseErr', snap.shadow.phaseErrorDeg.toFixed(1));
        set('hwRpmErr', snap.shadow.rpmError.toFixed(1));
        const vErr = snap.shadow.voltageError ?? 0;
        const iErr = snap.shadow.currentError ?? 0;
        set('hwVoltErr', `${vErr >= 0 ? '+' : ''}${vErr.toFixed(2)} V`);
        set('hwCurrErr', `${iErr >= 0 ? '+' : ''}${iErr.toFixed(2)} A`);
      }
    }
  }

  private _paintCoilPad(mask: number): void {
    document.querySelectorAll<HTMLElement>('#hwCoilPad .hw-coil-btn').forEach((btn) => {
      const i = parseInt(btn.dataset.coil || '0', 10);
      btn.classList.toggle('on', !!(mask & (1 << i)));
    });
  }

  private _syncTwinUI(mode: string): void {
    const sel = document.getElementById('hwTwinMode') as HTMLSelectElement | null;
    if (sel && sel.value !== mode) sel.value = mode;
    const shadowRow = document.getElementById('hwShadowRow') as HTMLElement | null;
    if (shadowRow) shadowRow.style.display = mode === TWIN_MODES.SHADOW ? 'block' : 'none';
  }

  private _setError(msg: string): void {
    const el = document.getElementById('hwError');
    if (el) el.textContent = msg || '';
  }

  private _loop(): void {
    // Keep UI fresh even if sensor callback is quiet
    cancelAnimationFrame(this._raf);
    const tick = () => {
      if (this.bridge?.isConnected && this.bridge.lastSensorUpdate) {
        this._renderSensors(this.bridge.getSensorSnapshot());
      }
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }

  destroy(): void {
    this._detachBridge();
    this.bridge = null;
    this._root?.remove();
    this._root = null;
  }
}

export function initHardwarePanel(visualizer: HardwarePanelVisualizer): HardwarePanel {
  if (window.hardwarePanel) {
    window.hardwarePanel.attach(visualizer);
    return window.hardwarePanel;
  }
  const panel = new HardwarePanel();
  panel.attach(visualizer);
  window.hardwarePanel = panel;
  window.HardwareBridge = HardwareBridge;
  return panel;
}
