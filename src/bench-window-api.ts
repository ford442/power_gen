/**
 * Bench / layout window API used by index.html controls and agents:
 * `setMode`, SEG + Heron layout presets, the lab field-bus toggle, and the
 * per-bench classroom toggles (transformer leakage, Hall carrier, Lorentz B).
 *
 * Split from main.ts for the 700-line gate. Importing this module assigns the
 * `window.*` names (nothing else assigns them); main.ts calls the exported
 * `wire*` helpers once the renderer has booted.
 */

import { showSetpointPanel, paintFocusedSetpoints } from './setpoint-sliders';
import { telemetryHub } from './telemetry-hub';
import { HERON_LAYOUT_DESCRIPTIONS, getHeronLayout } from './heron-layout';
import { setTransformerLeakage } from './devices/quanta/transformer.js';
import { setHallCarrierType } from './devices/quanta/hall-effect.js';
import { setLorentzFieldT, LORENTZ } from './devices/quanta/lorentz-sled.js';
import { syncFieldCouplingDisclaimer } from './renderers/shared/field-network';

const SEG_LAYOUT_DESCRIPTIONS: Record<string, string> = {
  searl: 'Searl documented configuration: 10 / 25 / 35 rollers on three rings, gap-derived proportions (~3 mm air gap).',
  roschin: 'Roschin–Godin 1 m converter: single ring of 12 rollers with 1 mm measured air gap; pairs with lab material preset.',
  legacy: 'Legacy 8 / 12 / 16 layout at 2.5 / 4.0 / 5.5 radii — retained for regression comparison.'
};

const MODE_DESCRIPTIONS: Record<string, string> = {
  seg: 'Searl Effect Generator: literature-grounded 10/25/35 or Roschin–Godin 12-roller layouts with gap-derived proportions, pole-banded rollers, and RK4 flux lines.',
  heron: "Heron's Fountain: Fluid dynamics with siphon-driven water jets. Particles simulate hydraulic pressure differentials.",
  kelvin: "Kelvin's Thunderstorm: Electrostatic induction with falling water droplets charging conductors.",
  solar: 'LEDs & Solar Cells: LEDs drain a battery while shining on solar panels that recharge it. Watch the charge level change.',
  mhd: 'MHD Generator: Hartmann-channel flow with transverse B. Watch flow U, B-field, Hartmann number, and induced power. Particles advect along the duct with Lorentz swirl (`?wasmPhysics=1` for C++ plant).',
  peltier: 'Peltier thermoelectric stack: two-node hot/cold junctions. Watch ΔT, COP proxy, and plate heat-map tint. WASM Seebeck plant with `?wasmPhysics=1`; JS fallback otherwise.',
  maglev: 'Quanta Magnetics — Magnetic Levitation: Halbach ring stack lifts a conductive floater; eddy-current damping stabilises the gap. Watch air gap, B-field estimate, and lift proxy in telemetry.',
  homopolar: 'Quanta Magnetics — Homopolar Generator: rotating copper disc in an axial magnetic field. Brushed radial path produces EMF ∝ ω×B×r. Watch disc RPM, EMF, current proxy, and B-field in telemetry.',
  'halbach-viz': 'Quanta Magnetics — Halbach Field Visualizer: configurable N-segment ring or linear array. Speed slider adjusts segment count and magnetization angle; field lines and |B| slice heatmap update in real time. Telemetry: peak B, period, dipole force proxy.',
  'pulse-coil': 'Quanta Magnetics — Pulse Coil (classroom R–L): capacitor-bank discharge through a series inductor. Watch coil current, cap voltage, peak B from amp-turns, and armature travel proxy. JS plant only (no WASM SimMode). Educational model — not a projectile or weapons simulation.',
  transformer: 'Quanta Magnetics — Mutual Induction: two-winding classroom transformer with coupling k, primary drive, and secondary load. Toggle leakage vs ideal coupling; watch Vp/Vs/Ip/Is and flux. Coupled-inductor RK4 ODE; the JS fallback mirrors the C++ plant `?wasmPhysics=1` runs.',
  vdg: 'Quanta Magnetics — Van de Graaff Generator: belt-charged isolated sphere with leakage and a spark gap. Watch sphere voltage, belt speed, charge, and spark rate. Educational model — classroom electrostatics, not a high-voltage engineering design. JS charge/voltage fallback; `?wasmPhysics=1` uses the C++ belt-charge ODE.',
  hall: 'Quanta Magnetics — Hall-Effect Bench: current-carrying strip in a transverse B field. Toggle semiconductor vs. metal carrier density; watch Hall voltage, current, field, and Hall coefficient. Educational model — not a calibrated metrology instrument. JS algebraic fallback; `?wasmPhysics=1` uses the C++ plant.',
  'lorentz-sled': 'Quanta Magnetics — Lorentz Rail Sled: a sliding armature bridges two rails in a transverse B field, so the drive current pushes it with F = I ℓ × B against friction and its own back-EMF. Set the bench field with the B slider; watch sled speed, armature current, force, and position. Educational Lorentz-force model — a low-voltage bench rail motor, not a railgun design tool. JS fallback mirrors the C++ plant; `?wasmPhysics=1` uses the C++ ODE.',
  'jumping-ring': 'Quanta Magnetics — Thomson Jumping Ring: an aluminium ring sits on an AC-driven iron core as a shorted single turn. The induced ring current opposes the primary (Lenz), the two repel, and the ring jumps — then hovers, because the coupling k(h) and so the lift fall off with height. Watch ring height, induced ring current, primary current, net force, and k(h). Educational Thomson-ring model — no projectile, and no thermal state at all: this ring never heats, glows or melts. JS fallback mirrors the C++ plant; `?wasmPhysics=1` uses the C++ coupled L–M(h) ODE.',
  'drop-tube': 'Quanta Magnetics — Lenz Drop Tube: a strong magnet falls down a copper tube. Every slice of the wall sees the falling flux change, carries a current that opposes the change (Lenz), and pushes back — so the drag grows with speed until it equals the weight, and the magnet falls at a constant terminal velocity v_t = m·g/k. The drive slider opens the release clamp and sets its height; the σ slider swaps copper for aluminium, brass, stainless or plastic. Watch speed, v_t, eddy drag, the eddy loop current, and depth. Educational point-dipole model — not a brake-design tool or a launcher, and no thermal state: the heat the drag puts into the tube is not tracked. JS plant only (algebraic; no WASM SimMode).'
};

