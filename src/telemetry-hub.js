/**
 * TelemetryHub — single writable multi-device telemetry state.
 *
 * Authority:
 *   - SEG plant (drive, RPM, V/I/P, B-field display): segOperator
 *   - Heron / Kelvin / Solar / etc. physics: written each frame by renderers
 *   - Derived scientific fields (torque, energy density, particle flux): optional
 *
 * UI (operator panel, scientific gauges, footers) must **subscribe** — they do
 * not dig into MultiDeviceVisualizer / WebGL2 internals for live values.
 *
 * Both WebGPU and WebGL2 call {@link TelemetryHub#publishFrame} once per frame
 * after physics steps so dashboard numbers stay non-zero on either path.
 */

import { segOperator, SEG_SPEC } from './seg-operator-state.js';
import { ValidatedConstants } from './ValidatedConstants';
import { getAllSimDeviceIds } from './devices/device-registry.js';
import { TelemetrySampler } from './telemetry/telemetry-sampler.js';

/** Literature refs with uncertainty metadata for gauges */
export const TELEMETRY_META = {
  B_surface: {
    value: SEG_SPEC.B_SURFACE_T,
    unit: 'T',
    uncertainty: ValidatedConstants.SEG_PHYSICS.B_FIELD_SURFACE?.uncertainty ?? 0.05,
    isValidated: ValidatedConstants.SEG_PHYSICS.B_FIELD_SURFACE?.isValidated ?? true,
    source: 'ValidatedConstants / scientific-data'
  },
  energyDensity_surface: {
    value: ValidatedConstants.SEG_PHYSICS.ENERGY_DENSITY_SURFACE?.value
      ?? SEG_SPEC.ENERGY_DENSITY_SURFACE_JM3,
    unit: 'J/m³',
    uncertainty: ValidatedConstants.SEG_PHYSICS.ENERGY_DENSITY_SURFACE?.uncertainty ?? 0.02,
    isValidated: ValidatedConstants.SEG_PHYSICS.ENERGY_DENSITY_SURFACE?.isValidated ?? true,
    source: 'ValidatedConstants'
  },
  torque_inner: {
    value: ValidatedConstants.SEG_PHYSICS.INNER_RING_TORQUE?.value ?? 0,
    unit: 'N·m',
    uncertainty: ValidatedConstants.SEG_PHYSICS.INNER_RING_TORQUE?.uncertainty ?? 0.1,
    isValidated: false,
    source: 'fallback-physics ringTorque'
  }
};

function emptyDeviceSnap(id) {
  return {
    id,
    energyLevel: 0,
    // SEG-mirrored
    segOmega: 0,
    corona: 0,
    // Heron
    heronHead: 0,
    heronHeadMax: 0,
    heronVExit: 0,
    heronFlowRateLmin: 0,
    heronPressureKPa: 0,
    // Kelvin
    kelvinV: 0,
    kelvinVoltageN: 0,
    kelvinVbreak: 0,
    kelvinSparkTimer: 0,
    kelvinE: 0,
    // Solar
    batteryCharge: 0.5,
    // Quanta maglev
    maglevGapMm: 0,
    maglevFieldT: 0,
    maglevLiftN: 0,
    maglevRpm: 0,
    // Quanta homopolar
    homopolarRpm: 0,
    homopolarEmfV: 0,
    homopolarCurrentA: 0,
    homopolarFieldT: 0
  };
}

