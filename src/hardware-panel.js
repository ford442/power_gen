/**
 * Hardware connect panel — digital twin UI for Web Serial / mock transport.
 * Injects into #left-panel; streams S telemetry; coil override pad.
 */

import { HardwareBridge, TWIN_MODES } from './hardware-bridge.js';
import { ElectromagnetController } from './electromagnet-controller.js';

function bits(mask, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push((mask >> i) & 1);
  return out;
}

export class HardwarePanel {
  /**
   * @param {object} options
   * @param {import('./multi-device-visualizer.js').MultiDeviceVisualizer} [options.visualizer]
   * @param {HardwareBridge} [options.bridge]
   */
  constructor(options = {}) {
    this.visualizer = options.visualizer || null;
    this.bridge = options.bridge || null;
    this._root = null;
    this._unsub = null;
    this._raf = 0;
  }

  /**
   * Attach bridge + inject UI. Creates bridge if missing.
   * @param {import('./multi-device-visualizer.js').MultiDeviceVisualizer} visualizer
   */
  attach(visualizer) {
    this.visualizer = visualizer;
    if (!visualizer.hardwareBridge) {
      visualizer.emController = visualizer.emController || new ElectromagnetController();
      visualizer.hardwareBridge = new HardwareBridge({
        onStatusChange: (s) => this._renderStatus(s),
        onSensorData: (s) => this._renderSensors(s),
        onError: (e) => this._setError(e.message || String(e)),
        onTwinModeChange: (m) => this._syncTwinUI(m)
      });
    }
    this.bridge = visualizer.hardwareBridge;
    if (!visualizer.emController) {
      visualizer.emController = new ElectromagnetController(this.bridge.config);
    }
    this._inject();
    this._wire();
    this._renderStatus(this.bridge.status);
    this._loop();
  }

  _inject() {
    const left = document.getElementById('left-panel');
    if (!left || document.getElementById('hardware-panel')) return;

    const el = document.createElement('div');
    el.id = 'hardware-panel';
    el.className = 'hw-panel';
    el.innerHTML = `
      <div class="ctrl-section-title">Hardware Twin</div>
      <div class="hw-status-row">
        <span class="hw-dot" id="hwDot"></span>
        <span id="hwStatusText">Disconnected</span>
        <span class="hw-serial-badge" id="hwSerialBadge"></span>
      </div>
      <div class="hw-btn-row">
        <button type="button" class="seg-op-btn" id="hwConnectBtn">Connect</button>
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
        </div>
      </div>
      <div class="ctrl-section-title" style="margin-top:10px">Coil override</div>
      <div class="hw-coil-pad" id="hwCoilPad"></div>
      <div class="hw-btn-row">
        <button type="button" class="seg-op-btn" id="hwClearManualBtn">Clear override</button>
        <button type="button" class="seg-op-btn" id="hwBrakeBtn">Brake</button>
      </div>
      <div class="hw-error" id="hwError"></div>
      <p class="hw-hint">Chrome/Edge + Web Serial. Protocol: docs/hardware_connection.md</p>
    `;
    left.appendChild(el);
    this._root = el;

    // Coil pad buttons
    const pad = el.querySelector('#hwCoilPad');
    const n = this.bridge?.config?.numCoils || 8;
    for (let i = 0; i < n; i++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'hw-coil-btn';
      b.dataset.coil = String(i);
      b.textContent = String(i);
      b.title = `Toggle coil ${i}`;
      pad.appendChild(b);
    }

    this._injectStyles();
  }