window.setMode = (mode: string): void => {
  if (window.multiVisualizer) window.multiVisualizer.onModeChange?.(mode);

  document.body.classList.toggle('overview-mode', mode === 'overview');

  document.querySelectorAll('.mode-btn').forEach((btn) => btn.classList.remove('active'));
  const modeBtn = document.getElementById('btn-' + mode);
  if (modeBtn) modeBtn.classList.add('active');

  const info = document.getElementById('info');
  if (info && MODE_DESCRIPTIONS[mode]) info.textContent = MODE_DESCRIPTIONS[mode];

  const modeLabel = mode.toUpperCase();
  const modeLabelEl = document.getElementById('modeLabel');
  if (modeLabelEl) modeLabelEl.textContent = modeLabel;
  const modeFooterEl = document.getElementById('modeFooter');
  if (modeFooterEl) modeFooterEl.textContent = modeLabel;

  const xfmrPanel = document.getElementById('transformer-controls');
  if (xfmrPanel) xfmrPanel.style.display = mode === 'transformer' ? 'block' : 'none';
  const scope = document.getElementById('pulse-coil-scope-wrap');
  if (scope) scope.style.display = mode === 'pulse-coil' ? 'block' : 'none';
  const hallPanel = document.getElementById('hall-controls');
  if (hallPanel) hallPanel.style.display = mode === 'hall' ? 'block' : 'none';
  const sledPanel = document.getElementById('lorentz-sled-controls');
  if (sledPanel) sledPanel.style.display = mode === 'lorentz-sled' ? 'block' : 'none';
  const ringPanel = document.getElementById('jumping-ring-controls');
  if (ringPanel) ringPanel.style.display = mode === 'jumping-ring' ? 'block' : 'none';
  const tubePanel = document.getElementById('drop-tube-controls');
  if (tubePanel) tubePanel.style.display = mode === 'drop-tube' ? 'block' : 'none';
  showSetpointPanel(mode);
  syncFieldCouplingUI();
};