function snapFromPhysics(id, physics) {
  if (!physics) return emptyDeviceSnap(id);
  return {
    id,
    energyLevel: physics.energyLevel ?? 0,
    segOmega: physics.segOmega ?? 0,
    corona: physics.corona ?? 0,
    heronHead: physics.heronHead ?? 0,
    heronHeadMax: physics.heronHeadMax ?? 0,
    heronVExit: physics.heronVExit ?? 0,
    heronFlowRateLmin: physics.heronFlowRateLmin ?? 0,
    heronPressureKPa: physics.heronPressureKPa ?? 0,
    kelvinV: physics.kelvinV ?? 0,
    kelvinVoltageN: physics.kelvinVoltageN ?? 0,
    kelvinVbreak: physics.kelvinVbreak ?? 0,
    kelvinSparkTimer: physics.kelvinSparkTimer ?? 0,
    kelvinE: physics.kelvinE ?? 0,
    batteryCharge: physics.batteryCharge ?? 0.5,
    maglevGapMm: physics.maglevGapMm ?? 0,
    maglevFieldT: physics.maglevFieldT ?? 0,
    maglevLiftN: physics.maglevLiftN ?? 0,
    maglevRpm: physics.maglevRpm ?? 0,
    homopolarRpm: physics.homopolarRpm ?? 0,
    homopolarEmfV: physics.homopolarEmfV ?? 0,
    homopolarCurrentA: physics.homopolarCurrentA ?? 0,
    homopolarFieldT: physics.homopolarFieldT ?? 0
  };
}

export class TelemetryHub {
  constructor() {
    /** @type {Set<(snap: object) => void>} */
    this._listeners = new Set();
    this._frameId = 0;
    this._snapshot = this._blankSnapshot();
    /** @type {TelemetrySampler} */
    this.sampler = new TelemetrySampler({ sampleHz: 10, maxDurationSec: 120 });
    this._simTimeS = 0;
  }

  _blankSnapshot() {
    return {
      frameId: 0,
      timeMs: 0,
      dt: 0,
      view: 'overview',
      renderer: null,
      /** SEG operator telemetry (RPM, V, I, P, B, …) */
      seg: null,
      /** Per-device physics snapshots */
      devices: Object.fromEntries(
        getAllSimDeviceIds().map((id) => [id, emptyDeviceSnap(id)])
      ),
      /** Derived scientific layer */
      scientific: {
        particleFlux: 0,
        maxFieldMagnitude: 0,
        avgEnergyDensity: 0,
        innerRingTorque: 0,
        middleRingTorque: 0,
        outerRingTorque: 0
      },
      meta: TELEMETRY_META
    };
  }

  /**
   * Publish one simulation frame. Call after physics steps on either renderer.
   *
   * @param {object} opts
   * @param {number} opts.dt  Frame delta seconds
   * @param {string} [opts.view]  Focused view id
   * @param {string} [opts.renderer]  'webgpu' | 'webgl2'
   * @param {Record<string, object|null|undefined>} [opts.devicePhysics]
   *        Map of deviceId → physics state (WebGPU physicsState or WebGL2 physics)
   * @param {object} [opts.scientific]  particleFlux, maxFieldMagnitude, torques, …
   * @param {object} [opts.segTelemetry]  Precomputed SEG telemetry; default computeTelemetry(dt)
   */
  publishFrame(opts = {}) {
    const dt = opts.dt ?? 0.016;
    this._frameId += 1;
    this._simTimeS += dt;

    const segTelemetry = opts.segTelemetry || segOperator.computeTelemetry(dt);

    const devices = { ...this._snapshot.devices };
    if (opts.devicePhysics) {
      for (const [id, phys] of Object.entries(opts.devicePhysics)) {
        devices[id] = snapFromPhysics(id, phys);
      }
    }
    // Always mirror live SEG plant into devices.seg
    devices.seg = snapFromPhysics('seg', {
      ...devices.seg,
      segOmega: segOperator.physics.segOmega,
      corona: segOperator.physics.corona,
      energyLevel: segOperator.physics.segOmega,
      magneticFieldStrength: segOperator.magneticFieldStrength
    });

    const sciIn = opts.scientific || {};
    const scientific = {
      particleFlux: sciIn.particleFlux ?? this._snapshot.scientific.particleFlux,
      maxFieldMagnitude: sciIn.maxFieldMagnitude
        ?? (segTelemetry.fieldSim || TELEMETRY_META.B_surface.value * segOperator.physics.segOmega),
      avgEnergyDensity: sciIn.avgEnergyDensity
        ?? (TELEMETRY_META.energyDensity_surface.value
          * Math.min(1, Math.max(0, segOperator.physics.segOmega))),
      innerRingTorque: sciIn.innerRingTorque
        ?? (TELEMETRY_META.torque_inner.value * segOperator.physics.segOmega),
      middleRingTorque: sciIn.middleRingTorque ?? 0,
      outerRingTorque: sciIn.outerRingTorque ?? 0
    };

    this._snapshot = {
      frameId: this._frameId,
      timeMs: typeof performance !== 'undefined' ? performance.now() : Date.now(),
      dt,
      simTimeS: this._simTimeS,
      view: opts.view || this._snapshot.view || 'overview',
      renderer: opts.renderer ?? this._snapshot.renderer,
      seg: segTelemetry,
      devices,
      scientific,
      meta: TELEMETRY_META
    };

    this.sampler.setLoadOhm(segOperator.loadResistance ?? 100);
    this.sampler.onFrame(this._snapshot, dt);

    this._notify();
    return this._snapshot;
  }