  _injectStyles() {
    if (document.getElementById('hw-panel-styles')) return;
    const s = document.createElement('style');
    s.id = 'hw-panel-styles';
    s.textContent = `
      .hw-panel { margin-top: 12px; padding-top: 10px; border-top: 1px solid #0ff3; font-size: 0.75rem; }
      .hw-status-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
      .hw-dot { width: 8px; height: 8px; border-radius: 50%; background: #555; box-shadow: 0 0 6px #000; }
      .hw-dot.on { background: #0f8; box-shadow: 0 0 8px #0f8; }
      .hw-dot.mock { background: #fa0; box-shadow: 0 0 8px #fa0; }
      .hw-dot.err { background: #f44; }
      .hw-serial-badge { margin-left: auto; color: #678; font-size: 0.65rem; }
      .hw-btn-row { display: flex; gap: 6px; margin: 6px 0; flex-wrap: wrap; }
      .hw-btn-row .seg-op-btn { flex: 1; min-width: 70px; font-size: 0.7rem; padding: 6px 4px; }
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

  _wire() {
    const b = this.bridge;
    document.getElementById('hwConnectBtn')?.addEventListener('click', async () => {
      this._setError('');
      if (!HardwareBridge.isSerialSupported()) {
        this._setError('Web Serial not available — use Mock');
        return;
      }
      await b.connect();
    });
    document.getElementById('hwMockBtn')?.addEventListener('click', async () => {
      this._setError('');
      await b.connectMock();
    });
    document.getElementById('hwDisconnectBtn')?.addEventListener('click', async () => {
      await b.disconnect();
      this._renderSensors(null);
    });
    document.getElementById('hwTwinMode')?.addEventListener('change', (e) => {
      b.setTwinMode(e.target.value);
    });
    document.getElementById('hwClearManualBtn')?.addEventListener('click', () => {
      b.clearManual();
      this._paintCoilPad(0);
    });
    document.getElementById('hwBrakeBtn')?.addEventListener('click', () => b.brake());

    document.getElementById('hwCoilPad')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-coil]');
      if (!btn) return;
      const i = parseInt(btn.dataset.coil, 10);
      let mask = b.manualCoilMask;
      if (mask & (1 << i)) mask &= ~(1 << i);
      else mask |= (1 << i);
      if (mask === 0) b.clearManual();
      else b.setManualCoils(mask, 255);
      this._paintCoilPad(mask);
    });

    // Feature badge
    const badge = document.getElementById('hwSerialBadge');
    if (badge) {
      badge.textContent = HardwareBridge.isSerialSupported() ? 'Web Serial' : 'No serial API';
    }
  }

  _renderStatus(status) {
    const dot = document.getElementById('hwDot');
    const text = document.getElementById('hwStatusText');
    const conn = document.getElementById('hwConnectBtn');
    const mock = document.getElementById('hwMockBtn');
    const disc = document.getElementById('hwDisconnectBtn');
    if (dot) {
      dot.className = 'hw-dot'
        + (status === 'connected' ? ' on' : '')
        + (status === 'mock' ? ' mock' : '')
        + (status === 'error' ? ' err' : '');
    }
    if (text) {
      const labels = {
        disconnected: 'Disconnected',
        connecting: 'Connecting…',
        connected: 'Connected',
        mock: 'Mock stream',
        error: 'Error'
      };
      text.textContent = labels[status] || status;
    }
    const live = status === 'connected' || status === 'mock';
    if (conn) conn.disabled = live || status === 'connecting';
    if (mock) mock.disabled = live || status === 'connecting';
    if (disc) disc.disabled = !live;
  }

  _renderSensors(snap) {
    const set = (id, v) => {
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
    const n = this.bridge.config.numCoils || 8;
    set('hwHall', bits(snap.hallMask, n).join(''));
    set('hwCoils', bits(snap.coilMask, n).join(''));
    if (!this.bridge.manualMode) this._paintCoilPad(snap.coilMask);

    const shadowRow = document.getElementById('hwShadowRow');
    if (shadowRow) {
      const show = this.bridge.twinMode === TWIN_MODES.SHADOW;
      shadowRow.style.display = show ? 'block' : 'none';
      if (show && snap.shadow) {
        set('hwPhaseErr', snap.shadow.phaseErrorDeg.toFixed(1));
        set('hwRpmErr', snap.shadow.rpmError.toFixed(1));
      }
    }
  }

  _paintCoilPad(mask) {
    document.querySelectorAll('#hwCoilPad .hw-coil-btn').forEach((btn) => {
      const i = parseInt(btn.dataset.coil, 10);
      btn.classList.toggle('on', !!(mask & (1 << i)));
    });
  }

  _syncTwinUI(mode) {
    const sel = document.getElementById('hwTwinMode');
    if (sel && sel.value !== mode) sel.value = mode;
    const shadowRow = document.getElementById('hwShadowRow');
    if (shadowRow) shadowRow.style.display = mode === TWIN_MODES.SHADOW ? 'block' : 'none';
  }

  _setError(msg) {
    const el = document.getElementById('hwError');
    if (el) el.textContent = msg || '';
  }

  _loop() {
    // Keep UI fresh even if sensor callback is quiet
    const tick = () => {
      if (this.bridge?.isConnected && this.bridge.lastSensorUpdate) {
        this._renderSensors(this.bridge.getSensorSnapshot());
      }
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }

  destroy() {
    cancelAnimationFrame(this._raf);
    this._root?.remove();
  }
}

/**
 * @param {import('./multi-device-visualizer.js').MultiDeviceVisualizer} visualizer
 */
export function initHardwarePanel(visualizer) {
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
