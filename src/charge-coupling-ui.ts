/**
 * Operator-panel wiring for the lab charge bus (ADR-0013).
 *
 * Kept out of main.ts: the bus has one checkbox, one source line and one
 * overview disclaimer, and none of it needs anything main.ts owns.
 */
import { telemetryHub } from './telemetry-hub';
import { syncChargeCouplingDisclaimer } from './renderers/shared/charge-network';

function formatV(v: number): string {
  return Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)} kV` : `${v.toFixed(0)} V`;
}

/**
 * Reflect the charge bus in the operator panel: name the source device and the
 * seed it is writing, or say the bench is isolated.
 */
export function syncChargeCouplingUI(): void {
  const net = window.multiVisualizer?.chargeNetwork ?? null;
  const snap = net?.getSnapshot?.() ?? null;
  const coupled = !!(snap?.couplingEnabled ?? net?.couplingEnabled);

  // `coupled` is authoritative and synchronous; a cached link still reads
  // active until the next frame's ChargeNetwork.update(), so never present
  // Kelvin as seeded once the bus itself is off.
  const link = net?.getLinkForDestination?.('kelvin') ?? null;
  const active = coupled && !!link?.active;
  const source = document.getElementById('chargeCouplingSource');
  if (source) {
    source.textContent = active && link
      ? `Kelvin seed: ${link.from} · ${formatV(link.appliedV)} from ${formatV(link.sourceV)} on the sphere`
        + ` (simulated, not calibrated kilovolts)${link.clamped ? ' · clamped at breakdown' : ''}`
      : coupled
        ? 'Kelvin seed: waiting for the VdG bench (switched off or not yet stepped)'
        : 'Kelvin seed: isolated bench (own start-up imbalance)';
    source.dataset.coupled = active ? 'true' : 'false';
  }

  document.body.classList.toggle('charge-coupled', coupled);
  if (snap) syncChargeCouplingDisclaimer(coupled, snap);
}

/**
 * Lab charge bus toggle. Off (the default) leaves Kelvin and the VdG isolated;
 * on, Kelvin's induction is biased by the sphere estimate. Independent of
 * `setFieldCoupling` and the energy toggle — setting one never sets another.
 */
export function setChargeCoupling(enabled: boolean): void {
  const net = window.multiVisualizer?.chargeNetwork;
  net?.setCouplingEnabled?.(!!enabled);
  const toggle = document.getElementById('chargeCouplingToggle') as HTMLInputElement | null;
  if (toggle) toggle.checked = !!enabled;
  syncChargeCouplingUI();
}

/**
 * Wire the checkbox and keep the seed readout live, repainted off the hub at
 * ~4 Hz like the field bus — the hub publishes, the panel paints.
 */
export function wireChargeCouplingControls(): void {
  window.setChargeCoupling = setChargeCoupling;
  window.syncChargeCouplingUI = syncChargeCouplingUI;

  const toggle = document.getElementById('chargeCouplingToggle') as HTMLInputElement | null;
  if (toggle) {
    toggle.checked = !!window.multiVisualizer?.chargeNetwork?.couplingEnabled;
    toggle.addEventListener('change', (e) => {
      setChargeCoupling((e.target as HTMLInputElement).checked);
    });
  }
  let lastPaintMs = 0;
  telemetryHub.subscribe(() => {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - lastPaintMs < 250) return;
    lastPaintMs = now;
    syncChargeCouplingUI();
  }, { immediate: false });
  syncChargeCouplingUI();
}