/**
 * Reflect the lab field bus in the device panels (ADR-0011). Under coupling the
 * B slider becomes a *display*: it still shows the live number, but the plant is
 * taking B from the source device, so leaving it editable would be a lie.
 */
function syncFieldCouplingUI(): void {
  const net = window.multiVisualizer?.fieldNetwork ?? null;
  const snap = net?.getSnapshot?.() ?? null;
  const coupled = !!(snap?.couplingEnabled ?? net?.couplingEnabled);

  // `coupled` is authoritative and synchronous; a cached link still reads
  // active until the next frame's FieldNetwork.update(), so never present a
  // destination as coupled once the bus itself is off.
  const sledLink = net?.getLinkForDestination?.('lorentz-sled') ?? null;
  const sledActive = coupled && !!sledLink?.active;
  const slider = document.getElementById('lorentzFieldSlider') as HTMLInputElement | null;
  const readout = document.getElementById('lorentzFieldValue');
  const sledSource = document.getElementById('lorentzFieldSource');
  if (slider) {
    slider.disabled = sledActive;
    slider.title = sledActive
      ? 'Coupled to mhd — turn field coupling off to set B locally'
      : '';
    if (sledActive && sledLink) slider.value = sledLink.appliedT.toFixed(2);
  }
  if (readout && sledActive && sledLink) {
    readout.textContent = `${sledLink.appliedT.toFixed(2)} T`;
  }
  if (sledSource) {
    sledSource.textContent = sledActive && sledLink
      ? `Source: ${sledLink.from} (simulated, not metrology)${sledLink.clamped ? ' · clamped' : ''}`
      : 'Source: local bench slider';
    sledSource.dataset.coupled = sledActive ? 'true' : 'false';
  }

  const hallLink = net?.getLinkForDestination?.('hall') ?? null;
  const hallActive = coupled && !!hallLink?.active;
  const hallSource = document.getElementById('hallFieldSource');
  if (hallSource) {
    hallSource.textContent = hallActive && hallLink
      ? `B source: ${hallLink.from} · ${hallLink.appliedT.toFixed(3)} T (simulated, not metrology)`
        + `${hallLink.clamped ? ' · clamped' : ''}`
      : 'B source: local drive control';
    hallSource.dataset.coupled = hallActive ? 'true' : 'false';
  }

  document.body.classList.toggle('field-coupled', coupled);
  if (snap) syncFieldCouplingDisclaimer(coupled, snap);
}

window.syncFieldCouplingUI = syncFieldCouplingUI;

/**
 * Wire the operator-panel field-coupling checkbox and keep the coupled B
 * readouts live. Repainted off the hub at ~4 Hz — the same "hub publishes,
 * panel paints" path the operator panel uses, not a second animation loop.
 */
export function wireFieldCouplingControls(): void {
  const toggle = document.getElementById('fieldCouplingToggle') as HTMLInputElement | null;
  if (toggle) {
    toggle.checked = !!window.multiVisualizer?.fieldNetwork?.couplingEnabled;
    toggle.addEventListener('change', (e) => {
      window.setFieldCoupling?.((e.target as HTMLInputElement).checked);
    });
  }
  let lastPaintMs = 0;
  telemetryHub.subscribe(() => {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - lastPaintMs < 250) return;
    lastPaintMs = now;
    syncFieldCouplingUI();
  }, { immediate: false });
  syncFieldCouplingUI();
}

/**
 * Keep the generated setpoint sliders honest about the plant (a released Halbach
 * N follows the drive sweep, a coupled Lorentz B follows the bus). Same "hub
 * publishes, panel paints" path as the coupling readouts, ~4 Hz.
 */
