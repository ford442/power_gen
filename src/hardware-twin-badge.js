/**
 * Global header badge for hardware twin connection state.
 * States: disconnected | mock | serial
 */

const LABELS = {
  disconnected: 'Twin off',
  mock: 'Twin mock',
  serial: 'Twin serial',
  connecting: 'Twin…',
  error: 'Twin error'
};

/**
 * @param {'disconnected'|'mock'|'serial'|'connecting'|'error'} state
 */
export function syncHardwareTwinBadge(state) {
  if (typeof document === 'undefined') return;
  const el = document.getElementById('hw-twin-badge');
  const text = document.getElementById('hwTwinBadgeText');
  if (!el) return;
  const kind = state === 'connected' ? 'serial' : state;
  el.dataset.state = kind;
  if (text) text.textContent = LABELS[kind] || LABELS.disconnected;
}

/** Map bridge.status → badge state. */
export function syncHardwareTwinBadgeFromBridge(bridge) {
  if (!bridge) {
    syncHardwareTwinBadge('disconnected');
    return;
  }
  syncHardwareTwinBadge(bridge.connectionKind || bridge.status || 'disconnected');
}