  /** Integrated simulation time (seconds) — advances with publishFrame dt. */
  getSimTimeS() {
    return this._simTimeS;
  }

  resetSimClock() {
    this._simTimeS = 0;
    this.sampler.clear();
  }

  /**
   * Record telemetry for N seconds of simulation time.
   * @param {number} durationSec
   * @param {number} [sampleHz]
   */
  startRecording(durationSec = 10, sampleHz) {
    if (sampleHz != null) this.sampler.setSampleHz(sampleHz);
    this.sampler.start(durationSec);
  }

  stopRecording() {
    this.sampler.stop();
  }

  getRecordedRows() {
    return this.sampler.getRows();
  }

  isRecording() {
    return this.sampler.recording;
  }

  /** Latest immutable-ish snapshot (do not mutate). */
  getSnapshot() {
    return this._snapshot;
  }

  getSeg() {
    return this._snapshot.seg;
  }

  getDevice(id) {
    return this._snapshot.devices[id] || emptyDeviceSnap(id);
  }

  /**
   * @param {(snap: object) => void} fn
   * @param {{ immediate?: boolean }} [opts]
   * @returns {() => void} unsubscribe
   */
  subscribe(fn, opts = {}) {
    if (typeof fn !== 'function') return () => {};
    this._listeners.add(fn);
    if (opts.immediate !== false && this._snapshot.seg) {
      try { fn(this._snapshot); } catch (e) { console.warn('[TelemetryHub] subscriber error', e); }
    }
    return () => this._listeners.delete(fn);
  }

  _notify() {
    for (const fn of this._listeners) {
      try {
        fn(this._snapshot);
      } catch (e) {
        console.warn('[TelemetryHub] subscriber error', e);
      }
    }
  }

  /**
   * Helper: collect physics maps from multi-device devices (WebGPU DeviceInstance
   * or WebGL2DeviceState).
   * @param {Record<string, { physicsState?: object, physics?: object, batteryCharge?: number }>} devices
   */
  static collectDevicePhysics(devices) {
    const out = {};
    if (!devices) return out;
    for (const [id, d] of Object.entries(devices)) {
      const phys = d.physicsState || d.physics || null;
      if (!phys) continue;
      // WebGPU solar stores battery on uniform manager; merge if needed
      if (id === 'solar' && typeof d.batteryCharge === 'number') {
        out[id] = { ...phys, batteryCharge: d.batteryCharge };
      } else {
        out[id] = phys;
      }
    }
    return out;
  }
}

/** App-wide singleton */
export const telemetryHub = new TelemetryHub();

// Dev / agent access
if (typeof window !== 'undefined') {
  window.telemetryHub = telemetryHub;
}
