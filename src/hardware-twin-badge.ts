/**
 * Global header badge for hardware twin connection state.
 * States: disconnected | mock | serial | bluetooth | usb (ADR-0005 WS3).
 */

export type HardwareTwinBadgeState =
  | 'disconnected'
  | 'mock'
  | 'serial'
  | 'bluetooth'
  | 'usb'
  | 'connecting'
  | 'error'
  | 'connected';

const LABELS: Record<string, string> = {
  disconnected: 'Twin off',
  mock: 'Twin mock',
  serial: 'Twin serial',
  bluetooth: 'Twin BLE',
  usb: 'Twin USB',
  connecting: 'Twin…',
  error: 'Twin error'
};

export function syncHardwareTwinBadge(state: HardwareTwinBadgeState): void {
  if (typeof document === 'undefined') return;
  const el = document.getElementById('hw-twin-badge');
  const text = document.getElementById('hwTwinBadgeText');
  if (!el) return;
  const kind = state === 'connected' ? 'serial' : state;
  el.dataset.state = kind;
  if (text) text.textContent = LABELS[kind] || LABELS.disconnected;
}

/** Map bridge.status → badge state. */
export function syncHardwareTwinBadgeFromBridge(bridge: { connectionKind?: string; status?: string } | null | undefined): void {
  if (!bridge) {
    syncHardwareTwinBadge('disconnected');
    return;
  }
  syncHardwareTwinBadge((bridge.connectionKind || bridge.status || 'disconnected') as HardwareTwinBadgeState);
}
