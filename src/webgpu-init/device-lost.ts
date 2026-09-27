/**
 * `device.lost` / `uncapturederror` wiring and the reload overlay. Split out of
 * webgpu-manager.ts; recovery itself (`WebGPUManager.reinit()`) stays on the manager.
 */

export interface DeviceLostInfo {
  reason?: string;
  message?: string;
}

export interface DeviceHookHandlers {
  /** Called first, before any handler — the manager flips its `deviceLost` flag here. */
  markLost: () => void;
  /** Custom loss handler; when null the reload overlay is shown instead. */
  onDeviceLost: ((info: DeviceLostInfo) => void) | null;
  onUncapturedError: ((event: GPUUncapturedErrorEvent) => void) | null;
}

export function attachDeviceHooks(device: GPUDevice, h: DeviceHookHandlers): void {
  device.lost.then((info) => {
    h.markLost();
    const reason = info?.reason || 'unknown';
    const message = info?.message || 'GPU device was lost';
    console.error('[WebGPU] device.lost:', reason, message);

    if (h.onDeviceLost) {
      try {
        h.onDeviceLost({ reason, message });
      } catch (e) {
        console.warn('[WebGPU] onDeviceLost handler threw:', e);
      }
    } else {
      showDeviceLostUI({ reason, message });
    }
  });

  device.addEventListener('uncapturederror', (event) => {
    const err = event.error;
    console.error('[WebGPU] uncapturederror:', err?.message || err);
    if (h.onUncapturedError) {
      try {
        h.onUncapturedError(event);
      } catch (e) {
        console.warn('[WebGPU] onUncapturedError handler threw:', e);
      }
    }
  });
}

export function showDeviceLostUI(info: DeviceLostInfo = {}): void {
  if (typeof document === 'undefined') return;

  const existing = document.getElementById('webgpu-device-lost');
  if (existing) existing.remove();

  const el = document.createElement('div');
  el.id = 'webgpu-device-lost';
  el.setAttribute('role', 'alert');
  el.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:100000',
    'display:flex', 'align-items:center', 'justify-content:center',
    'background:rgba(0,0,0,0.82)', 'color:#e8f4ff',
    'font-family:system-ui,Segoe UI,sans-serif', 'padding:24px', 'text-align:center'
  ].join(';');

  const reason = info.reason || 'unknown';
  const detail = info.message || 'The GPU device was lost.';
  el.innerHTML = `
      <div style="max-width:420px">
        <h2 style="margin:0 0 12px;font-size:1.25rem;color:#0ff">WebGPU device lost</h2>
        <p style="margin:0 0 8px;opacity:0.9;font-size:0.95rem">${escapeHtml(detail)}</p>
        <p style="margin:0 0 20px;opacity:0.65;font-size:0.8rem">Reason: ${escapeHtml(reason)}</p>
        <button type="button" id="webgpu-device-lost-reload"
          style="cursor:pointer;padding:10px 20px;border:1px solid #0ff;background:#062a33;color:#0ff;border-radius:6px;font-size:0.95rem">
          Reload page
        </button>
      </div>
    `;
  document.body.appendChild(el);
  el.querySelector('#webgpu-device-lost-reload')?.addEventListener('click', () => {
    location.reload();
  });
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