export function wireSetpointRepaint(): void {
  let lastPaintMs = 0;
  telemetryHub.subscribe(() => {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - lastPaintMs < 250) return;
    lastPaintMs = now;
    paintFocusedSetpoints(window.multiVisualizer?.currentView ?? 'overview');
  }, { immediate: false });
  showSetpointPanel(window.multiVisualizer?.currentView ?? 'overview');
}

/**
 * Lab field bus toggle (ADR-0011). Off (the default) leaves every device on its
 * own local B; on, Hall and the rail sled follow clamped source estimates.
 */
window.setFieldCoupling = (enabled: boolean): void => {
  const net = window.multiVisualizer?.fieldNetwork;
  net?.setCouplingEnabled?.(!!enabled);
  const toggle = document.getElementById('fieldCouplingToggle') as HTMLInputElement | null;
  if (toggle) toggle.checked = !!enabled;
  syncFieldCouplingUI();
};

/** Classroom toggle: ideal high-k vs leakage coupling on the transformer demo. */
window.setTransformerLeakage = (enabled: boolean): void => {
  const phys = window.multiVisualizer?.devices?.transformer?.physicsState;
  if (phys) setTransformerLeakage(phys, !!enabled);
  document.querySelectorAll<HTMLElement>('[data-transformer-leakage]').forEach((btn) => {
    btn.classList.toggle('active', String(enabled) === btn.dataset.transformerLeakage);
  });
};

/** Classroom toggle: semiconductor vs. metal carrier density on the Hall-effect bench. */
window.setHallCarrierType = (carrier: 'semiconductor' | 'metal'): void => {
  const phys = window.multiVisualizer?.devices?.hall?.physicsState;
  if (phys) setHallCarrierType(phys, carrier);
  document.querySelectorAll<HTMLElement>('[data-hall-carrier]').forEach((btn) => {
    btn.classList.toggle('active', carrier === btn.dataset.hallCarrier);
  });
};

/**
 * Bench-field slider (T) for the Lorentz rail sled. B is a local bench
 * parameter by default; under `?fieldCoupling=1` the FieldNetwork drives it
 * from `mhd` instead and this call only records the local setpoint to restore
 * when coupling is switched back off (ADR-0011).
 */
window.setLorentzFieldT = (fieldT: number): void => {
  const t = Math.max(0, Math.min(LORENTZ.fieldTMax, Number(fieldT) || 0));
  const phys = window.multiVisualizer?.devices?.['lorentz-sled']?.physicsState;
  const coupled = !!window.multiVisualizer?.fieldNetwork?.getLinkForDestination?.('lorentz-sled')?.active;
  if (phys) setLorentzFieldT(phys, t, { coupled });
  if (coupled) {
    syncFieldCouplingUI();
    return;
  }
  // The render loop pushes physicsState.lorentzFieldT into the C++ plant each
  // frame when ?wasmPhysics=1, so there is no separate bridge call here.
  const readout = document.getElementById('lorentzFieldValue');
  if (readout) readout.textContent = `${t.toFixed(2)} T`;
  const slider = document.getElementById('lorentzFieldSlider') as HTMLInputElement | null;
  if (slider && slider.value !== String(t)) slider.value = String(t);
};

function syncSEGLayoutUI(): void {
  const v = window.multiVisualizer;
  const buttons = document.querySelectorAll<HTMLElement>('[data-seg-layout]');
  const infoEl = document.getElementById('seg-layout-info');
  if (!v || typeof v.getSEGLayoutPreset !== 'function') return;

  const preset = v.getSEGLayoutPreset();
  buttons.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.segLayout === preset);
  });

  const layout = v.segLayout;
  if (infoEl) {
    if (layout) {
      infoEl.textContent = `${layout.name} — ${layout.totalRollers} active rollers, ${layout.ringCount} ring(s)`;
    } else {
      infoEl.textContent = SEG_LAYOUT_DESCRIPTIONS[preset] || '';
    }
  }

  if (v.currentView === 'seg') {
    const info = document.getElementById('info');
    if (info) info.textContent = SEG_LAYOUT_DESCRIPTIONS[preset] || info.textContent;
  }
}

window.setSEGLayout = async (preset: string): Promise<void> => {
  const v = window.multiVisualizer;
  if (!v?.setSEGLayoutPreset) {
    console.warn('[main] Layout switching requires multi-device visualizer');
    return;
  }
  await v.setSEGLayoutPreset(preset);
  syncSEGLayoutUI();
};

window.setSegFrameLevel = (level: string): void => {
  const v = window.multiVisualizer;
  if (v?.setSegFrameLevel) {
    v.setSegFrameLevel(level);
  } else if (v) {
    v.segFrameLevel = level;
  }
  console.log(`[main] SEG frame level → ${level}`);
};

window.setLightingLook = (look: string): void => {
  const v = window.multiVisualizer;
  if (v?.setLightingLook) {
    v.setLightingLook(look);
  }
  console.log(`[main] Lighting look → ${look}`);
};

window.syncSEGLayoutUI = syncSEGLayoutUI;

export function syncLayoutPanelsVisibility(): void {
  const view = window.multiVisualizer?.currentView || 'overview';
  const segSec = document.getElementById('seg-layout-section');
  const heronSec = document.getElementById('heron-layout-section');
  if (segSec) segSec.style.display = view === 'seg' ? '' : 'none';
  if (heronSec) heronSec.style.display = view === 'heron' ? '' : 'none';
}

window.syncLayoutPanelsVisibility = syncLayoutPanelsVisibility;

function syncHeronLayoutUI(): void {
  const v = window.multiVisualizer;
  const buttons = document.querySelectorAll<HTMLElement>('[data-heron-layout]');
  const infoEl = document.getElementById('heron-layout-info');
  if (!v || typeof v.getHeronLayoutPreset !== 'function') return;

  const preset = v.getHeronLayoutPreset();
  buttons.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.heronLayout === preset);
  });

  const layout = v.heronLayout || getHeronLayout(preset);
  if (infoEl) {
    const ps = v.devices?.heron?.physicsState as
      | { heronHead: number; heronFlowRateLmin: number; heronPressureKPa: number }
      | undefined;
    if (ps && v.currentView === 'heron') {
      infoEl.textContent = [
        layout.name,
        HERON_LAYOUT_DESCRIPTIONS[preset] || '',
        `L=${layout.pipeLengthM} m · D=${(layout.pipeDiameterM * 1000).toFixed(0)} mm`,
        `Head ${ps.heronHead.toFixed(2)}/${layout.headMaxM} m · Q ${ps.heronFlowRateLmin.toFixed(1)} L/min · P ${ps.heronPressureKPa.toFixed(1)} kPa`
      ].filter(Boolean).join(' — ');
    } else {
      infoEl.textContent = `${layout.name} — ${HERON_LAYOUT_DESCRIPTIONS[preset] || ''}`;
    }
  }

  if (v.currentView === 'heron') {
    const info = document.getElementById('info');
    if (info) info.textContent = HERON_LAYOUT_DESCRIPTIONS[preset] || info.textContent;
  }
}

window.setHeronLayout = async (preset: string): Promise<void> => {
  const v = window.multiVisualizer;
  if (!v?.setHeronLayoutPreset) {
    console.warn('[main] Heron layout switching requires multi-device visualizer');
    return;
  }
  await v.setHeronLayoutPreset(preset);
  syncHeronLayoutUI();
};

window.syncHeronLayoutUI = syncHeronLayoutUI;

export function wireHeronLayoutControls(): void {
  document.querySelectorAll<HTMLElement>('[data-heron-layout]').forEach((btn) => {
    btn.addEventListener('click', () => {
      window.setHeronLayout?.(btn.dataset.heronLayout ?? '');
    });
  });
  syncHeronLayoutUI();
}

export function wireSEGLayoutControls(): void {
  document.querySelectorAll<HTMLElement>('[data-seg-layout]').forEach((btn) => {
    btn.addEventListener('click', () => {
      window.setSEGLayout?.(btn.dataset.segLayout ?? '');
    });
  });
  syncSEGLayoutUI();
}
